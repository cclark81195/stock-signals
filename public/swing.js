// Swing Lab - front end (no build step, no dependencies)
import { replayAccount, replayPark, maxDrawdown } from "./swing-account.js";
import { buildRotation, rotationRows, align } from "./swing-momentum.js";
import { makeTradeChart } from "./swing-chart.js";
import { makeMixChart } from "./swing-mix.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "-" : (x < 0 ? "−" : "") + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const price = (x) => (x == null ? "-" : x.toFixed(x < 10 ? 3 : 2));
const qty = (n) => (n == null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
const sgn = (x, d = 2) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`);
const pct0 = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "pos" : "neg");
const STRATEGY_NAMES = { meanrev: "Buy sharp dips", breakout: "Buy new highs" };
const EXIT_NAMES = { signal: "Exit signal", stop: "Stop", "stop-gap": "Gap through stop", time: "Time limit", "data-end": "Still open at the end", dropped: "Fell off the leaderboard", target: "Back at its average", trend: "Market filter (SPY below its 200-day)" };

const STORE_KEY = "swing-lab-settings";
const FIELDS = { strategy: "s-strategy", universe: "s-universe", years: "s-years", balance: "s-balance", sizeMode: "s-sizemode", sizePct: "s-sizepct", moScore: "s-moscore", moSec: "s-mosec", moEvery: "s-moevery", moBuf: "s-mobuf", moStop: "s-mostop", moLook: "s-molook", moSkip: "s-moskip", moN: "s-mon", park: "s-park", parkRate: "s-parkrate", dollars: "s-dollars", slipBps: "s-slip", stopAtr: "s-stop", rsiBuy: "s-rsi", exitSma: "s-exma", hold: "s-hold", bbLen: "s-bblen", bbK: "s-bbk", bbHold: "s-bbhold", bbEntry: "s-bbentry", bbExit: "s-bbexit", borrow: "s-borrow", entryLen: "s-elen", exitLen: "s-xlen", hold2: "s-hold2", symbols: "s-symbols" };
const CHECKS = { trend: "s-trend", mkt: "s-mkt", bbShort: "s-bbshort", moJoin: "s-mojoin", moVol: "s-movol" };
const SW_BATCH = 25, SW_PARALLEL = 2;

const sw = { stocks: [], rows: new Map(), dailyPnl: {}, bench: null, benchErr: false, failed: [], running: false, cancel: false, sort: { k: "exp", dir: -1 }, limit: 50, baseDollars: 100, isRot: false, rot: { dates: null, spy: null, closes: new Map() } };

const isRotForm = () => $("s-strategy").value === "momentum";
/** The starting balance. The rotation always runs as one account, so a blank box means $10,000 there. */
const getBalance = () => { const b = Number($("s-balance").value) || 0; return b > 0 ? b : sw.isRot ? 10000 : 0; };
const listNow = () => sw.runStocks || sw.stocks;                     // the list the results on screen were run on
const rotOpts = () => {
  const dates = new Map(listNow().filter((x) => x.added).map((x) => [x.symbol, x.added])), want = $("s-mojoin").checked;
  return {
  score: $("s-moscore").value === "dip" ? "dip" : "momentum", every: ["day", "week"].includes($("s-moevery").value) ? $("s-moevery").value : "month",
  joined: want && dates.size ? dates : null, joinNA: want && !dates.size,
  sectors: new Map(listNow().map((x) => [x.symbol, x.sector])), sectorCap: Math.min(100, Math.max(0, Math.round(Number($("s-mosec").value) || 0))),
  buffer: Math.min(50, Math.max(0, Math.round(Number($("s-mobuf").value) || 0))),
  lookback: (Number($("s-molook").value) || 12) * 21, skip: (Number($("s-moskip").value) || 0) * 21,
  topN: Math.min(100, Math.max(3, Math.round(Number($("s-mon").value) || 20))), slipBps: Math.max(0, Number($("s-slip").value) || 0), spyFilter: $("s-mkt").checked,
  trailStop: Math.min(90, Math.max(0, Number($("s-mostop").value) || 0)), volSize: $("s-movol").checked,
  };
};
/** How big each buy is: a share of the portfolio, or fixed dollars. dollars is the size for the fixed case. */
function sizing(topN) {
  if (sw.isRot) return { pct: 100 / (topN || rotOpts().topN), dollars: 100 };
  if ($("s-sizemode").value === "pct") return { pct: Math.min(100, Math.max(0.5, Number($("s-sizepct").value) || 5)), dollars: sw.baseDollars };
  return { pct: null, dollars: Number($("s-dollars").value) || sw.baseDollars };
}
const sizeText = (z) => (z.pct ? `${+z.pct.toFixed(2)}% of the portfolio per buy` : `${money(z.dollars)} per buy`);

function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { /* storage may be unavailable */ }
  if (!saved) return;
  for (const [k, id] of Object.entries(FIELDS)) if (saved[k] != null) $(id).value = saved[k];
  for (const [k, id] of Object.entries(CHECKS)) if (typeof saved[k] === "boolean") $(id).checked = saved[k];
}
function readForm() {
  const s = {};
  for (const [k, id] of Object.entries(FIELDS)) s[k] = $(id).value.trim();
  for (const [k, id] of Object.entries(CHECKS)) s[k] = $(id).checked;
  return s;
}
function saveSettings(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
function params(s) {
  const p = new URLSearchParams({ strategy: s.strategy, years: s.years, trend: s.trend ? "1" : "0", mkt: s.mkt ? "1" : "0" });
  const set = (k, v) => { if (v !== "" && v != null) p.set(k, v); };
  set("dollars", s.sizeMode === "pct" ? "100" : s.dollars); set("slipBps", s.slipBps); set("stopAtr", s.stopAtr);
  if (s.strategy === "meanrev") { set("rsiBuy", s.rsiBuy); set("exitSma", s.exitSma); set("hold", s.hold); }
  else if (s.strategy === "bollinger") { set("bbLen", s.bbLen); set("bbK", s.bbK); set("bbEntry", s.bbEntry); set("bbExit", s.bbExit); set("hold", s.bbHold); if (s.bbShort) { set("bbShort", "1"); set("borrow", s.borrow); } }
  else { set("entryLen", s.entryLen); set("exitLen", s.exitLen); set("hold", s.hold2); }
  return p;
}
function showSizing() {
  const rot = isRotForm(), pct = $("s-sizemode").value === "pct";
  $("sw-sizemode-wrap").hidden = rot; $("sw-sizepct-wrap").hidden = rot || !pct; $("sw-dollars-wrap").hidden = rot || pct;
}
function showStrategy() {
  const v = $("s-strategy").value;
  $("sw-mo").hidden = v !== "momentum"; $("sw-molook-wrap").hidden = $("s-moscore").value === "dip"; $("sw-moskip-wrap").hidden = $("s-moscore").value === "dip"; $("sw-stop-wrap").hidden = v === "momentum"; $("sw-trend-wrap").hidden = v === "momentum";
  showSizing();
  $("sw-mr").hidden = v !== "meanrev"; $("sw-bo").hidden = v !== "breakout"; $("sw-bb").hidden = v !== "bollinger"; $("sw-bbs").hidden = v !== "bollinger";
}

// ---------------------------------------------------------------- merging the per-stock totals
const sum = (list, key = "all") => {
  const t = { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, sumWinR: 0, sumLossR: 0, pnl: 0 };
  for (const r of list) { const c = r[key]; if (!c) continue; for (const k of Object.keys(t)) t[k] += c[k]; }
  return t;
};
const exp = (c) => (c && c.trades ? c.sumNetR / c.trades : null);
const pf = (c) => (c && c.sumLossR > 0 ? c.sumWinR / c.sumLossR : null);

function detail(rows) {
  const d = { stopPctSum: 0, holdBarsSum: 0, days: 0, holdPctSum: 0, byExit: {}, byYear: {}, bySide: {} };
  for (const r of rows) {
    const a = r.all;
    if (!a || !a.byExit) continue;
    d.stopPctSum += a.stopPctSum; d.holdBarsSum += a.holdBarsSum; d.days += r.days; d.holdPctSum += r.holdPct;
    for (const [k, v] of Object.entries(a.byExit)) { const e = (d.byExit[k] ||= { trades: 0, sumNetR: 0 }); e.trades += v.trades; e.sumNetR += v.sumNetR; }
    for (const [k, v] of Object.entries(a.bySide || {})) { const g = (d.bySide[k] ||= { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, pnl: 0, borrow: 0 }); for (const f of Object.keys(g)) g[f] += v[f]; }
    for (const [k, v] of Object.entries(a.byYear)) { const y = (d.byYear[k] ||= { trades: 0, wins: 0, sumNetR: 0, pnl: 0 }); for (const f of Object.keys(y)) y[f] += v[f]; }
  }
  return d;
}

function tile(label, value, sub = "", klass = "", desc = "") {
  return `<div class="dt-tile"><div class="k">${esc(label)}</div><div class="v ${klass}">${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}${desc ? `<div class="d dt-ex">${esc(desc)}</div>` : ""}</div>`;
}

function renderTiles(rows, all, first, second) {
  const total = listNow().length || rows.length;
  $("sw-tiles").innerHTML = [
    tile("Stocks tested", String(rows.length), `of ${total}`, "", "Stocks tested without an error. A stock with no trades still counts."),
    tile("Trades", all.trades.toLocaleString("en-US"), `${rows.filter((r) => r.all.trades).length} stocks traded`, "", "Total simulated trades across every stock. Thousands of trades make the average trustworthy; a few dozen do not."),
    tile("Per trade, after costs", all.trades ? `${sgn(exp(all))}R` : "-", "the number that matters", cls(exp(all)), "Average result of one trade after costs, in R (the distance from the buy price to the stop). Above zero is what you need."),
    tile("Win rate", all.trades ? pct0(all.wins / all.trades) : "-", "", "", "Share of trades that made money after costs. Dip strategies win often with small gains; trend strategies win rarely with big ones."),
    tile("Profit factor", pf(all) == null ? "-" : pf(all).toFixed(2), "above 1 means wins outweigh losses", pf(all) == null ? "" : pf(all) > 1 ? "pos" : "neg", "Money won divided by money lost."),
    tile("Total result", money(all.pnl), `${sgn(all.sumNetR, 1)}R`, cls(all.pnl), "Every trade's profit or loss added together at the dollars-per-buy you chose."),
    tile("Older half", first.trades ? `${sgn(exp(first))}R` : "-", `${first.trades} trades, per trade`, cls(exp(first)), "Per-trade result using only the older half of the tested days."),
    tile("Newer half", second.trades ? `${sgn(exp(second))}R` : "-", `${second.trades} trades, per trade`, cls(exp(second)), "Per-trade result using only the newer half. If it disagrees with the older half, treat the result as noise."),
  ].join("");
}

function renderDiag(rows, all) {
  const d = detail(rows), n = all.trades;
  if (!n) { $("sw-diag").innerHTML = ""; $("sw-years").innerHTML = ""; $("sw-exits").innerHTML = ""; return; }
  const losses = n - all.wins;
  const gross = all.sumGrossR / n, net = all.sumNetR / n;
  const stopPct = d.stopPctSum / n;
  const invested = d.days ? d.holdBarsSum / d.days : 0;
  const retPct = (all.pnl / (n * sw.baseDollars)) * 100;
  $("sw-diag").innerHTML = [
    tile("Average win", all.wins ? `+${(all.sumWinR / all.wins).toFixed(2)}R` : "-", "after costs", "pos", "The average winning trade."),
    tile("Average loss", losses ? `−${(all.sumLossR / losses).toFixed(2)}R` : "-", "after costs", "neg", "The average losing trade. Around −1R when stops work; more means gaps through the stop."),
    tile("Before costs", `${sgn(gross)}R`, "per trade, if trading were free", cls(gross), "If this is near zero or negative, the strategy has no edge to protect and cutting costs will not fix it."),
    tile("After costs", `${sgn(net)}R`, `costs take ${(gross - net).toFixed(2)}R per trade`, cls(net), "Average result per trade after slippage."),
    tile("Return per trade", `${sgn(retPct)}%`, "of the money put in", cls(retPct), "Profit or loss as a percentage of the dollars spent on each buy, averaged over all trades."),
    tile("Average stop distance", `${stopPct.toFixed(1)}%`, "of the buy price", "", "How far below the buy price the stop sat. Much wider than a day trade's, so costs take a much smaller share of each R."),
    tile("Average hold", `${(d.holdBarsSum / n).toFixed(1)} days`, "", "", "How long a trade stayed open on average."),
    tile("Time invested", `${(invested * 100).toFixed(1)}%`, "of days, per stock", "", "How often a stock was held, on average. A strategy that earns a little while invested only 5% of the time leaves 95% of your money free for something else."),
    tile("Buy & hold", `${sgn(d.holdPctSum / rows.length, 0)}%`, "average stock, whole download", "", "What simply buying each stock at the start and holding it would have returned, for comparison. Today's S&P 500 members only, so it is flattered by survivorship."),
  ].join("");

  const vsYears = new Map((sw.vs?.years || []).map((y) => [y.year, y]));
  const yearKeys = [...new Set([...Object.keys(d.byYear), ...vsYears.keys()])].sort();
  $("sw-years").innerHTML = yearKeys.map((y) => {
    const v = d.byYear[y], r = vsYears.get(y);
    const part = r?.part ? ` <span class="hint">(part year)</span>` : "";
    return `<tr><td>${esc(y)}${part}</td><td class="num">${v ? v.trades : 0}</td><td class="num">${v ? pct0(v.wins / v.trades) : "-"}</td>
      <td class="num ${cls(v?.sumNetR)}">${v ? sgn(v.sumNetR / v.trades) + "R" : "-"}</td><td class="num ${cls(v?.pnl)}">${v ? money(v.pnl) : "-"}</td>
      <td class="num ${cls(r?.strat)}">${r ? pctFmt(r.strat) : "-"}</td><td class="num ${cls(r?.spy)}">${r ? pctFmt(r.spy) : "-"}</td></tr>`;
  }).join("");
  $("sw-sidesbox").hidden = !d.bySide.short;
  $("sw-sides").innerHTML = d.bySide.short ? ["long", "short"].filter((k) => d.bySide[k]).map((k) => { const g = d.bySide[k];
    const gn = g.sumNetR / g.trades, gg = g.sumGrossR / g.trades;
    return `<tr><td>${k === "long" ? "Long (buy)" : "Short (sell, then buy back)"}</td><td class="num">${g.trades}</td><td class="num">${pct0(g.wins / g.trades)}</td>
      <td class="num ${cls(gg)}">${sgn(gg)}R</td><td class="num ${cls(gn)}">${sgn(gn)}R</td><td class="num">${k === "short" ? money(g.borrow) : "-"}</td><td class="num ${cls(g.pnl)}">${money(g.pnl)}</td></tr>`; }).join("") : "";
  const exits = Object.entries(d.byExit).sort((a, b) => b[1].trades - a[1].trades);
  $("sw-exits").innerHTML = exits.map(([k, e]) => `<tr><td>${esc(EXIT_NAMES[k] || k)}</td><td class="num">${e.trades}</td><td class="num">${pct0(e.trades / n)}</td><td class="num ${cls(e.sumNetR)}">${sgn(e.sumNetR / e.trades)}R</td></tr>`).join("");
}

// ---------------------------------------------------------------- strategy vs the S&P 500
const pctFmt = (x, d = 2) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d)}%`);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/**
 * The one-account replay shared by the comparison and both charts: starts with the balance, parks the money that is not
 * in a trade (SPY, a yearly rate, or plain cash), funds each signal from it. null without a starting balance or SPY prices.
 */
function buildAccount(rows, over = {}) {
  const balance = getBalance();
  if (balance <= 0 || !sw.bench || !sw.bench.length || !rows.length) return null;
  const start = rows.map((r) => r.testStart).filter(Boolean).sort()[0];
  if (!start) return null;
  const i0 = Math.max(1, sw.bench.findIndex(([d]) => d >= start));
  const baseClose = sw.bench[i0 - 1][1];
  const bars = sw.bench.slice(i0);
  if (bars.length < 20) return null;
  const mode = $("s-park").value, rate = Math.max(0, Number($("s-parkrate").value) || 0) / 100;
  const growth = bars.map(([, c], i) => (mode === "spy" ? c / (i ? bars[i - 1][1] : baseClose) : mode === "rate" ? Math.pow(1 + rate, 1 / 252) : 1));
  const dayList = bars.map(([d]) => d);
  const size = sizing(over.topN);
  // the leaderboard has every stock's daily closes, so its positions are valued at market every day; the other strategies only
  // know each trade's result, so their stocks are valued at cost until sold
  let mark = null;
  if (sw.isRot && sw.rot.dates) {
    const at = new Map(sw.rot.dates.map((d, i) => [d, i]));
    mark = (t, date) => { const c = sw.rot.closes.get(t.symbol)?.[at.get(date)]; return c > 0 ? c / t.entry : 1; };
  }
  const rep = replayPark(rows, balance, size.dollars, dayList, growth, { pct: size.pct, base: sw.baseDollars, mark });
  const parkName = mode === "spy" ? "S&P 500 (SPY)" : mode === "rate" ? `Idle cash at ${(rate * 100).toFixed(1)}% a year` : "Cash";
  return { balance, mode, rate, size, marked: !!mark, bars, baseClose, dayList, rep, parkName, spyOnly: bars.map(([, c]) => (balance * c) / baseClose) };
}

/**
 * The strategy against SPY over the same days.
 *  - With a starting balance: one real account (limited cash, realised profit counted when a trade is sold, idle money parked).
 *  - Without one: every signal is taken and each stock tested gets its own slot of "dollars per buy".
 */
function computeVs(rows, acct) {
  if (!sw.bench || !sw.bench.length || !rows.length) return null;
  const start = rows.map((r) => r.testStart).filter(Boolean).sort()[0];
  if (!start) return null;
  const i0 = Math.max(1, sw.bench.findIndex(([d]) => d >= start));
  const baseClose = sw.bench[i0 - 1][1];                    // the close just before the first tested day
  const bars = sw.bench.slice(i0);
  if (bars.length < 20) return null;
  const balance = getBalance();
  const account = balance > 0;
  if (account && !acct) return null;
  const dayList = bars.map(([d]) => d);

  let strat, extra = {};
  if (account) {
    const rep = acct.rep;
    strat = rep.equity.map((e, i) => e / (i ? rep.equity[i - 1] : balance) - 1);
    const inStocks = rep.equity.map((e, i) => (e > 0 ? rep.held[i].reduce((t, h) => t + h[1], 0) / e : 0));
    const ddS = maxDrawdown([balance, ...rep.equity]), ddB = maxDrawdown([balance, ...acct.spyOnly]);
    const at = (k) => (k === 0 ? "the start" : dayList[k - 1]);
    extra = { marked: acct.marked, equity: rep.equity, taken: rep.taken, skipped: rep.skipped, maxOpen: rep.maxOpen, balance, mode: acct.mode, rate: acct.rate, size: acct.size, avgInStocks: mean(inStocks),
      ddStrat: ddS.dd, ddSpy: ddB.dd, ddFrom: at(ddS.from), ddTo: at(ddS.to), ddSpyFrom: at(ddB.from), ddSpyTo: at(ddB.to) };
  } else {
    const capital = rows.length * sw.baseDollars;
    strat = dayList.map((d) => (sw.dailyPnl[d] || 0) / capital);
    extra = { capital };
  }
  const days = bars.map(([date, c], i) => ({ date, c, spy: c / (i ? bars[i - 1][1] : baseClose) - 1, strat: strat[i] }));

  const years = new Map();
  let prevClose = baseClose;
  for (const d of days) {
    const y = d.date.slice(0, 4);
    const e = years.get(y) || { strat: account ? 1 : 0, firstDate: d.date, openClose: prevClose };
    e.strat = account ? e.strat * (1 + d.strat) : e.strat + d.strat;
    e.lastDate = d.date; e.closeC = d.c;
    years.set(y, e); prevClose = d.c;
  }
  const yr = [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([y, e]) => ({
    year: y, strat: account ? e.strat - 1 : e.strat, spy: e.closeC / e.openClose - 1,
    part: e.firstDate.slice(5) > "01-10" || e.lastDate.slice(5) < "12-20",
  }));
  const full = yr.filter((y) => !y.part);
  const basis = full.length >= 2 ? full : yr;
  const totalStrat = account ? extra.equity[extra.equity.length - 1] / balance - 1 : days.reduce((s, d) => s + d.strat, 0);
  const totalSpy = days[days.length - 1].c / baseClose - 1;
  const span = days.length / 252;
  const cagr = (t) => (1 + t > 0 ? Math.pow(1 + t, 1 / span) - 1 : -1);
  const yearsAhead = basis.filter((y) => y.strat > y.spy).length;
  // the older and newer half of the window, each as compound growth per year against SPY's: a real edge shows in both
  const halves = account ? [[0, Math.floor(days.length / 2)], [Math.floor(days.length / 2), days.length]].map(([a, b]) => {
    const grow = (key) => days.slice(a, b).reduce((p, d) => p * (1 + d[key]), 1);
    const yrs = (b - a) / 252, g = (x) => (x > 0 ? Math.pow(x, 1 / yrs) - 1 : -1);
    return { from: days[a].date, to: days[b - 1].date, strat: g(grow("strat")), spy: g(grow("spy")), edge: g(grow("strat")) - g(grow("spy")) };
  }) : [];
  
  return {
    account, yearsAhead, halves, years: yr, usedFull: basis === full, nYears: basis.length, span, start, end: days[days.length - 1].date,
    dates: dayList, spyClose: days.map((d) => d.c), baseClose, ...extra,
    avgAnnualStrat: mean(basis.map((y) => y.strat)), avgAnnualSpy: mean(basis.map((y) => y.spy)),
    avgDailyStrat: mean(days.map((d) => d.strat)), avgDailySpy: mean(days.map((d) => d.spy)),
    totalStrat, totalSpy, cagrStrat: cagr(totalStrat), cagrSpy: cagr(totalSpy),
    perDrop: extra.ddStrat < 0 ? cagr(totalStrat) / -extra.ddStrat : null, perDropSpy: extra.ddSpy < 0 ? cagr(totalSpy) / -extra.ddSpy : null,
  };
}

function renderVs(rows, acct) {
  const v = computeVs(rows, acct);
  sw.vs = v;
  const box = $("sw-vs");
  if (!v) {
    box.hidden = !sw.benchErr;
    $("sw-vs-tiles").innerHTML = "";
    $("sw-vs-note").textContent = sw.benchErr ? "The S&P 500 prices could not be loaded, so the comparison is unavailable. Run the test again to retry." : "";
    return;
  }
  box.hidden = false;
  const diff = (a, b) => (a == null || b == null ? "" : `${a - b >= 0 ? "ahead of" : "behind"} the S&P 500 by ${Math.abs((a - b) * 100).toFixed(2)} points`);
  const tiles = [];
  if (v.account) {
    const end = v.equity[v.equity.length - 1];
    tiles.push(tile("Ending balance", money(end), `S&P 500 on the same money: ${money((v.balance * v.spyClose[v.spyClose.length - 1]) / v.baseClose)}`, cls(end - v.balance),
      "What the account would hold at the end, counting a trade's profit or loss when it is sold, next to what the same starting money would be worth in SPY."));
    tiles.push(tile("Signals taken", `${v.taken.toLocaleString("en-US")}`, `${v.skipped.toLocaleString("en-US")} skipped for lack of cash; most open at once: ${v.maxOpen}`, "",
      `The account can hold at most ${v.size.pct ? Math.floor(100 / v.size.pct) : Math.floor(v.balance / v.size.dollars)} buys at a time (${v.size.pct ? "100% divided by the percent per buy" : "balance divided by dollars per buy"}). When more signals appear than that, the extra ones are skipped, so the account's results differ from the "every signal" numbers above. A bigger balance or a smaller buy size means fewer skipped signals.`));
  }
  tiles.push(
    tile("Average annual return", pctFmt(v.avgAnnualStrat), `S&P 500: ${pctFmt(v.avgAnnualSpy)}`, cls(v.avgAnnualStrat), `Average of ${v.nYears} ${v.usedFull ? "full " : ""}calendar year${v.nYears === 1 ? "" : "s"}. ${diff(v.avgAnnualStrat, v.avgAnnualSpy)}. ${v.account && v.mode !== "cash" ? "This is the return on the whole portfolio: the idle money plus the trades." : "The money is mostly idle, so this is the return on all of it, not only the part that was invested."}`),
    tile("Average daily return", pctFmt(v.avgDailyStrat, 3), `S&P 500: ${pctFmt(v.avgDailySpy, 3)}`, cls(v.avgDailyStrat), "The average return per trading day over the whole window. Multiply by about 252 for a rough yearly figure."),
    tile("Compound growth per year", pctFmt(v.cagrStrat), `S&P 500: ${pctFmt(v.cagrSpy)}`, cls(v.cagrStrat), "The whole window's total return turned into a steady yearly rate, which handles part years correctly."),
    tile("Total return", pctFmt(v.totalStrat, 1), `S&P 500: ${pctFmt(v.totalSpy, 1)}`, cls(v.totalStrat), `Over ${v.span.toFixed(1)} years, ${v.start} to ${v.end}.`),
  );
  if (v.account) {
    const edge = v.cagrStrat - v.cagrSpy, endBal = v.equity[v.equity.length - 1], spyEnd = (v.balance * v.spyClose[v.spyClose.length - 1]) / v.baseClose;
    tiles.push(
      tile("Edge over the S&P 500", `${edge >= 0 ? "+" : "−"}${Math.abs(edge * 100).toFixed(2)} pts`, "compound growth per year, portfolio minus S&P 500", cls(edge),
        v.mode === "spy" ? "Your goal in one number: how many percentage points a year the portfolio grew faster (or slower) than just holding SPY. With idle money in SPY, this is what trading on top of SPY added." : "How many percentage points a year the portfolio grew faster (or slower) than the S&P 500."),
      tile("Years ahead of the S&P 500", `${v.yearsAhead} of ${v.nYears}`, v.usedFull ? "full calendar years" : "calendar years", cls(v.yearsAhead / v.nYears - 0.5), "In how many calendar years the portfolio's return beat SPY's. Beating it consistently is more convincing than one big year."),
      tile("Ahead of SPY by", money(endBal - spyEnd), "ending balance minus the same money held in SPY", cls(endBal - spyEnd), "Dollars at the end compared with leaving the starting balance in SPY. Price only: SPY's dividends are not counted on either side."),
      tile("Worst drop", pctFmt(v.ddStrat, 1), `S&P 500: ${pctFmt(v.ddSpy, 1)}`, cls(v.ddStrat - v.ddSpy), `The biggest fall from a high point to a later low in the portfolio's value: ${v.ddFrom} to ${v.ddTo}. The S&P 500's was ${v.ddSpyFrom} to ${v.ddSpyTo}. A deeper drop than the S&P 500's means the extra return came with extra pain, and bigger positions make it deeper. ${v.marked ? "Positions are valued at each day's closing price." : "Stocks are counted at what was paid until they are sold, so unrealized losses on open positions are not included and the true drop can be deeper."}`),
      tile("Growth per unit of drop", v.perDrop == null ? "-" : v.perDrop.toFixed(2), `S&P 500: ${v.perDropSpy == null ? "-" : v.perDropSpy.toFixed(2)}`, v.perDrop == null || v.perDropSpy == null ? "" : cls(v.perDrop - v.perDropSpy), "Compound growth per year divided by the worst drop. Higher means more growth for the pain taken. Beating the S&P 500 on this, not just on growth, is the sign the edge is not simply more risk."),
      ...v.halves.map((h, k) => tile(k ? "Newer half: edge" : "Older half: edge", `${h.edge >= 0 ? "+" : "−"}${Math.abs(h.edge * 100).toFixed(1)} pts`, `${h.from} to ${h.to}`, cls(h.edge), `Growth per year minus the S&P 500's in the ${k ? "newer" : "older"} half of the window (${pctFmt(h.strat, 1)} vs ${pctFmt(h.spy, 1)}). A real edge is ahead in both halves; one that only pays in one half is probably a feature of that period.`)),
      tile("Share held in stocks", `${((v.avgInStocks || 0) * 100).toFixed(1)}%`, "of the portfolio, on average", "", "How much of the portfolio sat in trades rather than in the idle money, averaged over all days. Small numbers mean the portfolio is mostly the idle money's return."),
    );
  }
  $("sw-vs-tiles").innerHTML = tiles.join("");
  const idle = v.mode === "spy" ? "idle money held in SPY (SPY is sold to fund each buy at that day's close and bought back when the trade is sold; dividends not counted)"
    : v.mode === "rate" ? `idle money earning ${(v.rate * 100).toFixed(1)}% a year` : "idle cash earning nothing";
  $("sw-vs-note").textContent = v.account
    ? `Strategy: one account starting with ${money(v.balance)}, ${sizeText(v.size)}, profit counted when a trade is sold, ${idle}. S&P 500: the same money in SPY, price only.`
    : `Strategy: ${money(v.capital)} set aside (one ${money(sw.baseDollars)} slot per stock, every signal taken), idle cash earning nothing. S&P 500: SPY price only. Enter a starting balance above to test a single account with limited cash.`;
}

function renderCurve(curve) {
  const box = $("sw-curve");
  if (curve.length < 2) { box.innerHTML = `<p class="dt-empty">Not enough trades to draw a curve.</p>`; $("sw-curve-note").textContent = ""; return; }
  const W = 640, H = 170, pl = 44, pr = 10, pt = 10, pb = 22;
  const ys = [0, ...curve.map((p) => p.cumR)];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const step = Math.max(1, Math.ceil(curve.length / 600));
  const pts = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  const x = (i) => pl + (i / (pts.length - 1)) * (W - pl - pr);
  const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative result in R across ${curve.length} trades">
      <line class="zero" x1="${pl}" x2="${W - pr}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
      <polyline class="line" points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p.cumR).toFixed(1)}`).join(" ")}"></polyline>
      <text class="lbl" x="${pl - 6}" y="${y(hi).toFixed(1)}" text-anchor="end" dominant-baseline="hanging">${sgn(hi, 0)}R</text>
      <text class="lbl" x="${pl - 6}" y="${y(lo).toFixed(1)}" text-anchor="end">${sgn(lo, 0)}R</text>
      <text class="lbl" x="${pl}" y="${H - 5}">${esc(curve[0].date)}</text>
      <text class="lbl" x="${W - pr}" y="${H - 5}" text-anchor="end">${esc(curve[curve.length - 1].date)}</text></svg>`;
  $("sw-curve-note").textContent = `${curve.length.toLocaleString("en-US")} trades`;
}

function rowView(r) {
  const sector = (listNow().find((x) => x.symbol === r.symbol) || {}).sector || "";
  const a = r.all;
  return { symbol: r.symbol, sector, trades: a.trades, winRate: a.trades ? a.wins / a.trades : null, exp: exp(a), totalR: a.sumNetR, pnl: a.pnl,
    expFirst: exp(r.first), nFirst: r.first.trades, expSecond: exp(r.second), nSecond: r.second.trades, holdPct: r.holdPct, expGross: a.trades ? a.sumGrossR / a.trades : null };
}

function renderStocks() {
  const min = Number($("sw-min").value) || 1;
  const view = [...sw.rows.values()].map(rowView).filter((v) => v.trades >= min);
  const { k, dir } = sw.sort;
  view.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return typeof x === "string" ? dir * x.localeCompare(y) : dir * (x - y);
  });
  const half = (e, n) => (e == null ? "-" : `${sgn(e)}R <span class="hint">(${n})</span>`);
  $("sw-body").innerHTML = view.slice(0, sw.limit).map((v) => `<tr>
      <td><strong>${esc(v.symbol)}</strong></td><td class="tight">${esc(v.sector)}</td><td class="num">${v.trades}</td><td class="num">${pct0(v.winRate)}</td>
      <td class="num ${cls(v.exp)}">${sgn(v.exp)}R</td><td class="num ${cls(v.pnl)}">${money(v.pnl)}</td>
      <td class="num ${cls(v.expFirst)}">${half(v.expFirst, v.nFirst)}</td><td class="num ${cls(v.expSecond)}">${half(v.expSecond, v.nSecond)}</td>
      <td class="num ${cls(v.holdPct)}">${sgn(v.holdPct, 0)}%</td></tr>`).join("") || `<tr><td colspan="9" class="dt-empty">No stock has that many trades yet.</td></tr>`;
  $("sw-shown").textContent = `${view.length} of ${sw.rows.size} tested stocks have at least ${min} trade${min === 1 ? "" : "s"}.`;
  $("sw-more").hidden = view.length <= sw.limit;
  $("sw-more").textContent = `Show all ${view.length}`;
  document.querySelectorAll("#sw-table th.sortable").forEach((th) => th.setAttribute("aria-sort", th.dataset.k === k ? (dir > 0 ? "ascending" : "descending") : "none"));
}

function renderTrades(trades) {
  const shown = [...trades].sort((a, b) => b.exitTime - a.exitTime).slice(0, 300);
  $("sw-trades-count").textContent = `(newest ${shown.length} of ${trades.length.toLocaleString("en-US")})`;
  const rot = shown.some((t) => t.retPct != null);
  $("sw-trades").innerHTML = shown.map((t) => `<tr><td>${esc(t.date)}</td><td>${esc(t.exitDate)}</td><td><strong>${esc(t.symbol)}</strong>${t.side === "short" ? ` <span class="dt-pill err">short</span>` : ""}</td>
      <td class="num">${price(t.entry)}</td><td class="num">${price(t.exit)}</td><td class="num">${qty(t.shares)}</td><td class="num">${t.holdBars}</td>
      <td>${esc(EXIT_NAMES[t.exitReason] || t.exitReason)}</td><td class="num ${cls(t.retPct != null ? t.retPct : t.netR)}">${t.retPct != null ? sgn(t.retPct) + "%" : sgn(t.netR) + "R"}</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td></tr>`).join("");
  const pnl = shown.reduce((s, t) => s + t.pnl, 0), r = shown.reduce((s, t) => s + t.netR, 0);
  $("sw-trades-foot").innerHTML = shown.length ? `<tr><td colspan="8"><strong>Total of the ${shown.length} shown</strong></td><td class="num ${cls(r)}"><strong>${rot ? "" : sgn(r) + "R"}</strong></td><td class="num ${cls(pnl)}"><strong>${money(pnl)}</strong></td></tr>` : "";
}

const tradeChart = makeTradeChart($("sw-balcard"), { esc, money, sgn, price, qty, exitNames: EXIT_NAMES });

/** The balance chart with a marker per buy and sell. Redrawn after every batch, so it grows as the scan runs. */
function renderTradeChart(rows, all, final, acct) {
  const balance = getBalance();
  if (!all.length) { tradeChart.render([], 0); return; }
  if (balance <= 0) { tradeChart.render(all, 0, { settle: final, title: "Profit and loss, with every buy and sell (every signal, no cash limit)" }); return; }
  let takenList, spy = null, valueAt = null, title = "Account balance, with every buy and sell";
  if (acct) {
    takenList = acct.rep.takenList;
    const closes = new Map(sw.bench);
    spy = { close: (date) => (closes.has(date) ? closes.get(date) : null), base: acct.baseClose };
    if (acct.mode !== "cash") {
      const value = new Map(acct.dayList.map((d, i) => [d, acct.rep.equity[i]]));
      valueAt = (date) => (value.has(date) ? value.get(date) : null);
      title = "Portfolio value, with every buy and sell";
    }
  } else {
    const dates = [...new Set(all.flatMap((t) => [t.date, t.exitDate]))].sort();
    takenList = replayAccount(rows, balance, sw.baseDollars, dates).takenList;
  }
  tradeChart.render(takenList, balance, { spy, valueAt, settle: final, title });
}

const mixChart = makeMixChart($("sw-mixcard"), { esc, money });
function renderMix(acct) {
  if (!acct || !acct.rep.takenList.length) { mixChart.render(null); return; }
  const r = acct.rep;
  mixChart.render({ dates: acct.dayList, equity: r.equity, park: r.park, held: r.held, spyOnly: acct.spyOnly, parkName: acct.parkName });
}

function render(final = false) {
  const rows = [...sw.rows.values()];
  if (!rows.length) { $("sw-results").hidden = true; return; }
  $("sw-results").hidden = false; $("sw-results").classList.remove("rotation"); $("sw-rot").hidden = true;
  const all = sum(rows), first = sum(rows, "first"), second = sum(rows, "second");
  const acct = buildAccount(rows);
  if (final) renderVs(rows, acct);
  renderTiles(rows, all, first, second);
  renderDiag(rows, all);

  const bySector = new Map();
  for (const r of rows) {
    const sec = (listNow().find((x) => x.symbol === r.symbol) || {}).sector || "Other";
    if (!bySector.has(sec)) bySector.set(sec, []);
    bySector.get(sec).push(r);
  }
  const half = (c) => (c.trades ? `${sgn(exp(c))}R <span class="hint">(${c.trades})</span>` : "-");
  $("sw-sectors").innerHTML = [...bySector.entries()].map(([name, list]) => ({ name, n: list.length, a: sum(list), f: sum(list, "first"), s: sum(list, "second") }))
    .sort((x, y) => (exp(y.a) ?? -99) - (exp(x.a) ?? -99))
    .map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.n}</td><td class="num">${x.a.trades}</td><td class="num">${x.a.trades ? pct0(x.a.wins / x.a.trades) : "-"}</td>
      <td class="num ${cls(exp(x.a))}">${x.a.trades ? sgn(exp(x.a)) + "R" : "-"}</td><td class="num ${cls(x.a.pnl)}">${money(x.a.pnl)}</td>
      <td class="num ${cls(exp(x.f))}">${half(x.f)}</td><td class="num ${cls(exp(x.s))}">${half(x.s)}</td></tr>`).join("");

  renderStocks();
  const trades = rows.flatMap((r) => r.trades || []);
  let cum = 0;
  renderCurve([...trades].sort((a, b) => a.exitTime - b.exitTime).map((t) => { cum += t.netR; return { cumR: Math.round(cum * 100) / 100, date: t.exitDate }; }));
  renderTradeChart(rows, trades, final, acct);
  renderMix(acct);
  renderTrades(acct ? acct.rep.takenList : trades);
  const n = sw.failed.length;
  $("sw-failed").hidden = !n;
  $("sw-failed").textContent = n ? `${n} stock${n === 1 ? "" : "s"} could not be tested (usually Yahoo rate-limiting or missing data): ${sw.failed.slice(0, 40).join(", ")}${n > 40 ? ", ..." : ""}. Use "Retry failed" to try them again.` : "";
  $("sw-retry").hidden = !n || sw.running;
  $("sw-csv").hidden = false;
}

// ---------------------------------------------------------------- momentum / leaderboard rotation
/** Add one batch of aligned closes. All stocks are lined up on the first batch's calendar (SPY's). */
function ingestPrices(data) {
  const r = sw.rot;
  if (!r.dates) { r.dates = data.dates; r.spy = data.spy; }
  for (const [sym, arr] of Object.entries(data.closes || {})) r.closes.set(sym, align(data.dates, arr, r.dates));
  sw.bench = r.dates.map((d, i) => [d, r.spy[i]]);
}

function renderRotTiles(rot, rows, o, takenList) {
  const n = rot.trades.length, wins = rot.trades.filter((t) => t.pnl > 0).length;
  const avgRet = n ? rot.trades.reduce((s, t) => s + t.retPct, 0) / n : null;
  const avgHold = n ? rot.trades.reduce((s, t) => s + t.holdBars, 0) / n : null;
  const years = rot.testStart && sw.rot.dates ? (sw.rot.dates.length - sw.rot.dates.indexOf(rot.testStart)) / 252 : 0;
  const tiles = [
    tile("Stocks ranked", String(rot.universe), `${rows.length} traded`, "", "Stocks loaded and scored. A stock with too little price history is skipped until it has enough."),
    tile("Checks", rot.rebalances.toLocaleString("en-US"), { month: "monthly", week: "weekly", day: "daily" }[o.every], "", "How many times the leaderboard was checked and swapped."),
    tile("Trades", n.toLocaleString("en-US"), years ? `about ${(n / years).toFixed(0)} a year` : "", "", "Positions opened and closed. A stock that stays on the leaderboard is kept without trading, so this is much lower than the number of checks times the number of stocks."),
    tile("Win rate", n ? pct0(wins / n) : "-", "", "", "Share of positions that made money after slippage."),
    tile("Average trade", avgRet == null ? "-" : `${sgn(avgRet)}%`, "per position, after slippage", cls(avgRet), "Average percentage gain or loss of one position from buy to sell."),
    tile("Average hold", avgHold == null ? "-" : `${avgHold.toFixed(0)} days`, "", "", "How long a position was kept on average (trading days)."),
  ];
  tiles.push(tile("Index join dates", o.joined ? "Applied" : o.joinNA ? "Not available" : "Off", o.joined ? "ranked only after joining" : o.joinNA ? "this list has no join dates" : "hindsight in the stock list", o.joined ? "pos" : "neg", "With this on, a stock can only be ranked from the day it joined the S&P 500, which removes the advantage of knowing which stocks would later be added. Turn it off to see how much that hindsight was worth."));
  if (o.trailStop > 0) { const k = rot.trades.filter((t) => t.exitReason === "stop").length; tiles.push(tile("Stopped out", String(k), n ? `${pct0(k / n)} of positions` : "", "", `Positions sold because the close fell ${o.trailStop}% below the highest close since the buy. Each sale fills at the next close.`)); }
  if (o.volSize) { const ws = rot.trades.map((t) => t.w).filter((w) => w != null); const avg = ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null; tiles.push(tile("Average size", avg == null ? "-" : `${avg.toFixed(2)}x`, "vs equal weight", "", "Average of each position's size relative to the normal equal share. Below 1x means the picks were wilder than the typical stock.")); }
  if (o.spyFilter) tiles.push(tile("Market filter", rot.filterOff ? "Out of stocks" : "In stocks", "SPY vs its 200-day average", rot.filterOff ? "neg" : "pos", "With the filter on, everything is sold while SPY is below its 200-day average and the money sits in your idle-cash setting."));
  $("sw-rot-tiles").innerHTML = tiles.join("");
}

function renderPicks(rot, o) {
  const sec = (sym) => (listNow().find((x) => x.symbol === sym) || {}).sector || "";
  const label = o.score === "dip" ? "Dip below average" : "Momentum";
  $("sw-rot-note").textContent = rot.filterOff
    ? "The market filter is on and SPY is below its 200-day average, so the strategy would hold nothing right now."
    : rot.picks.length ? `Ranked on the latest close among ${rot.universe} stocks. ${o.score === "dip" ? "The score is how many standard deviations below its 20-day average each stock is." : "The score is each stock's gain over the ranking period."}`
    : "Nothing currently qualifies: no stock has a score above the minimum.";
  $("sw-rot-picks").innerHTML = rot.picks.map((p, i) => `<tr><td class="num">${i + 1}</td><td><strong>${esc(p.symbol)}</strong></td><td class="tight">${esc(sec(p.symbol))}</td>
      <td class="num pos">${o.score === "dip" ? `${p.score.toFixed(1)} dev. below` : `${sgn(p.score * 100, 1)}%`}</td><td class="num">${price(p.price)}</td></tr>`).join("") || `<tr><td colspan="5" class="dt-empty">None.</td></tr>`;
  document.querySelector("#sw-rot thead th:nth-child(4)").textContent = label;
}

function renderRotYears(takenList) {
  const by = new Map();
  for (const t of takenList) { const y = t.date.slice(0, 4); const e = by.get(y) || { n: 0, w: 0, pnl: 0 }; e.n++; if (t.pnl > 0) e.w++; e.pnl += t.pnl; by.set(y, e); }
  const vsYears = new Map((sw.vs?.years || []).map((y) => [y.year, y]));
  const keys = [...new Set([...by.keys(), ...vsYears.keys()])].sort();
  $("sw-years").innerHTML = keys.map((y) => {
    const v = by.get(y), r = vsYears.get(y);
    return `<tr><td>${esc(y)}${r?.part ? ` <span class="hint">(part year)</span>` : ""}</td><td class="num">${v ? v.n : 0}</td><td class="num">${v ? pct0(v.w / v.n) : "-"}</td><td class="num">-</td>
      <td class="num ${cls(v?.pnl)}">${v ? money(v.pnl) : "-"}</td><td class="num ${cls(r?.strat)}">${r ? pctFmt(r.strat) : "-"}</td><td class="num ${cls(r?.spy)}">${r ? pctFmt(r.spy) : "-"}</td></tr>`;
  }).join("");
}

function renderRotation(final = false) {
  const r = sw.rot;
  if (!r.dates || !r.closes.size) { $("sw-results").hidden = true; return; }
  $("sw-results").hidden = false; $("sw-results").classList.add("rotation"); $("sw-rot").hidden = false; $("sw-sidesbox").hidden = true;
  const o = rotOpts();
  const rot = buildRotation(r.dates, r.closes, r.spy, o);
  sw.rotResult = rot;
  const rows = rotationRows(rot);
  sw.rows = new Map(rows.map((x) => [x.symbol, x]));
  const acct = buildAccount(rows);
  if (final) renderVs(rows, acct);
  renderRotTiles(rot, rows, o, acct ? acct.rep.takenList : rot.trades);
  renderPicks(rot, o);
  renderRotYears(acct ? acct.rep.takenList : rot.trades);
  renderTradeChart(rows, rot.trades, final, acct);
  renderMix(acct);
  renderTrades(acct ? acct.rep.takenList : rot.trades);
  const n = sw.failed.length;
  $("sw-failed").hidden = !n;
  $("sw-failed").textContent = n ? `${n} stock${n === 1 ? "" : "s"} could not be loaded (usually Yahoo rate-limiting or missing data): ${sw.failed.slice(0, 40).join(", ")}${n > 40 ? ", ..." : ""}. Use "Retry failed" to try them again.` : "";
  $("sw-retry").hidden = !n || sw.running;
  $("sw-csv").hidden = false;
}

/** Re-run the ranking over a grid of settings around the chosen ones, on the prices already loaded. */
async function runRobustness() {
  if (!sw.isRot || !sw.rot.dates || sw.running) return;
  const base = rotOpts();
  const lookbacks = base.score === "dip" ? [base.lookback] : [3, 6, 9, 12].map((m) => m * 21);
  const combos = [];
  for (const lookback of lookbacks) for (const topN of [5, 10, 20]) for (const every of ["month", "week"]) combos.push({ lookback, topN, every });
  $("sw-rob-run").disabled = true;
  const out = [];
  for (let k = 0; k < combos.length; k++) {
    $("sw-rob-note").textContent = `Running ${k + 1} of ${combos.length}...`;
    await new Promise((res) => setTimeout(res, 0));
    const c = combos[k];
    const rot = buildRotation(sw.rot.dates, sw.rot.closes, sw.rot.spy, { ...base, ...c });
    const rows = rotationRows(rot);
    const acct = rot.trades.length ? buildAccount(rows, { topN: c.topN }) : null;
    out.push({ ...c, trades: rot.trades.length, v: acct ? computeVs(rows, acct) : null, current: c.lookback === base.lookback && c.topN === base.topN && c.every === base.every });
  }
  const ok = out.filter((x) => x.v);
  const edges = ok.map((x) => x.v.cagrStrat - x.v.cagrSpy).sort((a, b) => a - b);
  const beat = edges.filter((e) => e > 0).length;
  const median = edges.length ? edges[Math.floor(edges.length / 2)] : null;
  const worst = ok.length ? Math.min(...ok.map((x) => x.v.ddStrat)) : null;
  $("sw-rob-note").textContent = ok.length
    ? `${beat} of ${ok.length} nearby settings beat the S&P 500 in compound growth; the middle result is ${median >= 0 ? "+" : "−"}${Math.abs(median * 100).toFixed(1)} points a year and the deepest worst drop was ${pctFmt(worst, 1)}. Settings used when you clicked.`
    : "None of the nearby settings produced trades.";
  $("sw-rob-wrap").hidden = !out.length;
  $("sw-rob").innerHTML = out.map((x) => {
    const v = x.v, edge = v ? v.cagrStrat - v.cagrSpy : null;
    const cell = (t, k = "") => `<td class="num ${k}">${t}</td>`;
    return `<tr${x.current ? ' class="dt-cur"' : ""}>${cell(base.score === "dip" ? "-" : `${x.lookback / 21} mo`)}${cell(x.topN)}<td>${{ month: "monthly", week: "weekly", day: "daily" }[x.every]}</td>${v ? cell(pctFmt(v.cagrStrat, 1), cls(v.cagrStrat)) + cell(`${edge >= 0 ? "+" : "−"}${Math.abs(edge * 100).toFixed(1)} pts`, cls(edge)) + cell(pctFmt(v.ddStrat, 1)) + cell(`${v.yearsAhead} of ${v.nYears}`) : '<td class="num" colspan="4">no trades</td>'}${cell(x.trades)}</tr>`;
  }).join("");
  $("sw-rob-run").disabled = false;
}

// ---------------------------------------------------------------- running
function progress(done, total, extra = "") {
  $("sw-bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("sw-progress-text").textContent = `${done} of ${total} stocks${extra}`;
}
function settingsNote(s) {
  const bbExit = { mid: "the average", half: "halfway to the upper band", upper: "the upper band" }[s.bbExit] || "the average";
  if (s.strategy === "momentum") {
    const o = rotOpts();
    const rank = o.score === "dip" ? "how far each stock is below its 20-day average (at least 1 deviation)" : `the ${s.moLook}-month gain${Number(s.moSkip) ? ` leaving out the latest ${s.moSkip} month${s.moSkip === "1" ? "" : "s"}` : ""}`;
    return `Settings used: leaderboard ranked by ${rank}; hold the top ${o.topN} equally (${+(100 / o.topN).toFixed(2)}% each), checked ${{ month: "monthly", week: "weekly", day: "daily" }[o.every]}${o.buffer ? `, kept until they fall ${o.buffer} places below the group` : ""}${o.spyFilter ? "; all sold when SPY is below its 200-day average" : ""}${o.joined ? "; stocks ranked only after they joined the S&P 500" : "; ranks today's list for the whole period (hindsight)"}${s.universe && s.universe !== "sp500" ? `; stock list: ${LIST_NAMES[s.universe] || s.universe}` : ""}${o.sectorCap ? `; at most ${o.sectorCap} per sector` : ""}${o.trailStop ? `; ${o.trailStop}% trailing stop (21-day lockout)` : ""}${o.volSize ? "; positions scaled by volatility" : ""}; ${s.slipBps} bps slippage; ${s.years} years.`;
  }
  const strat = s.strategy === "meanrev"
    ? `buy dips (2-day RSI under ${s.rsiBuy}, sell above the ${s.exitSma}-day average, ${Number(s.hold) > 0 ? `${s.hold}-day limit` : "no time limit"})`
    : s.strategy === "bollinger"
    ? `Bollinger band (${s.bbLen}-day average, ${s.bbK} deviations; buy ${s.bbEntry === "reclaim" ? "when it closes back above the lower band" : "below the lower band"}, sell at ${bbExit}, ${Number(s.bbHold) > 0 ? `${s.bbHold}-day limit` : "no time limit"}${s.bbShort ? `; also shorts above the upper band, ${s.borrow}% a year to borrow` : ""})`
    : `buy ${s.entryLen}-day highs, sell below the ${s.exitLen}-day low${Number(s.hold2) > 0 ? `, ${s.hold2}-day limit` : ""}`;
  return `Settings used: ${strat}; ${s.stopAtr}-ATR stop; ${s.trend ? "uptrend only" : "any trend"}${s.mkt ? ", market up" : ""}; ${s.slipBps} bps slippage; $${s.dollars} per buy; ${s.years} years.`;
}

async function run(only = null) {
  if (sw.running) return;
  const s = readForm();
  saveSettings(s);
  const typed = s.symbols.split(/[\s,]+/).map((x) => x.toUpperCase()).filter(Boolean);
  const universe = typed.length ? typed : sw.stocks.map((x) => x.symbol);
  if (!universe.length) { $("sw-status").className = "status error"; $("sw-status").textContent = "The stock list has not loaded yet. Type some symbols above or reload the page."; return; }
  const symbols = only || universe;
  const rotRun = s.strategy === "momentum";
  if (!only || sw.isRot !== rotRun) { sw.rows.clear(); sw.dailyPnl = {}; sw.rot = { dates: null, spy: null, closes: new Map() }; tradeChart.reset(); mixChart.reset(); }
  sw.isRot = rotRun;
  sw.runStocks = sw.stocks;
  $("sw-rob-wrap").hidden = true; $("sw-rob-note").textContent = "";
  sw.bench = null; sw.benchErr = false; sw.vs = null;
  const benchP = rotRun ? Promise.resolve() : fetch(`/api/swing?bench=1&years=${encodeURIComponent(s.years)}`).then((r) => r.json().then((d) => { if (!r.ok) throw new Error(d.error || r.status); sw.bench = d.bench; })).catch(() => { sw.benchErr = true; });
  sw.failed = []; sw.running = true; sw.cancel = false;
  sw.baseDollars = rotRun || s.sizeMode === "pct" ? 100 : Number(s.dollars) || 100;
  $("sw-used").textContent = settingsNote(s);
  $("sw-run").disabled = true; $("sw-cancel").hidden = false; $("sw-retry").hidden = true; $("sw-progress").hidden = false;
  $("sw-status").className = "status";
  $("sw-status").textContent = (only ? "Retrying the stocks that failed..." : rotRun ? `Loading ${s.years} years of daily prices for ${symbols.length} stock${symbols.length === 1 ? "" : "s"} to rank them...` : `Testing ${symbols.length} stock${symbols.length === 1 ? "" : "s"} on up to ${s.years} years of daily prices...`) + " The charts and tables fill in as results arrive.";

  const queue = [];
  for (let i = 0; i < symbols.length; i += SW_BATCH) queue.push(symbols.slice(i, i + SW_BATCH));
  const warnings = new Set();
  let done = 0, lastErr = "";
  const worker = async () => {
    while (!sw.cancel) {
      const batch = queue.shift();
      if (!batch) return;
      try {
        if (rotRun) {
          const r = await fetch(`/api/swing?mode=prices&years=${encodeURIComponent(s.years)}&symbols=${encodeURIComponent(batch.join(","))}`);
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
          ingestPrices(data);
          sw.failed.push(...Object.keys(data.errors || {}));
        } else {
          const qs = params(s);
          qs.set("symbols", batch.join(","));
          const r = await fetch(`/api/swing?${qs}`);
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
          (data.warnings || []).forEach((w) => warnings.add(w));
          for (const [dt, v] of Object.entries(data.dailyPnl || {})) sw.dailyPnl[dt] = (sw.dailyPnl[dt] || 0) + v;
          for (const row of data.symbols || []) { if (row.error || !row.all) sw.failed.push(row.symbol); else sw.rows.set(row.symbol, row); }
        }
      } catch (e) {
        lastErr = e.message || String(e);
        sw.failed.push(...batch);
      }
      done += batch.length;
      progress(done, symbols.length, sw.failed.length ? `, ${sw.failed.length} failed` : "");
      draw(false);
    }
  };
  await Promise.all([benchP, ...Array.from({ length: SW_PARALLEL }, worker)]);

  const stopped = sw.cancel;
  sw.running = false;
  $("sw-cancel").hidden = true; $("sw-run").disabled = false; $("sw-progress").hidden = true;
  if (stopped) sw.failed.push(...queue.flat());
  draw(true);
  $("sw-updated").textContent = `Last run ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  const nDone = sw.isRot ? sw.rot.closes.size : sw.rows.size;
  $("sw-status").className = nDone ? "status" : "status error";
  $("sw-status").textContent = (stopped ? "Stopped. " : "Done. ") + `${nDone} stocks ${sw.isRot ? "ranked" : "tested"}${sw.failed.length ? `, ${sw.failed.length} not tested${lastErr ? ` (last error: ${lastErr})` : ""}` : ""}.` + (warnings.size ? " " + [...warnings].join(" ") : "");
}

function csv() {
  if (sw.isRot && sw.rotResult) {
    const lines = ["bought,sold,symbol,entry_price,exit_price,days,exit_reason,return_pct"];
    for (const t of sw.rotResult.trades) lines.push([t.date, t.exitDate, t.symbol, t.entry.toFixed(4), t.exit.toFixed(4), t.holdBars, t.exitReason, t.retPct.toFixed(3)].join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = `leaderboard-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  const head = ["symbol", "sector", "trades", "win_rate", "net_r_per_trade", "gross_r_per_trade", "total_net_r", "pnl_dollars", "older_half_trades", "older_half_net_r_per_trade", "newer_half_trades", "newer_half_net_r_per_trade", "buy_and_hold_pct"];
  const f = (x, d = 4) => (x == null ? "" : Number(x).toFixed(d));
  const lines = [head.join(",")];
  for (const r of sw.rows.values()) {
    const v = rowView(r);
    lines.push([v.symbol, `"${v.sector.replace(/"/g, '""')}"`, v.trades, f(v.winRate), f(v.exp), f(v.expGross), f(v.totalR, 2), f(v.pnl, 2), v.nFirst, f(v.expFirst), v.nSecond, f(v.expSecond), f(v.holdPct, 1)].join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `swing-scan-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const LIST_NAMES = { sp500: "S&P 500 stocks", sp400: "S&P 400 mid-size stocks", etfs: "ETFs" };
const listKey = () => (LIST_NAMES[$("s-universe").value] ? $("s-universe").value : "sp500");
async function loadStocks() {
  const key = listKey();
  sw.stocks = [];
  $("sw-run").disabled = true;
  $("sw-status").textContent = `Loading the ${LIST_NAMES[key]} list...`;
  try {
    const r = await fetch(key === "sp500" ? "/api/daytrade-symbols" : `/api/daytrade-symbols?list=${key}`);
    const data = await r.json();
    if (key === listKey()) sw.stocks = (data.options || []).filter((o) => o.tag !== "ETF" && o.tag !== "Crypto").map((o) => ({ symbol: o.symbol, sector: o.tag || "", added: o.added || "" }));
    else return;                                                    // the choice changed while this was loading; the newer load wins
  } catch { /* the symbols box still works */ }
  $("sw-run").disabled = false;
  $("sw-status").textContent = sw.stocks.length ? `Ready: ${sw.stocks.length} ${LIST_NAMES[key]}.` : `The ${LIST_NAMES[key]} list did not load. Type some symbols above to test those instead.`;
}

$("s-strategy").addEventListener("change", showStrategy);
$("s-universe").addEventListener("change", loadStocks);
const showPark = () => { $("sw-parkrate-wrap").hidden = $("s-park").value !== "rate"; };
// The balance and what idle money does are only used on this page, so changing them updates the results without a new run.
const draw = (final) => (sw.isRot ? renderRotation(final) : render(final));
const hasResults = () => (sw.isRot ? sw.rot.closes.size > 0 : sw.rows.size > 0);
const rerender = () => { if (!sw.running && hasResults()) { if (sw.isRot) $("sw-used").textContent = settingsNote(readForm()); draw(true); } };
$("s-balance").addEventListener("change", rerender);
$("s-park").addEventListener("change", () => { showPark(); rerender(); });
$("s-sizemode").addEventListener("change", () => { showSizing(); rerender(); });
for (const id of ["s-sizepct", "s-dollars"]) $(id).addEventListener("change", rerender);
// the rotation ranks from prices already in memory, so its settings update the results without re-downloading
$("s-moscore").addEventListener("change", () => { showStrategy(); if (sw.isRot) rerender(); });
for (const id of ["s-mojoin", "s-mosec", "s-moevery", "s-mon", "s-molook", "s-moskip", "s-mobuf", "s-mostop", "s-movol", "s-mkt", "s-slip"]) $(id).addEventListener("change", () => { if (sw.isRot) rerender(); });
$("s-parkrate").addEventListener("change", rerender);
$("sw-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
$("sw-run").addEventListener("click", () => run());
$("sw-cancel").addEventListener("click", () => { sw.cancel = true; $("sw-status").textContent = "Stopping after the batches already running..."; });
$("sw-retry").addEventListener("click", () => run([...new Set(sw.failed)]));
$("sw-csv").addEventListener("click", csv);
$("sw-rob-run").addEventListener("click", runRobustness);
$("sw-min").addEventListener("change", () => { sw.limit = 50; renderStocks(); });
$("sw-more").addEventListener("click", () => { sw.limit = 1000; renderStocks(); });
document.querySelectorAll("#sw-table th.sortable").forEach((th) => {
  th.tabIndex = 0;
  const go = () => {
    const k = th.dataset.k;
    sw.sort = { k, dir: sw.sort.k === k ? -sw.sort.dir : (k === "symbol" || k === "sector" ? 1 : -1) };
    renderStocks();
  };
  th.addEventListener("click", go);
  th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
});

loadSettings();
showStrategy();
showPark();
loadStocks();

(function wireExplain() {
  const btn = $("dt-explain");
  const apply = (on) => {
    document.body.classList.toggle("dt-explain", on);
    btn.setAttribute("aria-expanded", String(on));
    $("dt-explain-label").textContent = on ? "Hide explanations" : "Show explanations";
    document.querySelectorAll("details.dt-guide").forEach((d) => { d.open = on; });
  };
  btn.addEventListener("click", () => apply(btn.getAttribute("aria-expanded") !== "true"));
})();
