// Day Trade Lab - every tunable number lives here.
//
// Design rule: the backtester, the "today" scanner and the (future) live executor
// all read THIS object and call the SAME setup / risk functions, so what you test
// is what you would trade.
//
// Times are minutes since midnight, exchange time (America/New_York):
//   570 = 9:30   585 = 9:45   600 = 10:00   690 = 11:30   870 = 14:30
//   930 = 15:30  945 = 15:45  960 = 16:00

export const DEFAULTS = {
  // Liquid names only: tight spreads are what keep small edges alive.
  universe: ["SPY", "QQQ", "IWM", "DIA", "AAPL", "MSFT", "NVDA", "TSLA"],

  // ---- account & risk (enforced by RiskGuard, never by the strategy code) ----
  equity: 10000,            // dollars the bot is allowed to trade (ring-fenced account)
  riskPct: 0.5,             // % of equity risked per trade (distance entry -> stop)
  maxPositionPct: 100,      // max position size as % of equity (100 = no leverage)
  maxTradesPerDay: 3,       // per symbol in the backtest, portfolio-wide when live
  maxDailyLossR: 2,         // stop trading for the day after losing this many R
  maxConsecutiveLosses: 2,  // ...or after this many losers in a row
  noTradeDates: [],         // "YYYY-MM-DD" days to skip (FOMC, CPI, jobs report...)

  // ---- clock ----
  entryCutoffMin: 870,      // no new entries after 14:30 ET
  flattenMin: 945,          // be flat by 15:45 ET (exit at that bar's open)

  // ---- costs (per side) ----
  slippageBps: 2,           // 2 bps ~ a cent or two on a $100 stock; raise it for thin names
  commissionPerShare: 0,    // Robinhood stock commissions are $0; regulatory fees are tiny

  // ---- exits ----
  targetR: 2,               // profit target as a multiple of the initial risk
  maxChaseR: 0.5,           // skip the trade if the next open is already this far past the signal

  // ---- trade-quality filters (shared) ----
  minRiskNoise: 1.5,        // stop distance must be >= this many "typical 5-minute ranges"
  maxRiskPct: 1.0,          // ...and <= this % of price (very wide stops mean a bad setup)

  setups: {
    orb: {
      enabled: true,
      orMinutes: 15,        // opening range = first 15 minutes
      entryEndMin: 690,     // only take breakouts before 11:30 ET
      volMult: 1.5,         // breakout bar volume >= 1.5x the session's average bar so far
    },
    vwap: {
      enabled: true,
      startMin: 600,        // 10:00 ET
      belowBars: 4,         // at least 4 of the previous 6 bars closed below VWAP
      volMult: 1.2,
      stopPad: 0.25,        // stop = lowest low of the last 4 bars minus 0.25 x noise
    },
  },
};

/** Merge user overrides (from query-string / UI) onto the defaults. */
export function makeConfig(overrides = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    if (k === "setups") {
      for (const [name, o] of Object.entries(v)) Object.assign(cfg.setups[name] || (cfg.setups[name] = {}), o);
    } else {
      cfg[k] = v;
    }
  }
  return cfg;
}
