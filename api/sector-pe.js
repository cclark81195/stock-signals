// GET /api/sector-pe
// Average trailing P/E for each sector, using every S&P 500 company as the
// benchmark (so small indexes like the Dow still get a meaningful comparison).
// Companies with negative or unknown earnings are left out of the average.
// Cached at Vercel's edge for 6 hours.
import { getConstituents } from "../lib/constituents.js";
import { fetchValuations, mapLimit } from "../lib/yahoo.js";

const CHUNK = 100;

export default async function handler(req, res) {
  try {
    const { members } = await getConstituents("sp500");
    const chunks = [];
    for (let i = 0; i < members.length; i += CHUNK) chunks.push(members.slice(i, i + CHUNK).map((m) => m.symbol));
    const results = await mapLimit(chunks, 3, fetchValuations);
    const pe = Object.assign({}, ...results.filter((r) => r.ok).map((r) => r.value));

    const groups = {};
    for (const m of members) {
      if (!m.sector) continue;
      const g = (groups[m.sector] ||= { sum: 0, count: 0, members: 0 });
      g.members++;
      const v = pe[m.symbol]?.pe;
      if (v != null) { g.sum += v; g.count++; }
    }
    const sectors = Object.fromEntries(Object.entries(groups).map(([name, g]) => [name, {
      avgPE: g.count ? Math.round((g.sum / g.count) * 10) / 10 : null,
      count: g.count,
      members: g.members,
    }]));
    const priced = Object.keys(pe).length;
    if (!priced) throw new Error("No P/E data came back from Yahoo Finance");

    res.setHeader("Cache-Control", priced < members.length * 0.8
      ? "public, s-maxage=300"
      : "public, s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({ basis: "S&P 500", sectors });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
