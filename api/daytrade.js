// GET /api/daytrade?symbols=SPY,AAPL,BTC-USD&equity=10000&riskPct=0.5&targetR=2&slipBps=2&cryptoSlipBps=10&orb=1&vwap=1
//   &dollars=50 (fixed dollars per buy; omit for risk-based sizing)  &scan=1 (compact per-symbol totals for the S&P 500 scan)  &flag=1&tri=1 (pattern setups)  &exit=measured  &mkt=1 (SPY above VWAP)  &inplay=1 (unusual early volume)
// Day Trade Lab: latest-session setups plus a cost-aware backtest of the last ~60 days of
// 5-minute bars (the most Yahoo provides). Stocks use the 9:30-16:00 ET session; crypto uses
// UTC days. Research only; it places no orders. Cached at Vercel's edge for 5 minutes.
import { fetchChart, mapLimit } from "../lib/yahoo.js";
import { makeConfig, DEFAULTS } from "../lib/daytrade/config.js";
import { toSessions, aboveVwapMap } from "../lib/daytrade/sessions.js";
import { backtestSymbol, scanLatest, summarize, compactStats } from "../lib/daytrade/backtest.js";
import { configFor, profileFor, todayFor, PROFILES } from "../lib/daytrade/markets.js";

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
  const base = makeConfig({
    universe: symbols,
    equity: clamp(q.equity, 500, 10_000_000),
    riskPct: clamp(q.riskPct, 0.05, 2),
    dollarsPerTrade: clamp(q.dollars, 1, 10_000_000),
    targetR: clamp(q.targetR, 0.5, 5),
    slippageBps: clamp(q.slipBps, 0, 30),
    exit: q.exit === "measured" ? "measured" : q.exit === "fixed" ? "fixed" : undefined,
    filters: strip({ market: flag(q.mkt), inPlay: flag(q.inplay) }),
    setups: { orb: strip(orb), vwap: strip(vwap), flag: strip({ enabled: flag(q.flag) }), triangle: strip({ enabled: flag(q.tri) }) },
  });
  const cryptoSlip = clamp(q.cryptoSlipBps, 0, 100) ?? 10;

  const warnings = [];
  const scanMode = q.scan === "1";
  try {
    // The market filter needs SPY's 5-minute bars once, shared by every stock.
    let marketOk = null;
    if (base.filters.market && symbols.some((x) => profileFor(x) === PROFILES.equity)) {
      try {
        const spy = toSessions(await fetchChart("SPY", "60d", "5m"));
        const m = aboveVwapMap(spy);
        marketOk = (t) => m.get(t) === true;
      } catch {
        warnings.push("The market filter could not load SPY prices, so it was NOT applied to stocks.");
      }
    }
    const results = await mapLimit(symbols, 4, async (symbol) => {
      const cfg = configFor(base, symbol, cryptoSlip);
      const profile = profileFor(symbol);
      const bars = await fetchChart(symbol, "60d", "5m");
      const sessions = toSessions(bars, profile.tz, profile.minBars, profile.openMin, profile.closeMin);
      const today = todayFor(profile);
      const mk = profile === PROFILES.crypto ? null : marketOk; // the SPY filter is for stocks only

      // Keep an unfinished session out of the backtest so a half-day never counts as a full one.
      const latest = sessions[sessions.length - 1];
      const inProgress = latest && latest.date === today && latest.bars[latest.bars.length - 1].min < profile.closeMin - 10;
      const used = inProgress ? sessions.slice(0, -1) : sessions;
      const { trades, sessionsTested } = backtestSymbol(symbol, used, cfg, mk);
      if (scanMode) {
        // Split the tested days in half by date so the page can show "older half vs newer half".
        const tested = used.slice(1);
        const splitDate = tested.length ? tested[Math.floor(tested.length / 2)].date : null;
        return {
          symbol, assetClass: profile === PROFILES.crypto ? "crypto" : "stocks", sessions: sessionsTested, splitDate,
          all: compactStats(trades),
          first: compactStats(trades.filter((t) => t.date < splitDate)),
          second: compactStats(trades.filter((t) => t.date >= splitDate)),
        };
      }
      return {
        symbol,
        assetClass: profile === PROFILES.crypto ? "crypto" : "stocks",
        sessions: sessionsTested,
        scan: scanLatest(symbol, sessions, cfg, today, Math.floor(Date.now() / 1000), mk),
        stats: summarize(trades),
        trades,
      };
    });

    if (scanMode) {
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
      res.status(200).json({
        generatedAt: Math.floor(Date.now() / 1000), warnings,
        symbols: results.map((r, i) => (r.ok ? r.value : { symbol: symbols[i], error: String(r.error?.message || r.error) })),
      });
      return;
    }

    const rows = [], allTrades = [];
    const byClassTrades = { stocks: [], crypto: [] };
    results.forEach((r, i) => {
      if (!r.ok) { rows.push({ symbol: symbols[i], error: r.error }); return; }
      allTrades.push(...r.value.trades);
      byClassTrades[r.value.assetClass].push(...r.value.trades);
      const { trades, ...rest } = r.value;
      rows.push({ ...rest, recent: trades.slice(-10).reverse() });
    });

    // Separate numbers per asset class (no equity curve, to keep the payload small).
    const byClass = {};
    for (const [k, t] of Object.entries(byClassTrades)) {
      if (!t.length) continue;
      const { curve, ...s } = summarize(t);
      byClass[k] = s;
    }

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    res.status(200).json({
      generatedAt: Math.floor(Date.now() / 1000),
      warnings,
      config: {
        equity: base.equity, riskPct: base.riskPct, dollarsPerTrade: base.dollarsPerTrade, targetR: base.targetR,
        slippageBps: base.slippageBps, cryptoSlippageBps: cryptoSlip, exit: base.exit, filters: base.filters,
        maxTradesPerDay: base.maxTradesPerDay, maxDailyLossR: base.maxDailyLossR,
        setups: base.setups,
      },
      aggregate: summarize(allTrades),
      byClass,
      tradesTotal: allTrades.length,
      recentTrades: allTrades.sort((a, b) => b.exitTime - a.exitTime).slice(0, 500), // newest first; the page shows them all
      symbols: rows,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
