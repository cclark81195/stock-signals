// Replays a list of trades through one cash-limited account. Pure functions: used by the Swing Lab page and by the tests.

/** Small deterministic shuffle key, so ties between same-day signals are not always won by A-tickers. */
export const tieKey = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/**
 * Replays every trade through ONE account that starts with `balance` dollars and puts `dollars` into each buy.
 * A signal is only taken if enough cash is free that day; cash comes back (with the profit or loss) when the
 * trade is sold. Returns the account's realised balance for each day in `dayList`, plus how many signals it skipped.
 */
export function replayAccount(rows, balance, dollars, dayList) {
  const byDay = new Map();
  for (const r of rows) for (const t of r.trades || []) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push({ k: tieKey(t.symbol + t.date), exitDate: t.exitDate, pnl: t.pnl, t });
  }
  for (const list of byDay.values()) list.sort((x, y) => x.k - y.k);
  let cash = balance, realized = 0, taken = 0, skipped = 0, maxOpen = 0, open = [];
  const takenList = [];                 // the trades the account actually took, for the chart
  const equity = [];
  for (const d of dayList) {
    const still = [];
    for (const p of open) { if (p.exitDate <= d) { cash += dollars + p.pnl; realized += p.pnl; } else still.push(p); }
    open = still;
    for (const c of byDay.get(d) || []) {
      if (cash < dollars - 1e-9) { skipped++; continue; }
      cash -= dollars; taken++; takenList.push(c.t);
      if (c.exitDate <= d) { cash += dollars + c.pnl; realized += c.pnl; } else open.push(c);
    }
    maxOpen = Math.max(maxOpen, open.length);
    equity.push(balance + realized);
  }
  return { equity, taken, skipped, maxOpen, takenList };
}


/**
 * Like replayAccount, but the money that is not in a trade is never left idle: it is "parked" and grows by
 * growth[i] on day i (SPY's daily change for "hold SPY", a daily yield for "earns a rate", 1 for plain cash).
 * A signal is funded by taking its dollars out of the parked money, and when the trade is sold the dollars and the
 * profit or loss go back into it. Stocks are valued at what was paid until they are sold (profit counted when sold),
 * the same convention as replayAccount, so with growth all 1 the two give the same balance.
 * Returns, for each day: total value (equity), parked money (park) and the symbols held (held; each worth `dollars`).
 */
export function replayPark(rows, balance, dollars, dayList, growth) {
  const byDay = new Map();
  for (const r of rows) for (const t of r.trades || []) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push({ k: tieKey(t.symbol + t.date), exitDate: t.exitDate, pnl: t.pnl, t });
  }
  for (const list of byDay.values()) list.sort((x, y) => x.k - y.k);
  let park = balance, taken = 0, skipped = 0, maxOpen = 0, open = [];
  const takenList = [], equity = [], parked = [], held = [];
  dayList.forEach((d, i) => {
    park *= growth[i];
    const still = [];
    for (const p of open) { if (p.exitDate <= d) park += dollars + p.pnl; else still.push(p); }
    open = still;
    for (const c of byDay.get(d) || []) {
      if (park < dollars - 1e-9) { skipped++; continue; }
      park -= dollars; taken++; takenList.push(c.t);
      if (c.exitDate <= d) park += dollars + c.pnl; else open.push(c);
    }
    maxOpen = Math.max(maxOpen, open.length);
    equity.push(park + open.length * dollars);
    parked.push(park);
    held.push(open.map((p) => p.t.symbol));
  });
  return { equity, park: parked, held, taken, skipped, maxOpen, takenList };
}
