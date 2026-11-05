// Index membership: Dow 30, S&P 500, S&P 400 mid-caps and Nasdaq-100, read live from Wikipedia with backups.

const UA = "IndexSignalScanner/1.0 (personal stock-screening website)";

const SOURCES = {
  dow: { name: "Dow 30", url: "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average", min: 25, max: 35 },
  sp500: { name: "S&P 500", url: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", min: 400, max: 600 },
  sp400: { name: "S&P MidCap 400", url: "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies", min: 330, max: 480 },
  sp600: { name: "S&P SmallCap 600", url: "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies", min: 500, max: 700 },
  nasdaq100: { name: "Nasdaq-100", url: "https://en.wikipedia.org/wiki/Nasdaq-100", min: 90, max: 110 },
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

// Used only if Wikipedia can't be reached.
const NASDAQ100_BACKUP = Object.entries({
  "Information Technology": "AAPL ADBE ADI ADSK AMAT AMD APP ARM ASML AVGO CDNS CDW CRWD CSCO CTSH DDOG FTNT GFS INTC INTU KLAC LRCX MCHP MRVL MSFT MSTR MU NVDA NXPI ON PANW PLTR QCOM ROP SHOP SNPS TEAM TXN WDAY ZS",
  "Communication Services": "CHTR CMCSA EA GOOG GOOGL META NFLX TMUS TTD TTWO WBD",
  "Consumer Discretionary": "ABNB AMZN BKNG DASH LULU MAR MELI ORLY PDD ROST SBUX TSLA",
  "Consumer Staples": "CCEP COST KDP KHC MDLZ MNST PEP",
  "Health Care": "AMGN AZN DXCM GEHC GILD IDXX ISRG REGN VRTX",
  "Industrials": "ADP AXON CPRT CSX CTAS FAST HON ODFL PAYX PCAR TRI VRSK",
  "Utilities": "AEP CEG EXC XEL",
  "Energy": "BKR FANG",
  "Materials": "LIN",
  "Real Estate": "CSGP",
  "Financials": "PYPL",
}).flatMap(([sector, list]) => list.split(" ").map((symbol) => ({ symbol, company: "", sector })));

// The Nasdaq-100 page sometimes uses ICB industry names; map them onto the
// GICS sector names the other indexes use so sector P/E averages line up.
const ICB_TO_GICS = {
  "technology": "Information Technology",
  "telecommunications": "Communication Services",
  "basic materials": "Materials",
  "health care": "Health Care",
  "consumer discretionary": "Consumer Discretionary",
  "consumer staples": "Consumer Staples",
  "industrials": "Industrials",
  "utilities": "Utilities",
  "energy": "Energy",
  "financials": "Financials",
  "real estate": "Real Estate",
};

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

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "February 9, 2026" -> "2026-02-09", or "" when it is not a date. */
export function longDate(v) {
  const m = /([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(String(v || ""));
  const mo = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && mo >= 0 ? `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}` : "";
}

/**
 * The "Selected changes" table on a Wikipedia index page: Date | Added (ticker, security) | Removed (ticker, security) | Reason.
 * Returns [{ date, added, removed }] with tickers cleaned ("" when nothing was added or removed). A date shared by several
 * rows (rowspan) leaves those rows one cell short; they reuse the previous row's date.
 */
export function parseChangesTable(html) {
  const tables = html.split(/<table[\s>]/i).slice(1);
  const hit = tables.find((t) => { const head = decode(t.slice(0, 4000)); return /added/i.test(head) && /removed/i.test(head) && /date/i.test(head); });
  if (!hit) return [];
  const body = hit.slice(0, hit.search(/<\/table>/i) < 0 ? undefined : hit.search(/<\/table>/i));
  const out = []; let lastDate = "";
  for (const r of body.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...r.matchAll(/<t([hd])[^>]*>([\s\S]*?)(?=<t[hd][\s>]|<\/tr>|$)/gi)].map((m) => decode(m[2]));
    if (!cells.length) continue;
    let date = longDate(cells[0]), at = 1;
    if (!date) { if (cells.length >= 5 && lastDate) { date = lastDate; at = 0; } else continue; }
    lastDate = date;
    const added = cleanSymbol(cells[at] || ""), removed = cleanSymbol(cells[at + 2] || "");
    out.push({ date, added: /^[A-Z0-9-]{1,10}$/.test(added) ? added : "", removed: /^[A-Z0-9-]{1,10}$/.test(removed) ? removed : "" });
  }
  return out;
}

/**
 * Members as of today plus the index's recorded changes: a current member gets the date of its latest addition when the list
 * has none, and stocks that were removed (and are not back in the index) are returned as former members with the date they
 * left and, if known, the date they joined. Former members' sector is "Other" (the change table gives only names).
 */
export function applyChanges(members, changes) {
  const cur = new Map(members.map((m) => [m.symbol, { ...m }]));
  const latest = (sym, kind, before) => { let d = ""; for (const c of changes) if (c[kind] === sym && (!before || c.date < before) && c.date > d) d = c.date; return d; };
  for (const m of cur.values()) if (!m.added) m.added = latest(m.symbol, "added");
  const former = [];
  for (const sym of new Set(changes.map((c) => c.removed).filter(Boolean))) {
    if (cur.has(sym)) continue;
    const removed = latest(sym, "removed");
    former.push({ symbol: sym, company: sym, sector: "Other", added: latest(sym, "added", removed), removed, former: true });
  }
  return { members: [...cur.values()], former: former.sort((a, b) => a.symbol.localeCompare(b.symbol)) };
}

/** Members plus former members for an index with a changes table (S&P 500, 400, 600). Falls back to the plain list if the table is missing. */
export async function getMembership(key) {
  const data = await getConstituents(key);
  let changes = [];
  try {
    const resp = await fetch(SOURCES[key].url, { headers: { "User-Agent": UA } });
    if (resp.ok) changes = parseChangesTable(await resp.text());
  } catch { /* keep the plain list */ }
  const { members, former } = applyChanges(data.members, changes);
  return { ...data, members, former, changes: changes.length };
}

/** When the company joined the index, as YYYY-MM-DD, or "" if the list does not say (or says something else). */
export const isoDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "").trim()); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };

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
      sector: pick(rec, "gics sector", "sector", "icb industry", "industry"),
      added: isoDate(pick(rec, "date added", "date first added")),
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
  if (key !== "nasdaq100") return loadMembers(key);
  const data = await loadMembers(key);
  // Prefer the S&P 500 list's sector for companies in both indexes.
  const sp = await loadMembers("sp500").catch(() => null);
  const spSector = Object.fromEntries((sp?.members || []).map((m) => [m.symbol, m]));
  data.members = data.members.map((m) => ({
    ...m,
    company: m.company || spSector[m.symbol]?.company || m.symbol,
    sector: spSector[m.symbol]?.sector || ICB_TO_GICS[m.sector.toLowerCase()] || m.sector,
  }));
  return data;
}

async function loadMembers(key) {
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
  const backup = key === "nasdaq100" ? NASDAQ100_BACKUP : DOW30_BACKUP;
  return { index: src.name, source: "Built-in list (backup, may be out of date)", members: backup };
}
