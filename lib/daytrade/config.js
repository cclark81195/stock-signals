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
  dollarsPerTrade: 0,       // 0 = size each trade by risk; > 0 = buy this many dollars (fractional shares) every time
  maxPositionPct: 100,      // max position size as % of equity (100 = no leverage)
  maxTradesPerDay: 3,       // per symbol in the backtest, portfolio-wide when live
  maxDailyLossR: 2,         // stop trading for the day after losing this many R
  maxConsecutiveLosses: 2,  // ...or after this many losers in a row
  noTradeDates: [],         // "YYYY-MM-DD" days to skip (FOMC, CPI, jobs report...)

  // ---- clock ----
  entryCutoffMin: 870,      // no new entries after 14:30 ET
  avoidMidday: false,       // true = no new entries during the midday lull...
  middayStartMin: 690,      // ...from 11:30 ET
  middayEndMin: 840,        // ...until 14:00 ET
  flattenMin: 945,          // be flat by 15:45 ET (exit at that bar's open)

  // ---- costs (per side) ----
  slippageBps: 2,           // 2 bps ~ a cent or two on a $100 stock; raise it for thin names
  commissionPerShare: 0,    // Robinhood stock commissions are $0; regulatory fees are tiny

  // ---- exits ----
  targetR: 2,               // profit target as a multiple of the initial risk
  partial: { enabled: false, atR: 1, fraction: 0.5 },  // sell half at +1R, then move the stop on the rest to breakeven
  exit: "fixed",            // "fixed" = targetR; "measured" = pattern height (flag/triangle), kept between 1R and 4R
  maxChaseR: 0.5,           // skip the trade if the next open is already this far past the signal

  // ---- trade-quality filters (shared) ----
  minRiskNoise: 1.5,        // stop distance must be >= this many "typical 5-minute ranges"
  maxRiskPct: 1.0,          // ...and <= this % of price (very wide stops mean a bad setup)

  // ---- optional trade-quality filters (off = original behaviour) ----
  filters: {
    market: false,          // only trade when SPY is above its own VWAP (stocks only)
    inPlay: false,          // only trade stocks with unusual volume in their first 30 minutes
    minRelVol: 1.2,         // "unusual" = at least 1.2x the average of the last 10 sessions
  },

  setups: {
    // Order matters: the first setup that fires on a bar wins, so "gap and go" is checked before the plain breakout.
    gap: {
      enabled: false,
      minGapPct: 2,         // opened at least 2% above the previous close...
      orMinutes: 15,        // ...then the first close above the first 15 minutes' high (before 10:30 ET) on volume
      entryEndMin: 630,
      volMult: 1.5,
    },
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
    flag: {
      enabled: false,       // new, off until you switch it on
      poleBars: 6, minFlag: 3, maxFlag: 8,
      poleMinNoise: 6,      // pole range >= 6 x normal 5-minute range...
      poleMinPct: 0.4,      // ...and >= 0.4% of price
      maxRetrace: 0.5,      // flag gives back at most half the pole
      volMult: 1.2, stopPad: 0.25,
    },
    triangle: {
      enabled: false,
      lookback: 24,         // 2 hours of bars
      tolPct: 0.1,          // highs within 0.1% of the ceiling count as a touch
      volMult: 1.2, stopPad: 0.25,
    },
    pullback: {
      enabled: false,
      minRisePct: 0.5,      // the stock has risen at least 0.5% from its session low
      testBars: 5,          // price tested the 20-bar average within the last 5 bars
      touchNoise: 0.25,     // "tested" = low within 0.25 x normal bar range of the average
      volMult: 1.0, stopPad: 0.25,
    },
    fib: {
      enabled: false,
      lookback: 36,         // 3 hours of bars
      minLegNoise: 8,       // the up-move is at least 8 x normal bar range...
      minLegPct: 0.5,       // ...and 0.5% of price
      zoneLo: 0.36, zoneHi: 0.64,   // pulled back 38.2% to 61.8% of the move (with a little slack)
      stopLevel: 0.786, stopPad: 0.25,
    },
    dbottom: {
      enabled: false,
      lookback: 36, minApart: 6, maxApart: 30,
      tolPct: 0.25,         // the two lows are within 0.25% of each other
      minHeightNoise: 3, minHeightPct: 0.4,
      volMult: 1.2, stopPad: 0.25,
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
    } else if (k === "filters") {
      Object.assign(cfg.filters, v);
    } else if (k === "partial") {
      Object.assign(cfg.partial, v);
    } else {
      cfg[k] = v;
    }
  }
  return cfg;
}
