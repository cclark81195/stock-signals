// GET /api/constituents?index=dow|sp500
// Members of the index. Cached at Vercel's edge for a day.
import { getConstituents } from "../lib/constituents.js";

export default async function handler(req, res) {
  const key = String(req.query.index || "dow").toLowerCase();
  try {
    const data = await getConstituents(key);
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=86400");
    res.status(200).json(data);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e?.message || e) });
  }
}
