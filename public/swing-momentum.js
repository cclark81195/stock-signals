// Monthly momentum rotation (Swing Lab). Pure functions: used by the page and by the tests.
//
// A leaderboard: on each rebalance day (monthly by default; weekly or daily are options) every stock gets an "upside score" and
// the top `topN` are held equally. By default the score is momentum: the gain over the last `lookback` days, skipping the most
// recent `skip` days (the very latest month tends to reverse, so the classic "12-1" score leaves it out). A stock that stays on
// the leaderboard is simply kept (no trading); one that drops out is sold and the next-best stock is bought. The ranking uses
// the previous day's close and fills happen at the new day's close, so nothing looks ahead. Optional market filter: when SPY is
// below its 200-day average, hold nothing.
export const BASE = 100; // every trade's profit is stated for $100; the account scales it to the real position size

export const sma = (arr, n) => {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
};

const monthOf = (d) => d.slice(0, 7);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
/** Is index i the first trading day of a new month / week / (always, for "day")? */
const isRebalanceDay = (dates, i, every) => {
  if (every === "day") return true;
  if (every === "week") return dow(dates[i]) < dow(dates[i - 1]) || (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000 >= 5;
  return monthOf(dates[i]) !== monthOf(dates[i - 1]);
};

// "Upside score" of a stock on day s. Both are known from prices up to and including day s.
//   momentum: the gain over the last `lookback` days, leaving out the latest `skip` days
//   dip: how many standard deviations the close sits BELOW its 20-day average (the room to bounce back to the average)
function dipSeries(series) {
  const n = 20, z = new Array(series.length).fill(null), avg = new Array(series.length).fill(null);
  for (let i = n - 1; i < series.length; i++) {
    let sum = 0, ok = true;
    for (let k = i - n + 1; k <= i; k++) { const v = series[k]; if (!(v > 0)) { ok = false; break; } sum += v; }
    if (!ok) continue;
    const m = sum / n; let sq = 0;
    for (let k = i - n + 1; k <= i; k++) sq += (series[k] - m) ** 2;
    const sd = Math.sqrt(sq / n);
    avg[i] = m; if (sd > 0) z[i] = (m - series[i]) / sd;
  }
  return { z, avg };
}

/**
 * dates: the shared trading calendar; closes: Map symbol -> closes aligned to dates (null before a stock existed);
 * spy: SPY's closes aligned to dates.
 * opts: score "momentum"|"dip", every "month"|"week"|"day", topN, buffer (a holding is kept until it ranks below topN + buffer),
 *       minScore (a stock must score above this to be bought), lookback/skip (days, momentum), slipBps, spyFilter,
 *       joined (Map symbol -> "YYYY-MM-DD": a stock is only ranked once it was in the index), sectors (Map symbol -> sector) with
 *       sectorCap (at most this many holdings from one sector; 0 = no limit).
 * Returns { trades, bySymbol, rebalances, testStart, picks, filterOff, universe }.
 */
export function buildRotation(dates, closes, spy, opts = {}) {
  const o = { score: "momentum", every: "month", lookback: 252, skip: 21, topN: 20, buffer: 0, slipBps: 5, spyFilter: false, ...opts };
  if (o.minScore == null) o.minScore = o.score === "dip" ? 1 : 0;
  const slip = o.slipBps / 10000;
  const L = dates.length;
  const syms = [...closes.keys()].sort();
  const spySma = o.spyFilter ? sma(spy, 200) : null;
  const marketOn = (s) => !o.spyFilter || (spySma[s] != null && spy[s] > spySma[s]);
  const dip = new Map();
  if (o.score === "dip") for (const sym of syms) dip.set(sym, dipSeries(closes.get(sym)));
  const held = new Map();
  const trades = [];
  let rebalances = 0, firstIdx = null;

  const sell = (sym, i, reason, withSlip = true) => {
    const p = held.get(sym);
    const px = closes.get(sym)[i] > 0 ? closes.get(sym)[i] : p.px;
    const out = withSlip ? px * (1 - slip) : px;
    trades.push({
      symbol: sym, side: "long", date: dates[p.i], exitDate: dates[i], entry: p.px, exit: out, shares: BASE / p.px,
      holdBars: i - p.i, exitReason: reason, pnl: BASE * (out / p.px - 1), retPct: (out / p.px - 1) * 100,
      exitTime: Date.parse(dates[i]) / 1000, base: BASE,
    });
    held.delete(sym);
  };

  const scoreOf = (sym, s, fillIdx) => {
    const series = closes.get(sym);
    if (!(series[fillIdx] > 0)) return null;
    const since = o.joined && o.joined.get(sym);
    if (since && dates[s] < since) return null;                       // not yet a member of the index that day
    if (o.score === "dip") return dip.get(sym).z[s];
    const a = series[s - o.lookback], b = series[s - o.skip];
    return a > 0 && b > 0 ? b / a - 1 : null;
  };
  /** Every stock with a score, best first. */
  const leaderboard = (s, fillIdx) => {
    const list = [];
    for (const sym of syms) { const sc = scoreOf(sym, s, fillIdx); if (sc != null) list.push([sym, sc]); }
    return list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  };
  /** The stocks worth buying: scoring above the minimum. */
  const buyable = (board) => board.filter(([, sc]) => sc > o.minScore);

  const first = Math.max(o.lookback + 1, 253);
  for (let i = first; i < L; i++) {
    if (!isRebalanceDay(dates, i, o.every)) continue;
    const s = i - 1;                                                  // the ranking uses yesterday's close
    rebalances++;
    const on = marketOn(s);
    const board = on ? leaderboard(s, i) : [];
    const rank = new Map(board.map(([sym], k) => [sym, k]));
    const score = new Map(board);
    for (const sym of [...held.keys()]) {
      if (!on) { sell(sym, i, "trend"); continue; }
      if (o.score === "dip" && closes.get(sym)[s] >= dip.get(sym).avg[s]) { sell(sym, i, "target"); continue; }   // back at its average
      // a momentum holding also goes when its score is no longer above the minimum; a dip holding stays until it is back at its average or outranked
      const keeps = rank.has(sym) && rank.get(sym) < o.topN + o.buffer && (o.score === "dip" || score.get(sym) > o.minScore);
      if (!keeps) sell(sym, i, "dropped");
    }
    let slots = o.topN - held.size;
    const perSector = new Map();
    const secOf = (sym) => (o.sectors && o.sectors.get(sym)) || "";
    if (o.sectorCap > 0) for (const sym of held.keys()) perSector.set(secOf(sym), (perSector.get(secOf(sym)) || 0) + 1);
    for (const [sym] of buyable(board)) {
      if (slots <= 0) break;
      if (held.has(sym)) continue;
      if (o.sectorCap > 0 && secOf(sym) && (perSector.get(secOf(sym)) || 0) >= o.sectorCap) continue;   // that sector is full: take the next best
      if (o.sectorCap > 0) perSector.set(secOf(sym), (perSector.get(secOf(sym)) || 0) + 1);
      held.set(sym, { i, px: closes.get(sym)[i] * (1 + slip) });
      if (firstIdx == null) firstIdx = i;
      slots--;
    }
  }
  for (const sym of [...held.keys()]) sell(sym, L - 1, "data-end", false);

  // what it would hold if it rebalanced on the latest close
  const picksOn = L > first && marketOn(L - 1);
  const picks = [];
  if (picksOn) {
    const used = new Map();
    for (const [symbol, score] of buyable(leaderboard(L - 1, L - 1))) {
      if (picks.length >= o.topN) break;
      const sec = (o.sectors && o.sectors.get(symbol)) || "";
      if (o.sectorCap > 0 && sec && (used.get(sec) || 0) >= o.sectorCap) continue;
      used.set(sec, (used.get(sec) || 0) + 1);
      picks.push({ symbol, score, price: closes.get(symbol)[L - 1] });
    }
  }

  const bySymbol = new Map();
  for (const t of trades) { if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []); bySymbol.get(t.symbol).push(t); }
  const testStart = firstIdx == null ? null : dates[firstIdx];
  return { trades, bySymbol, rebalances, testStart, picks, filterOff: L > first && !marketOn(L - 1), universe: syms.length };
}

/** The shape the page's account code expects: one row per stock that traded. */
export const rotationRows = (rot) => [...rot.bySymbol.entries()].map(([symbol, trades]) => ({ symbol, trades, testStart: rot.testStart }));

/** Re-line a stock's closes (given on `from` dates) onto the `to` calendar, carrying the last close over gaps. */
export function align(from, series, to) {
  if (from.length === to.length && from.every((d, i) => d === to[i])) return series;
  const at = new Map(from.map((d, i) => [d, series[i]]));
  let last = null;
  return to.map((d) => { const v = at.get(d); if (v != null) last = v; return v != null ? v : last; });
}
