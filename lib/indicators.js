// Technical indicators and the Buy / Sell / Hold verdict.
//
// Every indicator is computed from DAILY price history and casts one vote:
//   +1 = bullish (buy), -1 = bearish (sell), 0 = neutral
// The ten votes are added:  >= +6 -> BUY,  <= -6 -> SELL,  otherwise HOLD.
// Five indicators follow the trend (MACD, moving averages, ADX, OBV, ROC) and
// five look for overbought / oversold extremes (RSI, Bollinger, Stochastic,
// CCI, MFI).
//
// All the tunable numbers are in SETTINGS below.

export const SETTINGS = {
  RSI_PERIOD: 14, RSI_OVERSOLD: 30, RSI_OVERBOUGHT: 70,
  MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,
  SMA_SHORT: 50, SMA_LONG: 200,
  BB_PERIOD: 20, BB_STD: 2, BB_LOW_ZONE: 0.2, BB_HIGH_ZONE: 0.8,
  STOCH_PERIOD: 14, STOCH_SMOOTH: 3, STOCH_OVERSOLD: 20, STOCH_OVERBOUGHT: 80,
  ADX_PERIOD: 14, ADX_TREND: 25,
  CCI_PERIOD: 20, CCI_OVERSOLD: -100, CCI_OVERBOUGHT: 100,
  MFI_PERIOD: 14, MFI_OVERSOLD: 20, MFI_OVERBOUGHT: 80,
  OBV_AVG: 20,
  ROC_PERIOD: 12,
  INDICATOR_COUNT: 10,
  BUY_THRESHOLD: 6, SELL_THRESHOLD: -6,
};
const S = SETTINGS;
export const MIN_BARS = S.SMA_LONG + 1;

// ---- helpers ---------------------------------------------------------------
// Exponential moving average seeded with the first value (pandas adjust=False).
function ema(values, alpha) {
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) { out[i] = prev; continue; }
    prev = Number.isNaN(prev) ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function rolling(values, n, fn) {
  const out = new Array(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    const w = values.slice(i - n + 1, i + 1);
    if (w.some(Number.isNaN)) continue;
    out[i] = fn(w);
  }
  return out;
}
const mean = (w) => w.reduce((a, b) => a + b, 0) / w.length;
const stdPop = (w) => { const m = mean(w); return Math.sqrt(mean(w.map((x) => (x - m) ** 2))); };
const last = (a) => a[a.length - 1];

// ---- indicators ------------------------------------------------------------
export function rsi(close, period = S.RSI_PERIOD) {
  const gains = [NaN], losses = [NaN];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = ema(gains, 1 / period), al = ema(losses, 1 / period);
  return ag.map((g, i) => {
    const l = al[i];
    if (Number.isNaN(g) || i < period) return NaN;
    if (l === 0 && g === 0) return 50;
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

export function macd(close) {
  const fast = ema(close, 2 / (S.MACD_FAST + 1));
  const slow = ema(close, 2 / (S.MACD_SLOW + 1));
  const line = fast.map((f, i) => f - slow[i]);
  const signal = ema(line, 2 / (S.MACD_SIGNAL + 1));
  return { line, signal };
}

export const sma = (close, n) => rolling(close, n, mean);

export function bollinger(close) {
  const mid = rolling(close, S.BB_PERIOD, mean);
  const sd = rolling(close, S.BB_PERIOD, stdPop);
  const upper = mid.map((m, i) => m + S.BB_STD * sd[i]);
  const lower = mid.map((m, i) => m - S.BB_STD * sd[i]);
  const pctB = close.map((c, i) => {
    const w = upper[i] - lower[i];
    return w > 0 ? (c - lower[i]) / w : NaN;
  });
  return { mid, upper, lower, pctB };
}

export function stochastic(high, low, close) {
  const lo = rolling(low, S.STOCH_PERIOD, (w) => Math.min(...w));
  const hi = rolling(high, S.STOCH_PERIOD, (w) => Math.max(...w));
  const fastK = close.map((c, i) => {
    const r = hi[i] - lo[i];
    return r > 0 ? (100 * (c - lo[i])) / r : NaN;
  });
  const k = rolling(fastK, S.STOCH_SMOOTH, mean);
  const d = rolling(k, S.STOCH_SMOOTH, mean);
  return { k, d };
}

// ADX with +DI / -DI (Wilder smoothing). ADX says how strong the trend is,
// +DI vs -DI says which way it points.
export function adx(high, low, close, period = S.ADX_PERIOD) {
  const n = close.length;
  const tr = new Array(n).fill(NaN), pdm = new Array(n).fill(NaN), mdm = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  const a = 1 / period;
  const str = ema(tr, a), sp = ema(pdm, a), sm = ema(mdm, a);
  const pdi = str.map((t, i) => (i >= period && t > 0 ? (100 * sp[i]) / t : NaN));
  const mdi = str.map((t, i) => (i >= period && t > 0 ? (100 * sm[i]) / t : NaN));
  const dx = pdi.map((p, i) => {
    const s = p + mdi[i];
    return s > 0 ? (100 * Math.abs(p - mdi[i])) / s : NaN;
  });
  const smooth = ema(dx, a);
  return { adx: smooth.map((v, i) => (i >= 2 * period ? v : NaN)), pdi, mdi };
}

// Commodity Channel Index on the typical price (high + low + close) / 3.
export function cci(high, low, close, period = S.CCI_PERIOD) {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  const avg = rolling(tp, period, mean);
  const dev = rolling(tp, period, (w) => { const m = mean(w); return mean(w.map((x) => Math.abs(x - m))); });
  return tp.map((v, i) => (dev[i] > 0 ? (v - avg[i]) / (0.015 * dev[i]) : NaN));
}

// Money Flow Index: an RSI that weights each day by traded value.
export function mfi(high, low, close, volume, period = S.MFI_PERIOD) {
  const n = close.length;
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  const pos = new Array(n).fill(0), neg = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const flow = tp[i] * volume[i];
    if (tp[i] > tp[i - 1]) pos[i] = flow; else if (tp[i] < tp[i - 1]) neg[i] = flow;
  }
  const out = new Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let p = 0, q = 0;
    for (let j = i - period + 1; j <= i; j++) { p += pos[j]; q += neg[j]; }
    out[i] = q === 0 ? (p === 0 ? 50 : 100) : 100 - 100 / (1 + p / q);
  }
  return out;
}

// On-Balance Volume: running total, + volume on up days, - volume on down days.
export function obv(close, volume) {
  const out = [0];
  for (let i = 1; i < close.length; i++) {
    out.push(out[i - 1] + (close[i] > close[i - 1] ? volume[i] : close[i] < close[i - 1] ? -volume[i] : 0));
  }
  return out;
}

// Rate of Change: % move over the last `period` sessions.
export function roc(close, period = S.ROC_PERIOD) {
  return close.map((c, i) => (i >= period && close[i - period] > 0 ? (c / close[i - period] - 1) * 100 : NaN));
}

// ---- voting ----------------------------------------------------------------
const money = (x) => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 1234567 -> "1.23M"; keeps the sign.
function compact(x) {
  const a = Math.abs(x), sign = x < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(0)}K`;
  return `${sign}${a.toFixed(0)}`;
}

/**
 * bars: { close, high, low, volume: number[] } (oldest first)
 * Returns null when there isn't enough history (e.g. a recent IPO).
 */
export function evaluate(bars) {
  const { close, high, low } = bars;
  if (!close || close.length < MIN_BARS) return null;
  const volume = bars.volume && bars.volume.length === close.length ? bars.volume : close.map(() => 0);
  const ind = [];

  // 1) RSI
  const r = last(rsi(close));
  ind.push(r < S.RSI_OVERSOLD
    ? { vote: 1, rule: `Below ${S.RSI_OVERSOLD} - oversold` }
    : r > S.RSI_OVERBOUGHT
      ? { vote: -1, rule: `Above ${S.RSI_OVERBOUGHT} - overbought` }
      : { vote: 0, rule: `Between ${S.RSI_OVERSOLD} and ${S.RSI_OVERBOUGHT} - neutral` });
  Object.assign(ind[0], { name: `RSI (${S.RSI_PERIOD})`, value: r.toFixed(1) });

  // 2) MACD
  const { line, signal } = macd(close);
  const m = last(line), s = last(signal);
  ind.push({
    name: `MACD (${S.MACD_FAST},${S.MACD_SLOW},${S.MACD_SIGNAL})`,
    value: `${m.toFixed(2)} vs ${s.toFixed(2)}`,
    ...(m > s ? { vote: 1, rule: "MACD above signal line - bullish momentum" }
      : m < s ? { vote: -1, rule: "MACD below signal line - bearish momentum" }
        : { vote: 0, rule: "MACD equal to signal line" }),
  });

  // 3) 50 / 200-day moving averages
  const s50 = last(sma(close, S.SMA_SHORT)), s200 = last(sma(close, S.SMA_LONG));
  ind.push({
    name: `Moving averages (${S.SMA_SHORT}/${S.SMA_LONG})`,
    value: `${money(s50)} / ${money(s200)}`,
    ...(s50 > s200 ? { vote: 1, rule: `${S.SMA_SHORT}-day above ${S.SMA_LONG}-day - uptrend` }
      : s50 < s200 ? { vote: -1, rule: `${S.SMA_SHORT}-day below ${S.SMA_LONG}-day - downtrend` }
        : { vote: 0, rule: "Averages equal" }),
  });

  // 4) Bollinger Bands
  const b = last(bollinger(close).pctB);
  ind.push({
    name: `Bollinger Bands (${S.BB_PERIOD}, ${S.BB_STD}sd)`,
    value: Number.isNaN(b) ? "%B n/a" : `%B ${Math.round(b * 100)}%`,
    ...(Number.isNaN(b) ? { vote: 0, rule: "Bands too narrow to judge" }
      : b <= S.BB_LOW_ZONE ? { vote: 1, rule: "Price near/below lower band" }
        : b >= S.BB_HIGH_ZONE ? { vote: -1, rule: "Price near/above upper band" }
          : { vote: 0, rule: "Price inside the bands - neutral" }),
  });

  // 5) Stochastic
  const k = last(stochastic(high, low, close).k);
  ind.push({
    name: `Stochastic (${S.STOCH_PERIOD},${S.STOCH_SMOOTH})`,
    value: Number.isNaN(k) ? "%K n/a" : `%K ${k.toFixed(1)}`,
    ...(Number.isNaN(k) ? { vote: 0, rule: "Not enough price range to judge" }
      : k < S.STOCH_OVERSOLD ? { vote: 1, rule: `Below ${S.STOCH_OVERSOLD} - oversold` }
        : k > S.STOCH_OVERBOUGHT ? { vote: -1, rule: `Above ${S.STOCH_OVERBOUGHT} - overbought` }
          : { vote: 0, rule: `Between ${S.STOCH_OVERSOLD} and ${S.STOCH_OVERBOUGHT} - neutral` }),
  });

  // 6) ADX / directional movement - only votes when the trend is strong
  const dm = adx(high, low, close);
  const ax = last(dm.adx), pdi = last(dm.pdi), mdi = last(dm.mdi);
  ind.push({
    name: `ADX (${S.ADX_PERIOD})`,
    value: Number.isNaN(ax) ? "n/a" : `${ax.toFixed(1)} · +DI ${pdi.toFixed(0)} / -DI ${mdi.toFixed(0)}`,
    ...(Number.isNaN(ax) || ax < S.ADX_TREND
      ? { vote: 0, rule: `ADX below ${S.ADX_TREND} - no strong trend` }
      : pdi > mdi ? { vote: 1, rule: `ADX above ${S.ADX_TREND}, buyers in control - strong uptrend` }
        : pdi < mdi ? { vote: -1, rule: `ADX above ${S.ADX_TREND}, sellers in control - strong downtrend` }
          : { vote: 0, rule: "Buyers and sellers evenly matched" }),
  });

  // 7) CCI
  const c = last(cci(high, low, close));
  ind.push({
    name: `CCI (${S.CCI_PERIOD})`,
    value: Number.isNaN(c) ? "n/a" : c.toFixed(0),
    ...(Number.isNaN(c) ? { vote: 0, rule: "Not enough price range to judge" }
      : c < S.CCI_OVERSOLD ? { vote: 1, rule: `Below ${S.CCI_OVERSOLD} - stretched low` }
        : c > S.CCI_OVERBOUGHT ? { vote: -1, rule: `Above +${S.CCI_OVERBOUGHT} - stretched high` }
          : { vote: 0, rule: `Between ${S.CCI_OVERSOLD} and +${S.CCI_OVERBOUGHT} - neutral` }),
  });

  // 8) Money Flow Index
  const mf = last(mfi(high, low, close, volume));
  ind.push({
    name: `Money Flow Index (${S.MFI_PERIOD})`,
    value: Number.isNaN(mf) ? "n/a" : mf.toFixed(1),
    ...(Number.isNaN(mf) ? { vote: 0, rule: "Not enough data to judge" }
      : mf < S.MFI_OVERSOLD ? { vote: 1, rule: `Below ${S.MFI_OVERSOLD} - oversold on heavy selling` }
        : mf > S.MFI_OVERBOUGHT ? { vote: -1, rule: `Above ${S.MFI_OVERBOUGHT} - overbought on heavy buying` }
          : { vote: 0, rule: `Between ${S.MFI_OVERSOLD} and ${S.MFI_OVERBOUGHT} - neutral` }),
  });

  // 9) On-Balance Volume vs its own average
  const ob = obv(close, volume);
  const obNow = last(ob), obAvg = last(sma(ob, S.OBV_AVG));
  ind.push({
    name: `On-Balance Volume (${S.OBV_AVG}-day avg)`,
    value: Number.isNaN(obAvg) ? "n/a" : `${compact(obNow)} vs ${compact(obAvg)}`,
    ...(Number.isNaN(obAvg) || obNow === obAvg
      ? { vote: 0, rule: "Volume flow level with its average" }
      : obNow > obAvg ? { vote: 1, rule: "OBV above its average - volume flowing in" }
        : { vote: -1, rule: "OBV below its average - volume flowing out" }),
  });

  // 10) Rate of Change
  const rc = last(roc(close));
  ind.push({
    name: `Rate of Change (${S.ROC_PERIOD})`,
    value: Number.isNaN(rc) ? "n/a" : `${rc > 0 ? "+" : ""}${rc.toFixed(1)}%`,
    ...(Number.isNaN(rc) || rc === 0 ? { vote: 0, rule: "No change over the period" }
      : rc > 0 ? { vote: 1, rule: `Higher than ${S.ROC_PERIOD} sessions ago - positive momentum` }
        : { vote: -1, rule: `Lower than ${S.ROC_PERIOD} sessions ago - negative momentum` }),
  });

  const score = ind.reduce((a, x) => a + x.vote, 0);
  const verdict = score >= S.BUY_THRESHOLD ? "BUY" : score <= S.SELL_THRESHOLD ? "SELL" : "HOLD";
  return {
    verdict, score,
    indicators: ind.map(({ name, value, vote, rule }) => ({ name, value, vote, rule })),
  };
}

// ---- history for the indicator pictures -------------------------------------
const rd = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const tail = (a, n, d = 2) => a.slice(-n).map((x) => rd(x, d));

/**
 * The last `days` sessions of every indicator series, for the "tap an indicator"
 * picture. Everything is computed on the full history first so the lines are
 * already warmed up at the left edge of the picture.
 */
export function history(bars, days = 126) {
  const { close, high, low, t } = bars;
  const volume = bars.volume && bars.volume.length === close.length ? bars.volume : close.map(() => 0);
  const mc = macd(close), bb = bollinger(close), st = stochastic(high, low, close), dm = adx(high, low, close);
  const ob = obv(close, volume);
  return {
    t: t.slice(-days),
    close: tail(close, days),
    RSI: { rsi: tail(rsi(close), days, 1) },
    MACD: {
      line: tail(mc.line, days, 3), signal: tail(mc.signal, days, 3),
      hist: tail(mc.line.map((v, i) => v - mc.signal[i]), days, 3),
    },
    MA: { sma50: tail(sma(close, S.SMA_SHORT), days), sma200: tail(sma(close, S.SMA_LONG), days) },
    Bollinger: { upper: tail(bb.upper, days), mid: tail(bb.mid, days), lower: tail(bb.lower, days) },
    Stoch: { k: tail(st.k, days, 1), d: tail(st.d, days, 1) },
    ADX: { adx: tail(dm.adx, days, 1), pdi: tail(dm.pdi, days, 1), mdi: tail(dm.mdi, days, 1) },
    CCI: { cci: tail(cci(high, low, close), days, 1) },
    MFI: { mfi: tail(mfi(high, low, close, volume), days, 1) },
    OBV: { obv: tail(ob, days, 0), avg: tail(sma(ob, S.OBV_AVG), days, 0) },
    ROC: { roc: tail(roc(close), days, 2) },
  };
}
