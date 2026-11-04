// Turns Yahoo's flat 5-minute bar arrays into one object per trading day, with the
// running VWAP and a "noise" yardstick (the typical 5-minute range) attached.

/**
 * Group bars by local date in `tz`. Only bars from `openMin` up to `closeMin` (minutes since
 * midnight) are kept: 9:30-16:00 ET for stocks, the whole UTC day for crypto.
 */
export function toSessions(bars, tz = "America/New_York", minBars = 30, openMin = 570, closeMin = 960) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const byDate = new Map();
  for (let i = 0; i < bars.t.length; i++) {
    const p = {};
    for (const part of fmt.formatToParts(new Date(bars.t[i] * 1000))) p[part.type] = part.value;
    const min = Number(p.hour) * 60 + Number(p.minute);
    if (min < openMin || min >= closeMin) continue;
    const date = `${p.year}-${p.month}-${p.day}`;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({
      t: bars.t[i], min,
      o: bars.open[i], h: bars.high[i], l: bars.low[i], c: bars.close[i], v: bars.volume[i] || 0,
    });
  }
  const sessions = [];
  for (const [date, b] of [...byDate.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (b.length < minBars) continue; // holiday stub or bad data
    b.sort((x, y) => x.t - y.t);
    attachVwap(b);
    attachEma(b);
    sessions.push({ date, bars: b });
  }
  return sessions;
}

// 9- and 20-bar exponential averages of the close, computed forward only (no peeking ahead).
function attachEma(b) {
  let e9 = b[0].c, e20 = b[0].c;
  for (const x of b) {
    e9 += (x.c - e9) * (2 / 10);
    e20 += (x.c - e20) * (2 / 21);
    x.ema9 = e9; x.ema20 = e20;
  }
}

function attachVwap(b) {
  let pv = 0, vol = 0;
  for (const x of b) {
    const typical = (x.h + x.l + x.c) / 3;
    pv += typical * x.v;
    vol += x.v;
    x.vwap = vol > 0 ? pv / vol : x.c;
  }
}

/**
 * Typical 5-minute range (average of high - low) over the `lookback` sessions BEFORE
 * index `i`. Used as the noise yardstick for "is this stop sensibly sized?".
 * Returns null until there is at least one prior session.
 */
export function noiseBefore(sessions, i, lookback = 5) {
  const from = Math.max(0, i - lookback);
  let sum = 0, n = 0;
  for (let s = from; s < i; s++) {
    for (const x of sessions[s].bars) { sum += x.h - x.l; n++; }
  }
  return n ? sum / n : null;
}

/**
 * Relative volume so far: volume of the session's first min(i+1, 6) bars (the first 30 minutes
 * at most) divided by the average for the same bars over the previous `lookback` sessions.
 * Uses only bars up to and including bar `i`, so it never looks ahead. null when unknown.
 */
export function relVolAt(sessions, si, i, lookback = 10) {
  const n = Math.min(i + 1, 6);
  if (n < 3) return null;
  const sumFirst = (bars) => bars.slice(0, n).reduce((t, x) => t + x.v, 0);
  const cur = sumFirst(sessions[si].bars);
  let tot = 0, cnt = 0;
  for (let k = Math.max(0, si - lookback); k < si; k++) {
    if (sessions[k].bars.length >= n) { tot += sumFirst(sessions[k].bars); cnt++; }
  }
  return cnt && tot > 0 ? cur / (tot / cnt) : null;
}

/** Map of bar time -> is SPY (or any index) above its own VWAP at that bar's close? */
export function aboveVwapMap(sessions) {
  const m = new Map();
  for (const s of sessions) for (const b of s.bars) m.set(b.t, b.c > b.vwap);
  return m;
}
