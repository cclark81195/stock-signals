// Entry setups. Each one is a PURE function: it looks at the session's bars up to and
// including bar `i` (a bar that has just CLOSED) and either returns a signal or null.
// It never sizes a trade or places an order; that is the risk engine's job.
//
// Long only: Robinhood retail accounts can't short stock, and long-only keeps the
// first version simple to test.
//
// signal = { setup, stopRef, reason }   stopRef = the price that proves the idea wrong.

const avgVolume = (bars, upTo) => {
  let s = 0;
  for (let k = 0; k < upTo; k++) s += bars[k].v;
  return upTo ? s / upTo : 0;
};

/**
 * Opening-range breakout: after the first N minutes, the first 5-minute bar that
 * CLOSES above the range high on above-average volume and above VWAP.
 * Stop = bottom of the opening range.
 */
export function orb(session, i, ctx, cfg) {
  const s = cfg.setups.orb;
  if (!s?.enabled) return null;
  const bars = session.bars;
  const b = bars[i];
  const orEnd = (cfg.openMin ?? 570) + s.orMinutes;
  if (b.min < orEnd || b.min > s.entryEndMin) return null;

  const range = bars.filter((x) => x.min < orEnd);
  if (range.length < Math.floor(s.orMinutes / 5)) return null; // opening bars missing
  const orHigh = Math.max(...range.map((x) => x.h));
  const orLow = Math.min(...range.map((x) => x.l));

  if (b.c <= orHigh) return null;
  // Must be the FIRST close above the range, otherwise the move is already stale.
  for (let k = range.length; k < i; k++) if (bars[k].c > orHigh) return null;

  if (i < 3 || b.v < s.volMult * avgVolume(bars, i)) return null;
  if (b.c <= b.vwap) return null;

  return {
    setup: "orb",
    stopRef: orLow,
    reason: `Closed above the ${s.orMinutes}-minute range high ${orHigh.toFixed(2)} on ${(b.v / avgVolume(bars, i)).toFixed(1)}x average volume, above VWAP.`,
  };
}

/**
 * VWAP reclaim: price spent most of the last few bars below VWAP, then a green bar
 * closes back above it on decent volume. Stop = lowest low of the last 4 bars,
 * padded by a fraction of normal noise.
 */
export function vwap(session, i, ctx, cfg) {
  const s = cfg.setups.vwap;
  if (!s?.enabled) return null;
  const bars = session.bars;
  const b = bars[i];
  if (b.min < s.startMin || b.min > cfg.entryCutoffMin || i < 7) return null;

  const prev = bars[i - 1];
  if (!(prev.c < prev.vwap)) return null;                // this bar is the cross
  if (!(b.c > b.vwap && b.c > b.o)) return null;          // green close back above VWAP
  const below = bars.slice(i - 6, i).filter((x) => x.c < x.vwap).length;
  if (below < s.belowBars) return null;                   // it was a real excursion, not a wiggle
  if (b.v < s.volMult * avgVolume(bars, i)) return null;

  const lowest = Math.min(...bars.slice(i - 3, i + 1).map((x) => x.l));
  const pad = ctx.noise ? s.stopPad * ctx.noise : 0;
  return {
    setup: "vwap",
    stopRef: lowest - pad,
    reason: `Reclaimed VWAP ${b.vwap.toFixed(2)} after ${below} of the last 6 bars closed below it.`,
  };
}


const maxOf = (bars, key) => Math.max(...bars.map((x) => x[key]));
const minOf = (bars, key) => Math.min(...bars.map((x) => x[key]));

/**
 * Bull flag: a sharp rise (the "pole"), a short, shallow, quieter pullback (the "flag"),
 * then the first close above the flag's high on a pickup in volume. Tries flags of
 * minFlag..maxFlag bars. Stop = bottom of the flag. The pole height is the "measured move".
 *
 * Exact rules (all must hold):
 *   - pole = the `poleBars` bars before the flag; its range is >= poleMinNoise x normal bar range
 *     and >= poleMinPct % of price
 *   - flag highs never exceed the pole high; the flag gives back at most maxRetrace of the pole
 *   - average flag volume is lower than average pole volume
 *   - breakout bar closes above the flag high and above VWAP, with volume >= volMult x the flag's average
 */
export function flag(session, i, ctx, cfg) {
  const s = cfg.setups.flag;
  if (!s?.enabled || !ctx.noise) return null;
  const bars = session.bars;
  const b = bars[i];
  if (b.min > cfg.entryCutoffMin || b.min < (cfg.openMin ?? 570) + 5 * (s.poleBars + s.minFlag)) return null;
  if (b.c <= b.vwap) return null;

  for (let f = s.minFlag; f <= s.maxFlag; f++) {
    const fs = i - f;                 // first flag bar
    if (fs - s.poleBars < 0) break;
    const flagBars = bars.slice(fs, i);
    const pole = bars.slice(fs - s.poleBars, fs);
    const poleHigh = maxOf(pole, "h"), poleLow = minOf(pole, "l");
    const poleRange = poleHigh - poleLow;
    if (poleRange < s.poleMinNoise * ctx.noise || poleRange / b.c * 100 < s.poleMinPct) continue;
    // the pole must END strong: its high sits in its last half
    if (pole.slice(0, Math.floor(s.poleBars / 2)).some((x) => x.h >= poleHigh)) continue;
    const flagHigh = maxOf(flagBars, "h"), flagLow = minOf(flagBars, "l");
    if (flagHigh > poleHigh) continue;
    if ((poleHigh - flagLow) / poleRange > s.maxRetrace) continue;
    const flagVol = flagBars.reduce((t, x) => t + x.v, 0) / f;
    const poleVol = pole.reduce((t, x) => t + x.v, 0) / pole.length;
    if (flagVol >= poleVol) continue;
    if (!(b.c > flagHigh) || b.v < s.volMult * flagVol) continue;
    const pad = s.stopPad * ctx.noise;
    return {
      setup: "flag",
      stopRef: flagLow - pad,
      measuredMove: poleRange,
      reason: `Bull flag: ${f}-bar pullback (${(((poleHigh - flagLow) / poleRange) * 100).toFixed(0)}% of the pole) after a ${poleRange.toFixed(2)} rise, broke above ${flagHigh.toFixed(2)} on rising volume.`,
    };
  }
  return null;
}

/**
 * Ascending triangle: a flat ceiling tested at least twice while the lows keep rising,
 * then the first close above the ceiling on volume.
 *
 * Exact rules:
 *   - look at the previous `lookback` bars; ceiling = their highest high
 *   - at least 2 separate touches (bars whose high is within tolPct % of the ceiling, not adjacent)
 *   - the lowest low of each third of the window is higher than the one before, and the whole rise is >= 0.5 x normal bar range
 *   - the pattern is at least 3 x normal bar range tall
 *   - breakout bar closes above the ceiling and VWAP on volume >= volMult x the session's average so far
 * Stop = the most recent rising low. The triangle's height is the "measured move".
 */
export function triangle(session, i, ctx, cfg) {
  const s = cfg.setups.triangle;
  if (!s?.enabled || !ctx.noise) return null;
  const bars = session.bars;
  const b = bars[i];
  if (i < s.lookback || b.min > cfg.entryCutoffMin || b.min < (cfg.openMin ?? 570) + 5 * s.lookback) return null;
  if (b.c <= b.vwap || b.c <= bars[i - 1].c) return null;

  const win = bars.slice(i - s.lookback, i);
  const ceiling = maxOf(win, "h");
  if (!(b.c > ceiling)) return null;
  let touches = 0, lastTouch = -9;
  win.forEach((x, k) => {
    if (x.h >= ceiling * (1 - s.tolPct / 100)) { if (k - lastTouch > 1) touches++; lastTouch = k; }
  });
  if (touches < 2) return null;

  const third = Math.floor(s.lookback / 3);
  const lows = [0, 1, 2].map((k) => minOf(win.slice(k * third, k === 2 ? win.length : (k + 1) * third), "l"));
  if (!(lows[0] < lows[1] && lows[1] < lows[2]) || lows[2] - lows[0] < 0.5 * ctx.noise) return null;
  const height = ceiling - lows[0];
  if (height < 3 * ctx.noise) return null;
  if (b.v < s.volMult * avgVolume(bars, i)) return null;

  return {
    setup: "triangle",
    stopRef: lows[2] - s.stopPad * ctx.noise,
    measuredMove: height,
    reason: `Ascending triangle: ceiling ${ceiling.toFixed(2)} touched ${touches} times with rising lows (${lows.map((x) => x.toFixed(2)).join(" → ")}), closed above it on volume.`,
  };
}

export const SETUPS = { orb, vwap, flag, triangle };

/**
 * Trade-quality filters, applied to every setup. All off by default.
 *   market: only when SPY is above its own VWAP (ctx.marketOk(bar time))
 *   inPlay: only when the stock's first 30 minutes traded >= minRelVol x its recent average (ctx.relVol)
 */
function passesFilters(session, i, ctx, cfg) {
  const f = cfg.filters || {};
  if (f.market && ctx.marketOk && !ctx.marketOk(session.bars[i].t)) return false;
  if (f.inPlay && ctx.relVol && !(ctx.relVol(i) >= f.minRelVol)) return false;
  return true;
}

/** First setup that fires on this bar wins (order = order of keys in cfg.setups). */
export function detect(session, i, ctx, cfg) {
  if (!passesFilters(session, i, ctx, cfg)) return null;
  for (const name of Object.keys(cfg.setups)) {
    const fn = SETUPS[name];
    if (!fn) continue;
    const sig = fn(session, i, ctx, cfg);
    if (sig) return sig;
  }
  return null;
}
