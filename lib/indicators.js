// Technical indicators and the Buy / Sell / Hold verdict.
//
// Every indicator is computed from DAILY price history and casts one vote:
//   +1 = bullish (buy), -1 = bearish (sell), 0 = neutral
// The five votes are added:  >= +3 -> BUY,  <= -3 -> SELL,  otherwise HOLD.
//
// All the tunable numbers are in SETTINGS below.

export const SETTINGS = {
  RSI_PERIOD: 14, RSI_OVERSOLD: 30, RSI_OVERBOUGHT: 70,
  MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,
  SMA_SHORT: 50, SMA_LONG: 200,
  BB_PERIOD: 20, BB_STD: 2, BB_LOW_ZONE: 0.2, BB_HIGH_ZONE: 0.8,
  STOCH_PERIOD: 14, STOCH_SMOOTH: 3, STOCH_OVERSOLD: 20, STOCH_OVERBOUGHT: 80,
  BUY_THRESHOLD: 3, SELL_THRESHOLD: -3,
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

// ---- voting ----------------------------------------------------------------
const money = (x) => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * bars: { close: number[], high: number[], low: number[] } (oldest first)
 * Returns null when there isn't enough history (e.g. a recent IPO).
 */
export function evaluate(bars) {
  const { close, high, low } = bars;
  if (!close || close.length < MIN_BARS) return null;
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

  const score = ind.reduce((a, x) => a + x.vote, 0);
  const verdict = score >= S.BUY_THRESHOLD ? "BUY" : score <= S.SELL_THRESHOLD ? "SELL" : "HOLD";
  return {
    verdict, score,
    indicators: ind.map(({ name, value, vote, rule }) => ({ name, value, vote, rule })),
  };
}
