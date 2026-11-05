import test from "node:test";
import assert from "node:assert/strict";
import { sma, atr, rsi, backtestDaily, makeConfig, swingStats, toDaily, aboveSma200Map } from "../lib/swing/engine.js";

const dateOf = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
/** Daily bars from a list of closes; each opens at the previous close and ranges +-0.5%. `over[i]` can patch a bar. */
function mk(closes, over = {}) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    const b = { t: 1577836800 + i * 86400, date: dateOf(i), o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1e6 };
    return { ...b, ...(over[i] || {}) };
  });
}
const ramp = (n, start = 100, step = 0.2) => Array.from({ length: n }, (_, i) => start + step * i);
const cfgOf = (o = {}) => makeConfig({ slippageBps: 0, ...o });

test("sma, atr and rsi are forward-only and sensible", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const bars = mk(ramp(40));
  assert.ok(atr(bars, 14)[13] > 0 && atr(bars, 14)[12] === null);
  const up = rsi(ramp(30), 2), down = rsi(ramp(30, 200, -1), 2);
  assert.ok(up[29] > 90 && down[29] < 10);
  // changing the future must not change the past
  const a = sma(ramp(30), 5), b = sma([...ramp(20), 999, 999], 5);
  assert.equal(a[19], b[19]);
});

// 250 days of steady uptrend, then two hard down days, then a recovery
function dipDays(extra = []) {
  const base = ramp(250);
  const top = base[249];
  return [...base, top - 3, top - 6, ...extra];
}

test("mean reversion buys the sharp dip at the NEXT open, with slippage, and sells on the bounce", () => {
  const closes = dipDays([top() - 1, top() + 2, top() + 3, top() + 4]);
  function top() { return ramp(250)[249]; }
  const bars = mk(closes);
  const { trades } = backtestDaily("X", bars, cfgOf({ slippageBps: 10 }));
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.date, bars[251].date);                               // signal at day 250's close -> buy at day 251's open
  assert.ok(Math.abs(t.entry - bars[251].o * 1.001) < 0.01);          // open + 10 bps
  assert.ok(t.stop < t.entry);
  assert.equal(t.exitReason, "signal");
  assert.ok(t.exit > t.entry && t.netR > 0 && t.netR < t.grossR);     // costs reduce R
});

test("the stop is a resting order: it fills at the stop, or at the open on a gap", () => {
  const top = ramp(250)[249];
  const closes = [...ramp(250), top - 3, top - 6, top - 6, top - 6, top - 6];
  const risk = (b) => b;
  // an intraday dive through the stop on day 253
  const bars = mk(closes, { 253: { l: top - 40 } });
  const t = backtestDaily("X", bars, cfgOf()).trades[0];
  assert.equal(t.exitReason, "stop");
  assert.ok(Math.abs(t.exit - t.stop) < 0.01);
  assert.ok(t.netR < 0 && t.netR > -1.05);
  // the same day opening below the stop is a gap: exit at the open, worse than -1R
  const gapped = mk(closes, { 253: { o: top - 40, l: top - 41, h: top - 38, c: top - 39 } });
  const g = backtestDaily("X", gapped, cfgOf()).trades[0];
  assert.equal(g.exitReason, "stop-gap");
  assert.ok(g.exit < g.stop && g.netR < -1);
  void risk;
});

test("the time limit and the end of the data both close a trade", () => {
  const top = ramp(250)[249];
  const flat = Array.from({ length: 30 }, () => top - 6);
  const t = backtestDaily("X", mk([...ramp(250), top - 3, top - 6, ...flat]), cfgOf({ meanrev: { maxHold: 5 } })).trades[0];
  assert.equal(t.exitReason, "time");
  assert.equal(t.holdBars, 6);                                         // signal after 5 days, sold at the next open
  const last = backtestDaily("X", mk([...ramp(250), top - 3, top - 6, top - 6, top - 6]), cfgOf()).trades[0];
  assert.equal(last.exitReason, "data-end");
});

test("the 200-day trend filter blocks buys in a downtrend; turning it off allows them", () => {
  const down = ramp(260, 200, -0.3);
  const closes = [...down, down[259] - 4, down[259] - 8, down[259] - 8, down[259] - 5];
  assert.equal(backtestDaily("X", mk(closes), cfgOf()).trades.length, 0);
  assert.ok(backtestDaily("X", mk(closes), cfgOf({ trendFilter: false })).trades.length >= 1);
});

test("the market filter blocks buys on days the market is below its 200-day average", () => {
  const top = ramp(250)[249];
  const closes = [...ramp(250), top - 3, top - 6, top - 5, top - 4, top];
  const bars = mk(closes);
  const bearish = new Map(bars.map((b) => [b.date, false]));
  assert.equal(backtestDaily("X", bars, cfgOf({ marketFilter: true }), bearish).trades.length, 0);
  assert.equal(backtestDaily("X", bars, cfgOf({ marketFilter: true }), null).trades.length >= 1, true); // no SPY data: not applied
});

test("breakout buys a close above the prior 55-day high and exits below the prior 20-day low", () => {
  const closes = [...ramp(260), ...Array.from({ length: 10 }, (_, i) => ramp(260)[259] + 3 + i), ...Array.from({ length: 30 }, (_, i) => ramp(260)[259] + 12 - i * 1.5)];
  const bars = mk(closes);
  const { trades } = backtestDaily("X", bars, cfgOf({ strategy: "breakout" }));
  assert.ok(trades.length >= 1);
  assert.equal(trades[0].setup, "breakout");
  assert.ok(["signal", "stop", "stop-gap"].includes(trades[0].exitReason));
  assert.ok(trades[0].exit > 0 && trades[0].stop < trades[0].entry);
});

test("no lookahead: cutting the data off later never changes trades already closed", () => {
  const top = ramp(250)[249];
  const closes = [...ramp(250), top - 3, top - 6, top - 1, top + 2, top + 3, ...ramp(40, top, 0.2)];
  const full = backtestDaily("X", mk(closes), cfgOf()).trades;
  const cut = backtestDaily("X", mk(closes.slice(0, 262)), cfgOf()).trades;
  assert.ok(full.length >= 1 && cut.length >= 1);
  assert.deepEqual({ ...cut[0], reason: 0 }, { ...full[0], reason: 0 });
});

test("swingStats adds up by year and by exit, and the dollar maths matches the R maths", () => {
  const top = ramp(250)[249];
  const trades = backtestDaily("X", mk([...ramp(250), top - 3, top - 6, top - 1, top + 2, top + 3]), cfgOf({ dollars: 200 })).trades;
  const c = swingStats(trades);
  assert.equal(Object.values(c.byYear).reduce((s, y) => s + y.trades, 0), trades.length);
  assert.equal(Object.values(c.byExit).reduce((s, e) => s + e.trades, 0), trades.length);
  const t = trades[0];
  assert.ok(Math.abs(t.shares * t.entry - 200) < 0.5);                // fixed dollars, fractional shares
  assert.ok(Math.abs(t.pnl - t.shares * (t.exit - t.entry)) < 1e-6);
});

test("toDaily drops bad rows and aboveSma200Map flags the trend", () => {
  const raw = { t: [1, 2, 3], open: [1, NaN, 3], high: [2, 2, 4], low: [1, 1, 2], close: [2, 2, 3], volume: [5, 5, 5] };
  assert.equal(toDaily(raw).length, 2);
  const m = aboveSma200Map(mk(ramp(260)));
  assert.equal([...m.values()].every(Boolean), true);
});

test("daily mark-to-market P&L adds up exactly to the trades' P&L, including slippage", () => {
  const top = ramp(250)[249];
  const closes = [...ramp(250), top - 3, top - 6, top - 1, top + 2, top + 3, ...ramp(30, top, 0.3), top - 20, top - 25, top - 30, top - 6, top - 8, top - 9];
  for (const slippageBps of [0, 10]) {
    const { trades, daily, testStart } = backtestDaily("X", mk(closes), cfgOf({ slippageBps, meanrev: { maxHold: 40 } }));
    assert.ok(trades.length >= 1);
    const fromTrades = trades.reduce((s, t) => s + t.pnl, 0);
    const fromDays = Object.values(daily).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(fromTrades - fromDays) < 0.01, `${fromTrades} vs ${fromDays}`);
    assert.equal(testStart, mk(closes)[200].date);
  }
  // a day with no position books nothing
  const t = backtestDaily("X", mk(ramp(260)), cfgOf());
  assert.deepEqual(t.daily, {});
});

import { replayAccount } from "../public/swing-account.js";
const row = (symbol, list) => ({ symbol, trades: list.map(([date, exitDate, pnl]) => ({ symbol, date, exitDate, pnl })) });
const days = ["d1", "d2", "d3", "d4", "d5"];

test("account replay: realised profit is added when a trade is sold, and cash is returned", () => {
  const r = replayAccount([row("A", [["d1", "d3", 10]])], 1000, 100, days);
  assert.deepEqual(r.equity, [1000, 1000, 1010, 1010, 1010]);
  assert.equal(r.taken, 1); assert.equal(r.skipped, 0);
});

test("account replay: with $200 and $100 buys only two positions fit; the rest are skipped, not queued", () => {
  const rows = [row("A", [["d1", "d4", 5]]), row("B", [["d1", "d4", 5]]), row("C", [["d1", "d4", 5]]), row("D", [["d2", "d3", 7]])];
  const r = replayAccount(rows, 200, 100, days);
  assert.equal(r.taken, 2); assert.equal(r.skipped, 2); assert.equal(r.maxOpen, 2);
  assert.ok(r.equity[4] > 200 && r.equity[4] <= 210);
});

test("account replay: cash freed on a sale is reusable the same day, and same-day round trips work", () => {
  const rows = [row("A", [["d1", "d2", 20]]), row("B", [["d2", "d4", -10]]), row("C", [["d3", "d3", 3]])];
  const r = replayAccount(rows, 100, 100, days);            // only one position at a time
  assert.equal(r.taken, 2); assert.equal(r.skipped, 1);     // A sells on d2 and B buys with that cash the same day; C finds B still holding it
  assert.equal(r.equity[1], 120);
  const same = replayAccount([row("S", [["d2", "d2", 4]])], 100, 100, days);   // bought and sold on one day
  assert.deepEqual(same.equity, [100, 104, 104, 104, 104]);
});

test("account replay: the balance never goes below what the realised losses allow, and matches the sum of taken trades", () => {
  const rows = [row("A", [["d1", "d2", -30], ["d3", "d4", 50]]), row("B", [["d1", "d5", 20]])];
  const r = replayAccount(rows, 1000, 100, days);
  assert.equal(r.skipped, 0);
  assert.equal(r.equity[4], 1000 - 30 + 50 + 20);
});

test("account replay: a buy bigger than the balance is never taken", () => {
  const r = replayAccount([row("A", [["d1", "d2", 5]])], 50, 100, days);
  assert.equal(r.taken, 0); assert.equal(r.skipped, 1); assert.deepEqual(r.equity, [50, 50, 50, 50, 50]);
});

import { bollinger } from "../lib/swing/engine.js";
const wobble = (n, base = 100) => Array.from({ length: n }, (_, i) => base + 0.6 * Math.sin(i * 0.9));
const bbCfg = (o = {}) => cfgOf({ strategy: "bollinger", trendFilter: false, ...o });

test("bollinger bands: flat prices give zero-width bands; bands never use future prices", () => {
  const flat = bollinger(Array(30).fill(50), 20, 2);
  assert.equal(flat.upper[25], 50); assert.equal(flat.lower[25], 50); assert.equal(flat.mid[18], null);
  const a = bollinger(wobble(40), 20, 2), b = bollinger([...wobble(30), 5, 500, 5, 500], 20, 2);
  assert.equal(a.lower[29], b.lower[29]);
  assert.ok(a.upper[30] > a.mid[30] && a.lower[30] < a.mid[30]);
});

test("bollinger: buys the close below the lower band at the NEXT open, sells back at the average", () => {
  const closes = [...wobble(260), 95, 97, 99, 100.5, 101, 101, 101, 101];
  const bars = mk(closes);
  const { trades } = backtestDaily("X", bars, bbCfg({ slippageBps: 10 }));
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.setup, "bollinger");
  assert.equal(t.date, bars[261].date);                              // signal day 260, buy day 261
  assert.ok(Math.abs(t.entry - bars[261].o * 1.001) < 0.01);
  assert.equal(t.exitReason, "signal");
  assert.ok(t.exit > t.entry && t.netR > 0);
});

test("bollinger: the cautious entry waits for a close back above the lower band, so it buys later and dearer", () => {
  const closes = [...wobble(260), 92, 91, 95, 99, 100.5, 101, 101, 101, 101];
  const bars = mk(closes);
  const plain = backtestDaily("X", bars, bbCfg()).trades[0];
  const cautious = backtestDaily("X", bars, bbCfg({ bollinger: { entry: "reclaim" } })).trades[0];
  assert.ok(plain && cautious);
  assert.ok(cautious.date > plain.date && cautious.entry > plain.entry);
});

test("bollinger: exiting at the upper band holds longer than exiting at the average; both use the same entry", () => {
  const closes = [...wobble(260), 95, 96, 98, 100, 102, 104, 106, 108, 110, 112, 112, 112, 112];
  const bars = mk(closes);
  const mid = backtestDaily("X", bars, bbCfg({ bollinger: { exitFrac: 0 } })).trades[0];
  const half = backtestDaily("X", bars, bbCfg({ bollinger: { exitFrac: 0.5 } })).trades[0];
  const up = backtestDaily("X", bars, bbCfg({ bollinger: { exitFrac: 1 } })).trades[0];
  assert.equal(mid.date, up.date);
  assert.ok(mid.holdBars <= half.holdBars && half.holdBars <= up.holdBars && mid.holdBars < up.holdBars, `${mid.holdBars}/${half.holdBars}/${up.holdBars}`);
});

test("bollinger: the time limit and the stop still protect a dip that keeps sliding", () => {
  const stuck = backtestDaily("X", mk([...wobble(260), 95, ...Array(30).fill(95)]), bbCfg({ bollinger: { maxHold: 5 } })).trades[0];
  assert.equal(stuck.exitReason, "time");
  const crash = mk([...wobble(260), 95, 94, 93, 92, 91, 90], { 262: { l: 70 } });
  const t = backtestDaily("X", crash, bbCfg()).trades[0];
  assert.ok(["stop", "stop-gap"].includes(t.exitReason) && t.netR < 0);
});

test("bollinger: the trend filter blocks it in a downtrend", () => {
  const down = Array.from({ length: 260 }, (_, i) => 200 - 0.3 * i + 0.6 * Math.sin(i * 0.9));
  const closes = [...down, down[259] - 6, down[259] - 6, down[259] - 3, down[259]];
  assert.equal(backtestDaily("X", mk(closes), bbCfg({ trendFilter: true })).trades.length, 0);
  assert.ok(backtestDaily("X", mk(closes), bbCfg({ trendFilter: false })).trades.length >= 1);
});

// ---- shorting (Bollinger only) ----
const shortCfg = (o = {}) => bbCfg({ ...o, bollinger: { allowShort: true, ...(o.bollinger || {}) } });
const spikeDay = (extra = [105, 103, 101, 99.5, 99, 99, 99]) => [...wobble(260), ...extra];

test("shorting is off by default: a spike above the upper band does nothing", () => {
  assert.equal(backtestDaily("X", mk(spikeDay()), bbCfg()).trades.length, 0);
});

test("short: sells at the NEXT open (slippage makes the sale a little cheaper), buys back at the average, and profits from the fall", () => {
  const bars = mk(spikeDay());
  const t = backtestDaily("X", bars, shortCfg({ slippageBps: 10 })).trades[0];
  assert.equal(t.side, "short");
  assert.equal(t.date, bars[261].date);                              // signal at day 260's close, sold short at day 261's open
  assert.ok(Math.abs(t.entry - bars[261].o * 0.999) < 0.01);         // sold 10 bps worse than the open
  assert.ok(t.stop > t.entry);                                       // the stop sits ABOVE a short
  assert.equal(t.exitReason, "signal");
  assert.ok(t.exit < t.entry && t.pnl > 0 && t.netR > 0 && t.netR < t.grossR);
  assert.ok(t.exit > bars[t.holdBars + 260].o * 0.99);              // covering costs a little extra, not less
});

test("short: a rally through the stop exits at the stop for about -1R; a gap above it is worse than -1R", () => {
  const rally = [105, 106, 107, 108, 109, 110, 115, 120];
  const t = backtestDaily("X", mk(spikeDay(rally)), shortCfg()).trades[0];
  assert.ok(["stop", "stop-gap"].includes(t.exitReason) && t.netR < 0);
  const climb = mk(spikeDay([105, 106, 108, 109, 110]), { 263: { l: 105, h: 140, c: 109 } });
  const s = backtestDaily("X", climb, shortCfg()).trades[0];
  assert.equal(s.exitReason, "stop");
  assert.ok(Math.abs(s.exit - s.stop) < 0.01 && s.netR < 0 && s.netR > -1.05);
  const gapped = mk(spikeDay([105, 106, 108, 109, 110]), { 263: { o: 140, h: 142, l: 138, c: 139 } });
  const g = backtestDaily("X", gapped, shortCfg()).trades[0];
  assert.equal(g.exitReason, "stop-gap");
  assert.ok(g.exit > g.stop && g.netR < -1);
});

test("short: the borrow fee is charged per calendar day, reduces P&L and R, and longs never pay it", () => {
  const closes = spikeDay([105, 105, 105, 105, 105, 105, 105, 105]);
  const free = backtestDaily("X", mk(closes), shortCfg({ borrowPct: 0, bollinger: { maxHold: 6 } })).trades[0];
  const paid = backtestDaily("X", mk(closes), shortCfg({ borrowPct: 36.5, bollinger: { maxHold: 6 } })).trades[0];
  assert.equal(free.borrow, 0);
  assert.ok(paid.borrow > 0);
  assert.ok(Math.abs(free.pnl - paid.pnl - paid.borrow) < 0.01);      // the fee is exactly the difference
  assert.ok(Math.abs(paid.borrow - paid.shares * paid.entry * 0.365 * (paid.holdBars - 1) / 365) < 0.05); // 36.5% a year, one day per day held here (test days are consecutive)
  assert.ok(paid.netR < free.netR);
  const long = backtestDaily("X", mk([...wobble(260), 95, 97, 99, 100.5, 101, 101]), shortCfg({ borrowPct: 36.5 })).trades[0];
  assert.equal(long.side, "long"); assert.equal(long.borrow, 0);
});

test("short: day-by-day P&L adds up exactly to the trade P&L, with slippage and borrow fees", () => {
  const closes = [...spikeDay([105, 106, 104, 103, 101, 99.5, 99]), ...wobble(5), 95, 97, 99, 100.5, 101, 101];
  const { trades, daily } = backtestDaily("X", mk(closes), shortCfg({ slippageBps: 10, borrowPct: 8 }));
  assert.ok(trades.some((t) => t.side === "short") && trades.some((t) => t.side === "long"));
  const a = trades.reduce((s, t) => s + t.pnl, 0), b = Object.values(daily).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`);
});

test("short safeguards mirror the long ones: downtrend only, and only while the market is down", () => {
  // after a long, steady rise a spike above the band happens ABOVE the 200-day average: with the trend filter on, no short
  const up = Array.from({ length: 260 }, (_, i) => 100 + 0.3 * i + 0.6 * Math.sin(i * 0.9));
  const topped = [...up, up[259] + 8, up[259] + 7, up[259] + 4, up[259]];
  assert.equal(backtestDaily("X", mk(topped), shortCfg({ trendFilter: true })).trades.length, 0);
  assert.ok(backtestDaily("X", mk(topped), shortCfg({ trendFilter: false })).trades.length >= 1);
  // in a downtrend the same spike is allowed
  const down = Array.from({ length: 260 }, (_, i) => 200 - 0.3 * i + 0.6 * Math.sin(i * 0.9));
  const bounce = [...down, down[259] + 8, down[259] + 7, down[259] + 4, down[259]];
  assert.ok(backtestDaily("X", mk(bounce), shortCfg({ trendFilter: true })).trades.some((t) => t.side === "short"));
  // market filter: no shorts while the market is up, shorts allowed while it is down
  const bars = mk(bounce);
  const marketUp = new Map(bars.map((b) => [b.date, true])), marketDown = new Map(bars.map((b) => [b.date, false]));
  assert.equal(backtestDaily("X", bars, shortCfg({ trendFilter: true, marketFilter: true }), marketUp).trades.length, 0);
  assert.ok(backtestDaily("X", bars, shortCfg({ trendFilter: true, marketFilter: true }), marketDown).trades.length >= 1);
});

test("short: the cautious entry waits for a close back below the upper band; exits run mid < half < lower band", () => {
  const closes = [...wobble(260), 108, 109, 105, 100, 98, 96, 94, 92, 90, 88, 88, 88];
  const bars = mk(closes);
  const plain = backtestDaily("X", bars, shortCfg()).trades[0];
  const cautious = backtestDaily("X", bars, shortCfg({ bollinger: { entry: "reclaim" } })).trades[0];
  assert.ok(plain && cautious && cautious.date > plain.date && cautious.entry < plain.entry);   // later, and sold lower
  const h = (f) => backtestDaily("X", bars, shortCfg({ bollinger: { exitFrac: f } })).trades[0].holdBars;
  assert.ok(h(0) <= h(0.5) && h(0.5) <= h(1) && h(0) < h(1), `${h(0)}/${h(0.5)}/${h(1)}`);
});

test("turning shorting on never changes the long trades", () => {
  const closes = [...wobble(260), 95, 97, 99, 100.5, 101, 101, 101, 101];
  const off = backtestDaily("X", mk(closes), bbCfg()).trades;
  const on = backtestDaily("X", mk(closes), shortCfg()).trades.filter((t) => t.side === "long");
  assert.deepEqual(on, off.map((t) => ({ ...t })));
});

test("swingStats splits longs and shorts, and borrow fees add up", () => {
  const closes = [...spikeDay([105, 103, 101, 99.5, 99, 99, 99]), ...wobble(6), 95, 97, 99, 100.5, 101, 101];
  const trades = backtestDaily("X", mk(closes), shortCfg({ borrowPct: 12 })).trades;
  const c = swingStats(trades);
  assert.equal(c.bySide.long.trades + c.bySide.short.trades, trades.length);
  assert.ok(Math.abs(c.bySide.short.borrow - trades.filter((t) => t.side === "short").reduce((s, t) => s + t.borrow, 0)) < 0.01);
  assert.ok(Math.abs(c.bySide.long.pnl + c.bySide.short.pnl - trades.reduce((s, t) => s + t.pnl, 0)) < 0.01);
});

// ---------------------------------------------------------------- parking idle cash
import { replayPark, maxDrawdown } from "../public/swing-account.js";
const mkTrade = (symbol, date, exitDate, pnl) => ({ symbol, date, exitDate, pnl });
const DAYS = ["d1", "d2", "d3", "d4", "d5", "d6"];

test("replayPark with no growth matches replayAccount's balance", () => {
  const rows = [{ trades: [mkTrade("AAA", "d1", "d3", 5), mkTrade("BBB", "d2", "d5", -2), mkTrade("CCC", "d2", "d2", 1)] }];
  const a = replayAccount(rows, 300, 100, DAYS);
  const p = replayPark(rows, 300, 100, DAYS, DAYS.map(() => 1));
  assert.deepEqual(p.equity.map((x) => +x.toFixed(9)), a.equity.map((x) => +x.toFixed(9)));
  assert.equal(p.taken, a.taken); assert.equal(p.skipped, a.skipped);
});

test("replayPark: parked money grows, funds a buy, and returns with the profit", () => {
  const g = [1, 1.1, 1, 1, 1, 1];                       // parked money +10% on day 2
  const rows = [{ trades: [mkTrade("AAA", "d2", "d4", 10)] }];
  const p = replayPark(rows, 1000, 100, DAYS, g);
  assert.equal(p.park[0], 1000);
  assert.ok(Math.abs(p.park[1] - 1000) < 1e-9, "1000*1.1 = 1100 minus the 100 bought");
  assert.deepEqual(p.held[1], [["AAA", 100]]); assert.deepEqual(p.held[2], [["AAA", 100]]); assert.deepEqual(p.held[3], []);
  assert.ok(Math.abs(p.equity[1] - 1100) < 1e-9, "total is parked plus stock at cost");
  assert.ok(Math.abs(p.park[3] - 1110) < 1e-9, "sold: 100 + 10 back into parked money");
  assert.ok(Math.abs(p.equity[5] - 1110) < 1e-9);
});

test("replayPark: skips a signal only when parked money cannot cover it", () => {
  const rows = [{ trades: [mkTrade("AAA", "d1", "d4", 0), mkTrade("BBB", "d1", "d4", 0), mkTrade("CCC", "d1", "d4", 0)] }];
  const p = replayPark(rows, 250, 100, DAYS, DAYS.map(() => 1));
  assert.equal(p.taken, 2); assert.equal(p.skipped, 1); assert.equal(p.maxOpen, 2);
  assert.ok(Math.abs(p.park[0] - 50) < 1e-9);
});

test("replayPark: a loss moves money out of the parked pile; stocks and parked always add to total", () => {
  const rows = [{ trades: [mkTrade("AAA", "d1", "d3", -20), mkTrade("BBB", "d2", "d6", 30)] }];
  const g = [1.01, 0.98, 1.02, 1, 1.03, 1];
  const p = replayPark(rows, 500, 100, DAYS, g);
  p.equity.forEach((e, i) => assert.ok(Math.abs(e - (p.park[i] + p.held[i].reduce((s, h) => s + h[1], 0))) < 1e-9));
});

test("replayPark: percent sizing takes that share of the portfolio and scales profit", () => {
  // trade profit is stated for $100; a 10% position of a $2,000 portfolio is $200, so the profit doubles
  const rows = [{ trades: [{ symbol: "AAA", date: "d2", exitDate: "d4", pnl: 5, shares: 2, entry: 50, exit: 52.5, netR: 1 }] }];
  const p = replayPark(rows, 2000, 100, DAYS, DAYS.map(() => 1), { pct: 10, base: 100 });
  assert.deepEqual(p.held[1], [["AAA", 200]]);
  assert.equal(p.takenList[0].size, 200); assert.equal(p.takenList[0].pnl, 10); assert.equal(p.takenList[0].shares, 4);
  assert.ok(Math.abs(p.equity[5] - 2010) < 1e-9);
  assert.equal(rows[0].trades[0].pnl, 5, "the original trade is left alone");
});

test("replayPark: percent sizing compounds with the portfolio and scales losses too", () => {
  const rows = [{ trades: [
    { symbol: "AAA", date: "d1", exitDate: "d2", pnl: 10, shares: 1, entry: 100, exit: 110 },   // +10% on $100
    { symbol: "BBB", date: "d3", exitDate: "d4", pnl: -10, shares: 1, entry: 100, exit: 90 },
  ] }];
  const p = replayPark(rows, 1000, 100, DAYS, DAYS.map(() => 1), { pct: 50, base: 100 });
  assert.equal(p.takenList[0].size, 500);               // 50% of 1,000
  assert.equal(p.takenList[0].pnl, 50);                 // +10% of 500
  assert.equal(p.takenList[1].size, 525);               // 50% of the 1,050 now
  assert.ok(Math.abs(p.takenList[1].pnl + 52.5) < 1e-9);
  assert.ok(Math.abs(p.equity[5] - 997.5) < 1e-9);
});

test("replayPark: fixed size with a different base scales profit (changing dollars after a run)", () => {
  const rows = [{ trades: [{ symbol: "AAA", date: "d1", exitDate: "d2", pnl: 4, shares: 1, entry: 100, exit: 104 }] }];
  const p = replayPark(rows, 1000, 300, DAYS, DAYS.map(() => 1), { base: 100 });   // run with $100, now $300 per buy
  assert.equal(p.takenList[0].pnl, 12);
});

test("maxDrawdown finds the deepest fall from a peak", () => {
  const m = maxDrawdown([100, 120, 90, 110, 130, 104, 125]);
  assert.ok(Math.abs(m.dd - (90 / 120 - 1)) < 1e-12 || Math.abs(m.dd - (104 / 130 - 1)) < 1e-12);
  assert.equal(maxDrawdown([100, 101, 102]).dd, 0);
  const n = maxDrawdown([100, 150, 60]); assert.equal(n.from, 1); assert.equal(n.to, 2); assert.ok(Math.abs(n.dd + 0.6) < 1e-12);
});
