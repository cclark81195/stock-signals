// Asset classes. Stocks trade 9:30-16:00 ET on weekdays; crypto trades around the clock,
// so a "session" for crypto is one UTC calendar day (VWAP and the opening range restart
// at 00:00 UTC, the usual daily anchor).
//
// The crypto rules are the stock rules re-timed, NOT separately tuned. Treat crypto
// results as experimental.

// The five biggest non-stablecoin cryptocurrencies by market cap when this was written
// (Nov 2026). Stablecoins (USDT, USDC) are left out because they are pegged to $1 and
// there is nothing to day trade. Rankings change; edit this list to update the picker.
export const CRYPTO = [
  { symbol: "BTC-USD", name: "Bitcoin" },
  { symbol: "ETH-USD", name: "Ethereum" },
  { symbol: "BNB-USD", name: "BNB" },
  { symbol: "XRP-USD", name: "XRP" },
  { symbol: "SOL-USD", name: "Solana" },
];

export const ETFS = [{ symbol: "SPY", name: "SPDR S&P 500 ETF Trust" }];

export const isCrypto = (symbol) => /^[A-Z0-9]{2,10}-USD$/.test(String(symbol).toUpperCase());

export const PROFILES = {
  equity: { name: "stocks", tz: "America/New_York", openMin: 570, closeMin: 960, minBars: 30 },
  crypto: { name: "crypto", tz: "UTC", openMin: 0, closeMin: 1440, minBars: 200 },
};

export const profileFor = (symbol) => (isCrypto(symbol) ? PROFILES.crypto : PROFILES.equity);

/** Date string (YYYY-MM-DD) of "today" in the profile's time zone. */
export function todayFor(profile, now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: profile.tz });
}

/**
 * Per-symbol copy of the config. Stocks are left exactly as configured; crypto gets
 * 24/7 clock times, fractional sizing, a wider stop allowance and its own slippage.
 */
export function configFor(cfg, symbol, cryptoSlippageBps = 10) {
  const out = JSON.parse(JSON.stringify(cfg));
  const p = profileFor(symbol);
  out.openMin = p.openMin;
  out.closeMin = p.closeMin;
  if (p !== PROFILES.crypto) return out;

  out.fractional = true;            // buy 0.0123 BTC, not whole coins
  out.entryCutoffMin = 1320;        // no new entries after 22:00 UTC
  out.flattenMin = 1425;            // flat by 23:45 UTC, before the daily reset
  out.maxRiskPct = Math.max(cfg.maxRiskPct, 2);
  out.slippageBps = cryptoSlippageBps;
  if (out.setups.orb) {
    out.setups.orb.orMinutes = Math.max(out.setups.orb.orMinutes, 60);  // first hour of the UTC day
    out.setups.orb.entryEndMin = 360;                                   // breakouts only before 06:00 UTC
  }
  if (out.setups.gap) out.setups.gap.enabled = false;                   // crypto has no overnight gap
  out.avoidMidday = false;                                              // the New York midday lull does not apply
  if (out.setups.vwap) out.setups.vwap.startMin = 60;                   // from 01:00 UTC
  return out;
}
