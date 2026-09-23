// Index membership: Dow 30 and S&P 500, read live from Wikipedia with backups.

const UA = "IndexSignalScanner/1.0 (personal stock-screening website)";

const SOURCES = {
  dow: { name: "Dow 30", url: "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average", min: 25, max: 35 },
  sp500: { name: "S&P 500", url: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", min: 400, max: 600 },
};
export const INDEXES = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.name]));

const SP500_BACKUP_CSV =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

// Used only if Wikipedia can't be reached.
const DOW30_BACKUP = [
  ["AAPL", "Apple", "Information Technology"], ["AMGN", "Amgen", "Health Care"],
  ["AMZN", "Amazon", "Consumer Discretionary"], ["AXP", "American Express", "Financials"],
  ["BA", "Boeing", "Industrials"], ["CAT", "Caterpillar", "Industrials"],
  ["CRM", "Salesforce", "Information Technology"], ["CSCO", "Cisco", "Information Technology"],
  ["CVX", "Chevron", "Energy"], ["DIS", "Walt Disney", "Communication Services"],
  ["GS", "Goldman Sachs", "Financials"], ["HD", "Home Depot", "Consumer Discretionary"],
  ["HON", "Honeywell", "Industrials"], ["IBM", "IBM", "Information Technology"],
  ["JNJ", "Johnson & Johnson", "Health Care"], ["JPM", "JPMorgan Chase", "Financials"],
  ["KO", "Coca-Cola", "Consumer Staples"], ["MCD", "McDonald's", "Consumer Discretionary"],
  ["MMM", "3M", "Industrials"], ["MRK", "Merck", "Health Care"],
  ["MSFT", "Microsoft", "Information Technology"], ["NKE", "Nike", "Consumer Discretionary"],
  ["NVDA", "Nvidia", "Information Technology"], ["PG", "Procter & Gamble", "Consumer Staples"],
  ["SHW", "Sherwin-Williams", "Materials"], ["TRV", "Travelers", "Financials"],
  ["UNH", "UnitedHealth Group", "Health Care"], ["V", "Visa", "Financials"],
  ["VZ", "Verizon", "Communication Services"], ["WMT", "Walmart", "Consumer Staples"],
].map(([symbol, company, sector]) => ({ symbol, company, sector }));

const cleanSymbol = (s) => String(s).trim().toUpperCase().replace(/\./g, "-");

function decode(html) {
  return html
    .replace(/<sup[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}

/** Parse the table with id="constituents" into rows keyed by header name. */
export function parseConstituentsTable(html) {
  const start = html.search(/<table[^>]*id="constituents"/i);
  if (start < 0) throw new Error("constituents table not found");
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end);
  const rows = table.split(/<tr[\s>]/i).slice(1).map((r) =>
    [...r.matchAll(/<t([hd])[^>]*>([\s\S]*?)(?=<t[hd][\s>]|<\/tr>|$)/gi)].map((m) => decode(m[2])));
  const header = rows.shift().map((h) => h.toLowerCase());
  return rows.filter((r) => r.length >= 2).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function normalize(records) {
  const pick = (rec, ...keys) => { for (const k of keys) if (rec[k]) return rec[k]; return ""; };
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const symbol = cleanSymbol(pick(rec, "symbol", "ticker"));
    if (!symbol || !/^[A-Z0-9-]{1,10}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      company: pick(rec, "security", "company", "name"),
      sector: pick(rec, "gics sector", "sector", "industry"),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const split = (line) => {
    const cells = []; let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const header = split(lines.shift()).map((h) => h.trim().toLowerCase());
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [header[i], v.trim()])));
}

export async function getConstituents(key) {
  const src = SOURCES[key];
  if (!src) throw new Error(`Unknown index "${key}"`);

  try {
    const resp = await fetch(src.url, { headers: { "User-Agent": UA } });
    if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
    const members = normalize(parseConstituentsTable(await resp.text()));
    if (members.length >= src.min && members.length <= src.max) {
      return { index: src.name, source: "Wikipedia (live)", members };
    }
  } catch { /* fall through to backup */ }

  if (key === "sp500") {
    const resp = await fetch(SP500_BACKUP_CSV, { headers: { "User-Agent": UA } });
    if (!resp.ok) throw new Error("Could not load the S&P 500 member list");
    return { index: src.name, source: "GitHub datasets (backup)", members: normalize(parseCsv(await resp.text())) };
  }
  return { index: src.name, source: "Built-in list (backup, may be out of date)", members: DOW30_BACKUP };
}
