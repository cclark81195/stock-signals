// Index Signal Scanner - front end (no build step, no dependencies)

const CHUNK = 50;           // symbols per /api/quotes request
const PARALLEL = 3;         // quote requests in flight at once
const REFRESH_MS = 15 * 60 * 1000;
const DAILY_PERIODS = new Set(["3M", "1Y"]);

const state = {
  index: "dow",
  members: [],
  info: {},        // symbol -> {company, sector}
  rows: {},        // symbol -> quote summary
  failed: new Set(),
  signal: "ALL",
  search: "",
  sector: "",
  sort: { key: "symbol", dir: "asc" },
  selected: null,
  period: "1Y",
  showMA: false,
  loadToken: 0,
  chartToken: 0,
  chartCache: new Map(),
  lastChart: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "-" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (x) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "pos" : "neg");
const signalClass = (s) => (s === "N/A" || !s ? "NA" : s);

async function getJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok && !body.rows) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

// ---------------------------------------------------------------- URL state
function readHash() {
  const [idx, sym] = location.hash.replace(/^#\/?/, "").split("/");
  return { index: idx === "sp500" ? "sp500" : "dow", symbol: sym ? decodeURIComponent(sym).toUpperCase() : null };
}
function writeHash() {
  const h = `#${state.index}${state.selected ? "/" + encodeURIComponent(state.selected) : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

// ---------------------------------------------------------------- loading
async function loadIndex(index, selectSymbol = null) {
  const token = ++state.loadToken;
  state.index = index;
  state.members = [];
  state.rows = {};
  state.failed = new Set();
  state.selected = null;
  state.sector = "";
  document.querySelectorAll(".index-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.index === index)));
  closeDetail(false);
  setStatus("Loading index members...");
  renderRows();

  let data;
  try {
    data = await getJSON(`/api/constituents?index=${index}`);
  } catch (e) {
    setStatus(`Couldn't load the index member list. ${e.message}`, true);
    return;
  }
  if (token !== state.loadToken) return;

  state.members = data.members;
  state.info = Object.fromEntries(data.members.map((m) => [m.symbol, m]));
  $("source-note").textContent = `${data.members.length} members · list from ${data.source}.`;
  fillSectors();
  renderRows();

  if (selectSymbol && state.info[selectSymbol]) selectStock(selectSymbol, { scroll: true });
  else writeHash();

  await loadQuotes(token);
}

async function loadQuotes(token, quiet = false) {
  const symbols = state.members.map((m) => m.symbol).sort();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));
  let done = 0;
  if (!quiet) { showProgress(0); setStatus(`Loading prices and signals for ${symbols.length} stocks...`); }

  const queue = [...chunks];
  async function worker() {
    while (queue.length) {
      const chunk = queue.shift();
      try {
        const data = await getJSON(`/api/quotes?symbols=${chunk.join(",")}`);
        if (token !== state.loadToken) return;
        Object.assign(state.rows, data.rows);
        for (const s of Object.keys(data.errors || {})) state.failed.add(s);
        for (const s of Object.keys(data.rows || {})) state.failed.delete(s);
      } catch {
        if (token !== state.loadToken) return;
        chunk.forEach((s) => { if (!state.rows[s]) state.failed.add(s); });
      }
      done++;
      if (!quiet) showProgress(done / chunks.length);
      renderRows();
      if (state.selected && state.rows[state.selected]) renderDetailSummary();
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (token !== state.loadToken) return;

  showProgress(null);
  const loaded = Object.keys(state.rows).length;
  const missing = state.members.length - loaded;
  const newest = Math.max(0, ...Object.values(state.rows).map((r) => r.asOf || 0));
  if (!loaded) {
    setStatus("No prices came back from Yahoo Finance. It may be limiting requests right now - try again in a few minutes.", true);
  } else {
    const when = newest ? new Date(newest * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "";
    setStatus(`Prices as of ${when}${missing ? ` · ${missing} stock${missing > 1 ? "s" : ""} unavailable` : ""}`);
  }
}

// ---------------------------------------------------------------- list
function fillSectors() {
  const sectors = [...new Set(state.members.map((m) => m.sector).filter(Boolean))].sort();
  $("sector").innerHTML = `<option value="">All sectors</option>` + sectors.map((s) => `<option>${esc(s)}</option>`).join("");
}

function currentList() {
  const q = state.search.trim().toLowerCase();
  let list = state.members.map((m) => ({ ...m, ...(state.rows[m.symbol] || {}) }));
  if (state.signal !== "ALL") list = list.filter((r) => r.signal === state.signal);
  if (state.sector) list = list.filter((r) => r.sector === state.sector);
  if (q) list = list.filter((r) => r.symbol.toLowerCase().includes(q) || (r.company || "").toLowerCase().includes(q));
  const { key, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return mul * av.localeCompare(bv);
    return mul * (av - bv) || a.symbol.localeCompare(b.symbol);
  });
  return list;
}

function renderRows() {
  const all = Object.values(state.rows);
  const count = (s) => all.filter((r) => r.signal === s).length;
  $("count-all").textContent = state.members.length || "-";
  $("count-buy").textContent = all.length ? count("BUY") : "-";
  $("count-hold").textContent = all.length ? count("HOLD") : "-";
  $("count-sell").textContent = all.length ? count("SELL") : "-";
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.signal === state.signal));
  document.querySelectorAll(".stocks th[data-sort]").forEach((th) => {
    if (th.dataset.sort === state.sort.key) th.dataset.dir = state.sort.dir; else delete th.dataset.dir;
  });

  const list = currentList();
  if (!state.members.length) { $("rows").innerHTML = ""; return; }
  if (!list.length) {
    $("rows").innerHTML = `<tr><td colspan="6" class="pending" style="text-align:center;padding:24px">No stocks match these filters.</td></tr>`;
    return;
  }
  $("rows").innerHTML = list.map((r) => {
    const has = r.price != null;
    const failed = !has && state.failed.has(r.symbol);
    const sig = has ? r.signal : failed ? "N/A" : "";
    return `<tr data-symbol="${esc(r.symbol)}" tabindex="0" class="${r.symbol === state.selected ? "selected" : ""}">
      <td><div class="sym">${esc(r.symbol)}</div><div class="co">${esc(r.company)}</div></td>
      <td class="num">${has ? money(r.price) : `<span class="pending">${failed ? "n/a" : "..."}</span>`}</td>
      <td class="num ${cls(r.dayPct)}">${has ? pct(r.dayPct) : ""}</td>
      <td class="num hide-sm ${cls(r.m1Pct)}">${has ? pct(r.m1Pct) : ""}</td>
      <td class="num hide-sm ${cls(r.y1Pct)}">${has ? pct(r.y1Pct) : ""}</td>
      <td class="center">${sig ? `<span class="badge ${signalClass(sig)}">${esc(sig)}</span>` : ""}</td>
    </tr>`;
  }).join("");
}

// ---------------------------------------------------------------- detail
function selectStock(symbol, { scroll = false } = {}) {
  state.selected = symbol;
  writeHash();
  document.querySelectorAll("#rows tr").forEach((tr) => tr.classList.toggle("selected", tr.dataset.symbol === symbol));
  $("detail-empty").hidden = true;
  $("detail-body").hidden = false;
  $("detail").classList.add("open");
  if (matchMedia("(max-width: 1000px)").matches) document.body.classList.add("detail-open");
  $("detail").scrollTop = 0;
  renderDetailSummary();
  loadChart();
  if (scroll) document.querySelector(`#rows tr[data-symbol="${CSS.escape(symbol)}"]`)?.scrollIntoView({ block: "center" });
}

function closeDetail(updateHash = true) {
  $("detail").classList.remove("open");
  document.body.classList.remove("detail-open");
  if (updateHash) { state.selected = null; writeHash(); renderRows(); $("detail-empty").hidden = false; $("detail-body").hidden = true; }
  else { $("detail-empty").hidden = false; $("detail-body").hidden = true; }
}

function renderDetailSummary() {
  const sym = state.selected;
  const info = state.info[sym] || {};
  const r = state.rows[sym];
  $("d-symbol").textContent = sym;
  $("d-company").textContent = [info.company, info.sector].filter(Boolean).join(" · ");
  $("d-price").textContent = r ? money(r.price) : "...";
  $("d-change").className = `change ${cls(r?.dayPct)}`;
  $("d-change").textContent = r?.dayPct != null ? `${pct(r.dayPct)} today` : "";

  const verdict = r ? r.signal : state.failed.has(sym) ? "N/A" : "...";
  const box = $("d-verdict");
  box.className = `verdict ${signalClass(verdict === "..." ? "N/A" : verdict)}`;
  $("d-verdict-value").textContent = verdict === "N/A" ? "Not enough data" : verdict;

  if (r?.indicators) {
    $("d-votes").innerHTML = r.indicators.map((i) => `<span class="v${i.vote}">${i.vote > 0 ? "+" : i.vote < 0 ? "−" : "0"}</span>`).join("");
    $("d-score").innerHTML = `<strong>${r.score > 0 ? "+" : ""}${r.score} / 5</strong>score`;
    $("d-indicators").innerHTML = r.indicators.map((i) => {
      const label = i.vote > 0 ? "Buy" : i.vote < 0 ? "Sell" : "Neutral";
      return `<div class="ind">
        <div class="ind-name">${esc(i.name)}</div>
        <div class="ind-value">${esc(i.value)}</div>
        <span class="vote v${i.vote}">${label}</span>
        <div class="ind-rule">${esc(i.rule)}</div>
      </div>`;
    }).join("");
    const d = new Date(r.asOf * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
    $("d-asof").textContent = `Based on daily price data through ${d}.`;
  } else {
    $("d-votes").innerHTML = "";
    $("d-score").innerHTML = "";
    $("d-indicators").innerHTML = r
      ? `<p class="footnote">This stock has less than 200 trading days of history, so the 200-day average (and the verdict) can't be calculated yet.</p>`
      : state.failed.has(sym)
        ? `<p class="footnote">Price data for this stock couldn't be loaded right now.</p>`
        : `<p class="footnote">Loading...</p>`;
    $("d-asof").textContent = "";
  }
}

// ---------------------------------------------------------------- chart
async function loadChart() {
  const sym = state.selected, period = state.period;
  const token = ++state.chartToken;
  document.querySelectorAll("#periods button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  $("legend").hidden = !DAILY_PERIODS.has(period);
  $("period-change").textContent = "";
  const key = `${sym}|${period}`;
  let data = state.chartCache.get(key);
  if (!data) {
    $("chart").innerHTML = `<div class="msg">Loading chart...</div>`;
    try {
      data = await getJSON(`/api/chart?symbol=${encodeURIComponent(sym)}&period=${period}`);
      state.chartCache.set(key, data);
    } catch (e) {
      if (token === state.chartToken) $("chart").innerHTML = `<div class="msg">Chart unavailable right now.</div>`;
      return;
    }
  }
  if (token !== state.chartToken) return;
  state.lastChart = data;
  drawChart(data);
}

function niceTicks(min, max, count = 4) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function fmtTime(ts, period, tz, long = false) {
  const d = new Date(ts * 1000);
  const o = { timeZone: tz };
  if (long) {
    return period === "1D" || period === "1W" || period === "1M"
      ? d.toLocaleString("en-US", { ...o, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString("en-US", { ...o, month: "short", day: "numeric", year: "numeric" });
  }
  if (period === "1D") return d.toLocaleTimeString("en-US", { ...o, hour: "numeric", minute: "2-digit" });
  if (period === "5Y") return d.toLocaleDateString("en-US", { ...o, month: "short", year: "numeric" });
  if (period === "1Y") return d.toLocaleDateString("en-US", { ...o, month: "short", year: "2-digit" }).replace(" ", " '");
  return d.toLocaleDateString("en-US", { ...o, month: "short", day: "numeric" });
}

function drawChart(data) {
  const el = $("chart");
  const { t, close, period, timezone: tz } = data;
  if (!t?.length) { el.innerHTML = `<div class="msg">No chart data for this period.</div>`; return; }

  const base = period === "1D" && data.previousClose ? data.previousClose : close[0];
  const change = (close[close.length - 1] / base - 1) * 100;
  const pc = $("period-change");
  pc.className = `period-change ${cls(change)}`;
  pc.textContent = `${pct(change)} ${period === "1D" ? "today" : "over " + period}`;

  const showMA = state.showMA && data.averages;
  $("legend").classList.toggle("ma-on", !!showMA);
  const series = [{ key: "price", label: "Price", values: close, color: "var(--series-price)", width: 2 }];
  if (showMA) {
    series.push({ key: "ma50", label: "50-day avg", values: data.averages.sma50, color: "var(--series-ma50)", width: 1.5 });
    series.push({ key: "ma200", label: "200-day avg", values: data.averages.sma200, color: "var(--series-ma200)", width: 1.5 });
  }

  const W = el.clientWidth || 600, H = el.clientHeight || 280;
  const m = { l: 6, r: 58, t: 10, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = series.flatMap((s) => s.values.filter((v) => v != null));
  if (period === "1D" && data.previousClose) vals.push(data.previousClose);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  lo -= pad; hi += pad;
  const n = t.length;
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;

  const path = (vs) => {
    let d = "", pen = false;
    vs.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const ticks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
  const grid = ticks.map((v) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" />
      <text x="${W - 4}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? "$" + Math.round(v).toLocaleString() : "$" + v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}</text>`).join("");

  const nx = W < 420 ? 3 : 5;
  const xIdx = [...new Set(Array.from({ length: nx }, (_, k) => Math.round((k * (n - 1)) / (nx - 1))))];
  const xl = xIdx.map((i, k) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${k === 0 ? "start" : k === xIdx.length - 1 ? "end" : "middle"}">${esc(fmtTime(t[i], period, tz))}</text>`).join("");

  const baseLine = period === "1D" && data.previousClose
    ? `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(data.previousClose)}" y2="${y(data.previousClose)}" stroke="var(--muted)" stroke-dasharray="3 4" />
       <text x="${m.l + 4}" y="${y(data.previousClose) - 5}">Prev close</text>` : "";

  const pricePath = path(close);
  const area = `${pricePath}L${x(n - 1).toFixed(1)},${m.t + ih}L${x(0).toFixed(1)},${m.t + ih}Z`;
  const lines = series.slice().reverse().map((s) =>
    `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linejoin="round" stroke-linecap="round" />`).join("");

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(state.selected)} price chart, ${esc(period)}, ${esc(pct(change))}">
    ${grid}${baseLine}
    <path d="${area}" fill="var(--series-price)" opacity="0.07" />
    ${lines}
    <g id="hover" visibility="hidden">
      <line id="hover-line" y1="${m.t}" y2="${m.t + ih}" stroke="var(--muted)" stroke-width="1" />
      ${series.map((s) => `<circle data-k="${s.key}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2" />`).join("")}
    </g>
    ${xl}
    <rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent" id="hit" />
  </svg>`;

  const svg = el.querySelector("svg"), hover = svg.querySelector("#hover"), tip = $("tooltip");
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    hover.setAttribute("visibility", "visible");
    const hl = hover.querySelector("#hover-line");
    hl.setAttribute("x1", x(i)); hl.setAttribute("x2", x(i));
    series.forEach((s) => {
      const c = hover.querySelector(`circle[data-k="${s.key}"]`);
      const v = s.values[i];
      c.setAttribute("visibility", v == null ? "hidden" : "visible");
      if (v != null) { c.setAttribute("cx", x(i)); c.setAttribute("cy", y(v)); }
    });
    tip.innerHTML = `<div class="t-date">${esc(fmtTime(t[i], period, tz, true))}</div>` +
      series.map((s) => s.values[i] == null ? "" :
        `<div class="t-row"><i style="background:${s.color}"></i>${esc(s.label)} <strong>${money(s.values[i])}</strong></div>`).join("");
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = ev.clientX + 14;
    if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${rect.top + 8}px`;
  };
  const leave = () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; };
  const hit = svg.querySelector("#hit");
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave);
  hit.addEventListener("pointercancel", leave);
}

// ---------------------------------------------------------------- misc UI
function setStatus(text, error = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", error);
}
function showProgress(frac) {
  const p = $("progress");
  if (frac == null) { p.hidden = true; return; }
  p.hidden = false;
  $("progress-bar").style.width = `${Math.round(frac * 100)}%`;
}

function wire() {
  document.querySelectorAll(".index-tabs button").forEach((b) =>
    b.addEventListener("click", () => { if (b.dataset.index !== state.index) loadIndex(b.dataset.index); }));

  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => {
      state.signal = state.signal === c.dataset.signal ? "ALL" : c.dataset.signal;
      renderRows();
    }));

  $("search").addEventListener("input", (e) => { state.search = e.target.value; renderRows(); });
  $("sector").addEventListener("change", (e) => { state.sector = e.target.value; renderRows(); });

  document.querySelectorAll(".stocks th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else state.sort = { key, dir: key === "symbol" ? "asc" : "desc" };
      renderRows();
    }));

  const rows = $("rows");
  rows.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-symbol]");
    if (tr) selectStock(tr.dataset.symbol);
  });
  rows.addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-symbol]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectStock(tr.dataset.symbol); }
  });

  $("back").addEventListener("click", () => closeDetail(true));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("detail").classList.contains("open")) closeDetail(true); });

  document.querySelectorAll("#periods button").forEach((b) =>
    b.addEventListener("click", () => { state.period = b.dataset.period; loadChart(); }));
  $("show-ma").addEventListener("change", (e) => { state.showMA = e.target.checked; if (state.lastChart) drawChart(state.lastChart); });

  let rt;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => state.lastChart && !$("detail-body").hidden && drawChart(state.lastChart), 80); }).observe($("chart"));

  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h.index !== state.index) loadIndex(h.index, h.symbol);
    else if (h.symbol && h.symbol !== state.selected && state.info[h.symbol]) selectStock(h.symbol);
  });

  // Keep prices fresh while the page stays open.
  setInterval(() => { if (document.visibilityState === "visible" && state.members.length) loadQuotes(state.loadToken, true); }, REFRESH_MS);
}

wire();
const start = readHash();
loadIndex(start.index, start.symbol);
