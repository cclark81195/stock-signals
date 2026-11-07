// Swing Lab - live scan sphere (no build step, no dependencies).
// Each dot is one TRADE by default (green = it made money, red = it lost), or one STOCK when switched.
// Dots appear as each batch of stocks finishes its backtest, so the count is whatever has actually been tested so far.
// A stock that fails or is skipped adds nothing. The total is used only for the progress readout.
//
//   const scan = makeScan(hostElement, { esc, sgn, pct0 }, { units: ["trades", "stocks"], effects: ["depth", ...] });
//   scan.reset(totalStocks)      // new run: clears the dots
//   scan.add([{ symbol, sector, trades, winRate, exp, holdPct, tradeList: [{ side, date, exitDate, netR, holdBars, exitReason }] }])
//   scan.finish(stopped)         // run over: the sphere keeps spinning
import { fx, onFx, buildFxPanel } from "./swing-fx.js";

const TAU = Math.PI * 2, GA = Math.PI * (3 - Math.sqrt(5));
const TILT = 0.38, CT = Math.cos(TILT), ST = Math.sin(TILT);
const BIG = 3000;              // above this many dots: no halos or trails, drawn in depth bands instead of sorted
const UNIT_NAMES = { trades: "Trade", stocks: "Stock" };
const MODES = {
  trades: [["result", "Result"], ["hold", "Hold time"]],
  stocks: [["exp", "Expectancy"], ["win", "Win rate"], ["count", "Trades"]],
};
const SHORT = { "Information Technology": "Tech", "Communication Services": "Comm", Financials: "Fin", "Health Care": "Health", Utilities: "Utils", Industrials: "Indust", "Real Estate": "Real Est", "Consumer Discretionary": "Disc", Materials: "Matls", "Consumer Staples": "Staples" };
const short = (s) => SHORT[s] || (s ? s.slice(0, 8) : "Other");
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
const WIN = hex("#38e3a6"), LOSS = hex("#ff5f7e"), DIM = hex("#8a94bd"), ACC = hex("#6f80ff"), ACC2 = hex("#d35cff");
const DIV = Array.from({ length: 41 }, (_, i) => { const t = (i - 20) / 20; return t >= 0 ? mix(DIM, WIN, Math.pow(t, 0.6)) : mix(DIM, LOSS, Math.pow(-t, 0.6)); });
const GRAD = Array.from({ length: 21 }, (_, i) => mix(ACC, ACC2, i / 20));
const TRADE = Array.from({ length: 41 }, (_, i) => { const t = (i - 20) / 20; return t >= 0 ? mix(DIM, WIN, 0.5 + 0.5 * Math.pow(t, 0.6)) : mix(DIM, LOSS, 0.5 + 0.5 * Math.pow(-t, 0.6)); });
const dayFmt = (s) => { const d = new Date(`${String(s).slice(0, 10)}T12:00:00`); return Number.isNaN(+d) ? String(s || "") : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export function makeScan(host, fmt, opts = {}) {
  const { esc, sgn, pct0 } = fmt;
  const units = opts.units || ["trades", "stocks"];
  const effects = opts.effects || ["depth", "sectors", "hud", "odo", "ribbon"];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  host.innerHTML = `
    <div class="scan-stage"><canvas role="img"></canvas></div>
    <div class="scan-read" role="status"></div>
    <div class="scan-modes" id="scan-unit" role="group" aria-label="What each dot is"></div>
    <div class="scan-modes" id="scan-mode" role="group" aria-label="Color dots by"></div>
    <div class="scan-legend" aria-hidden="true"></div>
    <div class="scan-fx" id="scan-fx"></div>`;
  const cv = host.querySelector("canvas"), ctx = cv.getContext("2d");
  const read = host.querySelector(".scan-read"), unitEl = host.querySelector("#scan-unit"), modeEl = host.querySelector("#scan-mode"), legend = host.querySelector(".scan-legend");
  buildFxPanel(host.querySelector("#scan-fx"), effects);
  unitEl.hidden = units.length < 2;

  let unit = units[0];
  const cmode = { trades: "result", stocks: "exp" };
  try {
    const u = localStorage.getItem("swing-scan-unit"); if (units.includes(u)) unit = u;
    for (const k of Object.keys(MODES)) { const m = localStorage.getItem("swing-scan-cmode-" + k); if (MODES[k].some((x) => x[0] === m)) cmode[k] = m; }
  } catch { /* ignore */ }

  // per unit: dots plus parallel arrays. y = current latitude (eases), ty = target latitude, cs/sn = longitude trig
  const mk = () => ({ dots: [], n: 0, cap: 0, y: null, ty: null, cs: null, sn: null, secCount: new Map(), bands: [] });
  const U = { trades: mk(), stocks: mk() };
  const cur = () => U[unit];
  function grow(u, need) {
    if (need <= u.cap) return;
    const nc = Math.max(need, u.cap * 2, 1024), f = (old) => { const a = new Float32Array(nc); if (old) a.set(old.subarray(0, u.n)); return a; };
    u.y = f(u.y); u.ty = f(u.ty); u.cs = f(u.cs); u.sn = f(u.sn); u.cap = nc;
  }
  let total = 0, state = "idle", doneAt = -1e9, startAt = 0, angle = 0.6, spin = 0, hov = -1, W = 0, H = 0, dpr = 1, visible = true, last = 0, readKey = "";
  const ptr = { x: 0, y: 0, on: false }; let ptrTimer = 0;
  let cap = 0, sx, sy, sz, sf, tx, ty;
  function ensure(n) {
    if (n <= cap) return;
    const nc = Math.max(n, cap * 2, 1024);
    sx = new Float32Array(nc); sy = new Float32Array(nc); sz = new Float32Array(nc); sf = new Float32Array(nc); tx = new Float32Array(nc); ty = new Float32Array(nc); cap = nc;
  }
  ensure(1024);

  // ---- layout: arrival order, or grouped into one latitude band per sector
  function relayout(u) {
    const k = u.n, ds = u.dots;
    if (fx.sectors) {
      const names = [...u.secCount.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
      const start = new Map(); let c = 0;
      u.bands = [];
      for (const nm of names) { start.set(nm, c); const cnt = u.secCount.get(nm); u.bands.push({ name: nm, start: c, count: cnt, pos: 0 }); c += cnt; }
      const bandOf = new Map(u.bands.map((b) => [b.name, b]));
      for (let i = 0; i < k; i++) {
        const d = ds[i], b = bandOf.get(d.sector), idx = b.start + d.ord;
        u.ty[i] = 1 - 2 * (idx + 0.5) / k;
        const th = d.ord * GA; u.cs[i] = Math.cos(th % TAU); u.sn[i] = Math.sin(th % TAU);
        if (d.pos) b.pos++;
      }
    } else {
      u.bands = [];
      for (let i = 0; i < k; i++) { u.ty[i] = k > 1 ? 1 - 2 * (i + 0.5) / k : 0; const th = (i * GA) % TAU; u.cs[i] = Math.cos(th); u.sn[i] = Math.sin(th); }
    }
  }
  onFx((key) => { if (key === "sectors") { relayout(U.trades); relayout(U.stocks); } });

  // ---- colors
  function palette() { const m = cmode[unit]; return m === "hold" || m === "count" ? GRAD : unit === "trades" ? TRADE : DIV; }
  function colorIdx(d) {
    if (unit === "trades") {
      if (cmode.trades === "hold") return Math.round(clamp(d.hold / 30, 0, 1) * 20);
      return 20 + Math.round(clamp(d.r / 2, -1, 1) * 20);
    }
    if (cmode.stocks === "win") return 20 + Math.round(clamp(((d.wr ?? 0.5) - 0.5) / 0.25, -1, 1) * 20);
    if (cmode.stocks === "count") return Math.round(clamp((d.trades - 5) / 60, 0, 1) * 20);
    return 20 + Math.round(clamp((d.exp ?? 0) / 0.5, -1, 1) * 20);
  }
  function recolor() { for (const d of cur().dots) d.ci = colorIdx(d); }
  function drawControls() {
    unitEl.innerHTML = '<span class="scan-lbl">Each dot is a</span>' + units.map((k) => `<button type="button" data-u="${k}" aria-pressed="${k === unit}">${UNIT_NAMES[k]}</button>`).join("");
    modeEl.innerHTML = '<span class="scan-lbl">Color by</span>' + MODES[unit].map(([k, n]) => `<button type="button" data-m="${k}" aria-pressed="${k === cmode[unit]}">${n}</button>`).join("");
    const m = cmode[unit], dot = (c) => `<i class="sq" style="background:${c}"></i>`;
    legend.innerHTML = unit === "trades"
      ? (m === "result" ? `<span>${dot("#38e3a6")}winning trade</span><span>${dot("#ff5f7e")}losing trade</span><span>brighter = bigger result (R)</span>` : `<span>${dot("#6f80ff")}short hold</span><span>${dot("#d35cff")}30+ days held</span>`)
      : m === "exp" ? `<span>${dot("#38e3a6")}positive expectancy</span><span>${dot("#ff5f7e")}negative</span><span>size = trades</span>`
        : m === "win" ? `<span>${dot("#38e3a6")}wins over 75%</span><span>${dot("#ff5f7e")}under 25%</span><span>size = trades</span>`
          : `<span>${dot("#6f80ff")}few trades</span><span>${dot("#d35cff")}many trades</span><span>size = trades</span>`;
    cv.setAttribute("aria-label", unit === "trades" ? "Sphere with one dot for each trade found so far. Green made money, red lost." : "Sphere with one dot for each stock tested so far");
  }
  unitEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-u]"); if (!b || b.dataset.u === unit) return;
    unit = b.dataset.u; try { localStorage.setItem("swing-scan-unit", unit); } catch { /* ignore */ }
    hov = -1; readKey = ""; recolor(); drawControls();
  });
  modeEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]"); if (!b) return;
    cmode[unit] = b.dataset.m; try { localStorage.setItem("swing-scan-cmode-" + unit, cmode[unit]); } catch { /* ignore */ }
    recolor(); drawControls();
  });
  drawControls();

  function fit() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  new ResizeObserver(fit).observe(cv);
  if ("IntersectionObserver" in window) new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(cv);

  const setPtr = (e) => { const r = cv.getBoundingClientRect(); ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; ptr.on = true; };
  cv.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") setPtr(e); });
  cv.addEventListener("pointerdown", (e) => { clearTimeout(ptrTimer); setPtr(e); });
  const rel = (e) => { if (e.pointerType !== "mouse") { clearTimeout(ptrTimer); ptrTimer = setTimeout(() => { ptr.on = false; }, 2600); } };
  cv.addEventListener("pointerup", rel); cv.addEventListener("pointercancel", rel);
  cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") ptr.on = false; });

  const num = (n) => n.toLocaleString("en-US");
  function setRead(html, key) { if (key !== readKey) { readKey = key; read.innerHTML = html; } }
  function updateRead() {
    const u = cur(), nS = U.stocks.n, nT = U.trades.n;
    if (hov >= 0 && u.dots[hov]) {
      const d = u.dots[hov];
      if (unit === "trades") {
        setRead(`<b>${esc(d.sym)}</b> <span class="hint">${d.side === "short" ? "short" : "long"}${d.sector ? " · " + esc(d.sector) : ""}</span><br><b class="${d.r >= 0 ? "pos" : "neg"}">${sgn(d.r)}R</b> <span class="hint">· ${dayFmt(d.date)} to ${dayFmt(d.exit)}${d.hold != null ? " · held " + d.hold + " days" : ""}${d.reason ? " · " + esc(d.reason) : ""}</span>`, "ht" + hov);
      } else {
        setRead(`<b>${esc(d.sym)}</b> <span class="hint">${d.sector ? esc(d.sector) + " · " : ""}${d.trades} trades${d.wr != null ? " · " + pct0(d.wr) + " wins" : ""}</span><br>Expectancy <b>${d.exp == null ? "-" : sgn(d.exp) + "R"}</b>${d.holdPct != null ? ` <span class="hint">· buy and hold ${sgn(d.holdPct, 1)}%</span>` : ""}`, "hs" + hov);
      }
    } else if (state === "scan") {
      const lastD = U.stocks.dots[nS - 1];
      setRead(`<span class="hint">Scanning</span> <b>${lastD ? esc(lastD.sym) : "..."}</b><br><span class="hint">${units.includes("trades") ? num(nT) + " trades found · " : ""}${nS} of ${total} stocks tested</span>`, "s" + nT + "/" + nS + "/" + total);
    } else if (state === "done" || state === "stopped") {
      setRead(`<b>${state === "stopped" ? "Stopped" : "Scan complete"}</b> <span class="hint">· ${units.includes("trades") ? num(nT) + " trades across " : ""}${nS} stocks</span><br><span class="hint">Tap or hover a dot to inspect it.</span>`, state + nT + "/" + nS);
    } else setRead("", "idle");
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const u = cur(), dots = u.dots, k = u.n, pal = palette(), big = k > BIG, depthOn = fx.depth, secOn = fx.sectors, hudOn = fx.hud;
    ensure(k);
    const bounce = reduced ? 1 : 1 + 0.05 * Math.pow(Math.max(0, 1 - (now - doneAt) / 800), 2);
    const R = Math.min(W, H) * (secOn ? 0.26 : hudOn ? 0.31 : 0.36) * bounce, cx = W / 2, cy = H / 2, ca = Math.cos(angle), sa = Math.sin(angle);
    const ks = R / 150;
    const proj = (x, y, z) => {
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca, y2 = y * CT - z1 * ST, z2 = y * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
      return [cx + x1 * R * f, cy - y2 * R * f, z2];
    };
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.6);
    g.addColorStop(0, "rgba(111,128,255,.17)"); g.addColorStop(0.55, "rgba(211,92,255,.05)"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // each dot keeps its longitude; only its latitude eases as the count (or the sector bands) change, so the sphere re-spaces smoothly
    const ease = reduced ? 1 : 0.14, yA = u.y, tY = u.ty, cs = u.cs, sn = u.sn;
    for (let i = 0; i < k; i++) {
      const yy = yA[i] += (tY[i] - yA[i]) * ease;
      const r = Math.sqrt(Math.max(0, 1 - yy * yy)), x = cs[i] * r, z = sn[i] * r;
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
      const y2 = yy * CT - z1 * ST, z2 = yy * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
      sx[i] = cx + x1 * R * f; sy[i] = cy - y2 * R * f; sz[i] = z2; sf[i] = f;
    }
    if (ptr.on) {
      let best = -1, bd = 1e12;
      for (let i = 0; i < k; i++) { if (sz[i] < -0.15) continue; const dx = sx[i] - ptr.x, dy = sy[i] - ptr.y, q = dx * dx + dy * dy; if (q < bd) { bd = q; best = i; } }
      const lim = Math.max(big ? 10 : 14, (big ? 9 : 16) * ks); hov = best >= 0 && bd < lim * lim ? best : -1;
    } else hov = -1;

    const ring = (rad, yOff, wd, col, al) => {
      ctx.lineWidth = wd; ctx.strokeStyle = col;
      for (let s = 0; s < 72; s++) {
        const t0 = s / 72 * TAU, t1 = (s + 1) / 72 * TAU;
        const a = proj(Math.cos(t0) * rad, yOff, Math.sin(t0) * rad), b = proj(Math.cos(t1) * rad, yOff, Math.sin(t1) * rad);
        ctx.globalAlpha = Math.max(0, al * (0.2 + 0.8 * ((a[2] + b[2]) / 2 + 1.6) / 3.2));
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    };
    // latitude lines
    for (let lat = -60; lat <= 60; lat += 30) { const a = lat * Math.PI / 180; ring(Math.cos(a), Math.sin(a), 1, "#8f9bff", 0.1); }
    // sector boundaries
    if (secOn) for (let b = 1; b < u.bands.length; b++) { const yb = 1 - 2 * u.bands[b].start / Math.max(1, k); ring(Math.sqrt(Math.max(0, 1 - yb * yb)) * 1.002, yb, 1, "#e9edff", 0.26); }

    // HUD compass ring in the horizon plane, with degree ticks
    if (hudOn) {
      const rad = Math.min(1.55, (W / 2 - 14) / (R * 1.12));
      ring(rad, 0, 0.8, "#e9edff", 0.24);
      ctx.lineWidth = 1; ctx.strokeStyle = "#e9edff"; ctx.font = `700 8px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#8a94bd";
      for (let d = 0; d < 360; d += 6) {
        const a = d * Math.PI / 180, major = d % 30 === 0, ca2 = Math.cos(a), sa2 = Math.sin(a), rr = rad * (major ? 1.075 : 1.035);
        const p0 = proj(ca2 * rad, 0, sa2 * rad), p1 = proj(ca2 * rr, 0, sa2 * rr);
        ctx.globalAlpha = (major ? 0.75 : 0.4) * (0.2 + 0.8 * (p0[2] + 1.6) / 3.2);
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        if (d % 90 === 0 && p0[2] > -0.2) { const pl = proj(ca2 * rad * 1.17, 0, sa2 * rad * 1.17); ctx.globalAlpha = 0.8; ctx.fillText(String(d).padStart(3, "0"), pl[0], pl[1]); }
      }
    }

    // motion trails behind the dots while it spins (skipped for very large counts)
    const tl = Math.min(0.3, spin * 0.42);
    if (depthOn && !reduced && !big && tl > 0.012 && k) {
      ctx.lineCap = "round"; ctx.strokeStyle = "#a9b6ff"; ctx.lineWidth = Math.max(0.8, 1.1 * ks);
      for (let s = 1; s <= 4; s++) {
        const a2 = angle - tl * s / 4, c2 = Math.cos(a2), s2 = Math.sin(a2);
        ctx.beginPath();
        for (let i = 0; i < k; i++) {
          if (sz[i] < -0.05) continue;
          const yy = yA[i], r = Math.sqrt(Math.max(0, 1 - yy * yy)), x = cs[i] * r, z = sn[i] * r;
          const x1 = x * c2 + z * s2, z1 = -x * s2 + z * c2, y2 = yy * CT - z1 * ST, z2 = yy * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
          const nx = cx + x1 * R * f, ny = cy - y2 * R * f;
          ctx.moveTo(s === 1 ? sx[i] : tx[i], s === 1 ? sy[i] : ty[i]); ctx.lineTo(nx, ny); tx[i] = nx; ty[i] = ny;
        }
        ctx.globalAlpha = 0.3 * (1 - (s - 1) / 4); ctx.stroke();
      }
      ctx.lineCap = "butt";
    }

    // dot size: trades shrink as there are more of them so the sphere stays readable; stocks use trade count
    const sparse = clamp(Math.sqrt(500 / Math.max(k, 30)), 1, 2.4);
    const tSize = clamp(2.6 * Math.sqrt(1200 / Math.max(k, 300)), 0.8, 2.8);
    const draw1 = (i) => {
      const d = dots[i], f = sf[i], zn = (sz[i] + 1) / 2;
      const fade = reduced ? 1 : clamp((now - d.born) / 200, 0, 1);
      const a = (depthOn ? 0.12 + 0.88 * Math.pow(zn, 1.7) : 0.3 + 0.7 * zn) * fade;
      const zs = depthOn ? 0.7 + 0.3 * zn : 1, col = pal[d.ci];
      if (big) { const rad = tSize * f * ks * zs, sd = rad * 2; ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fillRect(sx[i] - rad, sy[i] - rad, sd, sd); return; }
      const rad = unit === "trades" ? tSize * f * ks * zs * (0.85 + 0.3 * clamp(Math.abs(d.r) / 2, 0, 1)) : (1.4 + clamp(d.trades / 50, 0, 1) * 2.2) * f * ks * zs * sparse;
      if (k <= 1500 && zn > 0.6) { ctx.globalAlpha = 0.1 * a; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx[i], sy[i], rad * 2.6, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = a * (reduced || k > 1500 ? 1 : 0.86 + 0.14 * Math.sin(now * 0.0018 + i * 1.7)); ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx[i], sy[i], rad, 0, TAU); ctx.fill();
    };
    if (!big) {
      const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => sz[a] - sz[b]);
      for (const i of order) draw1(i);
    } else {
      const B = 12, bands = Array.from({ length: B }, () => []);
      for (let i = 0; i < k; i++) bands[clamp(Math.floor((sz[i] + 1) / 2 * B), 0, B - 1)].push(i);
      for (const b of bands) for (const i of b) draw1(i);
    }

    // scanner ring follows real progress (stocks tested / total stocks)
    if (state === "scan" && total) {
      const p = clamp(U.stocks.n / total, 0, 1), ys = 1 - 2 * p, rr = Math.sqrt(Math.max(0, 1 - ys * ys)) * 1.05;
      if (rr > 0.02) { ring(rr, ys, 11, "#d35cff", 0.1); ring(rr, ys, 5, "#d35cff", 0.28); ring(rr, ys, 1.6, "#ffe6ff", 0.9); }
    }
    if (hov >= 0) {
      ctx.globalAlpha = 1; ctx.strokeStyle = "#e9edff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx[hov], sy[hov], 9 * Math.max(0.8, ks), 0, TAU); ctx.stroke();
    }

    // sector labels with a leader line and the live share of winners
    if (secOn && u.bands.length) {
      ctx.font = `700 9.5px ${MONO}`; ctx.textBaseline = "middle";
      u.bands.forEach((b, bi) => {
        if (b.count < 3) return;
        const yb = 1 - 2 * (b.start + b.count / 2) / Math.max(1, k), rr = Math.sqrt(Math.max(0, 1 - yb * yb));
        const left = bi % 2 === 0, f = 1 / (1 - yb * ST * 0.28);
        const lx = cx + (left ? -1 : 1) * rr * R * f, ly = cy - yb * CT * R * f;
        const name = short(b.name) + " ", share = Math.round(b.pos / b.count * 100) + "%";
        const w1 = ctx.measureText(name).width, w2 = ctx.measureText(share).width, tw = w1 + w2;
        let ax = cx + (left ? -1 : 1) * R * 1.2;
        ax = left ? Math.max(ax, 6 + tw) : Math.min(ax, W - 6 - tw);
        const x0 = left ? ax - tw : ax;
        ctx.globalAlpha = 0.35; ctx.strokeStyle = "#e9edff"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(ax + (left ? 4 : -4), ly); ctx.stroke();
        ctx.globalAlpha = 0.7; ctx.fillStyle = "#e9edff"; ctx.beginPath(); ctx.arc(lx, ly, 2, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.78; ctx.fillStyle = "#060914"; ctx.fillRect(x0 - 3, ly - 7, tw + 6, 14);
        ctx.globalAlpha = 1; ctx.textAlign = "left";
        ctx.fillStyle = "#c9d0f5"; ctx.fillText(name, x0, ly);
        ctx.fillStyle = b.pos * 2 >= b.count ? "#38e3a6" : "#ff5f7e"; ctx.fillText(share, x0 + w1, ly);
      });
    }

    // HUD corner brackets and live readouts
    if (hudOn) {
      const m = 7, L = 14;
      ctx.globalAlpha = 0.45; ctx.strokeStyle = "#e9edff"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(m, m + L); ctx.lineTo(m, m); ctx.lineTo(m + L, m);
      ctx.moveTo(W - m - L, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + L);
      ctx.moveTo(m, H - m - L); ctx.lineTo(m, H - m); ctx.lineTo(m + L, H - m);
      ctx.moveTo(W - m - L, H - m); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m, H - m - L);
      ctx.stroke();
      ctx.font = `500 9px ${MONO}`; ctx.textBaseline = "middle"; ctx.fillStyle = "#8a94bd"; ctx.globalAlpha = 0.9;
      ctx.textAlign = "right";
      ctx.fillText("ROT " + ((((angle % TAU) + TAU) % TAU) * 180 / Math.PI).toFixed(1) + "°", W - 22, 22);
      ctx.fillText("TILT " + (TILT * 180 / Math.PI).toFixed(1) + "°", W - 22, 34);
      ctx.textAlign = "left";
      const el = (now - startAt) / 1000, rate = state === "scan" && el > 0.3 ? U.stocks.n / el : 0;
      ctx.fillText(state === "scan" ? "SCAN " + rate.toFixed(1) + " STK/S" : U.stocks.n + " STK", 22, H - 34);
      ctx.fillText(state === "scan" ? "LIVE" : "IDLE", 22, H - 22);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (host.hidden || !visible || !W) return;
    if (coarse && now - last < 30) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const target = reduced ? 0 : hov >= 0 ? 0 : state === "scan" ? 0.7 : 0.2;
    spin += (target - spin) * Math.min(1, dt * 5); angle += spin * dt;
    draw(now); updateRead();
  }
  requestAnimationFrame(frame);

  function push(u, d) {
    grow(u, u.n + 1);
    d.ord = u.secCount.get(d.sector) || 0; u.secCount.set(d.sector, d.ord + 1);
    u.y[u.n] = -1;                 // new dots slide up from the south pole into place
    u.dots.push(d); u.n++;
  }
  return {
    reset(n) {
      for (const k of Object.keys(U)) { const u = U[k]; u.dots.length = 0; u.n = 0; u.secCount = new Map(); u.bands = []; }
      total = n; state = "scan"; startAt = performance.now(); hov = -1; readKey = ""; host.hidden = false; fit();
    },
    add(rows) {
      const now = performance.now();
      for (const r of rows) {
        const sector = r.sector || "";
        push(U.stocks, { sym: r.symbol, sector, trades: r.trades || 0, wr: r.winRate, exp: r.exp, holdPct: r.holdPct, pos: (r.exp ?? 0) > 0, born: now, ci: 0 });
        if (!units.includes("trades")) continue;
        const list = [...(r.tradeList || [])].sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)));
        for (const t of list) { const rr = Number(t.netR) || 0; push(U.trades, { sym: r.symbol, sector, side: t.side, date: t.date, exit: t.exitDate, r: rr, pos: rr > 0, hold: t.holdBars, reason: t.exitReason, born: now, ci: 0 }); }
      }
      for (const k of Object.keys(U)) relayout(U[k]);
      const un = cur(); for (let i = un.n - 1; i >= 0 && un.dots[i].born === now; i--) un.dots[i].ci = colorIdx(un.dots[i]);
    },
    finish(stopped) { state = stopped ? "stopped" : "done"; doneAt = performance.now(); },
    count: () => cur().n,
  };
}
