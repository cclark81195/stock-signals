// Day Trade Lab - front end (no build step, no dependencies)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "-" : (x < 0 ? "−" : "") + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const price = (x) => (x == null ? "-" : x.toFixed(x < 10 ? 3 : 2));
const qty = (n) => (n == null ? "-" : Number.isInteger(n) ? String(n) : n.toLocaleString("en-US", { maximumFractionDigits: 6 }));
const sgn = (x, d = 2) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`);
const pct0 = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "pos" : "neg");
const SETUP_NAMES = { orb: "Opening-range breakout", vwap: "VWAP reclaim", flag: "Bull flag", triangle: "Ascending triangle", pullback: "Pullback to moving average", fib: "Fibonacci pullback", dbottom: "Double bottom", gap: "Gap and go" };
const EXIT_NAMES = { target: "Target", stop: "Stop", "stop-gap": "Gap through stop", time: "End-of-day close", "session-end": "Session end" };

const STORE_KEY = "daytrade-lab-settings";
const CHECKS = { flag: "f-flag", tri: "f-tri", pb: "f-pb", fib: "f-fib", dbot: "f-dbot", gap: "f-gap", mkt: "f-mkt", inplay: "f-inplay", midday: "f-midday", partial: "f-partial" };
const fields = { equity: "f-equity", dollars: "f-dollars", riskPct: "f-risk", targetR: "f-target", slipBps: "f-slip", cryptoSlipBps: "f-cslip" };

function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { /* storage may be unavailable */ }
  if (saved) {
    for (const [k, id] of Object.entries(fields)) if (saved[k] != null) $(id).value = saved[k];
    if (typeof saved.orb === "boolean") $("f-orb").checked = saved.orb;
    if (typeof saved.vwap === "boolean") $("f-vwap").checked = saved.vwap;
    for (const [k, id] of Object.entries(CHECKS)) if (typeof saved[k] === "boolean") $(id).checked = saved[k];
    if (saved.exit === "fixed" || saved.exit === "measured") $("f-exit").value = saved.exit;
  }
  const fromSaved = typeof saved?.symbols === "string" ? parseSymbols(saved.symbols) : [];
  setSelected(fromSaved);
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
function readForm() {
  const s = {};
  for (const [k, id] of Object.entries(fields)) s[k] = $(id).value.trim();
  s.symbols = picker.selected.join(",");
  s.orb = $("f-orb").checked;
  s.vwap = $("f-vwap").checked;
  for (const [k, id] of Object.entries(CHECKS)) s[k] = $(id).checked;
  s.exit = $("f-exit").value;
  return s;
}

const et = (ts) => new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------------------------------------------------------------- rendering
function tile(label, value, sub = "", klass = "", desc = "") {
  return `<div class="dt-tile"><div class="k">${esc(label)}</div><div class="v ${klass}">${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}${desc ? `<div class="d dt-ex">${esc(desc)}</div>` : ""}</div>`;
}

function renderTiles(a, equity) {
  if (!a.trades) { $("dt-tiles").innerHTML = ""; return; }
  const hitTarget = (a.byExit.target || 0) / a.trades;
  const otherExits = Object.entries(a.byExit).filter(([k]) => k !== "target").map(([k, n]) => `${n} ${(EXIT_NAMES[k] || k).toLowerCase()}`).join(", ");
  $("dt-tiles").innerHTML = [
    tile("Trades", String(a.trades), `avg hold ${Math.round(a.avgHoldMin)} min`, "",
      "How many simulated trades the rules took across all symbols. Hundreds are needed before results mean much; a few dozen is mostly luck."),
    tile("Win rate", pct0(a.winRate), `avg win ${sgn(a.avgWinR)}R, avg loss −${a.avgLossR.toFixed(2)}R`, "",
      "The share of trades that made money after costs. A low win rate can still work if the wins are bigger than the losses."),
    tile("Per trade, after costs", `${sgn(a.expectancyNetR)}R`, "the number that matters", cls(a.expectancyNetR),
      "The average result of one trade after slippage, in R. Positive means the rules made money on average. Negative means they lost."),
    tile("Per trade, before costs", `${sgn(a.expectancyGrossR)}R`, `costs take ${a.costDragR.toFixed(2)}R`, "",
      "The same average if trading were free. The gap from the tile before it is what slippage eats. Small edges often vanish here."),
    tile("Profit factor", a.profitFactor == null ? "-" : a.profitFactor.toFixed(2), "above 1 means wins outweigh losses", a.profitFactor == null ? "" : a.profitFactor > 1 ? "pos" : "neg",
      "Total won divided by total lost. Under 1 loses money, 1 is break-even, and about 1.5 or more is considered solid."),
    tile("Total result", `${sgn(a.totalNetR)}R`, `${money(a.totalPnl)} on ${money(equity).replace(".00", "")}`, cls(a.totalNetR),
      "All trades added up after costs, in R and in dollars. Dollars assume the same size on every trade (the same risk, or the same dollar amount if you set \"Dollars per buy\"), with no compounding."),
    tile("Worst drawdown", `−${a.maxDrawdownR.toFixed(1)}R`, "peak to trough", "",
      "The biggest fall from a high point in the running total. It shows how deep the worst stretch got. Ask whether you could stay with the plan through it."),
    tile("Hit the target", pct0(hitTarget), otherExits || "no other exits", "",
      "How many trades reached the profit target. The line above counts the rest: stops, gaps through the stop, and end-of-day exits."),
  ].join("");
}

function renderCurve(curve, box = "dt-curve", noteId = "dt-curve-note") {
  if (!curve || curve.length < 2) {
    $(box).innerHTML = `<p class="dt-empty">Not enough trades to draw a curve.</p>`;
    $(noteId).textContent = "";
    return;
  }
  const W = 640, H = 170, pl = 44, pr = 10, pt = 10, pb = 22;
  const ys = [0, ...curve.map((p) => p.cumR)];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const x = (i) => pl + (i / (curve.length - 1)) * (W - pl - pr);
  const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const pts = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.cumR).toFixed(1)}`).join(" ");
  $(box).innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative result in R across ${curve.length} trades">
      <line class="zero" x1="${pl}" x2="${W - pr}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
      <polyline class="line" points="${pts}"></polyline>
      <text class="lbl" x="${pl - 6}" y="${y(hi).toFixed(1)}" text-anchor="end" dominant-baseline="hanging">${sgn(hi, 1)}R</text>
      <text class="lbl" x="${pl - 6}" y="${y(lo).toFixed(1)}" text-anchor="end">${sgn(lo, 1)}R</text>
      <text class="lbl" x="${pl}" y="${H - 5}">${esc(curve[0].date)}</text>
      <text class="lbl" x="${W - pr}" y="${H - 5}" text-anchor="end">${esc(curve[curve.length - 1].date)}</text>
    </svg>`;
  $(noteId).textContent = `${curve.length} trades`;
}

const STATE = {
  signal: ["Signal", "signal"], "in-position": ["In trade", "pos"], traded: ["Traded", ""],
  waiting: ["Waiting", "wait"], none: ["No setup", ""], "no-data": ["No data", "err"],
};

function renderScan(symbols, equity) {
  $("dt-scan-note").textContent = `Each symbol shows its most recent session: stocks use New York trading days, crypto uses UTC days. Sizes assume a ${money(equity).replace(".00", "")} account.`;
  $("dt-scan").innerHTML = symbols.map((s) => {
    if (s.error) return `<tr><td><strong>${esc(s.symbol)}</strong></td><td><span class="dt-pill err">Error</span></td><td class="wrap" colspan="5">${esc(s.error)}</td></tr>`;
    const sc = s.scan, p = sc.plan;
    const [label, k] = STATE[sc.state] || [sc.state, ""];
    const when = sc.date ? ` <span class="dt-date">${esc(sc.date)}${sc.live ? ", in progress" : ""}</span>` : "";
    return `<tr>
      <td><strong>${esc(s.symbol)}</strong></td>
      <td><span class="dt-pill ${k}">${esc(label)}</span></td>
      <td class="wrap">${esc(sc.text)}${when}</td>
      <td class="num">${p ? price(p.entry) : "-"}</td><td class="num">${p ? price(p.stop) : "-"}</td>
      <td class="num">${p ? price(p.target) : "-"}</td><td class="num">${p ? qty(p.shares) : "-"}</td>
    </tr>`;
  }).join("");
}

function renderByClass(data) {
  const present = new Set(data.symbols.filter((x) => !x.error).map((x) => x.assetClass));
  $("dt-class-section").hidden = !present.has("crypto");
  const label = { stocks: "Stocks and SPY", crypto: "Crypto" };
  $("dt-byclass").innerHTML = ["stocks", "crypto"].filter((k) => present.has(k)).map((k) => {
    const v = data.byClass?.[k];
    if (!v || !v.trades) return `<tr><td>${label[k]}</td><td class="num">0</td><td class="num" colspan="3">-</td></tr>`;
    return `<tr><td>${label[k]}</td><td class="num">${v.trades}</td><td class="num">${pct0(v.winRate)}</td>
      <td class="num ${cls(v.expectancyNetR)}">${sgn(v.expectancyNetR)}R</td><td class="num ${cls(v.totalNetR)}">${sgn(v.totalNetR)}R</td></tr>`;
  }).join("");
}

function renderBySymbol(symbols) {
  $("dt-bysym").innerHTML = symbols.filter((s) => !s.error).map((s) => {
    const a = s.stats;
    if (!a.trades) return `<tr><td><strong>${esc(s.symbol)}</strong></td><td class="num">0</td><td class="num" colspan="5">-</td></tr>`;
    return `<tr>
      <td><strong>${esc(s.symbol)}</strong></td><td class="num">${a.trades}</td><td class="num">${pct0(a.winRate)}</td>
      <td class="num ${cls(a.expectancyNetR)}">${sgn(a.expectancyNetR)}R</td>
      <td class="num">${a.profitFactor == null ? "-" : a.profitFactor.toFixed(2)}</td>
      <td class="num ${cls(a.totalNetR)}">${sgn(a.totalNetR)}R</td><td class="num">−${a.maxDrawdownR.toFixed(1)}R</td>
    </tr>`;
  }).join("");
}

function renderBySetup(a) {
  const rows = Object.entries(a.bySetup || {});
  $("dt-bysetup").innerHTML = rows.length
    ? rows.map(([k, v]) => `<tr><td>${esc(SETUP_NAMES[k] || k)}</td><td class="num">${v.trades}</td><td class="num">${pct0(v.winRate)}</td><td class="num ${cls(v.netR)}">${sgn(v.netR)}R</td></tr>`).join("")
    : `<tr><td colspan="4" class="dt-empty">No trades.</td></tr>`;
}

function renderTrades(trades, total) {
  $("dt-trades").innerHTML = trades.length
    ? trades.map((t) => `<tr>
        <td>${esc(et(t.entryTime))}</td><td><strong>${esc(t.symbol)}</strong></td><td class="tight">${esc(SETUP_NAMES[t.setup] || t.setup)}</td>
        <td class="num">${price(t.entry)}</td><td class="num">${price(t.exit)}</td><td class="num">${qty(t.shares)}</td>
        <td class="tight">${esc(EXIT_NAMES[t.exitReason] || t.exitReason)}${t.partial ? ` <span class="dt-new" title="Half was sold at +1R, then the stop moved to the buy price">&frac12; at 1R</span>` : ""}</td>
        <td class="num ${cls(t.netR)}">${sgn(t.netR)}R</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td>
      </tr>`).join("")
    : `<tr><td colspan="9" class="dt-empty">No trades.</td></tr>`;
  const shown = trades.length;
  const sumR = trades.reduce((t, x) => t + x.netR, 0);
  const sumPnl = trades.reduce((t, x) => t + x.pnl, 0);
  $("dt-trades-foot").innerHTML = shown
    ? `<tr class="dt-total"><td colspan="7">Total, ${shown} trade${shown === 1 ? "" : "s"}</td><td class="num ${cls(sumR)}">${sgn(sumR)}R</td><td class="num ${cls(sumPnl)}">${money(sumPnl)}</td></tr>`
    : "";
  $("dt-trades-count").textContent = shown
    ? (total > shown ? `(newest ${shown} of ${total})` : `(${shown}, newest first)`)
    : "";
}

function render(data, equity) {
  const a = data.aggregate;
  const warn = $("dt-warn");
  const notes = [...(data.warnings || []), a.sampleWarning].filter(Boolean);
  warn.hidden = !notes.length;
  warn.textContent = notes.join(" ");
  renderTiles(a, equity);
  renderCurve(a.curve);
  renderScan(data.symbols, equity);
  renderBySymbol(data.symbols);
  renderByClass(data);
  renderBySetup(a);
  renderTrades(data.recentTrades, data.tradesTotal ?? data.recentTrades.length);
  dashBalance.render(data.recentTrades, data.config.equity, data.tradesTotal ?? data.recentTrades.length);
  $("dt-results").hidden = false;
  $("dt-updated").innerHTML = `Run at <strong>${new Date(data.generatedAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>`;
}

// The settings (everything except which symbols) as query parameters, shared by the normal run and the S&P 500 scan.
function settingsParams(s) {
  const qs = new URLSearchParams();
  if (s.equity) qs.set("equity", s.equity);
  if (s.riskPct) qs.set("riskPct", s.riskPct);
  if (Number(s.dollars) > 0) qs.set("dollars", s.dollars);
  if (s.targetR) qs.set("targetR", s.targetR);
  if (s.slipBps !== "") qs.set("slipBps", s.slipBps);
  if (s.cryptoSlipBps !== "") qs.set("cryptoSlipBps", s.cryptoSlipBps);
  qs.set("orb", s.orb ? "1" : "0");
  qs.set("vwap", s.vwap ? "1" : "0");
  for (const k of Object.keys(CHECKS)) qs.set(k, s[k] ? "1" : "0");
  qs.set("exit", s.exit);
  return qs;
}

// ---------------------------------------------------------------- running
let runToken = 0;
async function run() {
  const s = readForm();
  saveSettings(s);
  if (!picker.selected.length) { spRun(); return; }   // empty box: the whole S&P 500
  if (sp.running) { $("dt-status").className = "status"; $("dt-status").textContent = "The S&P 500 scan is still running. Stop it first, or wait for it to finish."; return; }
  $("dt-sp").hidden = true;
  const token = ++runToken;
  const qs = settingsParams(s);
  qs.set("symbols", s.symbols);

  $("f-run").disabled = true;
  $("dt-status").className = "status";
  $("dt-status").textContent = "Fetching 5-minute prices and running the backtest...";
  try {
    const r = await fetch(`/api/daytrade?${qs}`);
    const data = await r.json().catch(() => ({}));
    if (token !== runToken) return;
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    render(data, Number(s.equity) || data.config.equity);
    $("dt-status").textContent = "";
  } catch (e) {
    if (token !== runToken) return;
    $("dt-status").className = "status error";
    $("dt-status").textContent = `Could not run: ${e.message}`;
  } finally {
    if (token === runToken) $("f-run").disabled = false;
  }
}

// ---------------------------------------------------------------- symbol picker
// A searchable multi-select: type to filter, arrow keys + Enter (or tap) to add, x to remove.
const MAX_SYMBOLS = 10;                       // the API tests at most 10 symbols per run
// Only used if /api/daytrade-symbols can't be reached; the server's list (lib/daytrade/markets.js) is the source of truth.
const FALLBACK_OPTIONS = [
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", tag: "ETF" },
  { symbol: "BTC-USD", name: "Bitcoin", tag: "Crypto" }, { symbol: "ETH-USD", name: "Ethereum", tag: "Crypto" },
  { symbol: "BNB-USD", name: "BNB", tag: "Crypto" }, { symbol: "XRP-USD", name: "XRP", tag: "Crypto" },
  { symbol: "SOL-USD", name: "Solana", tag: "Crypto" },
];
const picker = { selected: [], options: FALLBACK_OPTIONS, shown: [], active: 0, open: false, freeText: true, stockCount: 0 };
const isCryptoSym = (sym) => /-USD$/.test(sym);
const SYMBOL_RE = /^[A-Z0-9.^-]{1,10}$/;

function parseSymbols(text) {
  const out = [];
  for (const raw of String(text).split(",")) {
    const sym = raw.trim().toUpperCase();
    if (SYMBOL_RE.test(sym) && !out.includes(sym)) out.push(sym);
  }
  return out.slice(0, MAX_SYMBOLS);
}

function optionName(sym) { return picker.options.find((o) => o.symbol === sym)?.name || ""; }

function renderChips() {
  $("chips").innerHTML = picker.selected.map((sym) =>
    `<span class="dt-chip${isCryptoSym(sym) ? " crypto" : ""}" title="${esc(optionName(sym))}">${esc(sym)}<button type="button" data-remove="${esc(sym)}" aria-label="Remove ${esc(sym)}">&times;</button></span>`).join("");
  const n = picker.selected.length;
  const count = $("f-count");
  count.textContent = `(${n} of ${MAX_SYMBOLS})`;
  count.classList.toggle("full", n >= MAX_SYMBOLS);
  updateRunLabel();
}

// Blank Symbols box = scan the whole S&P 500; otherwise a quick test of the picked symbols.
function updateRunLabel() {
  const b = $("f-run");
  if (!b) return;
  b.textContent = picker.selected.length ? "Run backtest" : "Run on the whole S&P 500";
}

function setSelected(list) {
  picker.selected = list.slice(0, MAX_SYMBOLS);
  renderChips();
  renderList();
}

function addSymbol(sym) {
  $("f-note").textContent = "";
  if (picker.selected.includes(sym)) return;
  if (picker.selected.length >= MAX_SYMBOLS) { $("f-count").classList.add("full"); return; }
  picker.selected.push(sym);
  $("f-search").value = "";
  picker.active = 0;
  renderChips();
  renderList();
}

function removeSymbol(sym) {
  $("f-note").textContent = "";
  picker.selected = picker.selected.filter((x) => x !== sym);
  renderChips();
  renderList();
}

/** Options matching the typed text, best matches first. */
function search(text) {
  const q = text.trim().toLowerCase();
  const taken = new Set(picker.selected);
  const avail = picker.options.filter((o) => !taken.has(o.symbol));
  if (!q) return { head: avail.filter((o) => o.tag === "ETF" || o.tag === "Crypto"), stocks: avail.filter((o) => o.tag !== "ETF" && o.tag !== "Crypto"), browsing: true };
  const scored = [];
  for (const o of avail) {
    const sym = o.symbol.toLowerCase(), name = o.name.toLowerCase();
    let score = -1;
    if (sym === q) score = 0;
    else if (sym.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(" " + q)) score = 3;
    else if (sym.includes(q)) score = 4;
    else if (name.includes(q)) score = 5;
    if (score >= 0) scored.push([score, o]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].symbol.localeCompare(b[1].symbol));
  return { head: scored.map((x) => x[1]), stocks: [], browsing: false };
}

function renderList() {
  const list = $("f-list"), input = $("f-search");
  if (!picker.open) { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); return; }
  const { head, stocks, browsing } = search(input.value);
  const SHOW_STOCKS = 40, SHOW_MATCHES = 50;
  const shown = browsing ? [...head, ...stocks.slice(0, SHOW_STOCKS)] : head.slice(0, SHOW_MATCHES);
  picker.shown = shown;
  picker.active = Math.min(picker.active, Math.max(0, shown.length - 1));

  const item = (o, i) => `<li role="option" id="opt-${i}" data-sym="${esc(o.symbol)}" aria-selected="${i === picker.active}"><strong>${esc(o.symbol)}</strong><span class="nm">${esc(o.name)}</span><span class="tag">${esc(o.tag)}</span></li>`;
  let html = "";
  if (browsing) {
    if (head.length) html += `<li class="group" role="presentation">Index fund and crypto</li>` + head.map((o, i) => item(o, i)).join("");
    if (stocks.length) html += `<li class="group" role="presentation">S&amp;P 500 stocks</li>` + stocks.slice(0, SHOW_STOCKS).map((o, i) => item(o, head.length + i)).join("");
    if (stocks.length > SHOW_STOCKS) html += `<li class="note" role="presentation">Showing ${SHOW_STOCKS} of ${stocks.length}. Type a ticker or company name to search them all.</li>`;
  } else {
    html = shown.map((o, i) => item(o, i)).join("");
    if (head.length > SHOW_MATCHES) html += `<li class="note" role="presentation">Showing the first ${SHOW_MATCHES} matches. Keep typing to narrow it down.</li>`;
  }
  if (!shown.length) {
    const typed = input.value.trim().toUpperCase();
    html = picker.freeText && SYMBOL_RE.test(typed)
      ? `<li class="note" role="presentation">The symbol list could not be loaded. Press Enter to add ${esc(typed)}.</li>`
      : `<li class="note" role="presentation">${input.value.trim() ? "No matches in the S&amp;P 500, SPY or the top crypto list." : "Everything available is already selected."}</li>`;
  }
  if (picker.selected.length >= MAX_SYMBOLS) html = `<li class="note" role="presentation">You have picked the maximum of ${MAX_SYMBOLS}. Remove one to add another.</li>`;
  list.innerHTML = html;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  const act = $(`opt-${picker.active}`);
  if (act && shown.length) { input.setAttribute("aria-activedescendant", act.id); act.scrollIntoView?.({ block: "nearest" }); }
}

function openList() { picker.open = true; renderList(); }
function closeList() { picker.open = false; renderList(); }

function wirePicker() {
  const input = $("f-search"), list = $("f-list");
  input.addEventListener("focus", openList);
  input.addEventListener("input", () => { picker.active = 0; openList(); });
  // Small delay so a tap on a list item (which can blur the box first on phones) still registers.
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) closeList(); }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!picker.open) { openList(); return; }
      const n = picker.shown.length;
      if (n) { picker.active = (picker.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n; renderList(); }
    } else if (e.key === "Enter") {
      e.preventDefault();                       // never submit the form from the search box
      const pick = picker.shown[picker.active];
      const typed = input.value.trim().toUpperCase();
      if (pick) addSymbol(pick.symbol);
      else if (picker.freeText && SYMBOL_RE.test(typed)) addSymbol(typed);
    } else if (e.key === "Escape") {
      closeList();
    } else if (e.key === "Backspace" && !input.value && picker.selected.length) {
      removeSymbol(picker.selected[picker.selected.length - 1]);
    }
  });
  // mousedown (not click) so the input keeps focus and the list doesn't close before the pick registers
  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("li[data-sym]");
    if (li) addSymbol(li.dataset.sym);
  });
  $("picker").addEventListener("click", (e) => {
    const rm = e.target.closest("button[data-remove]");
    if (rm) { removeSymbol(rm.dataset.remove); return; }
    input.focus();
  });
  $("q-crypto").addEventListener("click", () => {
    const missing = picker.options.filter((o) => o.tag === "Crypto" && !picker.selected.includes(o.symbol)).map((o) => o.symbol);
    const room = Math.max(0, MAX_SYMBOLS - picker.selected.length);
    setSelected([...picker.selected, ...missing.slice(0, room)]);
    $("f-note").textContent = missing.length > room ? `Added ${room} of ${missing.length}: the limit is ${MAX_SYMBOLS} symbols per run.` : "";
  });
  $("q-clear").addEventListener("click", () => { setSelected([]); $("f-note").textContent = ""; });
}

async function loadOptions() {
  try {
    const r = await fetch("/api/daytrade-symbols");
    const data = await r.json();
    if (!r.ok || !Array.isArray(data.options) || !data.options.length) throw new Error("bad list");
    picker.options = data.options;
    picker.stockCount = data.stockCount || 0;
    picker.freeText = !data.sp500Loaded;       // typed tickers are only allowed when the stock list is missing
    $("f-loaded").textContent = data.sp500Loaded
      ? `${data.stockCount} S&P 500 stocks, SPY and 5 crypto loaded.`
      : "The S&P 500 list could not be loaded. You can still type a ticker and press Enter.";
  } catch {
    picker.freeText = true;
    $("f-loaded").textContent = "The symbol list could not be loaded. Type a ticker and press Enter to add it.";
  }
  renderChips();
  renderList();
  spOptionsLoaded();
}



// ================================================================ account balance chart
// Balance = account size + the dollar result of every sold trade so far. Buys and sells are placed on a
// time axis where overnight and weekend gaps are squeezed out, so a day's trading looks like a day.
const etDay = (ts) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayLabel = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };


// One chart per card, so the main results and the S&P 500 scan each get their own.
function makeBalanceChart(card) {
  const q = (sel) => card.querySelector(sel);
  const box = q(".bal-svg");
  const bal = { events: [], days: [], times: [], xOf: new Map(), equity: 0, win: null, offset: 0, total: 0, sel: -1, key: "" };
function balPrepare(trades, equity) {
  const list = [...trades].sort((a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime);
  const events = [];
  list.forEach((t, k) => {
    events.push({ kind: "buy", time: t.entryTime, t, k });
    events.push({ kind: "sell", time: t.exitTime, t, k });
  });
  // sells before buys at the same instant, so a freed-up balance is counted before the next buy
  events.sort((a, b) => a.time - b.time || (a.kind === "sell" ? -1 : 1) - (b.kind === "sell" ? -1 : 1) || a.k - b.k);
  let balance = equity;
  for (const e of events) {
    if (e.kind === "sell") balance += e.t.pnl;
    e.balance = balance;
    e.day = etDay(e.time);
  }
  // squeezed time axis: any gap over 8 hours counts as 30 minutes
  const times = [...new Set(events.map((e) => e.time))].sort((a, b) => a - b);
  const xOf = new Map();
  let x = 0;
  times.forEach((t, i) => {
    if (i) { const dt = t - times[i - 1]; x += dt > 8 * 3600 ? 1800 : dt; }
    xOf.set(t, x);
  });
  bal.events = events; bal.times = times; bal.xOf = xOf; bal.equity = equity;
  bal.days = [...new Set(events.map((e) => e.day))].sort();
}

function render(trades, equity, total, key = "") {
  if (!trades || !trades.length) { card.hidden = true; return; }
  card.hidden = false;
  const first = !bal.events.length || bal.total !== total || bal.equity !== equity || bal.key !== key;
  balPrepare(trades, equity);
  bal.total = total; bal.key = key;
  if (bal.win == null || first) {
    bal.win = balDefaultWindow();
    bal.offset = 0; bal.sel = -1;
  }
  balDraw();
  q(".bal-note").textContent = total > trades.length ? `(newest ${trades.length} of ${total} trades)` : `(${trades.length} trades)`;
}

function balDefaultWindow() {
  // the widest range that still has a readable number of markers
  const n = bal.days.length;
  for (const w of ["all", 20, 5]) {
    const k = w === "all" ? n : Math.min(w, n);
    const set = new Set(bal.days.slice(n - k));
    if (bal.events.filter((e) => set.has(e.day)).length <= 150) return w;
  }
  return 1;
}

function balWindowDays() {
  const n = bal.days.length;
  const win = bal.win === "all" ? n : Math.min(bal.win, n);
  const end = Math.max(win, n - bal.offset);
  return { win, start: end - win, end };
}

function balDraw() {
  const n = bal.days.length;
  const { win, start, end } = balWindowDays();
  const shownDays = bal.days.slice(start, end);
  const dset = new Set(shownDays);
  const ev = bal.events.filter((e) => dset.has(e.day));
  const W = 720, H = 270, pl = 62, pr = 14, pt = 14, pb = 26;

  // balance just before the first visible event
  const firstIdx = bal.events.indexOf(ev[0]);
  const startBal = firstIdx > 0 ? bal.events[firstIdx - 1].balance : bal.equity;
  const x0 = bal.xOf.get(ev[0].time), x1 = bal.xOf.get(ev[ev.length - 1].time);
  const span = Math.max(x1 - x0, 600);
  const xa = x0 - span * 0.03, xb = x1 + span * 0.03;
  const X = (t) => pl + ((bal.xOf.get(t) - xa) / (xb - xa)) * (W - pl - pr);

  const vals = [startBal, ...ev.map((e) => e.balance)];
  if (start === 0) vals.push(bal.equity);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const c = (hi + lo) / 2; hi = c + 0.5; lo = c - 0.5; }
  const padY = (hi - lo) * 0.1; hi += padY; lo -= padY;
  const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);

  // step line: flat until a sell, then straight to the new balance
  let cur = startBal;
  let d = `M${pl},${Y(cur).toFixed(1)}`;
  for (const e of ev) {
    if (e.kind !== "sell") continue;
    const px = X(e.time).toFixed(1);
    d += ` L${px},${Y(cur).toFixed(1)} L${px},${Y(e.balance).toFixed(1)}`;
    cur = e.balance;
  }
  d += ` L${W - pr},${Y(cur).toFixed(1)}`;

  // day separators and labels
  const byDay = new Map();
  for (const e of ev) { if (!byDay.has(e.day)) byDay.set(e.day, []); byDay.get(e.day).push(e); }
  const dayList = [...byDay.keys()];
  const every = Math.max(1, Math.ceil(dayList.length / 7));
  let seps = "", labels = "";
  dayList.forEach((day, i) => {
    const es = byDay.get(day);
    const xs = es.map((e) => X(e.time));
    const left = Math.min(...xs), right = Math.max(...xs);
    if (i) { const prevRight = Math.max(...byDay.get(dayList[i - 1]).map((e) => X(e.time))); const mid = (prevRight + left) / 2; seps += `<line class="day" x1="${mid.toFixed(1)}" x2="${mid.toFixed(1)}" y1="${pt}" y2="${H - pb}"></line>`; }
    if (i % every === 0) labels += `<text class="lbl" x="${((left + right) / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(dayLabel(day))}</text>`;
  });

  const r = ev.length <= 60 ? 6 : ev.length <= 200 ? 4.5 : 3.2;
  const focusable = ev.length <= 150;
  const markers = ev.map((e) => {
    const cx = X(e.time), cy = Y(e.balance);
    const up = e.kind === "buy";
    const pts = up
      ? `${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy + r * 0.8).toFixed(1)} ${(cx + r).toFixed(1)},${(cy + r * 0.8).toFixed(1)}`
      : `${cx.toFixed(1)},${(cy + r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy - r * 0.8).toFixed(1)} ${(cx + r).toFixed(1)},${(cy - r * 0.8).toFixed(1)}`;
    const t = e.t;
    const label = up
      ? `Buy ${t.symbol}: ${qty(t.shares)} shares at ${price(t.entry)}, ${et(t.entryTime)}`
      : `Sell ${t.symbol}: ${qty(t.shares)} shares at ${price(t.exit)}, ${et(t.exitTime)}, ${money(t.pnl)}`;
    const id = bal.events.indexOf(e);
    return `<polygon class="mk ${up ? "buy" : "sell " + (t.pnl > 0 ? "win" : "loss")}${id === bal.sel ? " sel" : ""}" points="${pts}" data-i="${id}"${focusable ? ' tabindex="0" role="button"' : ""} aria-label="${esc(label)}"><title>${esc(label)}</title></polygon>`;
  }).join("");

  const startLine = start === 0 && bal.equity >= lo && bal.equity <= hi
    ? `<line class="start" x1="${pl}" x2="${W - pr}" y1="${Y(bal.equity).toFixed(1)}" y2="${Y(bal.equity).toFixed(1)}"></line>` : "";
  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Account balance over ${shownDays.length} trading day${shownDays.length === 1 ? "" : "s"} with ${ev.length} buy and sell markers">
      <line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(hi).toFixed(1)}" y2="${Y(hi).toFixed(1)}"></line>
      <line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(lo).toFixed(1)}" y2="${Y(lo).toFixed(1)}"></line>
      ${startLine}${seps}
      <path class="line" d="${d}"></path>
      ${markers}
      <text class="lbl" x="${pl - 6}" y="${Y(hi).toFixed(1)}" text-anchor="end" dominant-baseline="hanging">${money(hi).replace(/\.\d\d$/, "")}</text>
      <text class="lbl" x="${pl - 6}" y="${Y(lo).toFixed(1)}" text-anchor="end">${money(lo).replace(/\.\d\d$/, "")}</text>
      ${labels}
    </svg>`;

  // controls
  card.querySelectorAll(".bal-win").forEach((b) => {
    const w = b.dataset.win === "all" ? "all" : Number(b.dataset.win);
    b.setAttribute("aria-pressed", String(w === bal.win));
  });
  q(".bal-prev").disabled = start <= 0;
  q(".bal-next").disabled = end >= n;
  const endBal = ev[ev.length - 1].kind === "sell" ? ev[ev.length - 1].balance : cur;
  q(".bal-range").textContent = `${dayLabel(shownDays[0])}${shownDays.length > 1 ? ` to ${dayLabel(shownDays[shownDays.length - 1])}` : ""} (${shownDays.length} of ${n} days). Balance ${money(startBal)} → ${money(endBal)}.`;
}

function balSelect(i) {
  const e = bal.events[i];
  if (!e) return;
  bal.sel = i;
  const t = e.t;
  const buy = `Bought ${qty(t.shares)} ${t.symbol} at ${price(t.entry)} (${money(t.shares * t.entry)}) on ${et(t.entryTime)}`;
  const sell = `${t.partial ? `sold ${qty(t.partial.shares)} at ${price(t.partial.price)} (+1R), then the rest ` : ""}sold at ${price(t.exit)} on ${et(t.exitTime)}, ${EXIT_NAMES[t.exitReason] || t.exitReason}: ${money(t.pnl)} (${sgn(t.netR)}R)`;
  q(".bal-detail").textContent = `${SETUP_NAMES[t.setup] || t.setup}. ${buy}; ${sell}. Balance after the sale: ${money(bal.events.find((x) => x.kind === "sell" && x.k === e.k).balance)}.`;
  balDraw();
  const m = box.querySelector(`[data-i="${i}"]`);
  if (m && m.hasAttribute("tabindex")) m.focus();
}

function balInit() {
  card.querySelectorAll(".bal-win").forEach((b) => b.addEventListener("click", () => {
    bal.win = b.dataset.win === "all" ? "all" : Number(b.dataset.win);
    bal.offset = 0;
    balDraw();
  }));
  const shift = (dir) => {
    const { win, start, end } = balWindowDays();
    const n = bal.days.length;
    const newEnd = Math.min(n, Math.max(win, end + dir * win));
    bal.offset = n - newEnd;
    balDraw();
  };
  q(".bal-prev").addEventListener("click", () => shift(-1));
  q(".bal-next").addEventListener("click", () => shift(1));
  const pick = (e) => { const m = e.target.closest(".mk"); if (m) balSelect(Number(m.dataset.i)); };
  box.addEventListener("click", pick);
  box.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".mk")) { e.preventDefault(); pick(e); } });
}
  balInit();
  return { render };
}
const dashBalance = makeBalanceChart($("dt-balcard"));

// ================================================================ S&P 500 scan
// Runs the current settings on every S&P 500 stock, ten at a time (the API's per-run limit),
// two batches in flight. Each batch returns small ADDABLE totals per stock, so the page can
// combine them exactly into sector and whole-index numbers.
const sp = { rows: new Map(), failed: [], running: false, cancel: false, sort: { k: "exp", dir: -1 }, limit: 50, stocks: [], used: "", equity: 10000, slip: 2 };
const spBalance = makeBalanceChart($("sp-balcard"));
const SP_BATCH = 10, SP_PARALLEL = 2;

function spStocks() {
  return picker.options.filter((o) => o.tag !== "ETF" && o.tag !== "Crypto").map((o) => ({ symbol: o.symbol, sector: o.tag, name: o.name }));
}
function spOptionsLoaded() {
  sp.stocks = spStocks();
  const ok = sp.stocks.length >= 100;
  if (!ok && !picker.selected.length) { $("dt-status").className = "status error"; $("dt-status").textContent = "The S&P 500 list could not be loaded, so the whole-index scan is unavailable right now. Type some tickers or reload the page."; }
}

const spSum = (list, key = "all") => {
  const t = { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, sumWinR: 0, sumLossR: 0, pnl: 0 };
  for (const r of list) { const c = r[key]; if (!c) continue; for (const k of Object.keys(t)) t[k] += c[k]; }
  return t;
};
const spExp = (c) => (c && c.trades ? c.sumNetR / c.trades : null);
const spPF = (c) => (c && c.sumLossR > 0 ? c.sumWinR / c.sumLossR : null);

function spRowView(r) {
  const sector = (sp.stocks.find((x) => x.symbol === r.symbol) || {}).sector || "";
  const a = r.all;
  return {
    symbol: r.symbol, sector, trades: a.trades, winRate: a.trades ? a.wins / a.trades : null,
    exp: spExp(a), expGross: a.trades ? a.sumGrossR / a.trades : null, totalR: a.sumNetR, pnl: a.pnl,
    expFirst: spExp(r.first), nFirst: r.first.trades, expSecond: spExp(r.second), nSecond: r.second.trades,
  };
}


// Merge the diagnostics detail carried on each stock's "all" totals.
function spDetail(rows) {
  const d = { stopPctSum: 0, holdBarsSum: 0, partials: 0, byExit: {}, bySetup: {}, byHour: {} };
  for (const r of rows) {
    const a = r.all;
    if (!a || !a.byExit) continue;
    d.stopPctSum += a.stopPctSum; d.holdBarsSum += a.holdBarsSum; d.partials += a.partials;
    for (const [k, v] of Object.entries(a.byExit)) { const e = (d.byExit[k] ||= { trades: 0, sumNetR: 0 }); e.trades += v.trades; e.sumNetR += v.sumNetR; }
    for (const [k, v] of Object.entries(a.byHour || {})) {
      const h = (d.byHour[k] ||= { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, pnl: 0 });
      for (const f of Object.keys(h)) h[f] += v[f];
    }
    for (const [k, v] of Object.entries(a.bySetup)) {
      const g = (d.bySetup[k] ||= { trades: 0, wins: 0, sumNetR: 0, sumGrossR: 0, sumWinR: 0, sumLossR: 0, pnl: 0 });
      for (const f of Object.keys(g)) g[f] += v[f];
    }
  }
  return d;
}

const hourLabel = (m) => { const f = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`; return `${m === 540 ? "9:30" : f(m)}–${f(m + 60)}`; };

function spRenderDiagnostics(rows, all) {
  const d = spDetail(rows);
  const n = all.trades;
  if (!n) { $("sp-diag").innerHTML = ""; $("sp-bysetup").innerHTML = ""; $("sp-byexit").innerHTML = ""; $("sp-byhour").innerHTML = ""; return; }
  const losses = n - all.wins;
  const avgWin = all.wins ? all.sumWinR / all.wins : null;
  const avgLoss = losses ? all.sumLossR / losses : null;
  const gross = all.sumGrossR / n, net = all.sumNetR / n;
  const stopPct = d.stopPctSum / n;
  const costEst = stopPct > 0 ? ((2 * sp.slip) / 100) / stopPct : null;
  $("sp-diag").innerHTML = [
    tile("Average win", avgWin == null ? "-" : `+${avgWin.toFixed(2)}R`, "after costs", "pos", "The average winning trade. It has to be big enough, together with the win rate, to pay for the losers."),
    tile("Average loss", avgLoss == null ? "-" : `−${avgLoss.toFixed(2)}R`, "after costs", "neg", "The average losing trade. Around −1R is normal; more means gaps, slippage or exits that run past the stop."),
    tile("Before costs", `${sgn(gross)}R`, "per trade, if trading were free", cls(gross), "The average result per trade ignoring slippage. If this is near zero or negative, the setups have no edge to protect, and cutting costs will not fix it."),
    tile("After costs", `${sgn(net)}R`, `costs take ${(gross - net).toFixed(2)}R per trade`, cls(net), "The average result per trade after slippage. Costs take the gap between this and the number above."),
    tile("Average stop distance", `${stopPct.toFixed(2)}%`, costEst == null ? "of the buy price" : `costs of about ${costEst.toFixed(2)}R at ${(2 * sp.slip).toFixed(1)} bps round trip`, "", "How far below the buy price the stop sat, on average. Tight stops mean fixed costs eat a larger share of each R."),
    tile("Average hold", `${Math.round((d.holdBarsSum / n) * 5)} min`, d.partials ? `${d.partials} trades sold half early` : "", "", "How long a trade stayed open on average."),
  ].join("");

  const setups = Object.entries(d.bySetup).sort((a, b) => b[1].sumNetR / b[1].trades - a[1].sumNetR / a[1].trades);
  $("sp-bysetup").innerHTML = setups.map(([k, g]) => {
    const l = g.trades - g.wins, gn = g.sumNetR / g.trades, gg = g.sumGrossR / g.trades;
    return `<tr><td>${esc(SETUP_NAMES[k] || k)}</td><td class="num">${g.trades}</td><td class="num">${pct0(g.wins / g.trades)}</td>
      <td class="num">${g.wins ? "+" + (g.sumWinR / g.wins).toFixed(2) + "R" : "-"}</td><td class="num">${l ? "−" + (g.sumLossR / l).toFixed(2) + "R" : "-"}</td>
      <td class="num ${cls(gg)}">${sgn(gg)}R</td><td class="num ${cls(gn)}">${sgn(gn)}R</td>
      <td class="num">${g.sumLossR > 0 ? (g.sumWinR / g.sumLossR).toFixed(2) : "-"}</td><td class="num ${cls(g.pnl)}">${money(g.pnl)}</td></tr>`;
  }).join("");

  const hours = Object.entries(d.byHour).sort((a, b) => Number(a[0]) - Number(b[0]));
  $("sp-byhour").innerHTML = hours.map(([k, h]) => {
    const gn = h.sumNetR / h.trades, gg = h.sumGrossR / h.trades;
    return `<tr><td>${hourLabel(Number(k))}</td><td class="num">${h.trades}</td><td class="num">${pct0(h.wins / h.trades)}</td>
      <td class="num ${cls(gg)}">${sgn(gg)}R</td><td class="num ${cls(gn)}">${sgn(gn)}R</td><td class="num ${cls(h.pnl)}">${money(h.pnl)}</td></tr>`;
  }).join("");

  const exits = Object.entries(d.byExit).sort((a, b) => b[1].trades - a[1].trades);
  $("sp-byexit").innerHTML = exits.map(([k, e]) => `<tr><td>${esc(EXIT_NAMES[k] || k)}</td><td class="num">${e.trades}</td><td class="num">${pct0(e.trades / n)}</td><td class="num ${cls(e.sumNetR)}">${sgn(e.sumNetR / e.trades)}R</td></tr>`).join("");
}

function spRender() {
  const rows = [...sp.rows.values()];
  if (!rows.length) { $("sp-results").hidden = true; return; }
  $("sp-results").hidden = false;
  const all = spSum(rows), first = spSum(rows, "first"), second = spSum(rows, "second");
  const total = sp.stocks.length;
  $("sp-tiles").innerHTML = [
    tile("Stocks tested", String(rows.length), `of ${total}`, "", "Stocks that were tested without an error. A stock with no trades still counts as tested."),
    tile("Trades", all.trades.toLocaleString("en-US"), `${rows.filter((r) => r.all.trades).length} stocks traded`, "", "Total simulated trades across every stock."),
    tile("Per trade, after costs", all.trades ? `${sgn(spExp(all))}R` : "-", "the number that matters", cls(spExp(all)), "Average result of one trade after costs, in R. Above zero is what you need."),
    tile("Win rate", all.trades ? pct0(all.wins / all.trades) : "-", "", "", "Share of trades that made money after costs."),
    tile("Profit factor", spPF(all) == null ? "-" : spPF(all).toFixed(2), "above 1 means wins outweigh losses", spPF(all) == null ? "" : spPF(all) > 1 ? "pos" : "neg", "Money won divided by money lost."),
    tile("Total result", money(all.pnl), `${sgn(all.sumNetR, 1)}R`, cls(all.pnl), "Every stock's result added together, as if each had its own account of the size above. Not one account's result."),
    tile("Older half", first.trades ? `${sgn(spExp(first))}R` : "-", `${first.trades} trades, per trade`, cls(spExp(first)), "Per-trade result using only the older half of the tested days."),
    tile("Newer half", second.trades ? `${sgn(spExp(second))}R` : "-", `${second.trades} trades, per trade`, cls(spExp(second)), "Per-trade result using only the newer half. If it disagrees with the older half, treat the result as noise."),
  ].join("");

  spRenderDiagnostics(rows, all);

  // by sector
  const bySector = new Map();
  for (const r of rows) {
    const sec = (sp.stocks.find((x) => x.symbol === r.symbol) || {}).sector || "Other";
    if (!bySector.has(sec)) bySector.set(sec, []);
    bySector.get(sec).push(r);
  }
  const secRows = [...bySector.entries()].map(([name, list]) => ({ name, n: list.length, a: spSum(list), f: spSum(list, "first"), s: spSum(list, "second") }))
    .sort((x, y) => (spExp(y.a) ?? -99) - (spExp(x.a) ?? -99));
  const half = (c) => (c.trades ? `${sgn(spExp(c))}R <span class="hint">(${c.trades})</span>` : "-");
  $("sp-sectors").innerHTML = secRows.map((x) => `<tr>
      <td>${esc(x.name)}</td><td class="num">${x.n}</td><td class="num">${x.a.trades}</td>
      <td class="num">${x.a.trades ? pct0(x.a.wins / x.a.trades) : "-"}</td>
      <td class="num ${cls(spExp(x.a))}">${x.a.trades ? sgn(spExp(x.a)) + "R" : "-"}</td>
      <td class="num ${cls(x.a.pnl)}">${money(x.a.pnl)}</td>
      <td class="num ${cls(spExp(x.f))}">${half(x.f)}</td><td class="num ${cls(spExp(x.s))}">${half(x.s)}</td></tr>`).join("");

  spRenderStocks();
  const nFailed = sp.failed.length;
  $("sp-failed").hidden = !nFailed;
  $("sp-failed").textContent = nFailed ? `${nFailed} stock${nFailed === 1 ? "" : "s"} could not be tested (usually Yahoo rate-limiting or missing data): ${sp.failed.slice(0, 40).join(", ")}${nFailed > 40 ? ", ..." : ""}. Use "Retry failed" to try them again.` : "";
  $("sp-retry").hidden = !nFailed || sp.running;
  $("sp-csv").hidden = false;
}


// Charts for the scan: all tested stocks together, or one stock. Drawn when a scan finishes (not batch by batch,
// so the zoom does not jump while it runs).
function spCurve(trades) {
  let cum = 0;
  return [...trades].sort((a, b) => a.exitTime - b.exitTime).map((t) => { cum += t.netR; return { cumR: Math.round(cum * 100) / 100, date: t.date }; });
}
function spRenderCharts() {
  $("sp-charts").hidden = false;
  const sel = $("sp-chart-sym");
  const withTrades = [...sp.rows.values()].filter((r) => r.trades && r.trades.length).map((r) => r.symbol).sort();
  const keep = sel.value;
  sel.innerHTML = `<option value="">All stocks together</option>` + withTrades.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  sel.value = withTrades.includes(keep) ? keep : "";
  const sym = sel.value;
  const trades = [];
  for (const r of sp.rows.values()) if (r.trades && (!sym || r.symbol === sym)) trades.push(...r.trades);
  $("sp-chart-note").textContent = sym ? `${sym} only.` : `${withTrades.length} stocks with trades.`;
  renderCurve(spCurve(trades), "sp-curve", "sp-curve-note");
  spBalance.render(trades, sp.equity, trades.length, sym);
}

function spRenderStocks() {
  const min = Number($("sp-min").value) || 1;
  const view = [...sp.rows.values()].map(spRowView).filter((v) => v.trades >= min);
  const { k, dir } = sp.sort;
  view.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return typeof x === "string" ? dir * x.localeCompare(y) : dir * (x - y);
  });
  const shown = view.slice(0, sp.limit);
  const half = (e, n) => (e == null ? "-" : `${sgn(e)}R <span class="hint">(${n})</span>`);
  $("sp-body").innerHTML = shown.length ? shown.map((v) => `<tr>
      <td><button type="button" class="dt-linkbtn" data-sym="${esc(v.symbol)}" title="Show only ${esc(v.symbol)} in the charts above">${esc(v.symbol)}</button></td><td class="tight">${esc(v.sector)}</td><td class="num">${v.trades}</td>
      <td class="num">${pct0(v.winRate)}</td>
      <td class="num ${cls(v.exp)}">${sgn(v.exp)}R</td><td class="num ${cls(v.pnl)}">${money(v.pnl)}</td>
      <td class="num ${cls(v.expFirst)}">${half(v.expFirst, v.nFirst)}</td><td class="num ${cls(v.expSecond)}">${half(v.expSecond, v.nSecond)}</td></tr>`).join("")
    : `<tr><td colspan="8" class="dt-empty">No stock has that many trades yet.</td></tr>`;
  $("sp-shown").textContent = `${view.length} of ${sp.rows.size} tested stocks have at least ${min} trade${min === 1 ? "" : "s"}.`;
  const more = $("sp-more");
  more.hidden = view.length <= sp.limit;
  more.textContent = `Show all ${view.length}`;
  document.querySelectorAll("#sp-table th.sortable").forEach((th) => {
    th.setAttribute("aria-sort", th.dataset.k === k ? (dir > 0 ? "ascending" : "descending") : "none");
  });
}

function spProgress(done, total, extra = "") {
  $("sp-bar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("sp-progress-text").textContent = `${done} of ${total} stocks${extra}`;
}

function spSettingsNote(s) {
  const on = [s.orb && "opening-range breakout", s.vwap && "VWAP reclaim", s.flag && "bull flag", s.tri && "ascending triangle", s.pb && "pullback", s.fib && "Fibonacci", s.dbot && "double bottom", s.gap && "gap and go"].filter(Boolean);
  const filt = [s.mkt && "market up", s.inplay && "in play", s.midday && "no midday", s.partial && "half off at 1R"].filter(Boolean);
  return `Settings used: ${on.join(", ") || "no setups"}${filt.length ? `; filters: ${filt.join(", ")}` : ""}; ${s.exit === "measured" ? "measured-move" : `${s.targetR}R`} target; ${s.slipBps} bps slippage; $${Number(s.equity).toLocaleString("en-US")} account, ${Number(s.dollars) > 0 ? `$${s.dollars} per buy` : `${s.riskPct}% risk`}.`;
}

async function spRun(only = null) {
  if (sp.running) return;
  if (!sp.stocks.length) {
    $("dt-status").className = "status error";
    $("dt-status").textContent = "The S&P 500 list could not be loaded, so the whole-index scan is unavailable. Pick some symbols instead, or reload the page.";
    return;
  }
  const s = readForm();
  saveSettings(s);
  if (!s.orb && !s.vwap && !s.flag && !s.tri && !s.pb && !s.fib && !s.dbot && !s.gap) {
    $("dt-status").className = "status error";
    $("dt-status").textContent = "Switch on at least one setup above first.";
    return;
  }
  runToken++;                       // drop any single-run answer still in flight
  $("dt-results").hidden = true; $("dt-status").textContent = "";
  $("dt-sp").hidden = false;
  $("dt-sp").scrollIntoView({ behavior: "smooth", block: "start" });
  const symbols = only || sp.stocks.map((x) => x.symbol);
  if (!only) sp.rows.clear();
  sp.failed = [];
  sp.running = true; sp.cancel = false;
  sp.used = spSettingsNote(s);
  sp.equity = Number(s.equity) || 10000;
  sp.slip = Number(s.slipBps) || 0;
  $("sp-used").textContent = sp.used;
  $("f-run").disabled = true; $("sp-cancel").hidden = false; $("sp-retry").hidden = true;
  $("sp-progress").hidden = false;
  $("sp-status").className = "status";
  $("sp-status").textContent = (only ? "Retrying the stocks that failed..." : "Scanning the S&P 500. You can keep this page open while it runs...") + " The charts appear when it finishes.";

  const queue = [];
  for (let i = 0; i < symbols.length; i += SP_BATCH) queue.push(symbols.slice(i, i + SP_BATCH));
  const warnings = new Set();
  let done = 0, lastErr = "";
  const worker = async () => {
    while (!sp.cancel) {
      const batch = queue.shift();
      if (!batch) return;
      try {
        const qs = settingsParams(s);
        qs.set("symbols", batch.join(","));
        qs.set("scan", "1");
        const r = await fetch(`/api/daytrade?${qs}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
        (data.warnings || []).forEach((w) => warnings.add(w));
        for (const row of data.symbols || []) {
          if (row.error || !row.all) sp.failed.push(row.symbol); else sp.rows.set(row.symbol, row);
        }
      } catch (e) {
        lastErr = e.message || String(e);
        sp.failed.push(...batch);
      }
      done += batch.length;
      spProgress(done, symbols.length, sp.failed.length ? `, ${sp.failed.length} failed` : "");
      spRender();
    }
  };
  await Promise.all(Array.from({ length: SP_PARALLEL }, worker));

  const stopped = sp.cancel;
  sp.running = false;
  $("sp-cancel").hidden = true; $("f-run").disabled = false; $("sp-progress").hidden = true;
  if (stopped) sp.failed.push(...queue.flat()); // never started: offer them in "Retry failed"
  spRender();
  spRenderCharts();
  $("sp-status").className = sp.rows.size ? "status" : "status error";
  $("sp-status").textContent = (stopped ? "Stopped. " : "Done. ") + `${sp.rows.size} stocks tested${sp.failed.length ? `, ${sp.failed.length} not tested${lastErr ? ` (last error: ${lastErr})` : ""}` : ""}.`
    + (warnings.size ? " " + [...warnings].join(" ") : "");
}

function spCsv() {
  const head = ["symbol", "sector", "trades", "win_rate", "net_r_per_trade", "gross_r_per_trade", "total_net_r", "pnl_dollars", "older_half_trades", "older_half_net_r_per_trade", "newer_half_trades", "newer_half_net_r_per_trade"];
  const f = (x, d = 4) => (x == null ? "" : Number(x).toFixed(d));
  const lines = [head.join(",")];
  for (const r of [...sp.rows.values()]) {
    const v = spRowView(r);
    lines.push([v.symbol, `"${v.sector.replace(/"/g, '""')}"`, v.trades, f(v.winRate), f(v.exp), f(v.expGross), f(v.totalR, 2), f(v.pnl, 2), v.nFirst, f(v.expFirst), v.nSecond, f(v.expSecond)].join(","));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sp500-scan-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function spInit() {
  $("sp-cancel").addEventListener("click", () => { sp.cancel = true; $("sp-status").textContent = "Stopping after the batches already running..."; });
  $("sp-retry").addEventListener("click", () => spRun([...new Set(sp.failed)]));
  $("sp-csv").addEventListener("click", spCsv);
  $("sp-chart-sym").addEventListener("change", spRenderCharts);
  $("sp-body").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sym]");
    if (!b || sp.running) return;
    $("sp-chart-sym").value = b.dataset.sym;
    spRenderCharts();
    $("sp-chart-sym").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("sp-min").addEventListener("change", () => { sp.limit = 50; spRenderStocks(); });
  $("sp-more").addEventListener("click", () => { sp.limit = 1000; spRenderStocks(); });
  document.querySelectorAll("#sp-table th.sortable").forEach((th) => {
    th.tabIndex = 0;
    const go = () => {
      const k = th.dataset.k;
      sp.sort = { k, dir: sp.sort.k === k ? -sp.sort.dir : (k === "symbol" || k === "sector" ? 1 : -1) };
      spRenderStocks();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
spInit();

$("dt-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
wirePicker();
loadSettings();
loadOptions();
if (picker.selected.length) run();
else { $("dt-status").className = "status"; $("dt-status").textContent = "Ready. With the Symbols box empty, Run tests the whole S&P 500 (a few minutes); pick up to 10 symbols for a quick test."; }

// Show/hide every explanation (setting help, tile and chart notes, column guides). Collapsed by default.
(function wireExplain() {
  const btn = document.getElementById("dt-explain");
  if (!btn) return;
  const apply = (on) => {
    document.body.classList.toggle("dt-explain", on);
    btn.setAttribute("aria-expanded", String(on));
    document.getElementById("dt-explain-label").textContent = on ? "Hide explanations" : "Show explanations";
    document.querySelectorAll("details.dt-guide").forEach((d) => { d.open = on; });
  };
  btn.addEventListener("click", () => apply(btn.getAttribute("aria-expanded") !== "true"));
})();
