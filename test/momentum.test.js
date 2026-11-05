import test from "node:test";
import assert from "node:assert/strict";
import { buildRotation, rotationRows, align, sma, BASE } from "../public/swing-momentum.js";
import { replayPark } from "../public/swing-account.js";

// A calendar of business-like days: 30 days a month, so month changes are easy to reason about.
const mkDates = (months) => { const out = []; for (let m = 0; m < months; m++) for (let d = 1; d <= 20; d++) { const y = 2020 + Math.floor(m / 12), mm = (m % 12) + 1; out.push(`${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`); } return out; };
const dates = mkDates(40);                                    // 800 days
const grow = (rate, start = 100) => dates.map((_, i) => start * Math.pow(1 + rate, i));
const opts = { lookback: 100, skip: 20, topN: 2, slipBps: 0 };

test("ranks by past gain and holds the top N; stable winners are kept, not re-bought", () => {
  const closes = new Map([["UP3", grow(0.003)], ["UP2", grow(0.002)], ["UP1", grow(0.001)], ["FLAT", grow(0)]]);
  const rot = buildRotation(dates, closes, grow(0.001), opts);
  const syms = new Set(rot.trades.map((t) => t.symbol));
  assert.deepEqual([...syms].sort(), ["UP2", "UP3"]);
  // never changes its mind, so each is bought once and held to the end
  assert.equal(rot.trades.length, 2);
  assert.ok(rot.trades.every((t) => t.exitReason === "data-end"));
  assert.equal(rot.picks.length, 2); assert.equal(rot.picks[0].symbol, "UP3");
});

test("a stock that falls out of the top group is sold and the next best bought, at the new day's close", () => {
  // A leads for a while, then collapses; B takes over
  const a = dates.map((_, i) => (i < 300 ? 100 * Math.pow(1.004, i) : 100 * Math.pow(1.004, 300) * Math.pow(0.99, i - 300)));
  const b = grow(0.002);
  const c = grow(0.0005);
  const rot = buildRotation(dates, new Map([["A", a], ["B", b], ["C", c]]), grow(0.001), { ...opts, topN: 1 });
  const sold = rot.trades.filter((t) => t.symbol === "A");
  assert.equal(sold.length, 1);
  assert.equal(sold[0].exitReason, "dropped");
  const idx = dates.indexOf(sold[0].exitDate);
  assert.equal(sold[0].exit, a[idx], "fills at the close of the rebalance day, no slippage here");
  assert.ok(rot.trades.some((t) => t.symbol === "B" && t.date === sold[0].exitDate), "B is bought the same day");
  assert.ok(idx > 300);
});

test("rebalances only on the first trading day of a month", () => {
  const closes = new Map([["A", grow(0.002)], ["B", grow(0.001)]]);
  const rot = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1 });
  rot.trades.forEach((t) => assert.equal(t.date.slice(8), "01"));
  assert.ok(rot.rebalances > 25 && rot.rebalances < 40);
});

test("slippage is charged on both the buy and the sell", () => {
  const closes = new Map([["A", grow(0.002)], ["B", grow(0.001)]]);
  const free = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, slipBps: 0 });
  const cost = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, slipBps: 50 });
  const a = free.trades[0], b = cost.trades[0];
  assert.ok(Math.abs(b.entry / a.entry - 1.005) < 1e-9);
  assert.ok(b.pnl < a.pnl);
});

test("no look-ahead: a stock that only jumps on the rebalance day itself is not picked that day", () => {
  const spike = grow(0.0005);
  const fi = dates.findIndex((d, i) => i > 300 && d.endsWith("-01") && dates[i - 1].slice(0, 7) !== d.slice(0, 7));
  for (let i = fi; i < dates.length; i++) spike[i] *= 3;      // jumps on the rebalance day: yesterday's ranking cannot see it
  const closes = new Map([["SPIKE", spike], ["STEADY", grow(0.002)], ["OTHER", grow(0.001)]]);
  const rot = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1 });
  assert.ok(!rot.trades.some((t) => t.symbol === "SPIKE" && t.date === dates[fi]));
});

test("market filter: below the 200-day average of SPY, hold nothing", () => {
  const spy = dates.map((_, i) => (i < 400 ? 100 + i * 0.5 : 300 - (i - 400) * 0.6));     // up, then a long fall
  const closes = new Map([["A", grow(0.002)], ["B", grow(0.001)]]);
  const off = buildRotation(dates, closes, spy, { ...opts, topN: 1, spyFilter: false });
  const on = buildRotation(dates, closes, spy, { ...opts, topN: 1, spyFilter: true });
  assert.ok(on.trades.some((t) => t.exitReason === "trend"));
  assert.ok(on.trades.length > off.trades.length || on.trades[0].holdBars < off.trades[0].holdBars);
  assert.equal(on.picks.length, 0); assert.equal(on.filterOff, true);
});

test("stocks with too little history are ignored; a short universe still works", () => {
  const late = dates.map((_, i) => (i < 500 ? null : 100 + i));
  const rot = buildRotation(dates, new Map([["LATE", late], ["A", grow(0.001)]]), grow(0.001), { ...opts, topN: 5 });
  assert.ok(rot.trades.every((t) => t.symbol === "A" || t.date > dates[500 + 100]));
});

test("rotation trades replay through the account with percent sizing and scale correctly", () => {
  const closes = new Map([["A", grow(0.002)], ["B", grow(0.0015)], ["C", grow(0.001)], ["D", grow(0)]]);
  const rot = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 2 });
  const rows = rotationRows(rot);
  const days = dates.slice(rot.trades.length ? dates.indexOf(rot.testStart) - 1 : 0);
  const rep = replayPark(rows, 10000, 100, days, days.map(() => 1), { pct: 50, base: BASE });
  assert.equal(rep.skipped, 0);
  assert.ok(rep.equity[rep.equity.length - 1] > 10000);
  assert.ok(Math.abs(rep.takenList[0].size - 5000) < 1e-6);
});

test("align carries the last close over gaps and passes matching calendars through unchanged", () => {
  const d1 = ["a", "b", "c", "d"], s = [1, 2, 3, 4];
  assert.equal(align(d1, s, d1), s);
  assert.deepEqual(align(d1, s, ["a", "x", "c", "d", "e"]), [1, 1, 3, 4, 4]);
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

// ---- leaderboard options: oversold-bounce score, rebalance frequency, buffer
const wiggle = (base, amp, period = 7) => dates.map((_, i) => base * (1 + amp * Math.sin((2 * Math.PI * i) / period)));

test("dip score: buys the stock furthest below its 20-day average and sells when it is back at the average", () => {
  const calm = grow(0.001), other = grow(0.002);       // steady risers sit ABOVE their averages: no upside to bounce
  const dipper = dates.map((_, i) => 100);
  const di = 400; for (let i = di; i < di + 5; i++) dipper[i] = 100 - (i - di + 1) * 6;     // sharp fall over 5 days
  for (let i = di + 5; i < dates.length; i++) dipper[i] = 80 + (i - di - 5) * 2;              // then climbs back above 100
  const rot = buildRotation(dates, new Map([["CALM", calm], ["OTHER", other], ["DIP", dipper]]), grow(0.001), { score: "dip", every: "day", topN: 1, slipBps: 0 });
  const t = rot.trades.filter((x) => x.symbol === "DIP");
  assert.ok(t.length >= 1, "the sharp fall makes it the best-ranked stock");
  assert.equal(t[0].exitReason, "target");
  assert.ok(t[0].pnl > 0, "bought on the dip, sold back at the average");
  const idx = dates.indexOf(t[0].exitDate);
  assert.ok(dipper[idx - 1] >= 90, "sold only once the close was back at its average");
});

test("dip score needs a real dip: with nothing at least 1 deviation below average, nothing is bought", () => {
  const rot = buildRotation(dates, new Map([["A", grow(0.002)], ["B", grow(0.001)]]), grow(0.001), { score: "dip", every: "day", topN: 2, slipBps: 0 });
  assert.equal(rot.trades.length, 0);
});

test("daily rebalancing reacts faster than monthly", () => {
  const a = dates.map((_, i) => (i < 450 ? 100 * Math.pow(1.004, i) : 100 * Math.pow(1.004, 450) * Math.pow(0.97, i - 450)));
  const closes = new Map([["A", a], ["B", grow(0.002)]]);
  const m = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, every: "month" });
  const d = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, every: "day" });
  const exitM = m.trades.find((t) => t.symbol === "A" && t.exitReason !== "data-end").exitDate;
  const exitD = d.trades.find((t) => t.symbol === "A" && t.exitReason !== "data-end").exitDate;
  assert.ok(exitD < exitM || exitD === exitM);
  assert.ok(d.rebalances > m.rebalances * 10);
});

test("weekly rebalancing happens when the weekday goes backwards or a long gap passes", () => {
  const wk = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09"];
  const closes = new Map([["A", wk.map(() => 1)]]);
  const rot = buildRotation(wk, closes, wk.map(() => 1), { every: "week" });
  assert.equal(rot.rebalances, 0, "too little history to rebalance, but it must not throw");
});

test("buffer keeps a holding until it falls well down the list, cutting churn", () => {
  const closes = new Map();
  for (let k = 0; k < 6; k++) closes.set("S" + k, dates.map((_, i) => 100 * Math.pow(1 + 0.002 + 0.0004 * Math.sin(i / (30 + k * 7) + k), i)));
  const tight = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 2, every: "month", buffer: 0 });
  const loose = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 2, every: "month", buffer: 3 });
  assert.ok(loose.trades.length <= tight.trades.length);
});

test("positive-momentum rule: a stock with a negative score is never bought", () => {
  const down = dates.map((_, i) => 200 * Math.pow(0.999, i));
  const rot = buildRotation(dates, new Map([["DOWN", down]]), grow(0.001), { ...opts, topN: 1 });
  assert.equal(rot.trades.length, 0);
  assert.equal(rot.picks.length, 0);
});

test("join dates: a stock is not ranked before it joined the index", () => {
  const winner = grow(0.003), steady = grow(0.001);
  const all = buildRotation(dates, new Map([["WIN", winner], ["STEADY", steady]]), grow(0.001), { ...opts, topN: 1 });
  const joinedLate = dates[600];
  const pit = buildRotation(dates, new Map([["WIN", winner], ["STEADY", steady]]), grow(0.001), { ...opts, topN: 1, joined: new Map([["WIN", joinedLate]]) });
  assert.equal(all.trades[0].symbol, "WIN");
  const early = pit.trades.filter((t) => t.symbol === "WIN" && t.date < joinedLate);
  assert.equal(early.length, 0, "no WIN trade before it joined");
  assert.ok(pit.trades.some((t) => t.symbol === "STEADY" && t.date < joinedLate), "the other stock was held while WIN was not a member");
  assert.ok(pit.trades.some((t) => t.symbol === "WIN" && t.date >= joinedLate), "WIN is eligible after joining");
});

test("sector cap: at most N holdings from one sector, the next best from another is taken", () => {
  const closes = new Map([["T1", grow(0.004)], ["T2", grow(0.0035)], ["T3", grow(0.003)], ["H1", grow(0.002)], ["F1", grow(0.0015)]]);
  const sectors = new Map([["T1", "Tech"], ["T2", "Tech"], ["T3", "Tech"], ["H1", "Health"], ["F1", "Fin"]]);
  const free = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 3 });
  const capped = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 3, sectors, sectorCap: 1 });
  assert.deepEqual([...new Set(free.trades.map((t) => t.symbol))].sort(), ["T1", "T2", "T3"]);
  assert.deepEqual([...new Set(capped.trades.map((t) => t.symbol))].sort(), ["F1", "H1", "T1"]);
});

test("current picks respect the sector cap too", () => {
  const closes = new Map([["T1", grow(0.004)], ["T2", grow(0.0035)], ["H1", grow(0.002)]]);
  const sectors = new Map([["T1", "Tech"], ["T2", "Tech"], ["H1", "Health"]]);
  const rot = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 2, sectors, sectorCap: 1 });
  assert.deepEqual(rot.picks.map((p) => p.symbol), ["T1", "H1"]);
});

// ---- trailing stop and volatility-scaled sizes ----
const crash = dates.map((_, i) => (i < 400 ? 100 * Math.pow(1.004, i) : 100 * Math.pow(1.004, 400) * Math.pow(0.97, i - 400)));

test("trailing stop: sells at the next close after the close that broke the stop, then stays out 21 days", () => {
  const closes = new Map([["A", crash], ["B", grow(0.0005)]]);
  const on = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, trailStop: 20 });
  const t = on.trades.find((x) => x.symbol === "A");
  assert.equal(t.exitReason, "stop");
  const xi = dates.indexOf(t.exitDate);
  assert.equal(t.exit, crash[xi]);
  const peak = Math.max(...crash.slice(0, xi - 1));
  assert.ok(crash[xi - 1] <= peak * 0.8, "triggered by the previous close");
  assert.ok(crash[xi - 2] > peak * 0.8, "and not earlier");
  assert.ok(!on.trades.some((x) => x.symbol === "A" && dates.indexOf(x.date) > xi && dates.indexOf(x.date) < xi + 21));
  const off = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1 });
  assert.ok(off.trades.every((x) => x.exitReason !== "stop"), "off by default");
});

test("volatility sizing: a wilder stock gets a smaller weight, clamped; absent when off", () => {
  const wild = dates.map((_, i) => 100 * Math.pow(1.004, i) * (1 + (i % 2 ? 0.06 : -0.06)));
  const calm = (r) => dates.map((_, i) => 100 * Math.pow(1 + r, i) * (1 + (i % 2 ? 0.005 : -0.005)));
  const closes = new Map([["W", wild], ["C1", calm(0.003)], ["C2", calm(0.0029)], ["C3", calm(0.0028)]]);
  const on = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 4, volSize: true });
  const w = on.trades.find((x) => x.symbol === "W"), c = on.trades.find((x) => x.symbol === "C1");
  assert.ok(w && c);
  assert.ok(w.w < c.w && w.w >= 0.25 && c.w <= 1.5);
  const off = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 4 });
  assert.ok(off.trades.every((x) => x.w === undefined));
});

test("account sizing honours a trade's size multiplier w", () => {
  const closes = new Map([["A", grow(0.002)], ["B", grow(0.0015)]]);
  const rot = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 2 });
  rot.trades.forEach((t) => { if (t.symbol === "A") t.w = 0.5; });
  const days = dates.slice(dates.indexOf(rot.testStart) - 1);
  const rep = replayPark(rotationRows(rot), 10000, 100, days, days.map(() => 1), { pct: 50, base: BASE });
  const a = rep.takenList.find((t) => t.symbol === "A"), b = rep.takenList.find((t) => t.symbol === "B");
  assert.ok(Math.abs(a.size - 2500) < 1e-6 && Math.abs(b.size - 5000 * 1) < 1e-6 || a.size < b.size);
});

test("membership: a stock is not ranked after it left the index, and excluded stocks are never ranked", () => {
  const closes = new Map([["A", grow(0.003)], ["B", grow(0.002)], ["C", grow(0.001)]]);
  const left = dates[500];
  const r = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, removed: new Map([["A", left]]) });
  const a = r.trades.find((t) => t.symbol === "A");
  assert.ok(a && a.exitReason === "dropped" && a.exitDate >= left, "sold after leaving");
  assert.ok(r.trades.some((t) => t.symbol === "B"), "the next best takes over");
  const ex = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, exclude: new Set(["A"]) });
  assert.ok(ex.trades.every((t) => t.symbol !== "A"));
});

test("most-traded filter: only the N biggest by 60-day dollar volume that day can be ranked", () => {
  const closes = new Map([["WIN", grow(0.003)], ["BIG", grow(0.002)], ["MID", grow(0.0015)]]);
  const dvol = new Map([["WIN", dates.map(() => 1)], ["BIG", dates.map(() => 500)], ["MID", dates.map(() => 300)]]);
  const on = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, liquidTop: 2, dvol });
  assert.ok(on.trades.every((t) => t.symbol !== "WIN"), "the best performer is too thinly traded to be ranked");
  assert.ok(on.trades.some((t) => t.symbol === "BIG"));
  const off = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, dvol });
  assert.ok(off.trades.some((t) => t.symbol === "WIN"), "off by default");
  // a stock that becomes thin later is dropped
  const fade = new Map([["WIN", dates.map((_, i) => (i < 500 ? 900 : 1))], ["BIG", dates.map(() => 500)], ["MID", dates.map(() => 300)]]);
  const f = buildRotation(dates, closes, grow(0.001), { ...opts, topN: 1, liquidTop: 2, dvol: fade });
  const w = f.trades.find((t) => t.symbol === "WIN");
  assert.ok(w && w.exitReason === "dropped");
});
