// Run with:  node --test
// Synthetic-data tests for the Day Trade Lab engine (no network needed).
import test from "node:test";
import assert from "node:assert/strict";
import { makeConfig } from "../lib/daytrade/config.js";
import { toSessions, noiseBefore, relVolAt } from "../lib/daytrade/sessions.js";
import { buildPlan, RiskGuard, checkOrder } from "../lib/daytrade/risk.js";
import { backtestSymbol, runSession, scanLatest, summarize, compactStats } from "../lib/daytrade/backtest.js";
import { decide, execute } from "../lib/daytrade/executor.js";
import { DryRunBroker, RobinhoodMcpBroker } from "../lib/daytrade/broker.js";
import { configFor, isCrypto, profileFor, CRYPTO } from "../lib/daytrade/markets.js";

// ---- helpers: build a flat-ish day of 78 five-minute bars with scripted overrides ------
const DAY0 = Date.UTC(2026, 0, 5, 14, 30) / 1000; // 9:30 ET in January (UTC-5) = 14:30 UTC

function makeDay(dayIndex, base, script = {}) {
  const t0 = DAY0 + dayIndex * 86400;
  const bars = { t: [], open: [], high: [], low: [], close: [], volume: [] };
  let prev = base;
  for (let i = 0; i < 78; i++) {
    const s = script[i] || {};
    const o = s.o ?? prev;
    const c = s.c ?? o;
    const h = s.h ?? Math.max(o, c) + 0.1;
    const l = s.l ?? Math.min(o, c) - 0.1;
    bars.t.push(t0 + i * 300);
    bars.open.push(o); bars.high.push(h); bars.low.push(l); bars.close.push(c);
    bars.volume.push(s.v ?? 1000);
    prev = c;
  }
  return bars;
}
function concat(...days) {
  const out = { t: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const d of days) for (const k of Object.keys(out)) out[k].push(...d[k]);
  return out;
}

// An opening range of 100.0-100.5, then a breakout bar (index 3 = 9:45) on 4x volume,
// then whatever `after` scripts for later bars. The entry fills at 100.8 with the stop at
// the range low (100.0), so risk is 0.8 and the 2R target is 102.4.
function orbDay(dayIndex, after = {}) {
  const script = {
    0: { o: 100, c: 100.2, h: 100.5, l: 100.0 },
    1: { o: 100.2, c: 100.1, h: 100.4, l: 100.0 },
    2: { o: 100.1, c: 100.3, h: 100.4, l: 100.0 },
    3: { o: 100.3, c: 100.8, h: 100.9, l: 100.3, v: 4000 }, // breakout close above 100.5
    4: { o: 100.8, c: 100.8, h: 100.9, l: 100.7 },          // fills here
    ...after,
  };
  return makeDay(dayIndex, 100, script);
}

const cfg = makeConfig({ equity: 10000, riskPct: 1, slippageBps: 0, setups: { vwap: { enabled: false } } });

test("toSessions groups by exchange date and keeps regular hours", () => {
  const sessions = toSessions(concat(makeDay(0, 100), makeDay(1, 100)));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].bars.length, 78);
  assert.equal(sessions[0].bars[0].min, 570);
  assert.ok(sessions[0].bars[10].vwap > 0);
});

test("ORB breakout fills at the next open and hits the 2R target", () => {
  // entry 100.8, stop = OR low 100.0 -> risk 0.8 -> target 102.4
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1, { 6: { o: 100.8, c: 102.6, h: 102.7, l: 100.7 } })));
  const { trades } = backtestSymbol("TEST", sessions, { ...cfg, minRiskNoise: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, "target");
  assert.ok(Math.abs(trades[0].netR - 2) < 0.01, `netR was ${trades[0].netR}`);
});

test("stop is assumed to hit first when a bar touches both stop and target", () => {
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1, { 6: { o: 100.8, c: 100.8, h: 105, l: 99 } })));
  const { trades } = backtestSymbol("TEST", sessions, { ...cfg, minRiskNoise: 0 });
  assert.equal(trades[0].exitReason, "stop");
  assert.ok(trades[0].netR < -0.99);
});

test("slippage turns a 2R winner into something smaller (cost drag is visible)", () => {
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1, { 6: { o: 100.8, c: 102.6, h: 102.7, l: 100.7 } })));
  const { trades } = backtestSymbol("TEST", sessions, { ...cfg, slippageBps: 20, minRiskNoise: 0 });
  assert.ok(trades[0].netR < trades[0].grossR);
  const s = summarize(trades);
  assert.ok(s.costDragR > 0);
});

test("an open position is flattened at the flatten time", () => {
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1)));
  const { trades } = backtestSymbol("TEST", sessions, { ...cfg, minRiskNoise: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, "time");
});

test("a gap below the stop exits at the open, not at the stop price", () => {
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1, { 6: { o: 98, c: 98, h: 98.2, l: 97.8 } })));
  const { trades } = backtestSymbol("TEST", sessions, { ...cfg, minRiskNoise: 0 });
  assert.equal(trades[0].exitReason, "stop-gap");
  assert.ok(trades[0].netR < -1);
});

test("RiskGuard enforces the daily loss limit and trade count", () => {
  const g = new RiskGuard(makeConfig({ maxDailyLossR: 2, maxTradesPerDay: 5, maxConsecutiveLosses: 9 }));
  g.reset("2026-01-06");
  assert.equal(g.canOpen("2026-01-06", 600).ok, true);
  g.recordOpen(); g.recordClose(-1);
  g.recordOpen(); g.recordClose(-1.1);
  assert.equal(g.canOpen("2026-01-06", 600).ok, false);
  g.reset("2026-01-07");
  assert.equal(g.canOpen("2026-01-07", 600).ok, true);
  assert.equal(g.canOpen("2026-01-07", 900).ok, false, "past the entry cutoff");
});

test("buildPlan sizes by risk and rejects absurd stops", () => {
  const c = makeConfig({ equity: 10000, riskPct: 1 });
  const ok = buildPlan({ setup: "orb", stopRef: 99 }, 100, null, c);
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.shares, 100);              // $100 risk / $1 per share
  assert.equal(ok.plan.target, 102);              // 2R
  assert.equal(buildPlan({ setup: "orb", stopRef: 101 }, 100, null, c).ok, false);   // stop above entry
  assert.equal(buildPlan({ setup: "orb", stopRef: 90 }, 100, null, c).ok, false);    // 10% stop
});

test("checkOrder blocks off-list symbols, market orders and unprotected entries", () => {
  const c = makeConfig({ universe: ["SPY"] });
  const good = { symbol: "SPY", side: "buy", qty: 10, type: "limit", limitPrice: 100, stopPrice: 99 };
  assert.equal(checkOrder(good, c).ok, true);
  assert.equal(checkOrder({ ...good, symbol: "GME" }, c).ok, false);
  assert.equal(checkOrder({ ...good, type: "market" }, c).ok, false);
  assert.equal(checkOrder({ ...good, stopPrice: undefined }, c).ok, false);
  assert.equal(checkOrder({ ...good, qty: 1e6 }, c).ok, false);
});

test("decide() enters on the last closed bar and the dry-run broker records it", async () => {
  const c = makeConfig({ universe: ["TEST"], slippageBps: 0, minRiskNoise: 0, setups: { vwap: { enabled: false } } });
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1)));
  const today = sessions[1];
  const nowSec = today.bars[3].t + 300 + 5; // just after the breakout bar closed
  const guard = new RiskGuard(c);
  guard.reset(today.date);
  const actions = decide({ symbol: "TEST", sessions, positions: [], guard, cfg: c, nowSec, minNow: 585 });
  assert.equal(actions[0].type, "ENTER");
  assert.ok(actions[0].order.stopPrice < actions[0].order.limitPrice);

  const broker = new DryRunBroker();
  await execute(actions, broker, guard);
  assert.equal((await broker.getPositions()).length, 1);
  assert.equal(guard.trades, 1);
});

test("decide() flattens an open position at the flatten time", () => {
  const c = makeConfig({ universe: ["TEST"] });
  const sessions = toSessions(concat(makeDay(0, 100), makeDay(1, 100)));
  const guard = new RiskGuard(c);
  const a = decide({ symbol: "TEST", sessions, positions: [{ symbol: "TEST", qty: 5 }], guard, cfg: c, nowSec: 0, minNow: 950 });
  assert.equal(a[0].type, "FLATTEN");
});

test("RobinhoodMcpBroker refuses to do anything until explicitly enabled and configured", async () => {
  const off = new RobinhoodMcpBroker({ callTool: async () => ({}) });
  await assert.rejects(() => off.getAccount(), /disabled/);
  const noNames = new RobinhoodMcpBroker({ callTool: async () => ({}), liveEnabled: true });
  await assert.rejects(() => noNames.getAccount(), /not configured/);
});

test("summarize reports expectancy, drawdown and a small-sample warning", () => {
  const mk = (netR, i) => ({ netR, grossR: netR + 0.05, pnl: netR * 50, exitTime: i, date: "d", setup: "orb", exitReason: "stop", holdBars: 4 });
  const s = summarize([mk(2, 1), mk(-1, 2), mk(-1, 3), mk(2, 4)]);
  assert.equal(s.trades, 4);
  assert.ok(Math.abs(s.expectancyNetR - 0.5) < 1e-9);
  assert.ok(Math.abs(s.maxDrawdownR - 2) < 1e-9);
  assert.ok(s.sampleWarning);
  assert.ok(Math.abs(s.costDragR - 0.05) < 1e-9);
});

test("scanLatest ignores the 5-minute bar that is still forming", () => {
  const c = makeConfig({ slippageBps: 0, minRiskNoise: 0, setups: { vwap: { enabled: false } } });
  const sessions = toSessions(concat(makeDay(0, 100), orbDay(1)));
  const today = sessions[1].date;
  sessions[1].bars = sessions[1].bars.slice(0, 4); // 9:30-9:45 bars; the 9:45 breakout bar is last
  const t3 = sessions[1].bars[3].t;
  const forming = scanLatest("TEST", sessions, c, today, t3 + 100);
  assert.equal(forming.state, "waiting");
  const closed = scanLatest("TEST", sessions, c, today, t3 + 305);
  assert.equal(closed.state, "signal");
  assert.ok(closed.plan.stop < closed.plan.entry);
});


// ---- crypto (24/7, UTC-day sessions, fractional units) ---------------------------------
const CRYPTO_DAY0 = Date.UTC(2026, 0, 5, 0, 0) / 1000; // 00:00 UTC
function makeCryptoDay(dayIndex, base, script = {}) {
  const t0 = CRYPTO_DAY0 + dayIndex * 86400;
  const bars = { t: [], open: [], high: [], low: [], close: [], volume: [] };
  let prev = base;
  for (let i = 0; i < 288; i++) {
    const s = script[i] || {};
    const o = s.o ?? prev, c = s.c ?? o;
    bars.t.push(t0 + i * 300);
    bars.open.push(o); bars.close.push(c);
    bars.high.push(s.h ?? Math.max(o, c) + 0.1);
    bars.low.push(s.l ?? Math.min(o, c) - 0.1);
    bars.volume.push(s.v ?? 1000);
    prev = c;
  }
  return bars;
}
const cryptoSessions = (...days) => {
  const p = profileFor("BTC-USD");
  return toSessions(concat(...days), p.tz, p.minBars, p.openMin, p.closeMin);
};

test("crypto symbols are recognised and the picker's five are all crypto", () => {
  assert.equal(isCrypto("BTC-USD"), true);
  assert.equal(isCrypto("BRK-B"), false);
  assert.equal(isCrypto("SPY"), false);
  assert.equal(CRYPTO.length, 5);
  assert.ok(CRYPTO.every((c) => isCrypto(c.symbol)));
});

test("configFor leaves stocks alone and re-times crypto", () => {
  const base = makeConfig({});
  const stock = configFor(base, "AAPL", 10);
  assert.equal(stock.flattenMin, base.flattenMin);
  assert.equal(stock.slippageBps, base.slippageBps);
  assert.equal(stock.fractional, undefined);
  const c = configFor(base, "BTC-USD", 15);
  assert.equal(c.openMin, 0);
  assert.equal(c.fractional, true);
  assert.equal(c.slippageBps, 15);
  assert.equal(c.flattenMin, 1425);
  assert.ok(c.setups.orb.orMinutes >= 60);
  assert.equal(base.setups.orb.orMinutes, 15, "the original config must not be mutated");
});

test("crypto sessions are whole UTC days", () => {
  const sessions = cryptoSessions(makeCryptoDay(0, 100), makeCryptoDay(1, 100));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].bars.length, 288);
  assert.equal(sessions[0].bars[0].min, 0);
  assert.equal(sessions[1].date, "2026-01-06");
});

test("buildPlan sizes fractional units for crypto and checkOrder accepts them", () => {
  const c = configFor(makeConfig({ equity: 10000, riskPct: 1, universe: ["BTC-USD"] }), "BTC-USD", 0);
  const r = buildPlan({ setup: "orb", stopRef: 99000 }, 100000, null, { ...c, maxRiskPct: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.plan.shares > 0 && r.plan.shares < 1, `units were ${r.plan.shares}`); // 0.1 BTC max by notional
  const order = { symbol: "BTC-USD", side: "buy", qty: r.plan.shares, type: "limit", limitPrice: 100000, stopPrice: 99000 };
  assert.equal(checkOrder(order, c).ok, true);
  // the same order is refused for a stock config (whole shares only)
  const stockCfg = makeConfig({ universe: ["BTC-USD"] });
  assert.equal(checkOrder(order, stockCfg).ok, false);
});

test("an ORB breakout works on a 24/7 crypto day and trades a fractional size", () => {
  const range = {};
  for (let i = 0; i < 12; i++) range[i] = { o: 100.2, c: 100.2, h: 100.5, l: 100.0 };   // first hour: 100.0-100.5
  const script = {
    ...range,
    12: { o: 100.2, c: 100.8, h: 100.9, l: 100.2, v: 4000 },   // breakout close
    13: { o: 100.8, c: 100.8, h: 100.9, l: 100.7 },            // fills here
    15: { o: 100.8, c: 102.6, h: 102.7, l: 100.7 },            // hits the 2R target (102.4)
  };
  const sessions = cryptoSessions(makeCryptoDay(0, 100), makeCryptoDay(1, 100, script));
  const base = makeConfig({ equity: 10000, riskPct: 1, universe: ["BTC-USD"], setups: { vwap: { enabled: false } } });
  const cfg = configFor(base, "BTC-USD", 0);
  const { trades } = backtestSymbol("BTC-USD", sessions, cfg);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, "target");
  assert.ok(Math.abs(trades[0].netR - 2) < 0.01, `netR was ${trades[0].netR}`);
  assert.ok(!Number.isInteger(trades[0].shares), `shares were ${trades[0].shares}`);
});

test("the live crypto day is not treated as finished", () => {
  const sessions = cryptoSessions(makeCryptoDay(0, 100), makeCryptoDay(1, 100));
  sessions[1].bars = sessions[1].bars.slice(0, 100);                  // up to ~08:15 UTC
  const cfg = configFor(makeConfig({}), "BTC-USD", 10);
  const r = scanLatest("BTC-USD", sessions, cfg, sessions[1].date, sessions[1].bars[99].t + 400);
  assert.equal(r.live, true);
});

test("noiseBefore needs prior sessions", () => {
  const sessions = toSessions(concat(makeDay(0, 100), makeDay(1, 100)));
  assert.equal(noiseBefore(sessions, 0), null);
  assert.ok(noiseBefore(sessions, 1) > 0);
  void runSession; // exported for the scanner
});


// ---------------------------------------------------------------- pattern setups, filters, measured exit
// Bull flag: bars 3-8 rise 99.9 -> 103.0 (the pole), bars 9-11 pull back to 102.3 on light volume
// (the flag), bar 12 closes at 103.3 above the flag high 103.0 on 3000 volume. Entry fills at 103.3
// (bar 13 open); the stop is 102.25, so risk is 1.05 and the pole height 3.1 is about 2.95R.
function flagDay(dayIndex, over = {}) {
  const script = {};
  const closes = [100.4, 100.9, 101.4, 101.9, 102.4, 102.9];
  closes.forEach((c, k) => { script[3 + k] = { o: k ? closes[k - 1] : 100, c, v: 2000 }; });
  script[9] = { o: 102.9, c: 102.6, v: 500 };
  script[10] = { o: 102.6, c: 102.4, v: 500 };
  script[11] = { o: 102.4, c: 102.5, v: 500 };
  script[12] = { o: 102.5, c: 103.3, h: 103.4, l: 102.5, v: 3000 };
  script[13] = { o: 103.3, c: 103.3, h: 103.35, l: 103.2 };
  script[14] = { o: 103.3, c: 105.5, h: 105.6, l: 103.3 };   // reaches 2R (105.4) but not the measured move
  return makeDay(dayIndex, 100, { ...script, ...over });
}
const patCfg = (extra = {}) => makeConfig({
  equity: 10000, riskPct: 1, slippageBps: 0, maxRiskPct: 2,
  setups: { orb: { enabled: false }, vwap: { enabled: false }, flag: { enabled: true }, triangle: { enabled: true } },
  ...extra,
});
const run2 = (day, c, mk = null) => backtestSymbol("T", toSessions(concat(makeDay(0, 100), day)), c, mk).trades;

test("bull flag: buys the breakout above the pullback, stop under the flag", () => {
  const [t] = run2(flagDay(1), patCfg());
  assert.equal(t.setup, "flag");
  assert.ok(Math.abs(t.entry - 103.3) < 0.01, `entry ${t.entry}`);
  assert.ok(Math.abs(t.stop - 102.25) < 0.01, `stop ${t.stop}`);
  assert.equal(t.exitReason, "target");
  assert.ok(Math.abs(t.target - (103.3 + 2 * 1.05)) < 0.02, `target ${t.target}`);
});

test("bull flag: measured exit aims for the pole height instead of 2R", () => {
  const [t] = run2(flagDay(1), patCfg({ exit: "measured" }));
  assert.ok(Math.abs(t.target - (103.3 + 3.1)) < 0.05, `target ${t.target}`);
  assert.notEqual(t.exitReason, "target"); // bar 14 only reaches 105.6
});

test("bull flag: a deep pullback (more than half the pole) is not a flag", () => {
  const day = flagDay(1, { 10: { o: 102.6, c: 101.0, v: 500 } });
  assert.equal(run2(day, patCfg()).length, 0);
});

test("bull flag: a flag on heavier volume than the pole is rejected", () => {
  const day = flagDay(1, { 9: { o: 102.9, c: 102.6, v: 9000 }, 10: { o: 102.6, c: 102.4, v: 9000 }, 11: { o: 102.4, c: 102.5, v: 9000 } });
  assert.equal(run2(day, patCfg()).length, 0);
});

// Ascending triangle: ceiling 101.0 touched at bars 4 and 19, lows rising 99.5 -> 100.0 -> 100.3,
// breakout close at 101.3 on bar 24.
function triDay(dayIndex, over = {}) {
  const script = {};
  for (let k = 0; k < 24; k++) script[k] = { o: 100.5, c: 100.5 };
  script[2] = { o: 100.5, c: 100.5, l: 99.5 };
  script[4] = { o: 100.5, c: 100.5, h: 101.0 };
  script[10] = { o: 100.5, c: 100.5, l: 100.0 };
  script[18] = { o: 100.5, c: 100.5, l: 100.3 };
  script[19] = { o: 100.5, c: 100.5, h: 101.0 };
  script[24] = { o: 100.5, c: 101.3, h: 101.4, l: 100.5, v: 3000 };
  script[25] = { o: 101.3, c: 101.3, h: 101.35, l: 101.2 };
  script[26] = { o: 101.3, c: 102.9, h: 103.0, l: 101.3 };   // above the measured target (102.8), below 2R (103.4)
  return makeDay(dayIndex, 100, { ...script, ...over });
}

test("ascending triangle: buys the breakout above the ceiling", () => {
  const [t] = run2(triDay(1), patCfg());
  assert.equal(t.setup, "triangle");
  assert.ok(Math.abs(t.entry - 101.3) < 0.01);
  assert.ok(Math.abs(t.stop - 100.25) < 0.01, `stop ${t.stop}`);
  assert.notEqual(t.exitReason, "target"); // 2R target is 103.4
  const [m] = run2(triDay(1), patCfg({ exit: "measured" }));
  assert.equal(m.exitReason, "target");    // measured target 102.8 is reached
});

test("ascending triangle: falling lows are not a triangle", () => {
  const day = triDay(1, { 10: { o: 100.5, c: 100.5, l: 99.0 }, 18: { o: 100.5, c: 100.5, l: 99.2 } });
  assert.equal(run2(day, patCfg()).length, 0);
});

test("new setups are off unless switched on", () => {
  const c = makeConfig({ equity: 10000, riskPct: 1, slippageBps: 0, maxRiskPct: 2, setups: { orb: { enabled: false }, vwap: { enabled: false } } });
  assert.equal(run2(flagDay(1), c).length, 0);
  assert.equal(run2(triDay(1), c).length, 0);
});

test("market filter: no trade while SPY is below VWAP, trade when above", () => {
  const f = patCfg({ filters: { market: true } });
  assert.equal(run2(flagDay(1), f, () => false).length, 0);
  assert.equal(run2(flagDay(1), f, () => true).length, 1);
});

test("relative volume only uses bars up to the current one", () => {
  const sessions = toSessions(concat(makeDay(0, 100), makeDay(1, 100, { 3: { v: 3000 }, 4: { v: 3000 }, 5: { v: 3000 } })));
  assert.equal(relVolAt(sessions, 1, 1), null);                    // too early to know
  assert.ok(Math.abs(relVolAt(sessions, 1, 2) - 1) < 1e-9);        // bars 0-2 are normal
  assert.ok(Math.abs(relVolAt(sessions, 1, 5) - 2) < 1e-9);        // (3x1000 + 3x3000) / 6000
});

test("in-play filter blocks a setup when early volume is ordinary", () => {
  assert.equal(run2(flagDay(1), patCfg({ filters: { inPlay: true, minRelVol: 1.2 } })).length, 1); // 1.5x
  assert.equal(run2(flagDay(1), patCfg({ filters: { inPlay: true, minRelVol: 2 } })).length, 0);
});

test("compactStats are exact, addable totals that agree with summarize", () => {
  const trades = [...run2(flagDay(1), patCfg()), ...run2(triDay(1), patCfg())];
  assert.equal(trades.length, 2);
  const [a, b] = [compactStats([trades[0]]), compactStats([trades[1]])];
  const both = compactStats(trades);
  const full = summarize(trades);
  assert.equal(both.trades, a.trades + b.trades);
  assert.ok(Math.abs(both.sumNetR - (a.sumNetR + b.sumNetR)) < 0.01);
  assert.ok(Math.abs(both.sumNetR / both.trades - full.expectancyNetR) < 0.001);
  assert.ok(Math.abs(both.pnl - full.totalPnl) < 0.01);
  assert.equal(both.wins / both.trades, full.winRate);
});

// ---------------------------------------------------------------- fixed dollars per buy
test("fixed dollars per buy: same dollar amount every time, as fractional shares", () => {
  const c = patCfg({ dollarsPerTrade: 50 });
  const [t] = run2(flagDay(1), c);
  assert.ok(t.shares > 0 && !Number.isInteger(t.shares), `shares ${t.shares}`);
  assert.ok(Math.abs(t.shares * t.entry - 50) < 0.001, `spent ${t.shares * t.entry}`);
  // P&L is shares x (exit - entry), so it scales with the amount spent
  assert.ok(Math.abs(t.pnl - t.shares * (t.exit - t.entry)) < 0.01);
  const [big] = run2(flagDay(1), patCfg({ dollarsPerTrade: 100 }));
  assert.ok(Math.abs(big.pnl / t.pnl - 2) < 0.01);
  assert.ok(Math.abs(big.netR - t.netR) < 1e-9); // R is per share, so it does not change
});

test("fixed dollars per buy: capped by the account, ignores the risk percentage", () => {
  const sig = { setup: "orb", stopRef: 100 };
  const small = buildPlan(sig, 100.8, 0.2, makeConfig({ equity: 1000, dollarsPerTrade: 5000, riskPct: 0.1 }));
  assert.ok(small.ok);
  assert.ok(small.plan.notional <= 1000 + 1e-6, `notional ${small.plan.notional}`);
  const a = buildPlan(sig, 100.8, 0.2, makeConfig({ equity: 10000, dollarsPerTrade: 25, riskPct: 0.1 }));
  const b = buildPlan(sig, 100.8, 0.2, makeConfig({ equity: 10000, dollarsPerTrade: 25, riskPct: 2 }));
  assert.equal(a.plan.shares, b.plan.shares);
});

test("fixed dollars per buy: leaving it at 0 keeps whole-share risk sizing", () => {
  const r = buildPlan({ setup: "orb", stopRef: 100 }, 100.8, 0.2, makeConfig({ equity: 10000, riskPct: 0.5 }));
  assert.ok(Number.isInteger(r.plan.shares));
});

test("fixed dollars per buy: checkOrder accepts fractional stock quantities only in that mode", () => {
  const order = { symbol: "SPY", side: "buy", qty: 0.25, type: "limit", limitPrice: 500, stopPrice: 495 };
  assert.equal(checkOrder(order, makeConfig({ equity: 10000 })).ok, false);
  assert.equal(checkOrder(order, makeConfig({ equity: 10000, dollarsPerTrade: 125 })).ok, true);
});

// ---------------------------------------------------------------- more setups, partial exit, midday
const only = (name, extra = {}) => makeConfig({
  equity: 10000, riskPct: 1, slippageBps: 0, maxRiskPct: 3,
  setups: { orb: { enabled: false }, vwap: { enabled: false }, [name]: { enabled: true } },
  ...extra,
});

// Pullback: a steady climb (0.1 a bar), a dip at bars 30-31 that tests the 20-bar average, then a green
// bar 32 that closes above the 9-bar average and the last high on 2x volume. Fills at bar 33's open.
function pullbackDay(dayIndex, over = {}) {
  const script = {};
  for (let k = 0; k < 30; k++) script[k] = { o: 100 + 0.1 * k, c: 100 + 0.1 * (k + 1) };
  script[30] = { o: 103.0, c: 102.4, h: 103.0, l: 101.9 };
  script[31] = { o: 102.4, c: 102.3, h: 102.5, l: 102.2 };
  script[32] = { o: 102.3, c: 103.0, h: 103.1, l: 102.3, v: 2000 };
  script[33] = { o: 103.0, c: 103.0, h: 103.1, l: 102.9 };
  script[34] = { o: 103.0, c: 105.6, h: 105.8, l: 103.0 };
  return makeDay(dayIndex, 100, { ...script, ...over });
}

test("pullback: buys the resumption after a dip to the 20-bar average, stop under the dip", () => {
  const trades = run2(pullbackDay(1), only("pullback"));
  assert.ok(trades.length >= 1, "expected a pullback trade");
  const t = trades[0];
  assert.equal(t.setup, "pullback");
  assert.ok(t.stop < 102.0 && t.stop > 101.5, `stop ${t.stop}`);
});

test("pullback: a straight-up climb with no dip is not a pullback", () => {
  const script = {};
  for (let k = 0; k < 50; k++) script[k] = { o: 100 + 0.1 * k, c: 100 + 0.1 * (k + 1), v: k === 32 ? 2000 : 1000 };
  assert.equal(run2(makeDay(1, 100, script), only("pullback")).length, 0);
});

// Fibonacci: a 3.2 up-move (bars 3-14), a pullback to about 50% (bars 15-19), a green confirming bar 20.
function fibDay(dayIndex, over = {}) {
  const script = {};
  for (let k = 0; k < 12; k++) script[3 + k] = { o: 100 + 0.25 * k, c: 100 + 0.25 * (k + 1) };    // 100 -> 103
  script[14] = { o: 102.75, c: 103.0, h: 103.1, l: 102.7 };
  [102.7, 102.3, 102.0, 101.7, 101.6].forEach((c, k) => { script[15 + k] = { o: k ? [102.7, 102.3, 102.0, 101.7][k - 1] : 103.0, c, h: (k ? [102.7, 102.3, 102.0, 101.7][k - 1] : 103.0) + 0.05, l: c - 0.1 }; });
  script[20] = { o: 101.6, c: 102.0, h: 102.1, l: 101.5, v: 2000 };
  script[21] = { o: 102.0, c: 102.0, h: 102.1, l: 101.9 };
  script[22] = { o: 102.0, c: 103.6, h: 103.7, l: 102.0 };
  return makeDay(dayIndex, 100, { ...script, ...over });
}

test("fib: buys a 38-62% pullback of a clear up-move, stop under the 78.6% level", () => {
  const [t] = run2(fibDay(1), only("fib"));
  assert.ok(t, "expected a fib trade");
  assert.equal(t.setup, "fib");
  assert.ok(t.stop > 100.3 && t.stop < 100.8, `stop ${t.stop}`);
});

test("fib: a pullback that falls back below the start of the move is not a fib setup", () => {
  const day = fibDay(1, { 18: { o: 102.0, c: 99.5, l: 99.4 }, 19: { o: 99.5, c: 99.8 } });
  assert.equal(run2(day, only("fib")).length, 0);
});

// Double bottom: lows of 98.0 (bar 10) and 98.1 (bar 22) with a rally to 100.0 between, then a close above 100.0.
function dbDay(dayIndex, over = {}) {
  const script = {};
  const path = [[3, 99.6], [4, 99.2], [5, 98.8], [6, 98.5], [7, 98.3], [8, 98.2], [9, 98.15], [10, 98.1],
    [11, 98.6], [12, 99.0], [13, 99.4], [14, 99.7], [15, 99.8], [16, 99.7],
    [17, 99.4], [18, 99.0], [19, 98.7], [20, 98.4], [21, 98.3], [22, 98.2],
    [23, 98.7], [24, 99.2], [25, 99.6]];
  let prev = 100;
  for (const [k, c] of path) { script[k] = { o: prev, c, h: Math.max(prev, c) + 0.1, l: Math.min(prev, c) - 0.1 }; prev = c; }
  script[10] = { o: 98.15, c: 98.1, h: 98.25, l: 98.0 };
  script[22] = { o: 98.3, c: 98.2, h: 98.4, l: 98.1 };
  script[16] = { o: 99.8, c: 99.7, h: 100.0, l: 99.6 };
  script[26] = { o: 99.6, c: 100.5, h: 100.6, l: 99.6, v: 3000 };
  script[27] = { o: 100.5, c: 100.5, h: 100.6, l: 100.4 };
  return makeDay(dayIndex, 100, { ...script, ...over });
}

test("double bottom: buys the close above the middle peak, stop under the lows", () => {
  const [t] = run2(dbDay(1), only("dbottom"));
  assert.ok(t, "expected a double-bottom trade");
  assert.equal(t.setup, "dbottom");
  assert.ok(t.stop < 98.0 && t.stop > 97.8, `stop ${t.stop}`);
});

test("double bottom: lows that are not equal are not a double bottom", () => {
  const day = dbDay(1, { 22: { o: 97.5, c: 97.2, h: 97.6, l: 96.8 }, 21: { o: 98.3, c: 97.5, h: 98.3, l: 97.4 }, 23: { o: 97.2, c: 98.7, h: 98.8, l: 97.2 } });
  assert.equal(run2(day, only("dbottom")).length, 0);
});

// Gap and go: opens 3% above the previous close (100), holds, breaks the first 15-minute high at bar 3.
function gapDay(dayIndex, base = 103) {
  return makeDay(dayIndex, base, {
    0: { o: base, c: base + 0.2, h: base + 0.5, l: base },
    1: { o: base + 0.2, c: base + 0.1, h: base + 0.4, l: base },
    2: { o: base + 0.1, c: base + 0.3, h: base + 0.4, l: base },
    3: { o: base + 0.3, c: base + 0.9, h: base + 1.0, l: base + 0.3, v: 4000 },
    4: { o: base + 0.9, c: base + 0.9, h: base + 1.0, l: base + 0.8 },
  });
}
const gapDays = (day) => toSessions(concat(makeDay(0, 100), day));

test("gap and go: trades a gap that holds, labelled as 'gap'", () => {
  const c = makeConfig({ equity: 10000, riskPct: 1, slippageBps: 0, maxRiskPct: 3, setups: { orb: { enabled: true }, vwap: { enabled: false }, gap: { enabled: true } } });
  const [t] = backtestSymbol("T", gapDays(gapDay(1)), c).trades;
  assert.equal(t.setup, "gap");
});

test("gap and go: no gap, no trade (the plain breakout is still the opening-range setup)", () => {
  const c = makeConfig({ equity: 10000, riskPct: 1, slippageBps: 0, maxRiskPct: 3, setups: { orb: { enabled: false }, vwap: { enabled: false }, gap: { enabled: true } } });
  assert.equal(backtestSymbol("T", gapDays(gapDay(1, 100)), c).trades.length, 0);
});

test("gap and go: a gap that has already filled (range low under yesterday's close) is skipped", () => {
  const c = makeConfig({ equity: 10000, riskPct: 1, slippageBps: 0, maxRiskPct: 8, setups: { orb: { enabled: false }, vwap: { enabled: false }, gap: { enabled: true } } });
  const day = makeDay(1, 103, {
    0: { o: 103, c: 101, h: 103.1, l: 99.5 }, 1: { o: 101, c: 101.2, h: 101.4, l: 100.9 }, 2: { o: 101.2, c: 101.3, h: 101.5, l: 101.0 },
    3: { o: 101.3, c: 103.4, h: 103.5, l: 101.3, v: 4000 }, 4: { o: 103.4, c: 103.4 },
  });
  assert.equal(backtestSymbol("T", gapDays(day), c).trades.length, 0);
});

// ---- partial exit: sell half at +1R, then the stop on the rest moves to breakeven
test("partial exit: half at 1R and half at the 2R target = +1.5R in total", () => {
  const [t] = run2(flagDay(1), patCfg({ partial: { enabled: true } }));
  assert.ok(t.partial, "expected a partial exit");
  assert.ok(Math.abs(t.partial.price - (103.3 + 1.05)) < 0.02);
  assert.ok(Math.abs(t.netR - 1.5) < 0.02, `netR ${t.netR}`);
  assert.equal(t.exitReason, "target");
});

test("partial exit: after the half is sold, a drop back to entry costs nothing (+0.5R in total)", () => {
  const day = flagDay(1, {
    14: { o: 103.3, c: 104.4, h: 104.5, l: 103.3 },
    15: { o: 104.4, c: 103.3, h: 104.4, l: 103.2 },
  });
  const [t] = run2(day, patCfg({ partial: { enabled: true } }));
  assert.ok(Math.abs(t.netR - 0.5) < 0.03, `netR ${t.netR}`);
  assert.equal(t.exitReason, "stop");
  const [plain] = run2(day, patCfg());
  assert.ok(plain.holdBars > t.holdBars, "without the breakeven stop the trade is still open after the dip");
});

test("partial exit: P&L and shares add up (sold shares at 1R plus the rest at the exit)", () => {
  const [t] = run2(flagDay(1), patCfg({ partial: { enabled: true } }));
  const rest = t.shares - t.partial.shares;
  const expected = t.partial.shares * (t.partial.price - t.entry) + rest * (t.target - t.entry);
  assert.ok(Math.abs(t.pnl - expected) < 0.05, `${t.pnl} vs ${expected}`);
});

// ---- midday lull
test("avoid midday: blocks entries between 11:30 and 14:00 ET, allows them otherwise", () => {
  // the triangle breakout signal is on bar 24 = 11:30 ET
  assert.equal(run2(triDay(1), patCfg({ avoidMidday: false })).length, 1);
  assert.equal(run2(triDay(1), patCfg({ avoidMidday: true })).length, 0);
  // the flag breakout is at 10:30 ET, outside the lull
  assert.equal(run2(flagDay(1), patCfg({ avoidMidday: true })).length, 1);
});

test("crypto ignores the midday lull and the gap setup", () => {
  const c = configFor(makeConfig({ avoidMidday: true, setups: { gap: { enabled: true } } }), "BTC-USD");
  assert.equal(c.avoidMidday, false);
  assert.equal(c.setups.gap.enabled, false);
});
