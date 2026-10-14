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
  sectorPE: null,  // { basis, sectors: { name: { avgPE, count } } }
  listScroll: 0,
  openInd: null,   // short name of the indicator whose explanation is open
  selected: null,
  period: "1Y",
  showMA: false,
  loadToken: 0,
  chartToken: 0,
  chartCache: new Map(),
  updatedAt: null,       // unix seconds: when the oldest quotes on screen were fetched from Yahoo
  indCache: new Map(),   // symbol -> /api/indicator-history response
  lastChart: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "-" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (x) => (x == null ? "-" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "pos" : "neg");
const signalClass = (s) => (s === "N/A" || !s ? "NA" : s);
const ratio = (x) => (x == null ? "-" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1));
const INDEX_KEYS = ["dow", "sp500", "nasdaq100"];
const VOTE_LABEL = { 1: "Buy", "-1": "Sell", 0: "Neutral" };
const VOTE_SIGN = { 1: "+", "-1": "−", 0: "0" };
// Plain-English help shown when an indicator card is tapped.
const INDICATOR_HELP = {
  RSI: {
    what: "The Relative Strength Index measures how fast and how far the price has moved over the last 14 days, on a scale of 0 to 100. A very high reading means the stock has risen a lot quickly and may be due to cool off; a very low reading means it has fallen a lot and may bounce back.",
    example: "A stock rises on 11 of the last 14 days and its RSI reaches 78. That's above 70, so it's \"overbought\" and RSI votes Sell. If instead it fell most days and RSI dropped to 24, that's below 30 (\"oversold\") and RSI votes Buy.",
  },
  MACD: {
    what: "MACD compares a fast (12-day) and a slow (26-day) average of the price. The MACD line is the gap between them, and the signal line is a smoothed (9-day) version of that gap. When MACD is above its signal line, upward momentum is building.",
    example: "MACD is 1.20 and its signal line is 0.85. MACD is above the signal line, so momentum is turning up and MACD votes Buy. If MACD were -0.40 with the signal at -0.10, it would be below and vote Sell.",
  },
  MA: {
    what: "Compares the average closing price over the last 50 days with the average over the last 200 days. When the shorter-term average is above the longer-term one, the stock is in an uptrend; when it's below, a downtrend.",
    example: "The 50-day average is $182 and the 200-day average is $170. The recent average is higher, so the stock is trending up and this votes Buy. If the 50-day were $95 and the 200-day $110, it would be trending down and vote Sell.",
  },
  Bollinger: {
    what: "Bollinger Bands are drawn above and below the 20-day average price, 2 standard deviations away, so they widen when the price swings a lot. %B shows where today's price sits: 0% is the lower band and 100% the upper band. Near the bottom suggests the price is low for its recent range; near the top, high.",
    example: "The bands are at $90 and $110 and the price is $92, so %B is 10%. That's in the bottom fifth of the bands, so this votes Buy. At $109 (%B 95%) it would be in the top fifth and vote Sell.",
  },
  Stoch: {
    what: "The Stochastic oscillator shows where today's closing price sits within the high-to-low range of the last 14 days, from 0 (at the low) to 100 (at the high), smoothed over 3 days. Readings near the top can mean the stock is overbought; near the bottom, oversold.",
    example: "Over the last 14 days the stock traded between $40 and $50 and closed at $49, so %K is 90. That's above 80, so it votes Sell. A close of $41 would give %K 10, below 20, and vote Buy.",
  },
};
Object.assign(INDICATOR_HELP, {
  ADX: {
    what: "ADX (Average Directional Index) measures how strong a trend is, in either direction, on a scale of about 0 to 100. Above 25 means a real trend is under way. The two DI lines show who is winning: +DI is the pull of buyers and -DI the pull of sellers. ADX only votes when the trend is strong; below 25 it stays neutral.",
    example: "ADX is 31 and +DI (24) is above -DI (13): a strong uptrend, so ADX votes Buy. If ADX were 18, the trend is too weak to trust and it votes Neutral whatever the DI lines say.",
  },
  CCI: {
    what: "The Commodity Channel Index measures how far today's typical price (the average of the high, low and close) sits from its own 20-day average, scaled so that +100 and -100 mark an unusually big stretch. Above +100 means stretched high; below -100 means stretched low.",
    example: "CCI reads -140: the price is unusually far below its recent average, so CCI votes Buy. At +120 it would vote Sell, and anywhere between -100 and +100 it stays Neutral.",
  },
  MFI: {
    what: "The Money Flow Index is like RSI but weights each day by how much money traded, so a rise on heavy volume counts for more than one on thin volume. It runs from 0 to 100 over 14 days. Above 80 means money has been pouring in and the stock may be overbought; below 20 means heavy selling and possibly oversold.",
    example: "MFI is 86 after several high-volume up days, so it votes Sell. At 15 after heavy selling it would vote Buy.",
  },
  OBV: {
    what: "On-Balance Volume keeps a running total: on days the price closes up, that day's trading volume is added; on down days it is subtracted. A rising total suggests buyers are driving the moves. Here the total is compared with its own 20-day average: above it means volume is flowing in, below it means volume is flowing out.",
    example: "OBV is 48 million and its 20-day average is 45 million. Volume has been tilting toward buyers lately, so OBV votes Buy. If it sat below its average, it would vote Sell.",
  },
  ROC: {
    what: "Rate of Change is the simplest momentum gauge: how much the price has changed compared with 12 trading days ago, as a percentage. Positive means the stock is higher than it was; negative means lower.",
    example: "A stock at $105 that was $100 twelve trading days ago has an ROC of +5%, so it votes Buy. If it had been $110, ROC would be -4.5% and it would vote Sell.",
  },
});
const SHORT_NAMES = {
  "Moving averages": "MA", "Bollinger Bands": "Bollinger", Stochastic: "Stoch",
  "Money Flow Index": "MFI", "On-Balance Volume": "OBV", "Rate of Change": "ROC",
};
const shortName = (name) => SHORT_NAMES[name.split(" (")[0]] || name.split(" (")[0];
const INDICATOR_COUNT = 10;

// ---------------------------------------------------------------- indicator pictures
// How each indicator is drawn when its card is open. `build` returns lines to plot
// (and optional coloured zones / guide lines) from /api/indicator-history.
const C = { price: "var(--series-price)", ma50: "var(--series-ma50)", ma200: "var(--series-ma200)", buy: "var(--buy)", sell: "var(--sell)", muted: "var(--muted)", accent: "var(--accent)" };
const fmtNum = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
const fmtCompact = (v) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  return a >= 1e9 ? `${s}${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}${(a / 1e6).toFixed(0)}M` : a >= 1e3 ? `${s}${(a / 1e3).toFixed(0)}K` : `${s}${a.toFixed(0)}`;
};
const IND_VISUAL = {
  RSI: {
    title: "RSI over the last 6 months",
    read: "Above the red band the stock counts as overbought (Sell vote); below the green band it is oversold (Buy vote). Between them RSI stays neutral. The dot marks today.",
    build: (d) => ({ lines: [{ label: "RSI", v: d.RSI.rsi, color: C.accent, w: 2 }], range: [0, 100], zones: [{ lo: 70, hi: 100, kind: "sell", label: "Overbought" }, { lo: 0, hi: 30, kind: "buy", label: "Oversold" }], ticks: [0, 30, 50, 70, 100] }),
  },
  MACD: {
    title: "MACD vs its signal line",
    read: "When the MACD line (blue) is above its signal line (orange) momentum is up and MACD votes Buy; below it, Sell. The bars show the gap between the two: green above zero, red below. The dot marks today.",
    build: (d) => ({ bars: { v: d.MACD.hist }, lines: [{ label: "MACD", v: d.MACD.line, color: C.price, w: 2 }, { label: "Signal", v: d.MACD.signal, color: C.ma50, w: 1.5 }], guides: [{ y: 0 }], fmt: (v) => v.toFixed(1) }),
  },
  MA: {
    title: "Price with 50-day and 200-day averages",
    read: "When the 50-day line (orange) is above the 200-day line (green) the stock is in an uptrend and votes Buy; below it, a downtrend and Sell. Crossings are the turning points. The dot marks today.",
    build: (d) => ({ lines: [{ label: "Price", v: d.close, color: C.price, w: 1.5 }, { label: "50-day", v: d.MA.sma50, color: C.ma50, w: 2 }, { label: "200-day", v: d.MA.sma200, color: C.ma200, w: 2 }], money: true }),
  },
  Bollinger: {
    title: "Price inside its Bollinger Bands",
    read: "The shaded channel is the usual range around the 20-day average. Price in the bottom fifth of the channel is a Buy vote; in the top fifth, a Sell vote. The channel widens when the stock gets jumpy. The dot marks today.",
    build: (d) => ({ band: { hi: d.Bollinger.upper, lo: d.Bollinger.lower }, lines: [{ label: "Price", v: d.close, color: C.price, w: 2 }, { label: "20-day avg", v: d.Bollinger.mid, color: C.muted, w: 1, dash: "3 3" }], money: true }),
  },
  Stoch: {
    title: "Stochastic over the last 6 months",
    read: "%K shows where the close sits inside the last 14 days' high-to-low range. Above 80 (red band) is a Sell vote; below 20 (green band) is a Buy vote. %D is a slower copy of %K. The dot marks today.",
    build: (d) => ({ lines: [{ label: "%K", v: d.Stoch.k, color: C.accent, w: 2 }, { label: "%D", v: d.Stoch.d, color: C.ma50, w: 1.5 }], range: [0, 100], zones: [{ lo: 80, hi: 100, kind: "sell", label: "Overbought" }, { lo: 0, hi: 20, kind: "buy", label: "Oversold" }], ticks: [0, 20, 50, 80, 100] }),
  },
  ADX: {
    title: "Trend strength (ADX) and who is winning",
    read: "ADX (blue) says how strong the trend is. It only votes when it is above the dashed 25 line. Then the vote follows the leader: +DI (green) above -DI (red) is Buy, the reverse is Sell. The dot marks today.",
    build: (d) => ({ lines: [{ label: "ADX", v: d.ADX.adx, color: C.accent, w: 2.2 }, { label: "+DI", v: d.ADX.pdi, color: C.buy, w: 1.4 }, { label: "-DI", v: d.ADX.mdi, color: C.sell, w: 1.4 }], guides: [{ y: 25, label: "25 = strong trend" }], range: [0, null] }),
  },
  CCI: {
    title: "CCI over the last 6 months",
    read: "CCI measures how stretched the price is from its 20-day average. Above +100 (red band) is a Sell vote; below -100 (green band) is a Buy vote. Between them it is neutral. The dot marks today.",
    build: (d) => ({ lines: [{ label: "CCI", v: d.CCI.cci, color: C.accent, w: 2 }], zones: [{ lo: 100, hi: Infinity, kind: "sell", label: "Stretched high" }, { lo: -Infinity, hi: -100, kind: "buy", label: "Stretched low" }], guides: [{ y: 0 }], ticks: [-100, 0, 100] }),
  },
  MFI: {
    title: "Money Flow Index over the last 6 months",
    read: "MFI is RSI with trading volume added. Above 80 (red band) means heavy buying and a Sell vote; below 20 (green band) means heavy selling and a Buy vote. The dot marks today.",
    build: (d) => ({ lines: [{ label: "MFI", v: d.MFI.mfi, color: C.accent, w: 2 }], range: [0, 100], zones: [{ lo: 80, hi: 100, kind: "sell", label: "Overbought" }, { lo: 0, hi: 20, kind: "buy", label: "Oversold" }], ticks: [0, 20, 50, 80, 100] }),
  },
  OBV: {
    title: "On-Balance Volume vs its 20-day average",
    read: "OBV (blue) rises on up days and falls on down days, by that day's volume. When it is above its 20-day average (orange), volume is flowing in and OBV votes Buy; below it, Sell. The dot marks today.",
    build: (d) => ({ lines: [{ label: "OBV", v: d.OBV.obv, color: C.price, w: 2 }, { label: "20-day avg", v: d.OBV.avg, color: C.ma50, w: 1.5 }], fmt: fmtCompact }),
  },
  ROC: {
    title: "12-day Rate of Change",
    read: "The line is the % change in price versus 12 trading days earlier. Above zero (green side) the stock is higher than it was and ROC votes Buy; below zero (red side), Sell. The dot marks today.",
    build: (d) => ({ lines: [{ label: "ROC %", v: d.ROC.roc, color: C.accent, w: 2 }], zones: [{ lo: 0, hi: Infinity, kind: "buy", label: "Higher than 12 days ago" }, { lo: -Infinity, hi: 0, kind: "sell", label: "Lower" }], guides: [{ y: 0 }], fmt: (v) => `${v.toFixed(0)}%` }),
  },
};

function drawIndicatorVisual(el, key, d, sym) {
  const def = IND_VISUAL[key];
  if (!def || !d?.t?.length) { el.innerHTML = ""; return; }
  const spec = def.build(d);
  const n = d.t.length;
  const W = Math.max(240, el.clientWidth || 320), H = W < 420 ? 190 : 210;
  const m = { l: 6, r: 48, t: 10, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const fmt = spec.fmt || (spec.money ? (v) => "$" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(v < 100 ? 1 : 0)) : fmtNum);

  // y range: fixed when the indicator has natural limits, otherwise fitted to the data
  const all = [
    ...spec.lines.flatMap((l) => l.v.filter((x) => x != null)),
    ...(spec.band ? [...spec.band.hi, ...spec.band.lo].filter((x) => x != null) : []),
    ...(spec.bars ? spec.bars.v.filter((x) => x != null) : []),
    ...(spec.guides || []).map((g) => g.y),
    ...(spec.zones || []).flatMap((z) => [z.lo, z.hi]).filter(Number.isFinite),
  ];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (spec.range) { if (spec.range[0] != null) lo = spec.range[0]; if (spec.range[1] != null) hi = spec.range[1]; }
  else { const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad; }
  if (spec.range?.[1] == null && spec.range) hi += (hi - lo) * 0.08;
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * ih;

  const path = (vs) => {
    let p = "", pen = false;
    vs.forEach((v, i) => { if (v == null) { pen = false; return; } p += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    return p;
  };

  let svg = "";
  for (const z of spec.zones || []) {
    const top = y(z.hi), bot = y(z.lo);
    const colour = z.kind === "buy" ? "var(--buy)" : "var(--sell)";
    svg += `<rect x="${m.l}" y="${top}" width="${iw}" height="${Math.max(0, bot - top)}" fill="${colour}" opacity="0.11" />`;
    // label sits inside the zone, at the edge of the chart the zone touches
    const labelY = z.hi >= hi ? Math.min(top, bot) + 11 : Math.max(top, bot) - 4;
    svg += `<text class="ind-zone" x="${m.l + 4}" y="${labelY}" fill="${colour}">${esc(z.label)}</text>`;
  }
  const ticks = spec.ticks || niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
  svg += ticks.map((v) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" /><text x="${W - 4}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join("");
  for (const g of spec.guides || []) {
    svg += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(g.y)}" y2="${y(g.y)}" stroke="var(--muted)" stroke-dasharray="4 4" />`;
    if (g.label) svg += `<text x="${m.l + 4}" y="${y(g.y) - 4}">${esc(g.label)}</text>`;
  }
  if (spec.band) {
    let up = "", dn = "";
    spec.band.hi.forEach((v, i) => { if (v != null) up += `${up ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    for (let i = n - 1; i >= 0; i--) { const v = spec.band.lo[i]; if (v != null) dn += `L${x(i).toFixed(1)},${y(v).toFixed(1)}`; }
    svg += `<path d="${up}${dn}Z" fill="var(--series-price)" opacity="0.10" /><path d="${up}" fill="none" stroke="var(--series-price)" stroke-width="1" opacity="0.45" /><path d="M${dn.slice(1)}" fill="none" stroke="var(--series-price)" stroke-width="1" opacity="0.45" />`;
  }
  if (spec.bars) {
    const bw = Math.max(1, iw / n - 0.8), y0 = y(0);
    spec.bars.v.forEach((v, i) => { if (v == null) return; const yy = y(v); svg += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(yy, y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(yy - y0)).toFixed(1)}" fill="${v >= 0 ? "var(--buy)" : "var(--sell)"}" opacity="0.45" />`; });
  }
  for (const l of spec.lines.slice().reverse()) {
    svg += `<path d="${path(l.v)}" fill="none" stroke="${l.color}" stroke-width="${l.w}" stroke-linejoin="round" stroke-linecap="round"${l.dash ? ` stroke-dasharray="${l.dash}"` : ""} />`;
  }
  const first = spec.lines[0];
  const lastIdx = (() => { for (let i = n - 1; i >= 0; i--) if (first.v[i] != null) return i; return n - 1; })();
  svg += `<circle cx="${x(lastIdx)}" cy="${y(first.v[lastIdx])}" r="4" fill="${first.color}" stroke="var(--surface)" stroke-width="2" />`;
  const nx = W < 420 ? 3 : 5, tz = d.timezone || "America/New_York";
  const xi = [...new Set(Array.from({ length: nx }, (_, k) => Math.round((k * (n - 1)) / (nx - 1))))];
  svg += xi.map((i, k) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${k === 0 ? "start" : k === xi.length - 1 ? "end" : "middle"}">${esc(fmtTime(d.t[i], "3M", tz))}</text>`).join("");
  svg += `<g id="vis-hover" visibility="hidden"><line id="vis-line" y1="${m.t}" y2="${m.t + ih}" stroke="var(--muted)" /></g><rect id="vis-hit" x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent" />`;

  const legend = spec.lines.map((l) => `<span class="vkey" style="--c:${l.color}">${esc(l.label)}</span>`).join("") +
    (spec.band ? `<span class="vkey" style="--c:var(--series-price)">Bands</span>` : "");
  el.innerHTML = `<div class="vis-title">${esc(def.title)}</div>
    <svg class="vis-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(sym)} ${esc(def.title)}">${svg}</svg>
    <div class="vis-legend">${legend}</div>
    <p class="vis-read"><strong>How to read it:</strong> ${esc(def.read)}</p>`;

  const node = el.querySelector("svg"), hover = node.querySelector("#vis-hover"), tip = $("tooltip");
  const move = (ev) => {
    const rect = node.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    hover.setAttribute("visibility", "visible");
    const hl = hover.querySelector("#vis-line"); hl.setAttribute("x1", x(i)); hl.setAttribute("x2", x(i));
    tip.innerHTML = `<div class="t-date">${esc(fmtTime(d.t[i], "3M", tz, true))}</div>` + spec.lines.map((l) => l.v[i] == null ? "" :
      `<div class="t-row"><i style="background:${l.color}"></i>${esc(l.label)} <strong>${esc(fmt(l.v[i]))}</strong></div>`).join("");
    tip.hidden = false;
    const tw = tip.offsetWidth; let left = ev.clientX + 14;
    if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${rect.top + 8}px`;
  };
  const leave = () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; };
  const hit = node.querySelector("#vis-hit");
  hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave); hit.addEventListener("pointercancel", leave);
}

// Fetch (once per stock) and draw the picture for whichever indicator card is open.
async function paintIndicatorVisual() {
  const sym = state.selected, key = state.openInd;
  if (!sym || !key || !IND_VISUAL[key]) return;
  const slot = () => document.querySelector(`#d-indicators .ind.open .ind-visual`);
  let el = slot();
  if (!el) return;
  let data = state.indCache.get(sym);
  if (!data) {
    el.innerHTML = `<div class="vis-msg">Loading chart...</div>`;
    try {
      data = await getJSON(`/api/indicator-history?symbol=${encodeURIComponent(sym)}`);
      state.indCache.set(sym, data);
    } catch {
      if (state.selected === sym && state.openInd === key && (el = slot())) el.innerHTML = `<div class="vis-msg">Chart unavailable right now.</div>`;
      return;
    }
  }
  if (state.selected !== sym || state.openInd !== key) return;
  el = slot();
  if (el) drawIndicatorVisual(el, key, data, sym);
}

async function getJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok && !body.rows) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

// ---------------------------------------------------------------- URL state
function readHash() {
  const [idx, sym] = location.hash.replace(/^#\/?/, "").split("/");
  return { index: INDEX_KEYS.includes(idx) ? idx : "dow", symbol: sym ? decodeURIComponent(sym).toUpperCase() : null };
}
function writeHash() {
  const h = `#${state.index}${state.selected ? "/" + encodeURIComponent(state.selected) : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

// ---------------------------------------------------------------- loading
// Sector P/E averages don't depend on the index, so load them once.
async function loadSectorPE() {
  try {
    state.sectorPE = await getJSON("/api/sector-pe");
  } catch {
    state.sectorPE = { error: true, sectors: {} };
  }
  renderRows();
  if (state.selected) renderDetailSummary();
}

async function loadIndex(index, selectSymbol = null) {
  const token = ++state.loadToken;
  state.index = index;
  state.members = [];
  state.rows = {};
  state.failed = new Set();
  state.updatedAt = null;
  renderUpdated();
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
  const fetchedAt = [];
  async function worker() {
    while (queue.length) {
      const chunk = queue.shift();
      try {
        const data = await getJSON(`/api/quotes?symbols=${chunk.join(",")}`);
        if (token !== state.loadToken) return;
        if (data.generatedAt) { fetchedAt.push(data.generatedAt); state.updatedAt = Math.min(...fetchedAt); renderUpdated(); }
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
  const sectors = state.sectorPE?.sectors || {};
  let list = state.members.map((m) => ({ ...m, ...(state.rows[m.symbol] || {}), sectorPE: sectors[m.sector]?.avgPE ?? null }));
  if (state.signal !== "ALL") list = list.filter((r) => r.signal === state.signal);
  if (state.sector) list = list.filter((r) => r.sector === state.sector);
  if (q) list = list.filter((r) => r.symbol.toLowerCase().includes(q) || (r.company || "").toLowerCase().includes(q));
  const { dir } = state.sort;
  const key = state.sort.key === "signal" ? "score" : state.sort.key;
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

// 1.2T / 345.6B / 78.9M / 12.3K, or a dash when unknown.
function compact(n, prefix) {
  if (n == null || !isFinite(n)) return `<span class="pending">\u2013</span>`;
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [v, u] of units) if (n >= v) return `${prefix}${(n / v).toFixed(n / v >= 100 ? 0 : n / v >= 10 ? 1 : 2)}${u}`;
  return `${prefix}${Math.round(n)}`;
}

function fmtScore(n) {
  return `${n > 0 ? "+" : n < 0 ? "\u2212" : ""}${Math.abs(n)}`;
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
    $("rows").innerHTML = `<tr><td colspan="12" class="pending" style="text-align:center;padding:24px">No stocks match these filters.</td></tr>`;
    return;
  }
  $("rows").innerHTML = list.map((r) => {
    const has = r.price != null;
    const failed = !has && state.failed.has(r.symbol);
    const sig = has ? r.signal : failed ? "N/A" : "";
    return `<tr data-symbol="${esc(r.symbol)}" tabindex="0" class="${r.symbol === state.selected ? "selected" : ""}">
      <td><div class="sym">${esc(r.symbol)}</div><div class="co">${esc(r.company)}</div></td>
      <td class="center">${sig ? `<span class="badge ${signalClass(sig)}">${esc(sig)}</span>` : ""}</td>
      <td class="num score ${cls(r.score)}">${has && r.score != null ? fmtScore(r.score) : ""}</td>
      <td class="num">${has ? money(r.price) : `<span class="pending">${failed ? "n/a" : "..."}</span>`}</td>
      <td class="num ${cls(r.dayPct)}">${has ? pct(r.dayPct) : ""}</td>
      <td class="num ${cls(r.m1Pct)}">${has ? pct(r.m1Pct) : ""}</td>
      <td class="num ${cls(r.y1Pct)}">${has ? pct(r.y1Pct) : ""}</td>
      <td class="num">${has ? ratio(r.pe) : ""}</td>
      <td class="num sector-pe">${state.sectorPE ? ratio(r.sectorPE) : ""}</td>
      <td class="num">${has ? compact(r.avgVolume, "") : ""}</td>
      <td class="num">${has ? compact(r.marketCap, "$") : ""}</td>
      <td class="sector-name">${esc(r.sector || "")}</td>
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
  // On phones the detail replaces the list in the normal page flow (rather than
  // a fixed overlay), so the page scrolls natively. Remember where the list was.
  if (matchMedia("(max-width: 1000px)").matches) {
    if (!document.body.classList.contains("detail-open")) state.listScroll = window.scrollY;
    document.body.classList.add("detail-open");
    window.scrollTo(0, 0);
  }
  $("detail").scrollTop = 0;
  renderDetailSummary();
  loadChart();
  if (scroll) document.querySelector(`#rows tr[data-symbol="${CSS.escape(symbol)}"]`)?.scrollIntoView({ block: "center" });
}

function closeDetail(updateHash = true) {
  const wasOpen = document.body.classList.contains("detail-open");
  $("detail").classList.remove("open");
  document.body.classList.remove("detail-open");
  if (wasOpen) window.scrollTo(0, state.listScroll);
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

  renderValuation(sym, info, r);

  if (r?.indicators) {
    $("d-votes").innerHTML = r.indicators.map((i) => `<button type="button" class="vote-dot v${i.vote}" data-ind="${esc(shortName(i.name))}" title="${esc(i.name)}: ${VOTE_LABEL[i.vote]}">
        <i aria-hidden="true">${VOTE_SIGN[i.vote]}</i><b>${VOTE_LABEL[i.vote]}</b><small>${esc(shortName(i.name))}</small>
      </button>`).join("");
    $("d-score").innerHTML = `<strong>${r.score > 0 ? "+" : r.score < 0 ? "−" : ""}${Math.abs(r.score)} / ${INDICATOR_COUNT}</strong>score`;
    $("d-indicators").innerHTML = r.indicators.map((i) => {
      const label = `${VOTE_SIGN[i.vote]}${i.vote ? "1" : ""} ${VOTE_LABEL[i.vote]}`;
      const key = shortName(i.name);
      const help = INDICATOR_HELP[key];
      const open = state.openInd === key;
      return `<div class="ind${open ? " open" : ""}" data-ind="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}">
        <div class="ind-name">${esc(i.name)} <span class="ind-more" aria-hidden="true">${open ? "Hide" : "What's this?"}</span></div>
        <div class="ind-value">${esc(i.value)}</div>
        <span class="vote v${i.vote}">${label}</span>
        <div class="ind-rule">${esc(i.rule)}</div>
        ${open && help ? `<div class="ind-help">
          ${IND_VISUAL[key] ? `<div class="ind-visual" aria-live="polite"></div>` : ""}
          <p>${esc(help.what)}</p>
          <p><strong>Example:</strong> ${esc(help.example)}</p>
        </div>` : ""}
      </div>`;
    }).join("");
    if (state.openInd) paintIndicatorVisual();
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

function renderValuation(sym, info, r) {
  const sp = state.sectorPE;
  const sec = sp?.sectors?.[info.sector];
  const avg = sec?.avgPE ?? null;
  $("d-pe").textContent = r ? (r.pe == null ? "n/a" : ratio(r.pe)) : "...";
  $("d-fpe").textContent = r ? (r.forwardPE == null ? "n/a" : ratio(r.forwardPE)) : "...";
  $("d-sector-label").textContent = info.sector ? `${info.sector} avg P/E` : "Sector avg P/E";
  $("d-sector-pe").textContent = !sp ? "..." : avg == null ? "n/a" : ratio(avg);

  let note = "";
  if (r && r.pe == null && r.forwardPE == null) note = "P/E isn't available for this stock right now (it may have negative earnings).";
  else if (r && r.pe == null) note = "No trailing P/E because earnings over the last 12 months were negative.";
  else if (r && avg != null) {
    const diff = (r.pe / avg - 1) * 100;
    const word = Math.abs(diff) < 5 ? "about in line with" : diff > 0 ? `${Math.round(diff)}% above` : `${Math.round(-diff)}% below`;
    note = `${sym}'s P/E is ${word} the ${info.sector} average` +
      ` (${sec.count} profitable ${sp.basis} companies). Higher can mean the market expects faster growth, or that it's pricier.`;
  }
  if (sp?.error) note = (note ? note + " " : "") + "Sector averages couldn't be loaded right now.";
  $("d-pe-note").textContent = note;
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
// "Updated Oct 13, 9:12 PM ET (4 min ago)" in the bar at the top of the page.
function renderUpdated() {
  const el = $("last-updated");
  if (!el) return;
  if (!state.updatedAt) { el.classList.remove("stale"); el.textContent = state.members.length ? "Loading prices..." : ""; return; }
  const when = new Date(state.updatedAt * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const mins = Math.max(0, Math.round((Date.now() / 1000 - state.updatedAt) / 60));
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.floor(mins / 60)} hr ${mins % 60} min ago` : `${Math.floor(mins / 1440)} d ago`;
  el.classList.toggle("stale", mins >= 45);   // refresh runs every 15 min, so 45+ means something is wrong
  el.innerHTML = `Data updated <strong>${esc(when)} ET</strong> (${esc(ago)}) · prices are delayed about 15 minutes`;
}

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
      else state.sort = { key, dir: key === "symbol" || key === "sector" ? "asc" : "desc" };
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

  // Tapping an indicator card (or its vote circle) opens its explanation.
  const toggleInd = (key, scroll) => {
    state.openInd = state.openInd === key ? null : key;
    renderDetailSummary();
    if (scroll && state.openInd) document.querySelector(`#d-indicators .ind[data-ind="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  $("d-indicators").addEventListener("click", (e) => {
    if (e.target.closest(".ind-visual")) return;   // touching the picture shouldn't close the card
    const card = e.target.closest(".ind[data-ind]");
    if (card) toggleInd(card.dataset.ind);
  });
  $("d-indicators").addEventListener("keydown", (e) => {
    if (e.target.closest(".ind-visual")) return;
    const card = e.target.closest(".ind[data-ind]");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggleInd(card.dataset.ind);
      document.querySelector(`#d-indicators .ind[data-ind="${CSS.escape(card.dataset.ind)}"]`)?.focus();
    }
  });
  $("d-votes").addEventListener("click", (e) => {
    const dot = e.target.closest(".vote-dot[data-ind]");
    if (dot) { state.openInd = null; toggleInd(dot.dataset.ind, true); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("detail").classList.contains("open")) closeDetail(true); });

  document.querySelectorAll("#periods button").forEach((b) =>
    b.addEventListener("click", () => { state.period = b.dataset.period; loadChart(); }));
  $("show-ma").addEventListener("change", (e) => { state.showMA = e.target.checked; if (state.lastChart) drawChart(state.lastChart); });

  let vt;
  window.addEventListener("resize", () => { clearTimeout(vt); vt = setTimeout(() => { if (state.openInd && state.selected) paintIndicatorVisual(); }, 120); });

  let rt;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => state.lastChart && !$("detail-body").hidden && drawChart(state.lastChart), 80); }).observe($("chart"));

  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h.index !== state.index) loadIndex(h.index, h.symbol);
    else if (h.symbol && h.symbol !== state.selected && state.info[h.symbol]) selectStock(h.symbol);
  });

  setInterval(renderUpdated, 30 * 1000);   // keeps the "x min ago" text current

  // Keep prices fresh while the page stays open.
  setInterval(() => { if (document.visibilityState === "visible" && state.members.length) loadQuotes(state.loadToken, true); }, REFRESH_MS);
}

wire();
loadSectorPE();
const start = readHash();
loadIndex(start.index, start.symbol);
