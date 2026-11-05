// "Every position, worst to best" (Swing Lab leaderboard): one bar per position sorted from the biggest loss on the left to the
// biggest win on the right. Losses are red and hang below the zero line, wins are green and rise above it, and the height is the
// percentage gained or lost, on one scale. Dashed lines mark the median and the average. Plain SVG, no dependencies.
const MAX_BARS = 400;

export function makeDistChart(card, h) {
  const { esc, sgn } = h;
  const q = (sel) => card.querySelector(sel);
  const box = q(".ds-svg");
  const st = { bars: [], sel: -1, data: null };

  /** Sorted returns -> at most MAX_BARS bars; when there are more positions than bars, neighbours are averaged. */
  function makeBars(sorted) {
    const n = sorted.length, size = Math.max(1, Math.ceil(n / MAX_BARS)), bars = [];
    for (let a = 0; a < n; a += size) {
      const b = Math.min(n, a + size), part = sorted.slice(a, b);
      bars.push({ a, b: b - 1, n: b - a, v: part.reduce((t, x) => t + x.r, 0) / part.length, first: part[0], last: part[part.length - 1] });
    }
    return bars;
  }

  function draw() {
    const d = st.data, bars = st.bars, nb = bars.length;
    const W = 720, H = 300, pl = 56, pr = 14, pt = 14, pb = 28;
    const hi = Math.max(0, ...bars.map((b) => b.v)) * 1.06, lo = Math.min(0, ...bars.map((b) => b.v)) * 1.06;
    const span = hi - lo || 1;
    const Y = (v) => pt + ((hi - v) / span) * (H - pt - pb);
    const slot = (W - pl - pr) / nb, bw = Math.max(1, slot * (nb > 120 ? 0.92 : 0.8));
    const cx = (i) => pl + slot * (i + 0.5);
    const y0 = Y(0);
    const rects = bars.map((b, i) => {
      const hgt = b.v === 0 ? 0 : Math.max(0.8, Math.abs(Y(b.v) - y0)), top = b.v < 0 ? y0 : y0 - hgt;     // a hairline minimum, always on the right side of zero
      const who = b.n === 1 ? `${b.first.sym || ""} ${b.first.date || ""}`.trim() : `positions ${b.a + 1} to ${b.b + 1}`;
      const label = `${who}: ${sgn(b.v)}%${b.n > 1 ? " on average" : ""}`;
      return `<g class="ds-bar${i === st.sel ? " sel" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(label)}"><title>${esc(label)}</title>`
        + `<rect class="${b.v < 0 ? "ds-loss" : "ds-win"}" x="${(cx(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(2)}"></rect>`
        + `<rect class="ds-hit" x="${(cx(i) - slot / 2).toFixed(1)}" y="${pt}" width="${slot.toFixed(1)}" height="${H - pt - pb}"></rect></g>`;
    }).join("");
    const mark = (v, cls) => {
      const y = Y(Math.max(lo, Math.min(hi, v)));
      return `<line class="${cls}" x1="${pl}" x2="${W - pr}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
    };
    const ticks = [hi / 1.06, lo / 1.06].filter((v, i) => (i ? v < 0 : v > 0));
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Every position sorted from biggest loss to biggest win">
      <line class="grid" x1="${pl}" x2="${W - pr}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}"></line>
      ${rects}
      ${mark(d.median, "ds-med")}${mark(d.mean, "ds-avg")}
      <text class="lbl" x="${pl - 6}" y="${y0.toFixed(1)}" text-anchor="end" dominant-baseline="middle">0%</text>
      ${ticks.map((v) => `<text class="lbl" x="${pl - 6}" y="${Y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${sgn(v, 0)}%</text>`).join("")}
      <text class="lbl" x="${pl}" y="${H - 8}" text-anchor="start">biggest loss</text>
      <text class="lbl" x="${W - pr}" y="${H - 8}" text-anchor="end">biggest win</text></svg>`;
    q(".ds-legend").innerHTML = `<span><i class="sw ds-loss"></i> Losing position (depth = % lost)</span><span><i class="sw ds-win"></i> Winning position (height = % gained)</span>`
      + `<span><i class="lg ln ds-medk"></i> Median ${sgn(d.median)}%</span><span><i class="lg ln sp"></i> Average ${sgn(d.mean)}%</span>`;
    if (st.sel < 0 || st.sel >= nb) q(".ds-detail").textContent = nb < d.n ? `Each bar is the average of ${Math.ceil(d.n / MAX_BARS)} neighbouring positions. Tap or click a bar for details.` : "Tap or click a bar to see that position.";
  }

  function select(i) {
    const b = st.bars[i];
    if (!b) return;
    st.sel = i; draw();
    const f = b.first, l = b.last;
    q(".ds-detail").textContent = b.n === 1
      ? `Position ${b.a + 1} of ${st.data.n}: ${f.sym || "a stock"}${f.date ? `, bought ${f.date}` : ""}${f.exit ? `, sold ${f.exit}` : ""}: ${sgn(b.v)}%.`
      : `Positions ${b.a + 1} to ${b.b + 1} of ${st.data.n}, from ${sgn(f.r)}% to ${sgn(l.r)}%: ${sgn(b.v)}% on average.`;
    const el = box.querySelector(`[data-i="${i}"]`);
    if (el) el.focus();
  }

  /** trades: [{ r: percent return, sym, date, exit }]. Pass an empty list to hide the card. */
  function render(trades) {
    if (!trades || !trades.length) { card.hidden = true; return; }
    card.hidden = false;
    const sorted = [...trades].sort((a, b) => a.r - b.r);
    const n = sorted.length, mean = sorted.reduce((t, x) => t + x.r, 0) / n;
    const median = n % 2 ? sorted[(n - 1) / 2].r : (sorted[n / 2 - 1].r + sorted[n / 2].r) / 2;
    const wins = sorted.filter((x) => x.r > 0), losses = sorted.filter((x) => x.r < 0);
    const avg = (a) => (a.length ? a.reduce((t, x) => t + x.r, 0) / a.length : 0);
    const k = Math.max(1, Math.ceil(n * 0.1)), topSum = sorted.slice(-k).reduce((t, x) => t + x.r, 0), net = sorted.reduce((t, x) => t + x.r, 0);
    st.data = { n, mean, median };
    st.bars = makeBars(sorted); st.sel = -1;
    q(".ds-summary").textContent = `${n} positions: ${wins.length} won (${wins.length ? sgn(avg(wins)) : "0"}% on average), ${losses.length} lost (${losses.length ? sgn(avg(losses)) : "0"}% on average). Median ${sgn(median)}%, average ${sgn(mean)}%.`
      + (net > 0 && topSum > 0 ? ` The best ${k} position${k === 1 ? "" : "s"} (top 10%) added up to ${Math.round((topSum / net) * 100)}% of the combined return of all positions${topSum > net ? " (more than the whole, because the rest lost on balance)" : ""}.` : "");
    draw();
  }

  const pick = (e) => { const g = e.target.closest(".ds-bar"); if (g) select(Number(g.dataset.i)); };
  box.addEventListener("click", pick);
  box.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".ds-bar")) { e.preventDefault(); pick(e); } });
  return { render };
}
