// GET /api/strategy?symbol=AAPL
// A plain-English strategy for one stock: what the ten indicators say, short- vs
// long-term outlook, things to watch, upcoming earnings and recent headlines.
// Price data is required; headlines and earnings are best-effort extras.
// Cached at Vercel's edge for 15 minutes.
import { fetchChart, fetchNews, fetchEvents } from "../lib/yahoo.js";
import { evaluate, MIN_BARS } from "../lib/indicators.js";
import { buildStrategy } from "../lib/strategy.js";

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || "").toUpperCase();
  if (!/^[A-Z0-9^.=-]{1,12}$/.test(symbol)) {
    res.status(400).json({ error: "Bad symbol" });
    return;
  }
  try {
    const [bars, news, events] = await Promise.all([
      fetchChart(symbol, "2y", "1d"),
      fetchNews(symbol).catch(() => null),
      fetchEvents(symbol).catch(() => null),
    ]);
    const ev = bars.close.length >= MIN_BARS ? evaluate(bars) : null;
    if (!ev) {
      res.setHeader("Cache-Control", "public, s-maxage=900");
      res.status(404).json({ error: "Not enough history for this stock" });
      return;
    }
    const strategy = buildStrategy({
      verdict: ev.verdict, score: ev.score, indicators: ev.indicators,
      close: bars.close, high: bars.high, news: news || [], events,
    });
    // Don't cache for long when the extras failed, so they get retried soon.
    res.setHeader("Cache-Control", news && events ? "public, s-maxage=900, stale-while-revalidate=3600" : "public, s-maxage=120");
    res.status(200).json({ symbol, newsAvailable: !!news, eventsAvailable: !!events, generatedAt: Math.floor(Date.now() / 1000), ...strategy });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
