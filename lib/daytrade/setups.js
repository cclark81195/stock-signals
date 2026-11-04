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
  const orEnd = 570 + s.orMinutes;
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

export const SETUPS = { orb, vwap };

/** First setup that fires on this bar wins (order = order of keys in cfg.setups). */
export function detect(session, i, ctx, cfg) {
  for (const name of Object.keys(cfg.setups)) {
    const fn = SETUPS[name];
    if (!fn) continue;
    const sig = fn(session, i, ctx, cfg);
    if (sig) return sig;
  }
  return null;
}
