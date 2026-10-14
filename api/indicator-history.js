// GET /api/indicator-history?symbol=AAPL
// The last ~6 months of every indicator's line, used for the picture that opens
// when you tap an indicator on a stock's page. Cached at Vercel's edge for 15
// minutes (the underlying data is daily).
import { fetchChart } from "../lib/yahoo.js";
import { history, MIN_BARS } from "../lib/indicators.js";

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || "").toUpperCase();
  if (!/^[A-Z0-9^.=-]{1,12}$/.test(symbol)) {
    res.status(400).json({ error: "Bad symbol" });
    return;
  }
  try {
    const bars = await fetchChart(symbol, "2y", "1d");
    if (bars.close.length < MIN_BARS) {
      res.setHeader("Cache-Control", "public, s-maxage=900");
      res.status(404).json({ error: "Not enough history for this stock" });
      return;
    }
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json({
      symbol,
      timezone: bars.meta.exchangeTimezoneName || "America/New_York",
      ...history(bars),
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
