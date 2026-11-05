// "What the portfolio holds" chart (Swing Lab): one stacked bar per day (or per few days), split into the parked
// money (SPY, a yearly rate, or cash) and the stocks held, with the portfolio balance drawn along the top.
// Plain SVG, no dependencies.
const MAX_BARS = 150;
const TOP_STOCKS = 5;

export function makeMixChart(card, h) {
  const { esc, money } = h;
  const q = (sel) => card.querySelector(sel);
  const box = q(".mx-svg");
  const st = { d: null, win: "all", view: "all", offset: 0, sel: -1, bars: [], layers: [] };

  // Which stocks get their own colour: the ones held for the most dollar-days. Everything else is "Other stocks".
  function layersFor(d) {
    const tally = new Map();
    for (const list of d.held) for (const s of list) tally.set(s, (tally.get(s) || 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_STOCKS).map(([s]) => s);
    const layers = [{ key: "@park", name: d.parkName, cls: "mx-park" }, ...top.map((s, i) => ({ key: s, name: s, cls: `mx-s${i}` }))];
    if (tally.size > top.length) layers.push({ key: "@other", name: "Other stocks", cls: "mx-other" });
    return { layers, top: new Set(top) };
  }

  function windowDays() {
    const n = st.d.dates.length;
    const win = st.win === "all" ? n : Math.min(st.win, n);
    const end = Math.max(win, n - st.offset);
    return { win, start: end - win, end };
  }

  /** Average each layer over groups of days so a long window stays readable. */
  function makeBars(start, end) {
    const d = st.d, { layers, top } = layersFor(d);
    st.layers = layers;
    const size = Math.max(1, Math.ceil((end - start) / MAX_BARS));
    const bars = [];
    for (let a = start; a < end; a += size) {
      const b = Math.min(end, a + size), n = b - a;
      const vals = new Map(layers.map((l) => [l.key, 0]));
      let total = 0, spy = 0, park = 0;
      for (let i = a; i < b; i++) {
        park += d.park[i]; total += d.equity[i]; spy += d.spyOnly[i];
        for (const s of d.held[i]) vals.set(top.has(s) ? s : "@other", (vals.get(top.has(s) ? s : "@other") || 0) + d.dollars);
      }
      vals.set("@park", park);
      for (const [k, v] of vals) vals.set(k, v / n);
      bars.push({ a, b: b - 1, n, vals, total: total / n, spy: spy / n, held: d.held[b - 1], last: b - 1 });
    }
    st.bars = bars;
    return size;
  }

  function draw() {
    const d = st.d;
    const nDays = d.dates.length;
    const { start, end } = windowDays();
    const size = makeBars(start, end);
    const bars = st.bars, nb = bars.length;
    const W = 720, H = 290, pl = 62, pr = 14, pt = 14, pb = 26;
    const stocksOnly = st.view === "stocks";
    const shownLayers = stocksOnly ? st.layers.filter((l) => l.key !== "@park") : st.layers;
    const stackOf = (b) => shownLayers.reduce((t, l) => t + (b.vals.get(l.key) || 0), 0);
    let hi = stocksOnly ? Math.max(...bars.map(stackOf)) : Math.max(...bars.map((b) => Math.max(b.total, b.spy)));
    hi *= 1.06; if (!(hi > 0)) hi = 1;
    const Y = (v) => pt + (1 - v / hi) * (H - pt - pb);
    const slot = (W - pl - pr) / nb, bw = Math.max(1, slot * (nb > 80 ? 0.9 : 0.78));
    const cx = (i) => pl + slot * (i + 0.5);

    const rects = bars.map((b, i) => {
      let acc = 0;
      const segs = shownLayers.map((l) => {
        const v = b.vals.get(l.key) || 0;
        if (v <= 0) return "";
        const y1 = Y(acc + v), y0 = Y(acc); acc += v;
        return `<rect class="${l.cls}" x="${(cx(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(2)}"></rect>`;
      }).join("");
      const label = `${d.dates[b.a]}${b.n > 1 ? ` to ${d.dates[b.b]}` : ""}: portfolio ${money(b.total)}`;
      return `<g class="mx-bar${i === st.sel ? " sel" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(label)}"><title>${esc(label)}</title>${segs}<rect class="mx-hit" x="${(cx(i) - slot / 2).toFixed(1)}" y="${pt}" width="${slot.toFixed(1)}" height="${H - pt - pb}"></rect></g>`;
    }).join("");

    const line = (key, cls) => `<polyline class="${cls}" points="${bars.map((b, i) => `${cx(i).toFixed(1)},${Y(b[key]).toFixed(1)}`).join(" ")}"></polyline>`;
    const every = Math.max(1, Math.ceil(nb / 6)), long = end - start > 120;
    const labels = bars.map((b, i) => (i % every === 0 ? `<text class="lbl" x="${cx(i).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(long ? d.dates[b.a].slice(0, 7) : d.dates[b.a].slice(5))}</text>` : "")).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Portfolio holdings over ${end - start} days">
        <line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(hi).toFixed(1)}" y2="${Y(hi).toFixed(1)}"></line>
        <line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"></line>
        ${rects}${stocksOnly ? "" : line("spy", "mx-spyline") + line("total", "mx-total")}
        <text class="lbl" x="${pl - 6}" y="${Y(hi).toFixed(1)}" text-anchor="end" dominant-baseline="hanging">${money(hi).replace(/\.\d\d$/, "")}</text>
        <text class="lbl" x="${pl - 6}" y="${Y(0).toFixed(1)}" text-anchor="end">$0</text>${labels}</svg>`;

    q(".mx-legend").innerHTML = shownLayers.map((l) => `<span><i class="sw ${l.cls}"></i>${esc(l.name)}</span>`).join("")
      + (stocksOnly ? "" : `<span><i class="lg ln tot"></i> Portfolio balance</span><span><i class="lg ln sp"></i> Same money in the S&amp;P 500</span>`);
    card.querySelectorAll(".mx-view").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === st.view)));
    card.querySelectorAll(".mx-win").forEach((b) => { const w = b.dataset.win === "all" ? "all" : Number(b.dataset.win); b.setAttribute("aria-pressed", String(w === st.win)); });
    q(".mx-prev").disabled = start <= 0;
    q(".mx-next").disabled = end >= nDays;
    const last = bars[nb - 1];
    q(".mx-range").textContent = `${d.dates[start]} to ${d.dates[end - 1]}${size > 1 ? `; each bar is the average of ${size} days` : ""}${stocksOnly ? `; scale zoomed in to the stocks only (top of the chart: ${money(hi)})` : ""}. Portfolio ${money(d.equity[start])} → ${money(d.equity[end - 1])}; ${money(last.vals.get("@park") || 0)} parked on the last bar.`;
    if (st.sel < 0 || st.sel >= nb) q(".mx-detail").textContent = "Tap or click a bar to see what the portfolio held then.";
  }

  function select(i) {
    const b = st.bars[i], d = st.d;
    if (!b) return;
    st.sel = i;
    const when = b.n > 1 ? `${d.dates[b.a]} to ${d.dates[b.b]} (average)` : d.dates[b.a];
    const parts = st.layers.map((l) => [l.name, b.vals.get(l.key) || 0]).filter(([, v]) => v > 0.005).map(([n, v]) => `${n} ${money(v)}`);
    const heldNow = b.held.length ? `Stocks held on ${d.dates[b.last]}: ${b.held.slice(0, 40).join(", ")}${b.held.length > 40 ? `, and ${b.held.length - 40} more` : ""}.` : `No stocks held on ${d.dates[b.last]}.`;
    q(".mx-detail").textContent = `${when}: portfolio ${money(b.total)} (the same money in the S&P 500 alone: ${money(b.spy)}). Made of ${parts.join(", ")}. ${heldNow}`;
    draw();
    const el = box.querySelector(`[data-i="${i}"]`);
    if (el) el.focus();
  }

  /**
   * data: { dates, equity, park, held, spyOnly, dollars, parkName } with one entry per trading day.
   * Pass null to hide the card.
   */
  function render(data) {
    if (!data || !data.dates.length) { card.hidden = true; return; }
    card.hidden = false;
    st.d = data;
    if (st.sel >= 0) st.sel = Math.min(st.sel, MAX_BARS);
    q(".mx-title").textContent = "What the portfolio holds";
    draw();
  }

  function reset() { st.win = "all"; st.view = "all"; st.offset = 0; st.sel = -1; q(".mx-detail").textContent = "Tap or click a bar to see what the portfolio held then."; }

  card.querySelectorAll(".mx-win").forEach((b) => b.addEventListener("click", () => {
    st.win = b.dataset.win === "all" ? "all" : Number(b.dataset.win);
    st.offset = 0; st.sel = -1;
    if (st.d) draw();
  }));
  card.querySelectorAll(".mx-view").forEach((b) => b.addEventListener("click", () => { st.view = b.dataset.view; st.sel = -1; if (st.d) draw(); }));
  const shift = (dir) => {
    const { win, end } = windowDays();
    const n = st.d.dates.length;
    st.offset = n - Math.min(n, Math.max(win, end + dir * win));
    st.sel = -1;
    draw();
  };
  q(".mx-prev").addEventListener("click", () => shift(-1));
  q(".mx-next").addEventListener("click", () => shift(1));
  const pick = (e) => { const g = e.target.closest(".mx-bar"); if (g) select(Number(g.dataset.i)); };
  box.addEventListener("click", pick);
  box.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".mx-bar")) { e.preventDefault(); pick(e); } });
  return { render, reset };
}
