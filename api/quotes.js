// GET /api/quotes?symbols=AAPL,MSFT,...   (up to 60 symbols)
// Price, recent performance and the 5-indicator verdict for each symbol.
// Responses are cached at Vercel's edge for 15 minutes, so everyone who opens
// the site in that window shares one set of Yahoo requests.
import { fetchChart, mapLimit } from "../lib/yahoo.js";
import { evaluate } from "../lib/indicators.js";

const MAX_SYMBOLS = 60;

function pct(now, then) {
  return then ? (now / then - 1) * 100 : null;
}

function summarize(bars) {
  const { t, close } = bars;
  const n = close.length;
  const price = close[n - 1];
  const lastT = t[n - 1];
  const back = (days) => {
    const cutoff = lastT - days * 86400;
    for (let i = n - 1; i >= 0; i--) if (t[i] <= cutoff) return close[i];
    return null;
  };
  const ev = evaluate(bars);
  return {
    price,
    prevClose: n > 1 ? close[n - 2] : null,
    dayPct: n > 1 ? pct(price, close[n - 2]) : null,
    m1Pct: pct(price, back(30)),
    y1Pct: pct(price, back(365)),
    signal: ev ? ev.verdict : "N/A",
    score: ev ? ev.score : null,
    indicators: ev ? ev.indicators : null,
    asOf: lastT,
  };
}

export default async function handler(req, res) {
  const symbols = String(req.query.symbols || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    .filter((s) => /^[A-Z0-9^.=-]{1,12}$/.test(s))
    .slice(0, MAX_SYMBOLS);
  if (!symbols.length) {
    res.status(400).json({ error: "No symbols given" });
    return;
  }

  const results = await mapLimit(symbols, 8, (s) => fetchChart(s, "2y", "1d").then(summarize));
  const rows = {}, errors = {};
  results.forEach((r, i) => (r.ok ? (rows[symbols[i]] = r.value) : (errors[symbols[i]] = r.error)));

  const failed = Object.keys(errors).length;
  // Don't cache a mostly-failed response (e.g. Yahoo throttling) for long.
  res.setHeader(
    "Cache-Control",
    failed > symbols.length / 5
      ? "public, s-maxage=60"
      : "public, s-maxage=900, stale-while-revalidate=3600",
  );
  res.status(failed === symbols.length ? 502 : 200).json({ rows, errors });
}
