// Russell 1000 and Russell 3000 membership, read from the holdings file iShares publishes for the funds that track them
// (IWB and IWV). That is today's holdings, so it carries the same hindsight as any current list, and it has no join dates.
const UA = "IndexSignalScanner/1.0 (personal stock-screening website)";
const FUNDS = {
  russell1000: { name: "Russell 1000", url: "https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund", min: 800, max: 1200 },
  russell3000: { name: "Russell 3000", url: "https://www.ishares.com/us/products/239714/ishares-russell-3000-etf/1467271812596.ajax?fileType=csv&fileName=IWV_holdings&dataType=fund", min: 2400, max: 3600 },
};
export const RUSSELL_KEYS = Object.keys(FUNDS);

function splitCsv(line) {
  const cells = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Rows of an iShares holdings file: skips the fund header lines, keeps stocks only. */
export function parseIsharesHoldings(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const at = lines.findIndex((l) => /^"?ticker"?,/i.test(l.trim()));
  if (at < 0) throw new Error("holdings header not found");
  const head = splitCsv(lines[at]).map((h) => h.toLowerCase());
  const col = (n) => head.indexOf(n);
  const [iT, iN, iS, iA] = [col("ticker"), col("name"), col("sector"), col("asset class")];
  const seen = new Set(), out = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    const c = splitCsv(line);
    if (iA >= 0 && c[iA] && c[iA].toLowerCase() !== "equity") continue;
    const symbol = String(c[iT] || "").toUpperCase().replace(/\./g, "-");
    if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, company: c[iN] || symbol, sector: c[iS] && c[iS] !== "-" ? c[iS] : "Other" });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function getRussell(key) {
  const f = FUNDS[key];
  if (!f) throw new Error(`Unknown list "${key}"`);
  const resp = await fetch(f.url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`iShares ${resp.status}`);
  const members = parseIsharesHoldings(await resp.text());
  if (members.length < f.min || members.length > f.max) throw new Error(`${f.name}: unexpected size ${members.length}`);
  return { index: f.name, source: "iShares holdings (live)", members };
}
