// Fetches price data from Yahoo Finance's public chart endpoint.
// Runs on the server (Vercel function), so no API key is needed and
// visitors' browsers never talk to Yahoo directly.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

// Chart period -> Yahoo range and bar interval
export const PERIODS = {
  "1D": { range: "1d", interval: "5m" },
  "1W": { range: "5d", interval: "30m" },
  "1M": { range: "1mo", interval: "60m" },
  "3M": { range: "3mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  "5Y": { range: "5y", interval: "1wk" },
};

/** Returns { meta, t: [unix seconds], open, high, low, close } with gaps removed. */
export async function fetchChart(symbol, range, interval) {
  const path =
    `/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  let lastErr;
  for (const host of HOSTS) {
    try {
      const resp = await fetch(host + path, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (resp.status === 404) throw Object.assign(new Error("Symbol not found"), { final: true });
      if (!resp.ok) throw new Error(`Yahoo responded ${resp.status}`);
      const json = await resp.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description || "No data");
      return clean(result);
    } catch (e) {
      lastErr = e;
      if (e.final) break;
    }
  }
  throw lastErr;
}

function clean(result) {
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const out = { meta: result.meta || {}, t: [], open: [], high: [], low: [], close: [] };
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null || Number.isNaN(c)) continue;
    out.t.push(ts[i]);
    out.close.push(c);
    out.open.push(q.open?.[i] ?? c);
    out.high.push(q.high?.[i] ?? c);
    out.low.push(q.low?.[i] ?? c);
  }
  return out;
}

/** Run async jobs with a concurrency cap. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (e) {
        results[i] = { ok: false, error: String(e?.message || e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---- valuation (P/E) ---------------------------------------------------------
// P/E ratios come from Yahoo's quote endpoint, which needs a session cookie and
// a "crumb" token. Both are fetched once and reused while the function is warm.
let session = null;

function readCookies(resp) {
  const list = typeof resp.headers.getSetCookie === "function"
    ? resp.headers.getSetCookie()
    : (resp.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  return list.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

async function getSession(force = false) {
  if (session && !force) return session;
  let cookie = "";
  for (const url of ["https://fc.yahoo.com", "https://finance.yahoo.com"]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "manual" });
      cookie = readCookies(r);
      if (cookie) break;
    } catch { /* try the next one */ }
  }
  if (!cookie) throw new Error("Could not start a Yahoo session");
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}/v1/test/getcrumb`, { headers: { "User-Agent": UA, Cookie: cookie } });
      const crumb = (await r.text()).trim();
      if (r.ok && crumb && !crumb.includes("<") && !crumb.includes("{")) return (session = { cookie, crumb });
    } catch { /* try the next host */ }
  }
  throw new Error("Could not get a Yahoo crumb");
}

const positive = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);

/**
 * Returns { SYMBOL: { pe, forwardPE } } for up to ~100 symbols per call.
 * pe is the trailing-twelve-month P/E; null when earnings are negative or unknown.
 */
export async function fetchValuations(symbols) {
  if (!symbols.length) return {};
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cookie, crumb } = await getSession(attempt > 0);
    for (const host of HOSTS) {
      try {
        const url = `${host}/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}` +
          `&fields=trailingPE,forwardPE&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie } });
        if (r.status === 401 || r.status === 403) { lastErr = new Error(`Yahoo responded ${r.status}`); break; }
        if (!r.ok) throw new Error(`Yahoo responded ${r.status}`);
        const json = await r.json();
        const out = {};
        for (const q of json?.quoteResponse?.result || []) {
          out[String(q.symbol).toUpperCase()] = { pe: positive(q.trailingPE), forwardPE: positive(q.forwardPE) };
        }
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr;
}
