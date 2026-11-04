// Swing Lab - front end (no build step, no dependencies)
import { replayAccount } from "./swing-account.js";
import { makeTradeChart } from "./swing-chart.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "-" : (x < 0 ? "−" : "") + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const price = (x) => (x == null ? "-" : x.toFixed(x < 10 ? 3 : 2));
const qty = (n) => (n == null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
const sgn = (x, d = 2) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`);
const pct0 = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "pos" : "neg");
const STRATEGY_NAMES = { meanrev: "Buy sharp dips", breakout: "Buy new highs" };
const EXIT_NAMES = { signal: "Exit signal", stop: "Stop", "stop-gap": "Gap through stop", time: "Time limit", "data-end": "Still open at the end" };

const STORE_KEY = "swing-lab-settings";
const FIELDS = { strategy: "s-strategy", years: "s-years", balance: "s-balance", dollars: "s-dollars", slipBps: "s-slip", stopAtr: "s-stop", rsiBuy: "s-rsi", exitSma: "s-exma", hold: "s-hold", bbLen: "s-bblen", bbK: "s-bbk", bbHold: "s-bbhold", bbEntry: "s-bbentry", bbExit: "s-bbexit", borrow: "s-borrow", entryLen: "s-elen", exitLen: "s-xlen", hold2: "s-hold2", symbols: "s-symbols" };
const CHECKS = { trend: "s-trend", mkt: "s-mkt", bbShort: "s-bbshort" };
const SW_BATCH = 25, SW_PARALLEL = 2;

const sw = { stocks: [], rows: new Map(), dailyPnl: {}, bench: null, benchErr: false, failed: [], running: false, cancel: false, sort: { k: "exp", dir: -1 }, limit: 50, dollars: 100 };

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
  set("dollars", s.dollars); set("slipBps", s.slipBps); set("stopAtr", s.stopAtr);
  if (s.strategy === "meanrev") { set("rsiBuy", s.rsiBuy); set("exitSma", s.exitSma); set("hold", s.hold); }
  else if (s.strategy === "bollinger") { set("bbLen", s.bbLen); set("bbK", s.bbK); set("bbEntry", s.bbEntry); set("bbExit", s.bbExit); set("hold", s.bbHold); if (s.bbShort) { set("bbShort", "1"); set("borrow", s.borrow); } }
  else { set("entryLen", s.entryLen); set("exitLen", s.exitLen); set("hold", s.hold2); }
  return p;
}
function showStrategy() {
  const v = $("s-strategy").value;
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
  const total = sw.stocks.length || rows.length;
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
  const retPct = (all.pnl / (n * sw.dollars)) * 100;
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
 * The strategy against SPY over the same days.
 *  - With a starting balance: one real account (limited cash, realised profit counted when a trade is sold).
 *  - Without one: every signal is taken and each stock tested gets its own slot of "dollars per buy".
 */
function computeVs(rows) {
  if (!sw.bench || !sw.bench.length || !rows.length) return null;
  const start = rows.map((r) => r.testStart).filter(Boolean).sort()[0];
  if (!start) return null;
  const i0 = Math.max(1, sw.bench.findIndex(([d]) => d >= start));
  const baseClose = sw.bench[i0 - 1][1];                    // the close just before the first tested day
  const bars = sw.bench.slice(i0);
  if (bars.length < 20) return null;
  const balance = Number($("s-balance").value) || 0;
  const account = balance > 0;
  const dayList = bars.map(([d]) => d);

  let strat, extra = {};
  if (account) {
    const rep = replayAccount(rows, balance, sw.dollars, dayList);
    strat = rep.equity.map((e, i) => e / (i ? rep.equity[i - 1] : balance) - 1);
    extra = { equity: rep.equity, taken: rep.taken, skipped: rep.skipped, maxOpen: rep.maxOpen, balance };
  } else {
    const capital = rows.length * sw.dollars;
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
  return {
    account, years: yr, usedFull: basis === full, nYears: basis.length, span, start, end: days[days.length - 1].date,
    dates: dayList, spyClose: days.map((d) => d.c), baseClose, ...extra,
    avgAnnualStrat: mean(basis.map((y) => y.strat)), avgAnnualSpy: mean(basis.map((y) => y.spy)),
    avgDailyStrat: mean(days.map((d) => d.strat)), avgDailySpy: mean(days.map((d) => d.spy)),
    totalStrat, totalSpy, cagrStrat: cagr(totalStrat), cagrSpy: cagr(totalSpy),
  };
}

function renderVs(rows) {
  const v = computeVs(rows);
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
      `The account can hold at most ${Math.floor(v.balance / sw.dollars)} buys at a time (balance divided by dollars per buy). When more signals appear than that, the extra ones are skipped, so the account's results differ from the "every signal" numbers above. A bigger balance or a smaller buy size means fewer skipped signals.`));
  }
  tiles.push(
    tile("Average annual return", pctFmt(v.avgAnnualStrat), `S&P 500: ${pctFmt(v.avgAnnualSpy)}`, cls(v.avgAnnualStrat), `Average of ${v.nYears} ${v.usedFull ? "full " : ""}calendar year${v.nYears === 1 ? "" : "s"}. ${diff(v.avgAnnualStrat, v.avgAnnualSpy)}. The money is mostly idle, so this is the return on all of it, not only the part that was invested.`),
    tile("Average daily return", pctFmt(v.avgDailyStrat, 3), `S&P 500: ${pctFmt(v.avgDailySpy, 3)}`, cls(v.avgDailyStrat), "The average return per trading day over the whole window. Multiply by about 252 for a rough yearly figure."),
    tile("Compound growth per year", pctFmt(v.cagrStrat), `S&P 500: ${pctFmt(v.cagrSpy)}`, cls(v.cagrStrat), "The whole window's total return turned into a steady yearly rate, which handles part years correctly."),
    tile("Total return", pctFmt(v.totalStrat, 1), `S&P 500: ${pctFmt(v.totalSpy, 1)}`, cls(v.totalStrat), `Over ${v.span.toFixed(1)} years, ${v.start} to ${v.end}.`),
  );
  $("sw-vs-tiles").innerHTML = tiles.join("");
  $("sw-vs-note").textContent = v.account
    ? `Strategy: one account starting with ${money(v.balance)}, ${money(sw.dollars)} per buy, profit counted when a trade is sold, idle cash earning nothing. S&P 500: the same money in SPY, price only.`
    : `Strategy: ${money(v.capital)} set aside (one ${money(sw.dollars)} slot per stock, every signal taken), idle cash earning nothing. S&P 500: SPY price only. Enter a starting balance above to test a single account with limited cash.`;
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
  const sector = (sw.stocks.find((x) => x.symbol === r.symbol) || {}).sector || "";
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
  $("sw-trades").innerHTML = shown.map((t) => `<tr><td>${esc(t.date)}</td><td>${esc(t.exitDate)}</td><td><strong>${esc(t.symbol)}</strong>${t.side === "short" ? ` <span class="dt-pill err">short</span>` : ""}</td>
      <td class="num">${price(t.entry)}</td><td class="num">${price(t.exit)}</td><td class="num">${qty(t.shares)}</td><td class="num">${t.holdBars}</td>
      <td>${esc(EXIT_NAMES[t.exitReason] || t.exitReason)}</td><td class="num ${cls(t.netR)}">${sgn(t.netR)}R</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td></tr>`).join("");
  const pnl = shown.reduce((s, t) => s + t.pnl, 0), r = shown.reduce((s, t) => s + t.netR, 0);
  $("sw-trades-foot").innerHTML = shown.length ? `<tr><td colspan="8"><strong>Total of the ${shown.length} shown</strong></td><td class="num ${cls(r)}"><strong>${sgn(r)}R</strong></td><td class="num ${cls(pnl)}"><strong>${money(pnl)}</strong></td></tr>` : "";
}

const tradeChart = makeTradeChart($("sw-balcard"), { esc, money, sgn, price, qty, exitNames: EXIT_NAMES });

/** The balance chart with a marker per buy and sell. Redrawn after every batch, so it grows as the scan runs. */
function renderTradeChart(rows, all, final) {
  const balance = Number($("s-balance").value) || 0;
  if (!all.length) { tradeChart.render([], 0); return; }
  if (balance <= 0) { tradeChart.render(all, 0, { settle: final, title: "Profit and loss, with every buy and sell (every signal, no cash limit)" }); return; }
  const dates = [...new Set(all.flatMap((t) => [t.date, t.exitDate]))].sort();
  const { takenList } = replayAccount(rows, balance, sw.dollars, dates);
  let spy = null;
  if (sw.bench && sw.bench.length) {
    const start = rows.map((r) => r.testStart).filter(Boolean).sort()[0];
    const i0 = Math.max(1, sw.bench.findIndex(([d]) => d >= start));
    const base = sw.bench[i0 - 1][1];
    const map = new Map(sw.bench);
    spy = { close: (date) => (map.has(date) ? map.get(date) : null), base };
  }
  tradeChart.render(takenList, balance, { spy, settle: final, title: "Account balance, with every buy and sell" });
}

function render(final = false) {
  const rows = [...sw.rows.values()];
  if (!rows.length) { $("sw-results").hidden = true; return; }
  $("sw-results").hidden = false;
  const all = sum(rows), first = sum(rows, "first"), second = sum(rows, "second");
  if (final) renderVs(rows);
  renderTiles(rows, all, first, second);
  renderDiag(rows, all);

  const bySector = new Map();
  for (const r of rows) {
    const sec = (sw.stocks.find((x) => x.symbol === r.symbol) || {}).sector || "Other";
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
  renderTradeChart(rows, trades, final);
  renderTrades(trades);
  const n = sw.failed.length;
  $("sw-failed").hidden = !n;
  $("sw-failed").textContent = n ? `${n} stock${n === 1 ? "" : "s"} could not be tested (usually Yahoo rate-limiting or missing data): ${sw.failed.slice(0, 40).join(", ")}${n > 40 ? ", ..." : ""}. Use "Retry failed" to try them again.` : "";
  $("sw-retry").hidden = !n || sw.running;
  $("sw-csv").hidden = false;
}

// ---------------------------------------------------------------- running
function progress(done, total, extra = "") {
  $("sw-bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("sw-progress-text").textContent = `${done} of ${total} stocks${extra}`;
}
function settingsNote(s) {
  const bbExit = { mid: "the average", half: "halfway to the upper band", upper: "the upper band" }[s.bbExit] || "the average";
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
  if (!only) { sw.rows.clear(); sw.dailyPnl = {}; tradeChart.reset(); }
  sw.bench = null; sw.benchErr = false; sw.vs = null;
  const benchP = fetch(`/api/swing?bench=1&years=${encodeURIComponent(s.years)}`).then((r) => r.json().then((d) => { if (!r.ok) throw new Error(d.error || r.status); sw.bench = d.bench; })).catch(() => { sw.benchErr = true; });
  sw.failed = []; sw.running = true; sw.cancel = false;
  sw.dollars = Number(s.dollars) || 100;
  $("sw-used").textContent = settingsNote(s);
  $("sw-run").disabled = true; $("sw-cancel").hidden = false; $("sw-retry").hidden = true; $("sw-progress").hidden = false;
  $("sw-status").className = "status";
  $("sw-status").textContent = (only ? "Retrying the stocks that failed..." : `Testing ${symbols.length} stock${symbols.length === 1 ? "" : "s"} on up to ${s.years} years of daily prices...`) + " The charts and tables fill in as results arrive.";

  const queue = [];
  for (let i = 0; i < symbols.length; i += SW_BATCH) queue.push(symbols.slice(i, i + SW_BATCH));
  const warnings = new Set();
  let done = 0, lastErr = "";
  const worker = async () => {
    while (!sw.cancel) {
      const batch = queue.shift();
      if (!batch) return;
      try {
        const qs = params(s);
        qs.set("symbols", batch.join(","));
        const r = await fetch(`/api/swing?${qs}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
        (data.warnings || []).forEach((w) => warnings.add(w));
        for (const [dt, v] of Object.entries(data.dailyPnl || {})) sw.dailyPnl[dt] = (sw.dailyPnl[dt] || 0) + v;
        for (const row of data.symbols || []) { if (row.error || !row.all) sw.failed.push(row.symbol); else sw.rows.set(row.symbol, row); }
      } catch (e) {
        lastErr = e.message || String(e);
        sw.failed.push(...batch);
      }
      done += batch.length;
      progress(done, symbols.length, sw.failed.length ? `, ${sw.failed.length} failed` : "");
      render();
    }
  };
  await Promise.all([benchP, ...Array.from({ length: SW_PARALLEL }, worker)]);

  const stopped = sw.cancel;
  sw.running = false;
  $("sw-cancel").hidden = true; $("sw-run").disabled = false; $("sw-progress").hidden = true;
  if (stopped) sw.failed.push(...queue.flat());
  render(true);
  $("sw-updated").textContent = `Last run ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  $("sw-status").className = sw.rows.size ? "status" : "status error";
  $("sw-status").textContent = (stopped ? "Stopped. " : "Done. ") + `${sw.rows.size} stocks tested${sw.failed.length ? `, ${sw.failed.length} not tested${lastErr ? ` (last error: ${lastErr})` : ""}` : ""}.` + (warnings.size ? " " + [...warnings].join(" ") : "");
}

function csv() {
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

async function loadStocks() {
  try {
    const r = await fetch("/api/daytrade-symbols");
    const data = await r.json();
    sw.stocks = (data.options || []).filter((o) => o.tag !== "ETF" && o.tag !== "Crypto").map((o) => ({ symbol: o.symbol, sector: o.tag || "" }));
  } catch { /* the symbols box still works */ }
  $("sw-run").disabled = false;
  $("sw-status").textContent = sw.stocks.length ? `Ready: ${sw.stocks.length} S&P 500 stocks.` : "The S&P 500 list did not load. Type some symbols above to test those instead.";
}

$("s-strategy").addEventListener("change", showStrategy);
// The balance is only used on this page, so changing it updates the comparison without a new run.
$("s-balance").addEventListener("change", () => { if (!sw.running && sw.rows.size) { sw.dollars = Number($("s-dollars").value) || sw.dollars; render(true); } });
$("sw-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
$("sw-run").addEventListener("click", () => run());
$("sw-cancel").addEventListener("click", () => { sw.cancel = true; $("sw-status").textContent = "Stopping after the batches already running..."; });
$("sw-retry").addEventListener("click", () => run([...new Set(sw.failed)]));
$("sw-csv").addEventListener("click", csv);
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
