// GET /api/chart?symbol=AAPL&period=1D|1W|1M|3M|1Y|5Y
// Price history for the trend chart. Cached at Vercel's edge for 5 minutes.
import { fetchChart, PERIODS } from "../lib/yahoo.js";
import { sma, SETTINGS } from "../lib/indicators.js";

// For daily-bar periods we also return the 50/200-day averages, computed from
// two years of history so they're valid from the first point on the chart.
const WITH_AVERAGES = { "3M": 92, "1Y": 366 };
const round = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const period = String(req.query.period || "1Y").toUpperCase();
  const p = PERIODS[period];
  if (!/^[A-Z0-9^.=-]{1,12}$/.test(symbol) || !p) {
    res.status(400).json({ error: "Bad symbol or period" });
    return;
  }
  try {
    let bars;
    let averages = null;
    if (WITH_AVERAGES[period]) {
      bars = await fetchChart(symbol, "2y", "1d");
      const s50 = sma(bars.close, SETTINGS.SMA_SHORT);
      const s200 = sma(bars.close, SETTINGS.SMA_LONG);
      const cutoff = bars.t[bars.t.length - 1] - WITH_AVERAGES[period] * 86400;
      const keep = bars.t.map((ts) => ts > cutoff);
      for (const k of ["t", "open", "high", "low", "close"]) bars[k] = bars[k].filter((_, i) => keep[i]);
      averages = {
        [`sma${SETTINGS.SMA_SHORT}`]: s50.filter((_, i) => keep[i]).map(round),
        [`sma${SETTINGS.SMA_LONG}`]: s200.filter((_, i) => keep[i]).map(round),
      };
    } else {
      bars = await fetchChart(symbol, p.range, p.interval);
    }
    if (period === "1D" && bars.close.length === 0) {
      // Before the open / weekend: show the most recent full session.
      bars = await fetchChart(symbol, "5d", "5m");
      const tz = bars.meta.exchangeTimezoneName || "America/New_York";
      const day = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { timeZone: tz });
      const lastDay = day(bars.t[bars.t.length - 1]);
      const keep = bars.t.map((ts) => day(ts) === lastDay);
      for (const k of ["t", "open", "high", "low", "close"]) bars[k] = bars[k].filter((_, i) => keep[i]);
    }
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    res.status(200).json({
      symbol,
      period,
      intraday: p.interval.endsWith("m"),
      timezone: bars.meta.exchangeTimezoneName || "America/New_York",
      previousClose: period === "1D" ? bars.meta.chartPreviousClose ?? bars.meta.previousClose ?? null : null,
      t: bars.t,
      close: bars.close.map(round),
      averages,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
