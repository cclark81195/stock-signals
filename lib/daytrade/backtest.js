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

import { noiseBefore, relVolAt } from "./sessions.js";
import { detect } from "./setups.js";
import { buildPlan, RiskGuard } from "./risk.js";

const TICK = 0.01;

/**
 * Run one trading day. `final` is false only for a session that may still be in progress
 * (the latest one), so open trades are not force-closed and a fresh signal is reported.
 */
export function runSession(symbol, session, noise, guard, cfg, final = true, extra = {}) {
  const slip = cfg.slippageBps / 10000;
  const bars = session.bars;
  const trades = [];
  let pending = null;
  let pos = null;

  const close = (b, i, grossPx, netPx, why) => {
    // A trade may have sold part of itself earlier (the partial exit); the rest closes here.
    const p = pos.partial;                                   // { shares, grossPx, netPx } or undefined
    const left = pos.shares - (p ? p.shares : 0);
    const grossTotal = (p ? p.shares * (p.grossPx - pos.entryGross) : 0) + left * (grossPx - pos.entryGross);
    const netTotal = (p ? p.shares * (p.netPx - pos.entryNet) : 0) + left * (netPx - pos.entryNet) - 2 * cfg.commissionPerShare * pos.shares;
    const denom = pos.shares * pos.riskPerShare;
    const netR = netTotal / denom;
    guard.recordClose(netR);
    trades.push({
      symbol, date: session.date, setup: pos.setup, reason: pos.reason,
      entryTime: pos.entryTime, exitTime: b.t,
      entry: round(pos.entryNet), exit: round(p ? (p.shares * p.netPx + left * netPx) / pos.shares : netPx), stop: round(pos.initialStop), target: round(pos.target),
      shares: pos.shares, exitReason: why, partial: p ? { shares: p.shares, price: round(p.netPx) } : null,
      grossR: grossTotal / denom, netR,
      pnl: netTotal,
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
        pos = { ...res.plan, initialStop: res.plan.stop, entryGross: b.o, entryNet, entryTime: b.t, entryIdx: i, reason: pending.signal.reason };
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
      } else {
        // Partial exit: a limit sell of part of the position at +atR, then the stop on the rest moves to breakeven.
        const pc = cfg.partial;
        if (pc?.enabled && !pos.partial) {
          const level = pos.entryNet + pc.atR * pos.riskPerShare;
          const raw = pos.shares * pc.fraction;
          const part = cfg.fractional || cfg.dollarsPerTrade > 0 ? Math.floor(raw * 1e6) / 1e6 : Math.floor(raw);
          if (part >= (cfg.fractional || cfg.dollarsPerTrade > 0 ? 1e-6 : 1) && part < pos.shares && level < pos.target && b.h >= level + TICK) {
            pos.partial = { shares: part, grossPx: level, netPx: level };
            pos.stop = Math.max(pos.stop, pos.entryNet);
          }
        }
        if (b.h >= pos.target + TICK) {
          close(b, i, pos.target, pos.target, "target");
        } else if (final && lastBar) {
          close(b, i, b.c, b.c * (1 - slip), "session-end");
        }
      }
    }

    // 3) Look for a new setup on this closed bar.
    if (!pos && !(final && lastBar)) {
      if (guard.canOpen(session.date, b.min).ok) {
        const sig = detect(session, i, { noise, ...extra }, cfg);
        if (sig) pending = { signal: sig, refClose: b.c };
      }
    }
  }
  return { trades, open: pos, pending };
}

/** Backtest one symbol across all its sessions (the first session only seeds the noise yardstick). */
export function backtestSymbol(symbol, sessions, cfg, marketOk = null) {
  const guard = new RiskGuard(cfg);
  const trades = [];
  let tested = 0;
  for (let si = 1; si < sessions.length; si++) {
    const s = sessions[si];
    guard.reset(s.date);
    const noise = noiseBefore(sessions, si);
    const extra = { marketOk, relVol: (i) => relVolAt(sessions, si, i), prevClose: sessions[si - 1]?.bars.at(-1)?.c ?? null };
    trades.push(...runSession(symbol, s, noise, guard, cfg, true, extra).trades);
    tested++;
  }
  return { trades, sessionsTested: tested };
}

/** What is happening in the most recent session? Uses the same engine as the backtest. */
export function scanLatest(symbol, sessions, cfg, todayDate = null, nowSec = null, marketOk = null) {
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
  const r = runSession(symbol, session, noise, guard, cfg, final, { marketOk, relVol: (i) => relVolAt(sessions, si, i), prevClose: sessions[si - 1]?.bars.at(-1)?.c ?? null });

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

/**
 * Small, ADDABLE totals for a set of trades (used by the S&P 500 scan, which merges many
 * symbols on the page): sums rather than averages, so groups can be combined exactly.
 */
export function compactStats(trades, detail = false) {
  const c = { trades: trades.length, wins: 0, sumNetR: 0, sumGrossR: 0, sumWinR: 0, sumLossR: 0, pnl: 0 };
  const d = detail ? { stopPctSum: 0, holdBarsSum: 0, partials: 0, byExit: {}, bySetup: {} } : null;
  for (const t of trades) {
    c.sumNetR += t.netR; c.sumGrossR += t.grossR; c.pnl += t.pnl;
    if (t.netR > 0) { c.wins++; c.sumWinR += t.netR; } else c.sumLossR += -t.netR;
    if (d) {
      d.stopPctSum += ((t.entry - t.stop) / t.entry) * 100;
      d.holdBarsSum += t.holdBars;
      if (t.partial) d.partials++;
      const e = (d.byExit[t.exitReason] ||= { trades: 0, sumNetR: 0 });
      e.trades++; e.sumNetR += t.netR;
      const g = (d.bySetup[t.setup] ||= { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, sumWinR: 0, sumLossR: 0, pnl: 0 });
      g.trades++; g.sumNetR += t.netR; g.sumGrossR += t.grossR; g.pnl += t.pnl;
      if (t.netR > 0) { g.wins++; g.sumWinR += t.netR; } else g.sumLossR += -t.netR;
    }
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  for (const k of ["sumNetR", "sumGrossR", "sumWinR", "sumLossR", "pnl"]) c[k] = r3(c[k]);
  if (d) {
    d.stopPctSum = r3(d.stopPctSum);
    for (const e of Object.values(d.byExit)) e.sumNetR = r3(e.sumNetR);
    for (const g of Object.values(d.bySetup)) for (const k of ["sumNetR", "sumGrossR", "sumWinR", "sumLossR", "pnl"]) g[k] = r3(g[k]);
    Object.assign(c, d);
  }
  return c;
}
