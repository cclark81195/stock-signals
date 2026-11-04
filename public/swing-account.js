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
    byDay.get(t.date).push({ k: tieKey(t.symbol + t.date), exitDate: t.exitDate, pnl: t.pnl });
  }
  for (const list of byDay.values()) list.sort((x, y) => x.k - y.k);
  let cash = balance, realized = 0, taken = 0, skipped = 0, maxOpen = 0, open = [];
  const equity = [];
  for (const d of dayList) {
    const still = [];
    for (const p of open) { if (p.exitDate <= d) { cash += dollars + p.pnl; realized += p.pnl; } else still.push(p); }
    open = still;
    for (const c of byDay.get(d) || []) {
      if (cash < dollars - 1e-9) { skipped++; continue; }
      cash -= dollars; taken++;
      if (c.exitDate <= d) { cash += dollars + c.pnl; realized += c.pnl; } else open.push(c);
    }
    maxOpen = Math.max(maxOpen, open.length);
    equity.push(balance + realized);
  }
  return { equity, taken, skipped, maxOpen };
}

