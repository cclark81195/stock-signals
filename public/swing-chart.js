// Account balance chart with a marker for every buy and sell (Swing Lab). Plain SVG, no dependencies.
// The x axis is "days with activity" (weekends and quiet days squeezed out), so it can grow as a scan runs.
import { fx } from "./swing-fx.js";
export function makeTradeChart(card, h) {
  const { esc, money, sgn, price, qty, exitNames } = h;
  const q = (sel) => card.querySelector(sel);
  const box = q(".bal-svg");
  const WINDOWS = { 21: "1 month", 63: "3 months", 252: "1 year", all: "All" };
  const MAX_MARKERS = 300;
  const bal = { events: [], days: [], dayIdx: new Map(), start: 0, spy: null, valueAt: null, win: "all", offset: 0, sel: -1, picked: false, label: "" };

  function prepare(trades, start) {
    const events = [];
    trades.forEach((t, k) => { events.push({ kind: "buy", date: t.date, t, k }); events.push({ kind: "sell", date: t.exitDate, t, k }); });
    // within a day, sales come before other buys (freed cash first), but a trade's own buy comes before its sale
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.k === b.k ? (a.kind === "buy" ? -1 : 1) : (a.kind === "sell" ? -1 : 1) - (b.kind === "sell" ? -1 : 1) || a.k - b.k));
    let balance = start;
    for (const e of events) { if (e.kind === "sell") balance += e.t.pnl; e.balance = balance; }
    // with parked money the portfolio value is known for every day, not only after a sale
    if (bal.valueAt) for (const e of events) { const v = bal.valueAt(e.date); if (v != null) e.balance = v; }
    bal.events = events; bal.start = start;
    bal.days = [...new Set(events.map((e) => e.date))].sort();
    bal.dayIdx = new Map(bal.days.map((d, i) => [d, i]));
  }

  function windowDays() {
    const n = bal.days.length;
    const win = bal.win === "all" ? n : Math.min(bal.win, n);
    const end = Math.max(win, n - bal.offset);
    return { win, start: end - win, end };
  }

  // The widest range that still has a readable number of markers.
  function defaultWindow() {
    const n = bal.days.length;
    for (const w of ["all", 252, 63, 21]) {
      const k = w === "all" ? n : Math.min(w, n);
      const set = new Set(bal.days.slice(n - k));
      if (bal.events.filter((e) => set.has(e.date)).length <= MAX_MARKERS) return w;
    }
    return 21;
  }

  const label = (date, long) => (long ? date.slice(0, 7) : date.slice(5));

  function draw() {
    const n = bal.days.length;
    const { win, start, end } = windowDays();
    const shown = bal.days.slice(start, end);
    const dset = new Set(shown);
    const ev = bal.events.filter((e) => dset.has(e.date));
    const W = 720, H = 270, pl = 62, pr = 14, pt = 14, pb = 26;
    const firstIdx = bal.events.indexOf(ev[0]);
    const startBal = bal.valueAt ? (start > 0 ? (bal.valueAt(bal.days[start - 1]) ?? bal.start) : bal.start) : firstIdx > 0 ? bal.events[firstIdx - 1].balance : bal.start;
    const X = (date) => pl + ((bal.dayIdx.get(date) - start + 0.5) / Math.max(1, end - start)) * (W - pl - pr);

    // S&P 500 line: from the very start it is the true value of the same money; zoomed into a later range it is rebased to the
    // account's balance at the start of that range, so the two lines can be compared over the same period.
    let spyPts = [];
    if (bal.spy) {
      const c0 = bal.spy.close(shown[0]);
      const val = (dt) => { const c = bal.spy.close(dt); if (c == null) return null; return start === 0 ? (bal.start * c) / bal.spy.base : c0 ? (startBal * c) / c0 : null; };
      spyPts = shown.map((dt) => [dt, val(dt)]).filter(([, v]) => v != null);
    }
    const vals = [startBal, ...ev.map((e) => e.balance), ...spyPts.map(([, v]) => v)];
    if (start === 0) vals.push(bal.start);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1) { const c = (hi + lo) / 2; hi = c + 0.5; lo = c - 0.5; }
    const padY = (hi - lo) * 0.1; hi += padY; lo -= padY;
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);

    let cur = startBal, d, stratPts = null;
    if (bal.valueAt) {
      // daily line: the parked money moves every day
      const pts = shown.map((dt) => [dt, bal.valueAt(dt)]).filter(([, v]) => v != null);
      d = pts.length ? `M${pl},${Y(startBal).toFixed(1)} ` + pts.map(([dt, v]) => `L${X(dt).toFixed(1)},${Y(v).toFixed(1)}`).join(" ") : `M${pl},${Y(cur).toFixed(1)}`;
      if (pts.length) cur = pts[pts.length - 1][1];
      stratPts = pts;
    } else {
      // step line: flat until a sale, then straight to the new balance
      d = `M${pl},${Y(cur).toFixed(1)}`;
      for (const e of ev) {
        if (e.kind !== "sell") continue;
        const px = X(e.date).toFixed(1);
        d += ` L${px},${Y(cur).toFixed(1)} L${px},${Y(e.balance).toFixed(1)}`;
        cur = e.balance;
      }
      d += ` L${W - pr},${Y(cur).toFixed(1)}`;
    }
    // ribbon between the portfolio and the S&P 500: green where the portfolio is ahead, red where it is behind
    let ribbon = "";
    if (fx.ribbon && stratPts && stratPts.length > 1 && spyPts.length > 1) {
      const spyAt = new Map(spyPts);
      const both = stratPts.filter(([dt]) => spyAt.has(dt)).map(([dt, v]) => ({ x: X(dt), s: Y(v), b: Y(spyAt.get(dt)), up: v >= spyAt.get(dt) }));
      const flush = (run, up) => {
        if (run.length < 2) return;
        const top = run.map((q) => `${q.x.toFixed(1)},${q.s.toFixed(1)}`), bot = run.slice().reverse().map((q) => `${q.x.toFixed(1)},${q.b.toFixed(1)}`);
        ribbon += `<polygon class="rib ${up ? "up" : "dn"}" points="${top.concat(bot).join(" ")}"></polygon>`;
      };
      let run = [];
      for (const q of both) {
        if (run.length && run[run.length - 1].up !== q.up) {
          const a = run[run.length - 1], da = a.s - a.b, db = q.s - q.b, u = da / (da - db);
          const x = { x: a.x + (q.x - a.x) * u, s: a.s + (q.s - a.s) * u }; x.b = x.s; x.up = a.up;
          run.push(x); flush(run, a.up); run = [{ ...x, up: q.up }];
        }
        run.push(q);
      }
      flush(run, run.length ? run[run.length - 1].up : true);
    }
    const spyLine = spyPts.length > 1 ? `<polyline class="spy" points="${spyPts.map(([dt, v]) => `${X(dt).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"></polyline>` : "";

    const every = Math.max(1, Math.ceil(shown.length / 6));
    const long = shown.length > 120;
    const labels = shown.map((dt, i) => (i % every === 0 ? `<text class="lbl" x="${X(dt).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(label(dt, long))}</text>` : "")).join("");

    const showMarkers = ev.length <= MAX_MARKERS;
    const r = ev.length <= 60 ? 6 : ev.length <= 150 ? 4.5 : 3.2;
    const focusable = ev.length <= 150;
    const markers = showMarkers ? ev.map((e) => {
      const cx = X(e.date), cy = Y(e.balance), up = e.kind === "buy", t = e.t;
      const pts = up
        ? `${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy + r * 0.8).toFixed(1)} ${(cx + r).toFixed(1)},${(cy + r * 0.8).toFixed(1)}`
        : `${cx.toFixed(1)},${(cy + r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy - r * 0.8).toFixed(1)} ${(cx + r).toFixed(1)},${(cy - r * 0.8).toFixed(1)}`;
      const sh = t.side === "short";
      const text = up ? `${sh ? "Short sale" : "Buy"} ${t.symbol}: ${qty(t.shares)} shares at ${price(t.entry)}, ${t.date}` : `${sh ? "Cover" : "Sell"} ${t.symbol}: ${qty(t.shares)} shares at ${price(t.exit)}, ${t.exitDate}, ${money(t.pnl)}`;
      const id = bal.events.indexOf(e);
      return `<polygon class="mk ${up ? "buy" : "sell " + (t.pnl > 0 ? "win" : "loss")}${id === bal.sel ? " sel" : ""}" points="${pts}" data-i="${id}"${focusable ? ' tabindex="0" role="button"' : ""} aria-label="${esc(text)}"><title>${esc(text)}</title></polygon>`;
    }).join("") : "";

    const startLine = start === 0 && bal.start >= lo && bal.start <= hi ? `<line class="start" x1="${pl}" x2="${W - pr}" y1="${Y(bal.start).toFixed(1)}" y2="${Y(bal.start).toFixed(1)}"></line>` : "";
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(bal.label)} over ${shown.length} days with ${showMarkers ? ev.length : "no"} buy and sell markers">
        <line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(hi).toFixed(1)}" y2="${Y(hi).toFixed(1)}"></line>
        <line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(lo).toFixed(1)}" y2="${Y(lo).toFixed(1)}"></line>
        ${startLine}${ribbon}${spyLine}<path class="line${fx.ribbon ? " glow" : ""}" d="${d}"></path>${markers}
        <text class="lbl" x="${pl - 6}" y="${Y(hi).toFixed(1)}" text-anchor="end" dominant-baseline="hanging">${money(hi).replace(/\.\d\d$/, "")}</text>
        <text class="lbl" x="${pl - 6}" y="${Y(lo).toFixed(1)}" text-anchor="end">${money(lo).replace(/\.\d\d$/, "")}</text>${labels}</svg>`;

    card.querySelectorAll(".bal-win").forEach((b) => { const w = b.dataset.win === "all" ? "all" : Number(b.dataset.win); b.setAttribute("aria-pressed", String(w === bal.win)); });
    q(".bal-prev").disabled = start <= 0;
    q(".bal-next").disabled = end >= n;
    const endBal = bal.valueAt ? cur : ev.length && ev[ev.length - 1].kind === "sell" ? ev[ev.length - 1].balance : cur;
    q(".bal-range").textContent = `${shown[0]}${shown.length > 1 ? ` to ${shown[shown.length - 1]}` : ""} (${shown.length} of ${n} days with trades). ${bal.start ? "Balance" : "Profit"} ${money(startBal)} → ${money(endBal)}.`
      + (showMarkers ? "" : ` ${ev.length.toLocaleString("en-US")} buys and sells are too many to draw: choose a shorter range to see each one.`);
  }

  function select(i) {
    const e = bal.events[i];
    if (!e) return;
    bal.sel = i;
    const t = e.t;
    const sale = bal.events.find((x) => x.kind === "sell" && x.k === e.k);
    q(".bal-detail").textContent = `${t.side === "short" ? "Shorted" : "Bought"} ${qty(t.shares)} ${t.symbol} at ${price(t.entry)} (${money(t.shares * t.entry)}) on ${t.date}; ${t.side === "short" ? "bought back" : "sold"} at ${price(t.exit)} on ${t.exitDate}, ${exitNames[t.exitReason] || t.exitReason}: ${money(t.pnl)} (${t.retPct != null ? sgn(t.retPct) + "%" : sgn(t.netR) + "R"}) after ${t.holdBars} day${t.holdBars === 1 ? "" : "s"}. ${bal.valueAt ? "Portfolio value that day" : bal.start ? "Balance after the sale" : "Profit after the sale"}: ${money(sale.balance)}.`;
    draw();
    const m = box.querySelector(`[data-i="${i}"]`);
    if (m && m.hasAttribute("tabindex")) m.focus();
  }

  /** trades: the trades to draw; start: the account's starting balance (0 = running profit); spy: { close(date), base } or null. */
  function render(trades, start, { spy = null, settle = false, title = "", valueAt = null } = {}) {
    if (!trades || !trades.length) { card.hidden = true; return; }
    card.hidden = false;
    bal.valueAt = valueAt;
    prepare(trades, start);
    bal.spy = spy; bal.label = title;
    if (settle && !bal.picked) { bal.win = defaultWindow(); bal.offset = 0; }
    if (bal.sel >= bal.events.length) bal.sel = -1;
    q(".bal-note").textContent = `(${trades.length.toLocaleString("en-US")} trades)`;
    q(".bal-title").textContent = title;
    draw();
  }

  /** New scan: forget the chosen range and any selection. */
  function reset() { bal.picked = false; bal.win = "all"; bal.offset = 0; bal.sel = -1; q(".bal-detail").textContent = "Tap or click a marker to see that trade."; }

  card.querySelectorAll(".bal-win").forEach((b) => b.addEventListener("click", () => {
    bal.win = b.dataset.win === "all" ? "all" : Number(b.dataset.win);
    bal.offset = 0; bal.picked = true;
    if (bal.events.length) draw();
  }));
  const shift = (dir) => {
    const { win, end } = windowDays();
    const n = bal.days.length;
    bal.offset = n - Math.min(n, Math.max(win, end + dir * win));
    bal.picked = true;
    draw();
  };
  q(".bal-prev").addEventListener("click", () => shift(-1));
  q(".bal-next").addEventListener("click", () => shift(1));
  const pick = (e) => { const m = e.target.closest(".mk"); if (m) select(Number(m.dataset.i)); };
  box.addEventListener("click", pick);
  box.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".mk")) { e.preventDefault(); pick(e); } });
  /** Draw again with the current effect switches (the ribbon turned on or off). */
  function redraw() { if (bal.events.length) draw(); }
  return { render, reset, redraw, WINDOWS };
}
