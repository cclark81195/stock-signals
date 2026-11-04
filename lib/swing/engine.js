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
  // allowShort (Bollinger only) mirrors everything: sell short above the upper band, buy back at the average (or halfway to /
  // all the way to the lower band), stop ABOVE the entry, shorts only in a downtrend and only while the market is down.
  bollinger: { len: 20, k: 2, entry: "below", exitFrac: 0, maxHold: 10, allowShort: false },
  borrowPct: 1,              // yearly cost of borrowing shares to short, % of the position (accrues every calendar day held)
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
  const canShort = cfg.strategy === "bollinger" && !!bb.allowShort;
  const rsiV = cfg.strategy === "meanrev" ? rsi(closes, mr.rsiLen) : null;
  const exitMa = cfg.strategy === "meanrev" ? sma(closes, mr.exitSma) : null;
  const hh = cfg.strategy === "breakout" ? priorExtreme(bars, bo.entryLen, "h", Math.max) : null;
  const ll = cfg.strategy === "breakout" ? priorExtreme(bars, bo.exitLen, "l", Math.min) : null;
  const maxHold = cfg.strategy === "meanrev" ? mr.maxHold : cfg.strategy === "bollinger" ? bb.maxHold : bo.maxHold;
  const borrowRate = (cfg.borrowPct || 0) / 100;

  const trades = [];
  const daily = {};               // date -> profit or loss marked to that day's close (sums to the trades' P&L)
  let pending = null, pos = null, exitNext = null;

  // dir is +1 for a long trade and -1 for a short one; every price comparison below is written once and flipped by it.
  const mark = (i, px) => {
    let d = pos.shares * pos.dir * (px - pos.basis);
    if (pos.dir < 0 && borrowRate > 0) {                      // borrow fee: every calendar day a short is open
      const days = (bars[i].t - pos.lastT) / 86400;
      const fee = pos.shares * pos.entryNet * borrowRate * days / 365;
      d -= fee; pos.borrow += fee;
    }
    pos.lastT = bars[i].t;
    if (d) daily[bars[i].date] = (daily[bars[i].date] || 0) + d;
    pos.basis = px;
  };

  const close = (i, grossPx, why) => {
    const exitNet = grossPx * (1 - pos.dir * slip);            // selling gets slightly less, buying back costs slightly more
    mark(i, exitNet);
    const risk = Math.abs(pos.entryNet - pos.stop);
    const move = pos.shares * pos.dir * (exitNet - pos.entryNet);
    trades.push({
      symbol, setup: cfg.strategy, side: pos.dir > 0 ? "long" : "short", date: bars[pos.entryIdx].date, exitDate: bars[i].date,
      entryTime: bars[pos.entryIdx].t, exitTime: bars[i].t,
      entry: round(pos.entryNet), exit: round(exitNet), stop: round(pos.stop), shares: pos.shares,
      exitReason: why, holdBars: i - pos.entryIdx + 1, reason: pos.reason, borrow: round(pos.borrow),
      grossR: (pos.dir * (grossPx - pos.entryGross) * pos.shares) / (pos.shares * risk), netR: (move - pos.borrow) / (pos.shares * risk),
      pnl: move - pos.borrow,
    });
    pos = null; exitNext = null;
  };

  for (let i = 1; i < n; i++) {
    const b = bars[i];

    // 1) fill yesterday's signal at today's open
    if (pending && !pos) {
      const dir = pending.dir;
      const entryNet = b.o * (1 + dir * slip);
      const stop = entryNet - dir * cfg.stopAtr * pending.atr;
      if (stop > 0 && (dir > 0 ? entryNet > stop : stop > entryNet)) {
        pos = { dir, entryIdx: i, entryGross: b.o, entryNet, basis: entryNet, stop, shares: cfg.dollars / entryNet, reason: pending.reason, borrow: 0, lastT: b.t };
      }
    }
    pending = null;

    // 2) manage the open position
    if (pos) {
      const gap = pos.dir > 0 ? b.o <= pos.stop : b.o >= pos.stop;             // opened beyond the stop
      const hit = pos.dir > 0 ? b.l <= pos.stop : b.h >= pos.stop;             // traded through the stop
      if (gap) close(i, b.o, "stop-gap");
      else if (exitNext && i > pos.entryIdx) close(i, b.o, exitNext);          // yesterday's exit signal
      else if (hit) close(i, pos.stop, "stop");
    }

    // 3) at the close: read exit signals, or mark an open trade at the end of the data
    if (pos) {
      if (i < n - 1) mark(i, b.c);                                             // still open: value it at today's close
      if (i === n - 1) close(i, b.c, "data-end");
      else if (cfg.strategy === "meanrev" && b.c > exitMa[i]) exitNext = "signal";
      else if (cfg.strategy === "breakout" && ll[i] != null && b.c < ll[i]) exitNext = "signal";
      else if (cfg.strategy === "bollinger" && bands.mid[i] != null && (pos.dir > 0
        ? b.c >= bands.mid[i] + bb.exitFrac * (bands.upper[i] - bands.mid[i])
        : b.c <= bands.mid[i] - bb.exitFrac * (bands.mid[i] - bands.lower[i]))) exitNext = "signal";
      else if (maxHold > 0 && i - pos.entryIdx + 1 >= maxHold) exitNext = "time";
      continue;
    }

    // 4) at the close: read an entry signal (fills tomorrow)
    if (i >= n - 1 || sma200[i] == null || atrV[i] == null) continue;
    // Safeguards, mirrored for shorts: longs need an uptrend (and an up market), shorts need a downtrend (and a down market).
    const longOk = (!cfg.trendFilter || b.c > sma200[i]) && !(cfg.marketFilter && marketOk && marketOk.get(b.date) === false);
    const shortOk = canShort && (!cfg.trendFilter || b.c < sma200[i]) && !(cfg.marketFilter && marketOk && marketOk.get(b.date) === true);
    if (cfg.strategy === "meanrev") {
      if (longOk && rsiV[i] != null && exitMa[i] != null && rsiV[i] < mr.rsiBuy) {
        pending = { dir: 1, atr: atrV[i], reason: `${mr.rsiLen}-day RSI ${rsiV[i].toFixed(1)} is below ${mr.rsiBuy}: a sharp short-term drop` };
      }
    } else if (cfg.strategy === "bollinger") {
      const lo = bands.lower[i], up = bands.upper[i];
      if (lo != null && longOk) {
        const prevLo = bands.lower[i - 1];
        const hit = bb.entry === "reclaim" ? prevLo != null && closes[i - 1] < prevLo && b.c >= lo : b.c < lo;
        if (hit) pending = { dir: 1, atr: atrV[i], reason: bb.entry === "reclaim" ? `Closed back above the lower Bollinger band after a dip below it` : `Closed below the lower Bollinger band (${bb.len}-day average minus ${bb.k} deviations)` };
      }
      if (!pending && up != null && shortOk) {
        const prevUp = bands.upper[i - 1];
        const hit = bb.entry === "reclaim" ? prevUp != null && closes[i - 1] > prevUp && b.c <= up : b.c > up;
        if (hit) pending = { dir: -1, atr: atrV[i], reason: bb.entry === "reclaim" ? `Closed back below the upper Bollinger band after a day above it` : `Closed above the upper Bollinger band (${bb.len}-day average plus ${bb.k} deviations)` };
      }
    } else if (longOk && hh[i] != null && b.c > hh[i]) {
      pending = { dir: 1, atr: atrV[i], reason: `Closed above the ${bo.entryLen}-day high` };
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
  c.bySide = {};
  for (const t of trades) {
    const g = (c.bySide[t.side || "long"] ||= { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, pnl: 0, borrow: 0 });
    g.trades++; g.sumNetR += t.netR; g.sumGrossR += t.grossR; g.pnl += t.pnl; g.borrow += t.borrow || 0; if (t.netR > 0) g.wins++;
  }
  for (const g of Object.values(c.bySide)) for (const k of ["sumNetR", "sumGrossR", "pnl", "borrow"]) g[k] = Math.round(g[k] * 1000) / 1000;
  for (const y of Object.values(c.byYear)) { y.sumNetR = Math.round(y.sumNetR * 1000) / 1000; y.pnl = Math.round(y.pnl * 1000) / 1000; }
  return c;
}
