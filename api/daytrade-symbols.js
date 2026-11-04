// GET /api/daytrade-symbols
// Everything the Day Trade Lab's symbol picker offers: SPY, the five biggest non-stablecoin
// cryptocurrencies, and every S&P 500 stock (from the same live list the scanner uses).
// Cached at Vercel's edge for a day when the S&P 500 list loaded, 5 minutes when it didn't.
import { getConstituents } from "../lib/constituents.js";
import { CRYPTO, ETFS } from "../lib/daytrade/markets.js";

export default async function handler(req, res) {
  const options = [
    ...ETFS.map((e) => ({ ...e, tag: "ETF" })),
    ...CRYPTO.map((c) => ({ ...c, tag: "Crypto" })),
  ];
  let sp = null;
  try {
    sp = await getConstituents("sp500");
  } catch { /* the picker still offers SPY and crypto */ }
  if (sp) {
    for (const m of sp.members) {
      if (ETFS.some((e) => e.symbol === m.symbol)) continue;
      options.push({ symbol: m.symbol, name: m.company || m.symbol, tag: m.sector || "S&P 500" });
    }
  }
  res.setHeader("Cache-Control", sp ? "public, s-maxage=86400, stale-while-revalidate=86400" : "public, s-maxage=300");
  res.status(200).json({ options, sp500Loaded: !!sp, stockCount: sp ? sp.members.length : 0 });
}
