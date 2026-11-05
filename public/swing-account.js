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
 *
 * Position size: `dollars` for every buy, or, with opts.pct, that percentage of the whole portfolio (parked money plus
 * stocks at cost) at the moment of the buy. Trades carry their profit for `t.base || opts.base || dollars` dollars, so a
 * different size just scales the profit (every result is linear in the dollars spent).
 * Returns, for each day: total value (equity), parked money (park) and the positions held (held: [symbol, dollars]).
 * takenList holds copies of the trades the account took, with shares, pnl and size scaled to the dollars actually used.
 */
export function replayPark(rows, balance, dollars, dayList, growth, opts = {}) {
  const pct = opts.pct > 0 ? opts.pct / 100 : null;
  const byDay = new Map();
  for (const r of rows) for (const t of r.trades || []) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push({ k: tieKey(t.symbol + t.date), exitDate: t.exitDate, t });
  }
  for (const list of byDay.values()) list.sort((x, y) => x.k - y.k);
  let park = balance, taken = 0, skipped = 0, maxOpen = 0, open = [];
  const takenList = [], equity = [], parked = [], held = [];
  const scaled = (c, size) => { const f = size / (c.t.base || opts.base || dollars); return { ...c.t, shares: c.t.shares * f, pnl: c.t.pnl * f, size }; };
  // opts.mark(trade, date) -> what one dollar paid for the trade is worth on `date` (price now / price paid). Without it,
  // stocks are valued at what was paid until they are sold.
  dayList.forEach((d, i) => {
    park *= growth[i];
    const still = [];
    for (const p of open) { if (p.exitDate <= d) park += p.size + p.pnl; else still.push(p); }
    open = still;
    const worth = (p) => p.size * (opts.mark ? opts.mark(p.t, d) : 1);
    for (const c of byDay.get(d) || []) {
      const size = pct ? pct * (park + open.reduce((t, p) => t + worth(p), 0)) : dollars;
      if (!(size > 0) || park < size - 1e-9) { skipped++; continue; }
      const t = scaled(c, size);
      park -= size; taken++; takenList.push(t);
      if (c.exitDate <= d) park += size + t.pnl; else open.push({ exitDate: c.exitDate, size, pnl: t.pnl, symbol: c.t.symbol, t: c.t });
    }
    maxOpen = Math.max(maxOpen, open.length);
    const values = open.map(worth);
    equity.push(park + values.reduce((a, b) => a + b, 0));
    parked.push(park);
    held.push(open.map((p, k) => [p.symbol, values[k]]));
  });
  return { equity, park: parked, held, taken, skipped, maxOpen, takenList };
}

/** Largest peak-to-trough fall in a series of portfolio values: { dd: -0.23, from: index of the peak, to: index of the low }. */
export function maxDrawdown(values) {
  let peak = -Infinity, peakAt = 0, dd = 0, from = 0, to = 0;
  values.forEach((v, i) => {
    if (v > peak) { peak = v; peakAt = i; }
    const d = peak > 0 ? v / peak - 1 : 0;
    if (d < dd) { dd = d; from = peakAt; to = i; }
  });
  return { dd, from, to };
}
