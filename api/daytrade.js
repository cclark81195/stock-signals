// GET /api/daytrade?symbols=SPY,QQQ&equity=10000&riskPct=0.5&targetR=2&slipBps=2&orb=1&vwap=1
// Day Trade Lab: today's setups plus a cost-aware backtest of the last ~60 days of
// 5-minute bars (the most Yahoo provides). Research only; it places no orders.
// Cached at Vercel's edge for 5 minutes.
import { fetchChart, mapLimit } from "../lib/yahoo.js";
import { makeConfig, DEFAULTS } from "../lib/daytrade/config.js";
import { toSessions } from "../lib/daytrade/sessions.js";
import { backtestSymbol, scanLatest, summarize } from "../lib/daytrade/backtest.js";

const clamp = (v, lo, hi) => {
  const x = Number(v);
  return v === undefined || v === "" || !Number.isFinite(x) ? undefined : Math.min(hi, Math.max(lo, x));
};
const flag = (v) => (v === undefined ? undefined : !(v === "0" || v === "false"));

export default async function handler(req, res) {
  const q = req.query || {};
  const symbols = [...new Set(String(q.symbols || DEFAULTS.universe.join(","))
    .split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.^-]{1,10}$/.test(s)))].slice(0, 10);
  if (!symbols.length) {
    res.status(400).json({ error: "No valid symbols" });
    return;
  }

  const orb = { enabled: flag(q.orb), orMinutes: clamp(q.orMinutes, 5, 60) };
  const vwap = { enabled: flag(q.vwap) };
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const cfg = makeConfig({
    universe: symbols,
    equity: clamp(q.equity, 500, 10_000_000),
    riskPct: clamp(q.riskPct, 0.05, 2),
    targetR: clamp(q.targetR, 0.5, 5),
    slippageBps: clamp(q.slipBps, 0, 30),
    setups: { orb: strip(orb), vwap: strip(vwap) },
  });

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  try {
    const results = await mapLimit(symbols, 4, async (symbol) => {
      const bars = await fetchChart(symbol, "60d", "5m");
      const sessions = toSessions(bars, bars.meta.exchangeTimezoneName || "America/New_York");
      // Keep an unfinished session out of the backtest so a half-day never counts as a full one.
      const latest = sessions[sessions.length - 1];
      const inProgress = latest && latest.date === today && latest.bars[latest.bars.length - 1].min < 950;
      const { trades, sessionsTested } = backtestSymbol(symbol, inProgress ? sessions.slice(0, -1) : sessions, cfg);
      return {
        symbol,
        sessions: sessionsTested,
        scan: scanLatest(symbol, sessions, cfg, today, Math.floor(Date.now() / 1000)),
        stats: summarize(trades),
        trades,
      };
    });

    const rows = [], allTrades = [];
    results.forEach((r, i) => {
      if (!r.ok) { rows.push({ symbol: symbols[i], error: r.error }); return; }
      allTrades.push(...r.value.trades);
      const { trades, ...rest } = r.value;
      rows.push({ ...rest, recent: trades.slice(-10).reverse() });
    });

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    res.status(200).json({
      generatedAt: Math.floor(Date.now() / 1000),
      config: {
        equity: cfg.equity, riskPct: cfg.riskPct, targetR: cfg.targetR, slippageBps: cfg.slippageBps,
        maxTradesPerDay: cfg.maxTradesPerDay, maxDailyLossR: cfg.maxDailyLossR, flattenMin: cfg.flattenMin,
        setups: cfg.setups,
      },
      aggregate: summarize(allTrades),
      recentTrades: allTrades.sort((a, b) => b.exitTime - a.exitTime).slice(0, 40),
      symbols: rows,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
