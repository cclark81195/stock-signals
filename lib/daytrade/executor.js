// The decision step of the automated loop. One call = one pass for one symbol:
//
//   reconcile -> flatten if late -> otherwise look for an entry on the last CLOSED bar
//
// decide() is pure (no network, no clock): you hand it the latest sessions, the broker's
// current positions and the time, and it returns a list of actions. execute() then sends
// those actions to a broker adapter. In dry-run mode nothing leaves this process.
//
// NOTE: Vercel functions are short-lived, so a live loop needs a scheduler (cron every
// 5 minutes during market hours) or a small always-on worker. The logic below is the same either way.

import { noiseBefore } from "./sessions.js";
import { detect } from "./setups.js";
import { buildPlan, checkOrder } from "./risk.js";

const BAR_SECONDS = 300;

/** Index of the last bar that has fully closed at `nowSec`, or -1. */
export function lastClosedIndex(session, nowSec) {
  for (let i = session.bars.length - 1; i >= 0; i--) if (session.bars[i].t + BAR_SECONDS <= nowSec) return i;
  return -1;
}

/**
 * @returns Array of { type: "ENTER", order, plan, reason } | { type: "FLATTEN", symbol, reason } | { type: "SKIP", reason }
 */
export function decide({ symbol, sessions, positions, guard, cfg, nowSec, minNow }) {
  const held = positions.find((p) => p.symbol === symbol && p.qty > 0);
  if (held) {
    return minNow >= cfg.flattenMin ? [{ type: "FLATTEN", symbol, reason: "End-of-day flatten time" }] : [{ type: "SKIP", reason: "Already in a position" }];
  }
  if (sessions.length < 2) return [{ type: "SKIP", reason: "Not enough history" }];

  const si = sessions.length - 1;
  const session = sessions[si];
  const i = lastClosedIndex(session, nowSec);
  if (i < 0) return [{ type: "SKIP", reason: "No closed bar yet" }];

  const gate = guard.canOpen(session.date, session.bars[i].min);
  if (!gate.ok) return [{ type: "SKIP", reason: gate.reason }];

  const noise = noiseBefore(sessions, si);
  const sig = detect({ ...session, bars: session.bars.slice(0, i + 1) }, i, { noise }, cfg);
  if (!sig) return [{ type: "SKIP", reason: "No setup" }];

  const ref = session.bars[i].c;
  const limitPrice = round(ref * (1 + (cfg.slippageBps * 2) / 10000)); // never pay more than 2x modelled slippage
  const res = buildPlan(sig, limitPrice, noise, cfg);
  if (!res.ok) return [{ type: "SKIP", reason: res.reason }];

  const order = {
    symbol, side: "buy", qty: res.plan.shares, type: "limit", limitPrice,
    stopPrice: round(res.plan.stop), takeProfitPrice: round(res.plan.target),
  };
  const ok = checkOrder(order, cfg);
  if (!ok.ok) return [{ type: "SKIP", reason: ok.reason }];
  return [{ type: "ENTER", order, plan: res.plan, reason: sig.reason }];
}

/** Send actions to a broker adapter, counting entries against the day's limits. */
export async function execute(actions, broker, guard, log = () => {}) {
  const results = [];
  for (const a of actions) {
    if (a.type === "ENTER") {
      guard.recordOpen();
      const r = await broker.placeEntry(a.order);
      log({ ...a, result: r });
      results.push(r);
    } else if (a.type === "FLATTEN") {
      const r = await broker.closePosition(a.symbol);
      log({ ...a, result: r });
      results.push(r);
    } else {
      log(a);
    }
  }
  return results;
}

const round = (x) => Math.round(x * 100) / 100;
