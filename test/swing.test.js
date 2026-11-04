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
