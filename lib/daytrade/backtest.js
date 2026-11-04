// Cost-aware, bar-by-bar simulator. The SAME setups, risk guard and plan builder used
// for "today's setups" (and later for live trading) run here, so a backtest cannot
// quietly use different rules than the bot would.
//
// Fill assumptions (deliberately pessimistic):
//   * A signal is read when a 5-minute bar CLOSES; the order fills at the NEXT bar's open.
//   * Slippage is charged on every market-style fill (entry, stop, time exit).
//   * Profit targets are limit orders: they fill only if price trades a cent THROUGH the target.
//   * If a single bar touches both stop and target, the stop is assumed to hit first.
//   * A bar that opens beyond the stop (a gap) exits at that open, not at the stop price.
//
// The result reports GROSS and NET R so you can see how much of any edge is eaten by costs.

import { noiseBefore } from "./sessions.js";
import { detect } from "./setups.js";
import { buildPlan, RiskGuard } from "./risk.js";

const TICK = 0.01;

/**
 * Run one trading day. `final` is false only for a session that may still be in progress
 * (the latest one), so open trades are not force-closed and a fresh signal is reported.
 */
export function runSession(symbol, session, noise, guard, cfg, final = true) {
  const slip = cfg.slippageBps / 10000;
  const bars = session.bars;
  const trades = [];
  let pending = null;
  let pos = null;

  const close = (b, i, grossPx, netPx, why) => {
    const grossPer = grossPx - pos.entryGross;
    const netPer = netPx - pos.entryNet - 2 * cfg.commissionPerShare;
    const netR = netPer / pos.riskPerShare;
    guard.recordClose(netR);
    trades.push({
      symbol, date: session.date, setup: pos.setup, reason: pos.reason,
      entryTime: pos.entryTime, exitTime: b.t,
      entry: round(pos.entryNet), exit: round(netPx), stop: round(pos.stop), target: round(pos.target),
      shares: pos.shares, exitReason: why,
      grossR: grossPer / pos.riskPerShare, netR,
      pnl: netPer * pos.shares,
      holdBars: i - pos.entryIdx + 1,
    });
    pos = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const lastBar = i === bars.length - 1;

    // 1) Fill a pending entry at this bar's open.
    if (pending && !pos) {
      const entryNet = b.o * (1 + slip);
      const res = buildPlan(pending.signal, entryNet, noise, cfg);
      const chased = res.ok && b.o - pending.refClose > cfg.maxChaseR * res.plan.riskPerShare;
      if (res.ok && !chased) {
        guard.recordOpen();
        pos = { ...res.plan, entryGross: b.o, entryNet, entryTime: b.t, entryIdx: i, reason: pending.signal.reason };
      }
    }
    pending = null;

    // 2) Manage the open position on this bar (including the bar it was entered on).
    if (pos) {
      const fresh = i === pos.entryIdx;
      if (b.min >= cfg.flattenMin) {
        close(b, i, b.o, b.o * (1 - slip), "time");
      } else if (!fresh && b.o <= pos.stop) {
        close(b, i, b.o, b.o * (1 - slip), "stop-gap");
      } else if (b.l <= pos.stop) {
        close(b, i, pos.stop, pos.stop * (1 - slip), "stop");
      } else if (b.h >= pos.target + TICK) {
        close(b, i, pos.target, pos.target, "target");
      } else if (final && lastBar) {
        close(b, i, b.c, b.c * (1 - slip), "session-end");
      }
    }

    // 3) Look for a new setup on this closed bar.
    if (!pos && !(final && lastBar)) {
      if (guard.canOpen(session.date, b.min).ok) {
        const sig = detect(session, i, { noise }, cfg);
        if (sig) pending = { signal: sig, refClose: b.c };
      }
    }
  }
  return { trades, open: pos, pending };
}

/** Backtest one symbol across all its sessions (the first session only seeds the noise yardstick). */
export function backtestSymbol(symbol, sessions, cfg) {
  const guard = new RiskGuard(cfg);
  const trades = [];
  let tested = 0;
  for (let si = 1; si < sessions.length; si++) {
    const s = sessions[si];
    guard.reset(s.date);
    const noise = noiseBefore(sessions, si);
    trades.push(...runSession(symbol, s, noise, guard, cfg, true).trades);
    tested++;
  }
  return { trades, sessionsTested: tested };
}

/** What is happening in the most recent session? Uses the same engine as the backtest. */
export function scanLatest(symbol, sessions, cfg, todayDate = null, nowSec = null) {
  if (sessions.length < 2) return { state: "no-data", text: "Not enough intraday history yet." };
  const si = sessions.length - 1;
  let session = sessions[si];
  const isToday = todayDate ? session.date === todayDate : true;
  // Yahoo includes the 5-minute bar that is still forming; a signal must wait for the bar to close.
  if (isToday && nowSec && session.bars.length > 1) {
    const forming = session.bars[session.bars.length - 1];
    if (forming.t + 300 > nowSec) session = { ...session, bars: session.bars.slice(0, -1) };
  }
  const noise = noiseBefore(sessions, si);
  const lastBar = session.bars[session.bars.length - 1];
  const final = !isToday || lastBar.min >= (cfg.closeMin ?? 960) - 10; // last bar of the day present => it is over
  const guard = new RiskGuard(cfg);
  guard.reset(session.date);
  const r = runSession(symbol, session, noise, guard, cfg, final);

  const out = { date: session.date, live: !final, price: lastBar.c, vwap: lastBar.vwap, trades: r.trades, guard: { trades: guard.trades, realizedR: guard.realizedR } };
  if (r.open) {
    return { ...out, state: "in-position", text: `Would be in a long from ${r.open.entry.toFixed(2)} (${r.open.setup}). Stop ${r.open.stop.toFixed(2)}, target ${r.open.target.toFixed(2)}.`, plan: r.open };
  }
  if (r.pending) {
    const ref = buildPlan(r.pending.signal, r.pending.refClose * (1 + cfg.slippageBps / 10000), noise, cfg);
    return {
      ...out, state: "signal",
      text: ref.ok ? `${r.pending.signal.setup.toUpperCase()} signal on the last closed bar. ${r.pending.signal.reason}` : `${r.pending.signal.setup.toUpperCase()} signal rejected by risk rules: ${ref.reason}.`,
      plan: ref.ok ? ref.plan : null,
    };
  }
  if (r.trades.length) return { ...out, state: "traded", text: `${r.trades.length} simulated trade${r.trades.length === 1 ? "" : "s"} in this session.` };
  if (!final && lastBar.min < (cfg.openMin ?? 570) + (cfg.setups.orb?.orMinutes ?? 15)) return { ...out, state: "waiting", text: "Opening range still forming." };
  return { ...out, state: "none", text: final ? "No setup triggered in this session." : "No setup yet. Watching." };
}

// ---------------------------------------------------------------- statistics
const round = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function summarize(trades) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const n = sorted.length;
  const empty = { trades: 0, sampleWarning: "No trades yet, so there is nothing to judge." };
  if (!n) return empty;

  const wins = sorted.filter((t) => t.netR > 0);
  const losses = sorted.filter((t) => t.netR <= 0);
  const sumWin = wins.reduce((s, t) => s + t.netR, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.netR, 0));

  let cum = 0, peak = 0, maxDD = 0;
  const curve = sorted.map((t) => {
    cum += t.netR;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    return { t: t.exitTime, date: t.date, cumR: Math.round(cum * 100) / 100 };
  });

  const byExit = {};
  for (const t of sorted) byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1;
  const bySetup = {};
  for (const t of sorted) {
    const s = (bySetup[t.setup] ||= { trades: 0, netR: 0, wins: 0 });
    s.trades++; s.netR += t.netR; if (t.netR > 0) s.wins++;
  }
  for (const s of Object.values(bySetup)) { s.netR = Math.round(s.netR * 100) / 100; s.winRate = s.wins / s.trades; }

  const expectancyNetR = mean(sorted.map((t) => t.netR));
  const expectancyGrossR = mean(sorted.map((t) => t.grossR));
  return {
    trades: n,
    winRate: wins.length / n,
    avgWinR: mean(wins.map((t) => t.netR)),
    avgLossR: Math.abs(mean(losses.map((t) => t.netR))),
    expectancyNetR,
    expectancyGrossR,
    costDragR: expectancyGrossR - expectancyNetR,
    profitFactor: sumLoss > 0 ? sumWin / sumLoss : null,
    totalNetR: cum,
    totalPnl: sorted.reduce((s, t) => s + t.pnl, 0),
    maxDrawdownR: maxDD,
    avgHoldMin: mean(sorted.map((t) => t.holdBars)) * 5,
    byExit, bySetup, curve,
    sampleWarning: n < 100
      ? `Only ${n} trades. Anything under a few hundred is mostly luck, so treat this as a smoke test of the code, not proof of an edge.`
      : null,
  };
}
