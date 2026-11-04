// Day Trade Lab - front end (no build step, no dependencies)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "-" : (x < 0 ? "−" : "") + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const price = (x) => (x == null ? "-" : x.toFixed(2));
const sgn = (x, d = 2) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`);
const pct0 = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "pos" : "neg");
const SETUP_NAMES = { orb: "Opening-range breakout", vwap: "VWAP reclaim" };
const EXIT_NAMES = { target: "Target", stop: "Stop", "stop-gap": "Gap through stop", time: "3:45 flatten", "session-end": "Session end" };

const STORE_KEY = "daytrade-lab-settings";
const fields = { equity: "f-equity", riskPct: "f-risk", targetR: "f-target", slipBps: "f-slip", symbols: "f-symbols" };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!s) return;
    for (const [k, id] of Object.entries(fields)) if (s[k] != null) $(id).value = s[k];
    if (typeof s.orb === "boolean") $("f-orb").checked = s.orb;
    if (typeof s.vwap === "boolean") $("f-vwap").checked = s.vwap;
  } catch { /* storage may be unavailable; defaults are fine */ }
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
function readForm() {
  const s = {};
  for (const [k, id] of Object.entries(fields)) s[k] = $(id).value.trim();
  s.orb = $("f-orb").checked;
  s.vwap = $("f-vwap").checked;
  return s;
}

const et = (ts) => new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------------------------------------------------------------- rendering
function tile(label, value, sub = "", klass = "") {
  return `<div class="dt-tile"><div class="k">${esc(label)}</div><div class="v ${klass}">${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
}

function renderTiles(a, equity) {
  if (!a.trades) { $("dt-tiles").innerHTML = ""; return; }
  $("dt-tiles").innerHTML = [
    tile("Trades", String(a.trades), `avg hold ${Math.round(a.avgHoldMin)} min`),
    tile("Win rate", pct0(a.winRate), `avg win ${sgn(a.avgWinR)}R, avg loss −${a.avgLossR.toFixed(2)}R`),
    tile("Per trade, after costs", `${sgn(a.expectancyNetR)}R`, "the number that matters", cls(a.expectancyNetR)),
    tile("Per trade, before costs", `${sgn(a.expectancyGrossR)}R`, `costs take ${a.costDragR.toFixed(2)}R`),
    tile("Profit factor", a.profitFactor == null ? "-" : a.profitFactor.toFixed(2), "above 1 means wins outweigh losses", a.profitFactor == null ? "" : a.profitFactor > 1 ? "pos" : "neg"),
    tile("Total result", `${sgn(a.totalNetR)}R`, `${money(a.totalPnl)} on ${money(equity).replace(".00", "")}`, cls(a.totalNetR)),
    tile("Worst drawdown", `−${a.maxDrawdownR.toFixed(1)}R`, "peak to trough"),
    tile("Exits", Object.entries(a.byExit).map(([k, n]) => `${n} ${EXIT_NAMES[k] || k}`).join(", ").replace(/^(.{34}).+$/, "$1…"), "how trades ended"),
  ].join("");
}

function renderCurve(curve) {
  if (!curve || curve.length < 2) {
    $("dt-curve").innerHTML = `<p class="dt-empty">Not enough trades to draw a curve.</p>`;
    $("dt-curve-note").textContent = "";
    return;
  }
  const W = 640, H = 170, pl = 44, pr = 10, pt = 10, pb = 22;
  const ys = [0, ...curve.map((p) => p.cumR)];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const x = (i) => pl + (i / (curve.length - 1)) * (W - pl - pr);
  const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const pts = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.cumR).toFixed(1)}`).join(" ");
  $("dt-curve").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative result in R across ${curve.length} trades">
      <line class="zero" x1="${pl}" x2="${W - pr}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
      <polyline class="line" points="${pts}"></polyline>
      <text class="lbl" x="${pl - 6}" y="${y(hi).toFixed(1)}" text-anchor="end" dominant-baseline="hanging">${sgn(hi, 1)}R</text>
      <text class="lbl" x="${pl - 6}" y="${y(lo).toFixed(1)}" text-anchor="end">${sgn(lo, 1)}R</text>
      <text class="lbl" x="${pl}" y="${H - 5}">${esc(curve[0].date)}</text>
      <text class="lbl" x="${W - pr}" y="${H - 5}" text-anchor="end">${esc(curve[curve.length - 1].date)}</text>
    </svg>`;
  $("dt-curve-note").textContent = `${curve.length} trades`;
}

const STATE = {
  signal: ["Signal", "signal"], "in-position": ["In trade", "pos"], traded: ["Traded", ""],
  waiting: ["Waiting", "wait"], none: ["No setup", ""], "no-data": ["No data", "err"],
};

function renderScan(symbols, equity) {
  const first = symbols.find((s) => s.scan);
  $("dt-scan-note").textContent = first
    ? `Most recent trading day in the data: ${first.scan.date}${first.scan.live ? " (still in progress)" : " (finished)"}. Sizes assume a ${money(equity).replace(".00", "")} account.`
    : "";
  $("dt-scan").innerHTML = symbols.map((s) => {
    if (s.error) return `<tr><td><strong>${esc(s.symbol)}</strong></td><td><span class="dt-pill err">Error</span></td><td class="wrap" colspan="5">${esc(s.error)}</td></tr>`;
    const sc = s.scan, p = sc.plan;
    const [label, k] = STATE[sc.state] || [sc.state, ""];
    return `<tr>
      <td><strong>${esc(s.symbol)}</strong></td>
      <td><span class="dt-pill ${k}">${esc(label)}</span></td>
      <td class="wrap">${esc(sc.text)}</td>
      <td class="num">${p ? price(p.entry) : "-"}</td><td class="num">${p ? price(p.stop) : "-"}</td>
      <td class="num">${p ? price(p.target) : "-"}</td><td class="num">${p ? p.shares : "-"}</td>
    </tr>`;
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

function renderTrades(trades) {
  $("dt-trades").innerHTML = trades.length
    ? trades.map((t) => `<tr>
        <td>${esc(et(t.entryTime))}</td><td><strong>${esc(t.symbol)}</strong></td><td>${esc(SETUP_NAMES[t.setup] || t.setup)}</td>
        <td class="num">${price(t.entry)}</td><td class="num">${price(t.exit)}</td><td>${esc(EXIT_NAMES[t.exitReason] || t.exitReason)}</td>
        <td class="num ${cls(t.netR)}">${sgn(t.netR)}R</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td>
      </tr>`).join("")
    : `<tr><td colspan="8" class="dt-empty">No trades.</td></tr>`;
}

function render(data, equity) {
  const a = data.aggregate;
  const warn = $("dt-warn");
  warn.hidden = !a.sampleWarning;
  warn.textContent = a.sampleWarning || "";
  renderTiles(a, equity);
  renderCurve(a.curve);
  renderScan(data.symbols, equity);
  renderBySymbol(data.symbols);
  renderBySetup(a);
  renderTrades(data.recentTrades);
  $("dt-results").hidden = false;
  $("dt-updated").innerHTML = `Run at <strong>${new Date(data.generatedAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>`;
}

// ---------------------------------------------------------------- running
let runToken = 0;
async function run() {
  const s = readForm();
  saveSettings(s);
  const token = ++runToken;
  const qs = new URLSearchParams();
  const symbols = s.symbols.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean).join(",");
  if (symbols) qs.set("symbols", symbols);
  if (s.equity) qs.set("equity", s.equity);
  if (s.riskPct) qs.set("riskPct", s.riskPct);
  if (s.targetR) qs.set("targetR", s.targetR);
  if (s.slipBps !== "") qs.set("slipBps", s.slipBps);
  qs.set("orb", s.orb ? "1" : "0");
  qs.set("vwap", s.vwap ? "1" : "0");

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

$("dt-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
loadSettings();
run();
