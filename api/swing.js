// GET /api/swing?symbols=AAPL,MSFT&strategy=meanrev|breakout&years=10&dollars=100&slipBps=5&stopAtr=3&trend=1&mkt=0
//   &rsiBuy=10&exitSma=5&hold=10 (mean reversion)  &entryLen=55&exitLen=20 (breakout)
// Swing Lab: backtests daily-bar, multi-day strategies over up to 10 years. Research only; places no orders.
// Returns compact, ADDABLE per-symbol totals (like the Day Trade Lab scan) so the page can merge many stocks.
import { fetchChart, mapLimit } from "../lib/yahoo.js";
import { makeConfig, toDaily, aboveSma200Map, backtestDaily, swingStats } from "../lib/swing/engine.js";
import { compactStats } from "../lib/daytrade/backtest.js";

const clamp = (v, lo, hi) => {
  const x = Number(v);
  return v === undefined || v === "" || !Number.isFinite(x) ? undefined : Math.min(hi, Math.max(lo, x));
};
const flag = (v) => (v === undefined ? undefined : !(v === "0" || v === "false"));

export default async function handler(req, res) {
  const q = req.query || {};
  const symbols = [...new Set(String(q.symbols || "SPY").split(",").map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9.^-]{1,10}$/.test(s)))].slice(0, 25);
  if (!symbols.length) { res.status(400).json({ error: "No valid symbols" }); return; }

  const cfg = makeConfig({
    strategy: q.strategy === "breakout" ? "breakout" : "meanrev",
    dollars: clamp(q.dollars, 1, 1_000_000),
    slippageBps: clamp(q.slipBps, 0, 50),
    stopAtr: clamp(q.stopAtr, 0.5, 10),
    trendFilter: flag(q.trend),
    marketFilter: flag(q.mkt),
    meanrev: { rsiBuy: clamp(q.rsiBuy, 1, 50), exitSma: Math.round(clamp(q.exitSma, 2, 50) ?? 5) || undefined, maxHold: Math.round(clamp(q.hold, 0, 60) ?? 10) },
    breakout: { entryLen: Math.round(clamp(q.entryLen, 10, 200) ?? 55), exitLen: Math.round(clamp(q.exitLen, 5, 100) ?? 20), maxHold: Math.round(clamp(q.hold, 0, 500) ?? 0) },
  });
  // one "hold" box serves both strategies, with different defaults
  if (q.hold === undefined || q.hold === "") { cfg.meanrev.maxHold = 10; cfg.breakout.maxHold = 0; }
  const years = Number(q.years) <= 5 ? 5 : 10;

  const warnings = [];
  try {
    let marketOk = null;
    if (cfg.marketFilter) {
      try { marketOk = aboveSma200Map(toDaily(await fetchChart("SPY", `${years}y`, "1d"))); }
      catch { warnings.push("The market filter could not load SPY prices, so it was NOT applied."); }
    }
    const results = await mapLimit(symbols, 5, async (symbol) => {
      const bars = toDaily(await fetchChart(symbol, `${years}y`, "1d"));
      if (bars.length < 260) throw new Error("Not enough price history");
      const { trades, daysTested } = backtestDaily(symbol, bars, cfg, marketOk);
      const tested = bars.slice(200);
      const splitDate = tested.length ? tested[Math.floor(tested.length / 2)].date : null;
      const first = bars[0].c, last = bars[bars.length - 1].c;
      return {
        symbol, days: daysTested, splitDate,
        holdPct: Math.round(((last / first) - 1) * 1000) / 10, // buy-and-hold over the whole download, for reference
        all: swingStats(trades),
        first: compactStats(trades.filter((t) => t.date < splitDate)),
        second: compactStats(trades.filter((t) => t.date >= splitDate)),
        trades: trades.map((t) => ({
          symbol: t.symbol, date: t.date, exitDate: t.exitDate, entry: t.entry, exit: t.exit, shares: t.shares,
          exitReason: t.exitReason, holdBars: t.holdBars, netR: t.netR, pnl: t.pnl, exitTime: t.exitTime,
        })),
      };
    });
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      generatedAt: Math.floor(Date.now() / 1000), warnings, years,
      config: { ...cfg },
      symbols: results.map((r, i) => (r.ok ? r.value : { symbol: symbols[i], error: String(r.error?.message || r.error) })),
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
