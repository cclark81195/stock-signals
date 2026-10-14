// Turns the ten indicator votes (plus a little price context, upcoming earnings
// and recent headlines) into a plain-English "strategy" for one stock.
//
// Everything here is rule-based and deterministic: it explains what the
// indicators say, it does not predict the future or read the news articles.
import { sma } from "./indicators.js";

// Order matches evaluate(): the five trend-following indicators and the five
// overbought/oversold ones.
const IDX = { RSI: 0, MACD: 1, SMA: 2, BB: 3, STOCH: 4, ADX: 5, CCI: 6, MFI: 7, OBV: 8, ROC: 9 };
const TREND_IDS = [IDX.MACD, IDX.SMA, IDX.ADX, IDX.OBV, IDX.ROC];
const EXTREME_IDS = [IDX.RSI, IDX.BB, IDX.STOCH, IDX.CCI, IDX.MFI];
const NAMES = ["RSI", "MACD", "50/200-day averages", "Bollinger Bands", "Stochastic", "ADX", "CCI", "Money Flow Index", "On-Balance Volume", "Rate of Change"];

const CAUTION = /\b(downgrad\w*|lawsuit\w*|sued?|sues|probe\w*|investigat\w*|subpoena\w*|recall\w*|plunge\w*|plummet\w*|tumbl\w*|slump\w*|crash\w*|miss(?:es|ed)?|cuts?|slash\w*|warn\w*|fraud|bankrupt\w*|layoffs?|fires?|fined?|penalt\w*|delay\w*|halt\w*|short[- ]seller|default\w*|shortfall)\b/i;
const POSITIVE = /\b(upgrad\w*|beats?|record|surg\w*|soar\w*|jump\w*|rall(?:y|ies|ied)|raises?|boost\w*|approv\w*|wins?|buyback\w*|partnership)\b/i;

export function tagHeadline(title) {
  if (CAUTION.test(title)) return "caution";
  if (POSITIVE.test(title)) return "positive";
  return null;
}

const money = (x) => `$${x.toFixed(2)}`;
const list = (a) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

export function buildStrategy({ verdict, score, indicators, close, high, news = [], events = null, now = Date.now() / 1000 }) {
  const votes = indicators.map((i) => i.vote);
  const n = close.length;
  const price = close[n - 1];
  const s50 = sma(close, 50)[n - 1];
  const s200 = sma(close, 200)[n - 1];
  const back = (d) => (n > d ? (price / close[n - 1 - d] - 1) * 100 : null);
  const ret3m = back(63), ret1y = back(252);
  const hi52 = Math.max(...(high || close).slice(-252));
  const offHigh = (price / hi52 - 1) * 100;

  const uptrend = s50 > s200 && price > s200;
  const downtrend = s50 < s200 && price < s200;
  const trend = uptrend ? "up" : downtrend ? "down" : "mixed";

  const overheated = EXTREME_IDS.filter((i) => votes[i] === -1);
  const oversold = EXTREME_IDS.filter((i) => votes[i] === 1);
  const trendUp = TREND_IDS.filter((i) => votes[i] === 1);
  const trendDown = TREND_IDS.filter((i) => votes[i] === -1);
  const momentum = [IDX.MACD, IDX.OBV, IDX.ROC].map((i) => votes[i]);
  const adxStrong = votes[IDX.ADX] !== 0;

  // ---- headline ------------------------------------------------------------------
  let headline;
  if (verdict === "BUY") {
    headline = trend !== "up" ? "Rebound setup against a weaker long-term trend"
      : overheated.length >= 2 ? "Strong uptrend, but stretched" : "Strong, broad-based uptrend";
  } else if (verdict === "SELL") {
    headline = trend === "up" ? "Long-term uptrend breaking down" : trend === "down" ? "Broad downtrend" : "Momentum has turned negative";
  } else {
    headline = trend === "up" ? "Uptrend with mixed short-term signals"
      : trend === "down" ? "Downtrend with mixed signals" : "No clear edge either way";
  }

  // ---- short term (days to a few weeks) ------------------------------------------
  let short;
  if (overheated.length >= 2) {
    short = { stance: "Cautious", text: `${list(overheated.map((i) => NAMES[i]))} say the stock is stretched after its run. Buying right now risks a pullback; a dip back toward the 50-day average (${money(s50)}) is usually a better entry.` };
  } else if (oversold.length >= 2 && momentum.some((m) => m < 1)) {
    short = { stance: "Watch for a bounce", text: `${list(oversold.map((i) => NAMES[i]))} show the stock is oversold, which often precedes a bounce. But momentum hasn't turned up yet, so it can keep falling first. Many traders wait for the MACD to cross above its signal line.` };
  } else if (oversold.length >= 2) {
    short = { stance: "Favorable", text: `Oversold readings (${list(oversold.map((i) => NAMES[i]))}) while momentum is already improving is a classic short-term entry setup.` };
  } else if (momentum.every((m) => m === 1)) {
    short = { stance: "Favorable", text: "MACD, volume flow and rate of change all point up, so near-term momentum supports the stock." };
  } else if (momentum.every((m) => m === -1)) {
    short = { stance: "Unfavorable", text: "MACD, volume flow and rate of change all point down. Near-term momentum is against the stock, so there is no rush to buy." };
  } else {
    short = { stance: "No clear edge", text: "Momentum signals disagree with each other, which usually means the stock is drifting or consolidating. Waiting for them to line up gives a clearer entry." };
  }

  // ---- long term (months and beyond) ---------------------------------------------
  const yr = ret1y == null ? "" : ` It is ${ret1y >= 0 ? "up" : "down"} ${Math.abs(ret1y).toFixed(0)}% over the past year.`;
  let long;
  if (trend === "up") {
    long = { stance: "Supportive", text: `The 50-day average (${money(s50)}) is above the 200-day (${money(s200)}) and the price is above both, a healthy long-term uptrend.${yr} Dips are generally treated as buying opportunities while the price holds above the 200-day line.` };
  } else if (trend === "down") {
    long = { stance: "Unfavorable", text: `The 50-day average (${money(s50)}) is below the 200-day (${money(s200)}) and the price is below both, a long-term downtrend.${yr} Long-term investors often wait for the price to reclaim the 200-day line before committing.` };
  } else {
    long = { stance: "Unclear", text: `The long-term trend is mixed: price ${money(price)}, 50-day ${money(s50)}, 200-day ${money(s200)}.${yr} The stock is between trends, so a clear break above the 200-day or below it would settle the picture.` };
  }

  // ---- why the verdict ---------------------------------------------------------
  const bull = votes.map((v, i) => (v === 1 ? NAMES[i] : null)).filter(Boolean);
  const bear = votes.map((v, i) => (v === -1 ? NAMES[i] : null)).filter(Boolean);
  const neutral = 10 - bull.length - bear.length;
  const why = [];
  const sgn = score > 0 ? `+${score}` : score < 0 ? `−${Math.abs(score)}` : "0";
  why.push(`The score is ${sgn} out of 10: ${bull.length} bullish, ${bear.length} bearish, ${neutral} neutral. ${verdict === "HOLD" ? "It takes +6 for a Buy or −6 for a Sell, so the evidence is not lopsided enough to act on." : verdict === "BUY" ? "That clears the +6 bar for a Buy." : "That clears the −6 bar for a Sell."}`);
  if (bull.length) why.push(`Bullish: ${list(bull)}.`);
  if (bear.length) why.push(`Bearish: ${list(bear)}.`);
  if (trendUp.length && trendDown.length && (!overheated.length && !oversold.length)) {
    why.push("The trend indicators are split, which is why the verdict sits in the middle.");
  }

  // ---- things to watch -----------------------------------------------------------
  const watch = [];
  if (events?.earningsStart && events.earningsStart > now) {
    const days = Math.ceil((events.earningsStart - now) / 86400);
    if (days <= 30) watch.push(`Earnings are expected in about ${days} day${days === 1 ? "" : "s"}. Results can move the price sharply in either direction, and technical indicators can't anticipate that.`);
  }
  if (!adxStrong) watch.push("ADX shows no strong trend right now, so trend signals are less reliable than usual. Expect choppy moves.");
  if (offHigh > -3) watch.push(`The price is within ${Math.abs(offHigh).toFixed(1)}% of its 52-week high (${money(hi52)}). That level often acts as resistance.`);
  else if (offHigh < -30) watch.push(`The price is ${Math.abs(offHigh).toFixed(0)}% below its 52-week high of ${money(hi52)}, a large drawdown. Check why before assuming it is cheap.`);
  if (price > s200 * 0.97 && price < s200 * 1.03) watch.push(`The price is sitting right at its 200-day average (${money(s200)}). A decisive move above or below it often sets the next trend.`);
  if (votes[IDX.OBV] !== 0 && votes[IDX.ROC] !== 0 && votes[IDX.OBV] !== votes[IDX.ROC]) {
    watch.push("Price momentum and volume flow disagree, which can be an early warning that the current move lacks conviction.");
  }
  if (events?.exDividend && events.exDividend > now && events.exDividend - now < 14 * 86400) {
    watch.push("An ex-dividend date is coming up within two weeks; the price usually drops by about the dividend amount that day.");
  }

  // ---- headlines -----------------------------------------------------------------
  const items = news.slice(0, 6).map((h) => ({ ...h, tone: tagHeadline(h.title) }));
  const recent = items.filter((h) => !h.time || now - h.time < 14 * 86400);
  const cautionCount = recent.filter((h) => h.tone === "caution").length;
  if (cautionCount) {
    watch.push(`${cautionCount} recent headline${cautionCount === 1 ? "" : "s"} contain${cautionCount === 1 ? "s" : ""} cautionary words (flagged below). ${verdict === "BUY" ? "The technicals say Buy, but " : ""}Read ${cautionCount === 1 ? "it" : "them"} before acting, because indicators only see price and volume, not news.`);
  }

  return {
    headline, verdict, score,
    short, long, why, watch,
    earnings: events?.earningsStart ? { start: events.earningsStart, end: events.earningsEnd ?? events.earningsStart } : null,
    news: items,
    context: { price, s50, s200, ret3m, ret1y, hi52, offHigh, trend },
  };
}
