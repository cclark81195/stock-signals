// Swing Lab - live scan sphere (no build step, no dependencies).
// One dot = one stock that has finished its backtest. The dot count is the number of stocks tested so far:
// stocks that fail or are skipped never get a dot. The total is used only for the progress readout.
//
//   const scan = makeScan(hostElement, { esc, sgn, pct0 });
//   scan.reset(total)            // new run: clears the dots
//   scan.add([{ symbol, sector, trades, winRate, exp, holdPct }])   // call as each batch finishes
//   scan.finish(stopped)         // run over: sphere keeps spinning
const TAU = Math.PI * 2, GA = Math.PI * (3 - Math.sqrt(5));
const TILT = 0.38, CT = Math.cos(TILT), ST = Math.sin(TILT);
const MODES = [["exp", "Expectancy"], ["win", "Win rate"], ["trades", "Trades"]];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
const WIN = hex("#38e3a6"), LOSS = hex("#ff5f7e"), DIM = hex("#8a94bd"), ACC = hex("#6f80ff"), ACC2 = hex("#d35cff");

export function makeScan(host, fmt) {
  const { esc, sgn, pct0 } = fmt;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  host.innerHTML = `
    <div class="scan-stage"><canvas role="img" aria-label="Sphere with one dot for each stock tested so far"></canvas></div>
    <div class="scan-read" role="status"></div>
    <div class="scan-modes" role="group" aria-label="Color dots by"></div>
    <div class="scan-legend" aria-hidden="true"></div>`;
  const cv = host.querySelector("canvas"), ctx = cv.getContext("2d");
  const read = host.querySelector(".scan-read"), modesEl = host.querySelector(".scan-modes"), legend = host.querySelector(".scan-legend");
  let mode = "exp";
  try { const m = localStorage.getItem("swing-scan-mode"); if (MODES.some((x) => x[0] === m)) mode = m; } catch { /* ignore */ }

  const dots = [];          // { sym, sector, trades, wr, exp, hold, y, born, col }
  let total = 0, state = "idle", doneAt = -1e9, angle = 0.6, spin = 0, hov = -1, W = 0, H = 0, dpr = 1, visible = true, last = 0, readKey = "";
  const ptr = { x: 0, y: 0, on: false }; let ptrTimer = 0;
  let sx = new Float32Array(0), sy = new Float32Array(0), sz = new Float32Array(0), sf = new Float32Array(0);

  function colorOf(d) {
    if (mode === "win") { const t = clamp(((d.wr ?? 0.5) - 0.5) / 0.25, -1, 1); return t >= 0 ? mix(DIM, WIN, Math.pow(t, 0.6)) : mix(DIM, LOSS, Math.pow(-t, 0.6)); }
    if (mode === "trades") return mix(ACC, ACC2, clamp((d.trades - 5) / 60, 0, 1));
    const t = clamp((d.exp ?? 0) / 0.5, -1, 1);
    return t >= 0 ? mix(DIM, WIN, Math.pow(t, 0.6)) : mix(DIM, LOSS, Math.pow(-t, 0.6));
  }
  function recolor() { for (const d of dots) d.col = colorOf(d); }
  function drawModes() {
    modesEl.innerHTML = '<span class="scan-lbl">Color by</span>' + MODES.map(([k, n]) => `<button type="button" data-m="${k}" aria-pressed="${k === mode}">${n}</button>`).join("");
    legend.innerHTML = mode === "exp"
      ? '<span><i class="sq" style="background:#38e3a6"></i>positive expectancy</span><span><i class="sq" style="background:#ff5f7e"></i>negative</span>'
      : mode === "win"
        ? '<span><i class="sq" style="background:#38e3a6"></i>wins more than 75%</span><span><i class="sq" style="background:#ff5f7e"></i>under 25%</span>'
        : '<span><i class="sq" style="background:#6f80ff"></i>few trades</span><span><i class="sq" style="background:#d35cff"></i>many trades</span>';
  }
  modesEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]"); if (!b) return;
    mode = b.dataset.m; try { localStorage.setItem("swing-scan-mode", mode); } catch { /* ignore */ }
    recolor(); drawModes();
  });
  drawModes();

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

  function setRead(html, key) { if (key !== readKey) { readKey = key; read.innerHTML = html; } }
  function updateRead() {
    if (hov >= 0 && dots[hov]) {
      const d = dots[hov];
      setRead(`<b>${esc(d.sym)}</b> <span class="hint">${d.sector ? esc(d.sector) + " · " : ""}${d.trades} trades${d.wr != null ? " · " + pct0(d.wr) + " wins" : ""}</span><br>Expectancy <b>${d.exp == null ? "-" : sgn(d.exp) + "R"}</b>${d.hold != null ? ` <span class="hint">· buy and hold ${sgn(d.hold, 1)}%</span>` : ""}`, "h" + hov);
    } else if (state === "scan") {
      setRead(`<span class="hint">Scanning</span> <b>${dots.length ? esc(dots[dots.length - 1].sym) : "..."}</b><br><span class="hint">${dots.length} of ${total} stocks tested</span>`, "s" + dots.length + "/" + total);
    } else if (state === "done" || state === "stopped") {
      setRead(`<b>${state === "stopped" ? "Stopped" : "Scan complete"}</b> <span class="hint">· ${dots.length} stocks tested</span><br><span class="hint">Tap or hover a dot to inspect that stock.</span>`, state + dots.length);
    } else setRead("", "idle");
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const k = dots.length;
    const bounce = reduced ? 1 : 1 + 0.05 * Math.pow(Math.max(0, 1 - (now - doneAt) / 800), 2);
    const R = Math.min(W, H) * 0.36 * bounce, cx = W / 2, cy = H / 2, ca = Math.cos(angle), sa = Math.sin(angle);
    const ks = R / 130;
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.6);
    g.addColorStop(0, "rgba(111,128,255,.17)"); g.addColorStop(0.55, "rgba(211,92,255,.05)"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    if (sx.length < k) { const n = Math.max(k, sx.length * 2, 64); sx = new Float32Array(n); sy = new Float32Array(n); sz = new Float32Array(n); sf = new Float32Array(n); }
    // dots keep their longitude (index * golden angle); only latitude eases as the count changes, so the sphere re-spaces smoothly
    const ease = reduced ? 1 : 0.14;
    for (let i = 0; i < k; i++) {
      const d = dots[i], ty = k > 1 ? 1 - 2 * (i + 0.5) / k : 0;
      d.y += (ty - d.y) * ease;
      const r = Math.sqrt(Math.max(0, 1 - d.y * d.y)), th = i * GA;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
      const y2 = d.y * CT - z1 * ST, z2 = d.y * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
      sx[i] = cx + x1 * R * f; sy[i] = cy - y2 * R * f; sz[i] = z2; sf[i] = f;
    }
    if (ptr.on) {
      let best = -1, bd = 1e12;
      for (let i = 0; i < k; i++) { if (sz[i] < -0.15) continue; const dx = sx[i] - ptr.x, dy = sy[i] - ptr.y, q = dx * dx + dy * dy; if (q < bd) { bd = q; best = i; } }
      const lim = Math.max(14, 16 * ks); hov = best >= 0 && bd < lim * lim ? best : -1;
    } else hov = -1;

    // latitude lines
    ctx.globalAlpha = 0.08; ctx.strokeStyle = "#8f9bff"; ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = lat * Math.PI / 180, rr = Math.cos(a), yy = Math.sin(a);
      ctx.beginPath();
      for (let s = 0; s <= 72; s++) {
        const t = s / 72 * TAU, x = Math.cos(t) * rr, z = Math.sin(t) * rr, x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
        const y2 = yy * CT - z1 * ST, z2 = yy * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
        const px = cx + x1 * R * f, py = cy - y2 * R * f; if (s) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
    }

    // motion trails behind the dots while it spins
    const tl = Math.min(0.3, spin * 0.42);
    if (!reduced && tl > 0.012 && k) {
      ctx.lineCap = "round"; ctx.strokeStyle = "#a9b6ff"; ctx.lineWidth = Math.max(0.8, 1.1 * ks);
      for (let s = 1; s <= 4; s++) {
        const a2 = angle - tl * s / 4, c2 = Math.cos(a2), s2 = Math.sin(a2);
        ctx.beginPath();
        for (let i = 0; i < k; i++) {
          if (sz[i] < -0.05) continue;
          const d = dots[i], r = Math.sqrt(Math.max(0, 1 - d.y * d.y)), th = i * GA, x = Math.cos(th) * r, z = Math.sin(th) * r;
          const x1 = x * c2 + z * s2, z1 = -x * s2 + z * c2, y2 = d.y * CT - z1 * ST, z2 = d.y * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
          const nx = cx + x1 * R * f, ny = cy - y2 * R * f;
          const px = s === 1 ? sx[i] : d._tx, py = s === 1 ? sy[i] : d._ty;
          ctx.moveTo(px, py); ctx.lineTo(nx, ny); d._tx = nx; d._ty = ny;
        }
        ctx.globalAlpha = 0.3 * (1 - (s - 1) / 4); ctx.stroke();
      }
      ctx.lineCap = "butt";
    }

    // dots, back to front. Few dots are drawn bigger so a 30-stock run still reads well.
    const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => sz[a] - sz[b]);
    const sparse = clamp(Math.sqrt(500 / Math.max(k, 30)), 1, 2.4);
    for (const i of order) {
      const d = dots[i], f = sf[i], zn = (sz[i] + 1) / 2;
      const fade = reduced ? 1 : clamp((now - d.born) / 200, 0, 1);
      const a = (0.12 + 0.88 * Math.pow(zn, 1.7)) * fade;
      const rad = (1.4 + clamp(d.trades / 50, 0, 1) * 2.2) * f * ks * (0.7 + 0.3 * zn) * sparse;
      if (zn > 0.6) { ctx.globalAlpha = 0.1 * a; ctx.fillStyle = d.col; ctx.beginPath(); ctx.arc(sx[i], sy[i], rad * 2.6, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = a * (reduced ? 1 : 0.86 + 0.14 * Math.sin(now * 0.0018 + i * 1.7)); ctx.fillStyle = d.col;
      ctx.beginPath(); ctx.arc(sx[i], sy[i], rad, 0, TAU); ctx.fill();
    }

    // scanner ring follows real progress (tested / total)
    if (state === "scan" && total) {
      const p = clamp(k / total, 0, 1), ys = 1 - 2 * p, rr = Math.sqrt(Math.max(0, 1 - ys * ys)) * 1.05;
      if (rr > 0.02) {
        const ring = (wd, col, al) => {
          ctx.lineWidth = wd; ctx.strokeStyle = col; ctx.globalAlpha = al; ctx.beginPath();
          for (let s = 0; s <= 72; s++) {
            const t = s / 72 * TAU, x = Math.cos(t) * rr, z = Math.sin(t) * rr, x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
            const y2 = ys * CT - z1 * ST, z2 = ys * ST + z1 * CT, f = 1 / (1 - z2 * 0.28);
            const px = cx + x1 * R * f, py = cy - y2 * R * f; if (s) ctx.lineTo(px, py); else ctx.moveTo(px, py);
          }
          ctx.stroke();
        };
        ring(11, "#d35cff", 0.1); ring(5, "#d35cff", 0.28); ring(1.6, "#ffe6ff", 0.9);
      }
    }
    if (hov >= 0) {
      ctx.globalAlpha = 1; ctx.strokeStyle = "#e9edff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx[hov], sy[hov], 9 * Math.max(0.8, ks), 0, TAU); ctx.stroke();
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

  return {
    reset(n) { dots.length = 0; total = n; state = "scan"; hov = -1; readKey = ""; host.hidden = false; fit(); },
    add(rows) {
      const now = performance.now();
      for (const r of rows) {
        const d = { sym: r.symbol, sector: r.sector || "", trades: r.trades || 0, wr: r.winRate, exp: r.exp, hold: r.holdPct, y: 0, born: now, col: "", _tx: 0, _ty: 0 };
        d.y = -1;                        // new dots slide up from the south pole into place
        d.col = colorOf(d); dots.push(d);
      }
    },
    finish(stopped) { state = stopped ? "stopped" : "done"; doneAt = performance.now(); },
    count: () => dots.length,
  };
}
