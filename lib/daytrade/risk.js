// Risk engine. This is the part that must NEVER depend on a model's judgement or on
// strategy code being right: it is plain, boring, deterministic checks.
//
//   buildPlan  - turns a signal + entry price into stop / target / share count (or a rejection)
//   RiskGuard  - daily limits: max trades, max daily loss (in R), consecutive-loss stop, kill switch
//   checkOrder - last line of defence before an order reaches a broker

/**
 * @param signal  { setup, stopRef }
 * @param entry   expected entry price
 * @param noise   typical 5-minute range for this symbol (or null)
 */
export function buildPlan(signal, entry, noise, cfg) {
  const stop = signal.stopRef;
  const risk = entry - stop;
  if (!(risk > 0)) return { ok: false, reason: "Stop is not below the entry price" };
  if (noise && risk < cfg.minRiskNoise * noise) return { ok: false, reason: "Stop too tight: it would be hit by ordinary noise" };
  if ((risk / entry) * 100 > cfg.maxRiskPct) return { ok: false, reason: `Stop is wider than ${cfg.maxRiskPct}% of price` };

  // "measured": aim for the pattern's height, but never less than 1R or more than 4R.
  const targetR = cfg.exit === "measured" && signal.measuredMove > 0
    ? Math.min(4, Math.max(1, signal.measuredMove / risk))
    : cfg.targetR;

  const maxNotional = (cfg.equity * cfg.maxPositionPct) / 100;
  const fixed = cfg.dollarsPerTrade > 0;
  // Fixed-dollar mode: buy the same dollar amount every time (never more than the account allows),
  // as a fractional quantity. Otherwise size so that hitting the stop loses about riskPct of equity.
  const raw = fixed
    ? Math.min(cfg.dollarsPerTrade, maxNotional) / entry
    : Math.min(((cfg.equity * cfg.riskPct) / 100) / risk, maxNotional / entry);
  const fractional = cfg.fractional || fixed;   // crypto is always fractional; stocks are in fixed-dollar mode
  const shares = fractional ? Math.floor(raw * 1e6) / 1e6 : Math.floor(raw);
  if (shares < (fractional ? 1e-6 : 1)) {
    return { ok: false, reason: fixed ? "The dollar amount is too small to buy any" : fractional ? "Risk budget is too small to buy any" : "Risk budget is too small for even one share" };
  }

  return {
    ok: true,
    plan: {
      setup: signal.setup,
      entry, stop,
      target: entry + targetR * risk,
      riskPerShare: risk,
      shares,
      riskDollars: shares * risk,
      notional: shares * entry,
    },
  };
}

export class RiskGuard {
  constructor(cfg) { this.cfg = cfg; this.reset(null); }

  /** Call at the start of each trading day. */
  reset(date) {
    this.date = date;
    this.trades = 0;
    this.realizedR = 0;
    this.consecutiveLosses = 0;
    this.killed = false;
    this.killReason = null;
  }

  /** { ok, reason } - may a NEW position be opened right now? */
  canOpen(date, min) {
    const c = this.cfg;
    if (this.killed) return { ok: false, reason: this.killReason || "Kill switch is on" };
    if (c.noTradeDates.includes(date)) return { ok: false, reason: "No-trade date" };
    if (min > c.entryCutoffMin) return { ok: false, reason: "Past the entry cutoff time" };
    if (this.trades >= c.maxTradesPerDay) return { ok: false, reason: "Daily trade limit reached" };
    if (this.realizedR <= -c.maxDailyLossR) return { ok: false, reason: "Daily loss limit reached" };
    if (this.consecutiveLosses >= c.maxConsecutiveLosses) return { ok: false, reason: "Too many losses in a row today" };
    return { ok: true };
  }

  recordOpen() { this.trades++; }

  /** rMultiple is the NET result of a closed trade in units of its initial risk. */
  recordClose(rMultiple) {
    this.realizedR += rMultiple;
    this.consecutiveLosses = rMultiple < 0 ? this.consecutiveLosses + 1 : 0;
  }

  kill(reason) { this.killed = true; this.killReason = reason; }
}

/**
 * Final gate for any order headed to a real broker. Returns { ok, reason }.
 * order = { symbol, side, qty, type, limitPrice, stopPrice, takeProfitPrice }
 */
export function checkOrder(order, cfg, account = {}) {
  if (!cfg.universe.includes(order.symbol)) return { ok: false, reason: "Symbol is not on the allowlist" };
  if (order.side !== "buy" && order.side !== "sell") return { ok: false, reason: "Unknown side" };
  const fractionalOk = cfg.fractional || cfg.dollarsPerTrade > 0;
  if (fractionalOk ? !(order.qty > 0) : !Number.isInteger(order.qty) || order.qty < 1) {
    return { ok: false, reason: fractionalOk ? "Quantity must be positive" : "Quantity must be a whole number of shares" };
  }
  if (order.type !== "limit") return { ok: false, reason: "Only limit orders are allowed" };
  if (!(order.limitPrice > 0)) return { ok: false, reason: "Missing limit price" };
  if (order.side === "buy") {
    if (!(order.stopPrice > 0) || order.stopPrice >= order.limitPrice) return { ok: false, reason: "Entries need a protective stop below the limit price" };
    if (order.qty * order.limitPrice > (cfg.equity * cfg.maxPositionPct) / 100) return { ok: false, reason: "Order exceeds the maximum position size" };
    if (account.buyingPower != null && order.qty * order.limitPrice > account.buyingPower) return { ok: false, reason: "Not enough buying power" };
  }
  return { ok: true };
}
