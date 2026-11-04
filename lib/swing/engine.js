// Swing Lab engine: long-only strategies on DAILY bars, multi-day holds, cost-aware.
// Same honesty rules as the day-trade engine:
//   * a signal is read at a day's CLOSE; the order fills at the NEXT day's open, plus slippage;
//   * the stop is a resting order: a day that trades through it exits at the stop (worse, with slippage),
//     a day that OPENS beyond it exits at the open (a gap);
//   * indicators use only data up to the signal day (no peeking ahead);
//   * R = profit divided by the money at risk between the buy price and the stop.
import { compactStats } from "../daytrade/backtest.js";

export const DEFAULTS = {
  strategy: "meanrev",       // "meanrev" | "breakout" | "bollinger"
  dollars: 100,              // fixed dollars per buy (fractional shares)
  slippageBps: 5,            // per side
  trendFilter: true,         // only buy when the close is above the 200-day average
  marketFilter: false,       // ...and SPY is above its own 200-day average
  stopAtr: 3,                // stop distance, in 14-day average true ranges
  atrLen: 14,
  meanrev: { rsiLen: 2, rsiBuy: 10, exitSma: 5, maxHold: 10 },
  breakout: { entryLen: 55, exitLen: 20, maxHold: 0 }, // maxHold 0 = no time limit
  // Bollinger: bands = len-day average +- k standard deviations. entry "below" buys the first close under the lower band;
  // "reclaim" waits for a close back above it. exitFrac: sell at the average (0), halfway to the upper band (0.5) or the upper band (1).
  bollinger: { len: 20, k: 2, entry: "below", exitFrac: 0, maxHold: 10 },
};

export function makeConfig(over = {}) {
  const c = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (k === "meanrev" || k === "breakout" || k === "bollinger") {
      for (const [kk, vv] of Object.entries(v || {})) if (vv !== undefined) c[k][kk] = vv;
    } else c[k] = v;
  }
  return c;
}

// ---------------------------------------------------------------- indicators (all forward-only)
export function sma(vals, n) {
  const out = new Array(vals.length).fill(null);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= n) s -= vals[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** Bollinger bands: the n-day average and k standard deviations (population) either side of it. */
export function bollinger(closes, n, k) {
  const mid = sma(closes, n);
  const upper = new Array(closes.length).fill(null), lower = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    upper[i] = mid[i] + k * sd; lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's average true range. */
export function atr(bars, n) {
  const out = new Array(bars.length).fill(null);
  let prev = null, sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < n) { sum += tr; if (i === n - 1) out[i] = prev = sum / n; }
    else { prev = (prev * (n - 1) + tr) / n; out[i] = prev; }
  }
  return out;
}

/** Wilder's RSI of the close. */
export function rsi(closes, n) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** Highest high / lowest low of the PREVIOUS n bars (today excluded). */
function priorExtreme(bars, n, key, pick) {
  const out = new Array(bars.length).fill(null);
  for (let i = n; i < bars.length; i++) {
    let v = bars[i - n][key];
    for (let j = i - n + 1; j < i; j++) v = pick(v, bars[j][key]);
    out[i] = v;
  }
  return out;
}

/** Daily bars from fetchChart() output, with the date in New York. */
export function toDaily(bars) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const out = [];
  for (let i = 0; i < bars.t.length; i++) {
    const o = bars.open[i], h = bars.high[i], l = bars.low[i], c = bars.close[i];
    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ t: bars.t[i], date: fmt.format(new Date(bars.t[i] * 1000)), o, h, l, c, v: bars.volume?.[i] || 0 });
  }
  return out;
}

/** Map of date -> whether SPY closed above its 200-day average that day. */
export function aboveSma200Map(daily) {
  const m = sma(daily.map((b) => b.c), 200);
  const map = new Map();
  daily.forEach((b, i) => { if (m[i] != null) map.set(b.date, b.c > m[i]); });
  return map;
}

// ---------------------------------------------------------------- the simulation
const round = (x) => Math.round(x * 10000) / 10000;

export function backtestDaily(symbol, bars, cfg, marketOk = null) {
  const n = bars.length;
  const closes = bars.map((b) => b.c);
  const sma200 = sma(closes, 200);
  const atrV = atr(bars, cfg.atrLen);
  const slip = cfg.slippageBps / 10000;
  const mr = cfg.meanrev, bo = cfg.breakout, bb = cfg.bollinger;
  const bands = cfg.strategy === "bollinger" ? bollinger(closes, bb.len, bb.k) : null;
  const rsiV = cfg.strategy === "meanrev" ? rsi(closes, mr.rsiLen) : null;
  const exitMa = cfg.strategy === "meanrev" ? sma(closes, mr.exitSma) : null;
  const hh = cfg.strategy === "breakout" ? priorExtreme(bars, bo.entryLen, "h", Math.max) : null;
  const ll = cfg.strategy === "breakout" ? priorExtreme(bars, bo.exitLen, "l", Math.min) : null;
  const maxHold = cfg.strategy === "meanrev" ? mr.maxHold : cfg.strategy === "bollinger" ? bb.maxHold : bo.maxHold;

  const trades = [];
  const daily = {};               // date -> profit or loss marked to that day's close (sums to the trades' P&L)
  let pending = null, pos = null, exitNext = null;
  const mark = (i, px) => {
    const d = pos.shares * (px - pos.basis);
    if (d) daily[bars[i].date] = (daily[bars[i].date] || 0) + d;
    pos.basis = px;
  };

  const close = (i, grossPx, why) => {
    const exitNet = grossPx * (1 - slip);
    mark(i, exitNet);
    const risk = pos.entryNet - pos.stop;
    trades.push({
      symbol, setup: cfg.strategy, date: bars[pos.entryIdx].date, exitDate: bars[i].date,
      entryTime: bars[pos.entryIdx].t, exitTime: bars[i].t,
      entry: round(pos.entryNet), exit: round(exitNet), stop: round(pos.stop), shares: pos.shares,
      exitReason: why, holdBars: i - pos.entryIdx + 1, reason: pos.reason,
      grossR: (grossPx - pos.entryGross) / risk, netR: (exitNet - pos.entryNet) / risk,
      pnl: pos.shares * (exitNet - pos.entryNet),
    });
    pos = null; exitNext = null;
  };

  for (let i = 1; i < n; i++) {
    const b = bars[i];

    // 1) fill yesterday's buy signal at today's open
    if (pending && !pos) {
      const entryNet = b.o * (1 + slip);
      const stop = entryNet - cfg.stopAtr * pending.atr;
      if (stop > 0 && entryNet > stop) {
        pos = { entryIdx: i, entryGross: b.o, entryNet, basis: entryNet, stop, shares: cfg.dollars / entryNet, reason: pending.reason };
      }
    }
    pending = null;

    // 2) manage the open position
    if (pos) {
      if (b.o <= pos.stop) close(i, b.o, "stop-gap");                       // opened beyond the stop
      else if (exitNext && i > pos.entryIdx) close(i, b.o, exitNext);       // yesterday's exit signal
      else if (b.l <= pos.stop) close(i, pos.stop, "stop");                 // traded through the stop
    }

    // 3) at the close: read exit signals, or mark an open trade at the end of the data
    if (pos) {
      if (i < n - 1) mark(i, b.c);                                          // still open: value it at today's close
      if (i === n - 1) close(i, b.c, "data-end");
      else if (cfg.strategy === "meanrev" && b.c > exitMa[i]) exitNext = "signal";
      else if (cfg.strategy === "breakout" && ll[i] != null && b.c < ll[i]) exitNext = "signal";
      else if (cfg.strategy === "bollinger" && bands.mid[i] != null && b.c >= bands.mid[i] + bb.exitFrac * (bands.upper[i] - bands.mid[i])) exitNext = "signal";
      else if (maxHold > 0 && i - pos.entryIdx + 1 >= maxHold) exitNext = "time";
      continue;
    }

    // 4) at the close: read a buy signal (fills tomorrow)
    if (i >= n - 1 || sma200[i] == null || atrV[i] == null) continue;
    if (cfg.trendFilter && !(b.c > sma200[i])) continue;
    if (cfg.marketFilter && marketOk && marketOk.get(b.date) === false) continue;
    if (cfg.strategy === "meanrev") {
      if (rsiV[i] != null && exitMa[i] != null && rsiV[i] < mr.rsiBuy) {
        pending = { atr: atrV[i], reason: `${mr.rsiLen}-day RSI ${rsiV[i].toFixed(1)} is below ${mr.rsiBuy}: a sharp short-term drop` };
      }
    } else if (cfg.strategy === "bollinger") {
      const lo = bands.lower[i];
      if (lo != null) {
        const prevLo = i > 0 ? bands.lower[i - 1] : null;
        const hit = bb.entry === "reclaim" ? prevLo != null && closes[i - 1] < prevLo && b.c >= lo : b.c < lo;
        if (hit) pending = { atr: atrV[i], reason: bb.entry === "reclaim" ? `Closed back above the lower Bollinger band after a dip below it` : `Closed below the lower Bollinger band (${bb.len}-day average minus ${bb.k} deviations)` };
      }
    } else if (hh[i] != null && b.c > hh[i]) {
      pending = { atr: atrV[i], reason: `Closed above the ${bo.entryLen}-day high` };
    }
  }
  for (const k of Object.keys(daily)) daily[k] = Math.round(daily[k] * 10000) / 10000;
  return { trades, daily, daysTested: Math.max(0, n - 200), testStart: n > 200 ? bars[200].date : null };
}

// ---------------------------------------------------------------- statistics
/** compactStats plus a by-year split (the best test of whether a result holds in different markets). */
export function swingStats(trades) {
  const c = compactStats(trades, true);
  c.byYear = {};
  for (const t of trades) {
    const y = (c.byYear[t.date.slice(0, 4)] ||= { trades: 0, wins: 0, sumNetR: 0, pnl: 0 });
    y.trades++; y.sumNetR += t.netR; y.pnl += t.pnl; if (t.netR > 0) y.wins++;
  }
  for (const y of Object.values(c.byYear)) { y.sumNetR = Math.round(y.sumNetR * 1000) / 1000; y.pnl = Math.round(y.pnl * 1000) / 1000; }
  return c;
}
