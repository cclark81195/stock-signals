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

/**
 * Gap and go: the stock opened at least minGapPct above the previous close and the gap is holding
 * (price still above that close and VWAP). Buy the first close above the opening range's high on
 * volume, before entryEndMin. Stop = the opening range's low. Needs ctx.prevClose (stocks only).
 */
export function gap(session, i, ctx, cfg) {
  const s = cfg.setups.gap;
  if (!s?.enabled || !ctx.prevClose) return null;
  const bars = session.bars;
  const b = bars[i];
  const orEnd = (cfg.openMin ?? 570) + s.orMinutes;
  if (b.min < orEnd || b.min > s.entryEndMin) return null;
  const gapPct = ((bars[0].o - ctx.prevClose) / ctx.prevClose) * 100;
  if (gapPct < s.minGapPct) return null;

  const range = bars.filter((x) => x.min < orEnd);
  if (range.length < Math.floor(s.orMinutes / 5)) return null;
  const orHigh = maxOf(range, "h"), orLow = minOf(range, "l");
  if (b.c <= orHigh || orLow <= ctx.prevClose || b.c <= b.vwap) return null;       // the gap must still be holding
  for (let k = range.length; k < i; k++) if (bars[k].c > orHigh) return null;       // only the first breakout
  if (i < 3 || b.v < s.volMult * avgVolume(bars, i)) return null;
  return {
    setup: "gap",
    stopRef: orLow,
    reason: `Opened ${gapPct.toFixed(1)}% above yesterday's close and the gap held; closed above the ${s.orMinutes}-minute range high ${orHigh.toFixed(2)} on ${(b.v / avgVolume(bars, i)).toFixed(1)}x volume.`,
  };
}

/**
 * Pullback to the moving average (trend continuation): in an uptrend (price above VWAP, the 9-bar
 * average above the rising 20-bar average) the stock dips to test the 20-bar average, then a green
 * bar closes above the 9-bar average and above the previous bar's high. Stop = the lowest low of the
 * last testBars + 1 bars. Needs the stock to have risen at least minRisePct from its session low.
 */
export function pullback(session, i, ctx, cfg) {
  const s = cfg.setups.pullback;
  if (!s?.enabled || !ctx.noise) return null;
  const bars = session.bars;
  const b = bars[i];
  if (i < 20 || b.min > cfg.entryCutoffMin || b.min < (cfg.openMin ?? 570) + 60) return null;
  if (!(b.c > b.o && b.c > b.vwap && b.c > b.ema9 && b.c > bars[i - 1].h)) return null;
  if (!(b.ema9 > b.ema20 && b.ema20 > bars[i - 6].ema20)) return null;

  const hist = bars.slice(0, i + 1);
  const rise = ((maxOf(hist, "h") - minOf(hist, "l")) / b.c) * 100;
  if (rise < s.minRisePct) return null;

  let tested = false;
  for (let j = i - s.testBars; j < i; j++) {
    const x = bars[j];
    if (x.l <= x.ema20 + s.touchNoise * ctx.noise && x.c >= x.ema20 - 0.5 * ctx.noise) { tested = true; break; }
  }
  if (!tested) return null;
  if (b.v < s.volMult * avgVolume(bars, i)) return null;

  const lowest = minOf(bars.slice(i - s.testBars, i + 1), "l");
  return {
    setup: "pullback",
    stopRef: lowest - s.stopPad * ctx.noise,
    reason: `Uptrend pullback: price tested the 20-bar average ${b.ema20.toFixed(2)} and a green bar closed back above the 9-bar average and the last high.`,
  };
}

/**
 * Fibonacci pullback: after a clear up-move (swing low then swing high within the last `lookback`
 * bars), price pulls back 38.2%-61.8% of the move without breaking the swing low, then a green bar
 * closes above the previous bar's high (still below the swing high). Stop = just under the 78.6% level.
 * The up-move's size is the "measured move".
 */
export function fib(session, i, ctx, cfg) {
  const s = cfg.setups.fib;
  if (!s?.enabled || !ctx.noise) return null;
  const bars = session.bars;
  const b = bars[i];
  if (i < 10 || b.min > cfg.entryCutoffMin || b.min < (cfg.openMin ?? 570) + 60) return null;
  if (!(b.c > b.o && b.c > bars[i - 1].h)) return null;

  const ws = Math.max(0, i - s.lookback);
  let hIdx = ws;
  for (let k = ws; k <= i; k++) if (bars[k].h >= bars[hIdx].h) hIdx = k;
  if (hIdx > i - 2) return null;                       // need at least a bar or two of pullback
  let lIdx = ws;
  for (let k = ws; k <= hIdx; k++) if (bars[k].l < bars[lIdx].l) lIdx = k;
  if (hIdx - lIdx < 3) return null;
  const H = bars[hIdx].h, L = bars[lIdx].l, leg = H - L;
  if (leg < s.minLegNoise * ctx.noise || (leg / b.c) * 100 < s.minLegPct) return null;

  const pullLow = minOf(bars.slice(hIdx + 1, i + 1), "l");
  if (pullLow <= L) return null;
  const depth = (H - pullLow) / leg;
  if (depth < s.zoneLo || depth > s.zoneHi || b.c >= H) return null;

  return {
    setup: "fib",
    stopRef: H - s.stopLevel * leg - s.stopPad * ctx.noise,
    measuredMove: leg,
    reason: `Fibonacci pullback: pulled back ${(depth * 100).toFixed(0)}% of the ${leg.toFixed(2)} up-move (${L.toFixed(2)} to ${H.toFixed(2)}) and a green bar closed above the last high.`,
  };
}

/**
 * Double bottom: two lows within tolPct of each other (6-30 bars apart) with a rally between them
 * at least minHeightNoise normal bar-ranges tall, then the first close above the middle peak ("neckline")
 * on volume. Stop = just under the lower of the two lows. The pattern height is the measured move.
 */
export function dbottom(session, i, ctx, cfg) {
  const s = cfg.setups.dbottom;
  if (!s?.enabled || !ctx.noise) return null;
  const bars = session.bars;
  const b = bars[i];
  if (i < s.lookback / 2 || b.min > cfg.entryCutoffMin || b.min < (cfg.openMin ?? 570) + 75) return null;

  const ws = Math.max(2, i - s.lookback);
  const mins = [];
  for (let k = ws; k <= i - 3; k++) {
    const l = bars[k].l;
    if (l < bars[k - 1].l && l < bars[k - 2].l && l <= bars[k + 1].l && l <= bars[k + 2].l) mins.push(k);
  }
  for (let a = mins.length - 1; a >= 1; a--) {
    const k2 = mins[a];
    for (let c = a - 1; c >= 0; c--) {
      const k1 = mins[c];
      const apart = k2 - k1;
      if (apart < s.minApart || apart > s.maxApart) continue;
      const l1 = bars[k1].l, l2 = bars[k2].l;
      if (Math.abs(l1 - l2) / Math.min(l1, l2) * 100 > s.tolPct) continue;
      const neck = maxOf(bars.slice(k1, k2 + 1), "h");
      const low = Math.min(l1, l2);
      if (neck - low < s.minHeightNoise * ctx.noise || ((neck - low) / b.c) * 100 < s.minHeightPct) continue;
      if (!(b.c > neck)) continue;
      let fresh = true;
      for (let k = k2 + 1; k < i; k++) if (bars[k].c > neck) { fresh = false; break; }
      if (!fresh || bars.slice(k2 + 1, i).some((x) => x.l < low)) continue;
      if (b.v < s.volMult * avgVolume(bars, i)) continue;
      return {
        setup: "dbottom",
        stopRef: low - s.stopPad * ctx.noise,
        measuredMove: neck - low,
        reason: `Double bottom: lows ${l1.toFixed(2)} and ${l2.toFixed(2)}, closed above the middle peak ${neck.toFixed(2)} on volume.`,
      };
    }
  }
  return null;
}

export const SETUPS = { gap, orb, vwap, flag, triangle, pullback, fib, dbottom };

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
