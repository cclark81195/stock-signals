// Broker adapters. Strategy and risk code only ever talk to this small interface:
//
//   getAccount()            -> { equity, buyingPower }
//   getPositions()          -> [{ symbol, qty, avgPrice }]
//   placeEntry(order)       -> { id, status }   limit buy + protective stop (+ target if supported)
//   closePosition(symbol)   -> { id, status }
//
// DryRunBroker records what WOULD be sent and never touches a real account.
// RobinhoodMcpBroker is a deliberate skeleton: it cannot send anything until you
// (1) fill in the real tool names from Robinhood's MCP documentation and
// (2) explicitly set liveEnabled: true. See docs/DAYTRADE.md.

export class DryRunBroker {
  constructor({ equity = 10000 } = {}) {
    this.equity = equity;
    this.positions = new Map();
    this.journal = [];
    this.nextId = 1;
  }
  async getAccount() { return { equity: this.equity, buyingPower: this.equity }; }
  async getPositions() { return [...this.positions.values()]; }
  async placeEntry(order) {
    const id = `dry-${this.nextId++}`;
    this.positions.set(order.symbol, { symbol: order.symbol, qty: order.qty, avgPrice: order.limitPrice });
    this.journal.push({ id, action: "ENTER", order });
    return { id, status: "simulated" };
  }
  async closePosition(symbol) {
    const id = `dry-${this.nextId++}`;
    this.positions.delete(symbol);
    this.journal.push({ id, action: "FLATTEN", symbol });
    return { id, status: "simulated" };
  }
}

export class RobinhoodMcpBroker {
  /**
   * @param callTool     async (toolName, args) => result   (your MCP client's call function)
   * @param toolNames    { account, positions, placeOrder, closePosition } - REAL names from Robinhood's docs
   * @param liveEnabled  must be exactly true, or every method refuses
   */
  constructor({ callTool, toolNames = {}, liveEnabled = false } = {}) {
    this.callTool = callTool;
    this.toolNames = toolNames;
    this.liveEnabled = liveEnabled === true;
  }
  #need(key) {
    if (!this.liveEnabled) throw new Error("Live trading is disabled. Set liveEnabled: true only after paper/dry-run validation.");
    if (typeof this.callTool !== "function") throw new Error("No MCP client supplied (callTool).");
    if (!this.toolNames[key]) throw new Error(`Robinhood MCP tool name for "${key}" is not configured. Take it from Robinhood's Trading MCP documentation.`);
    return this.toolNames[key];
  }
  async getAccount() { return this.callTool(this.#need("account"), {}); }
  async getPositions() { return this.callTool(this.#need("positions"), {}); }
  async placeEntry(order) {
    // TODO(live): map `order` onto Robinhood's order schema. Confirm bracket / OCO support first;
    // if there is none, the executor must place the stop as a separate order immediately after the fill.
    return this.callTool(this.#need("placeOrder"), order);
  }
  async closePosition(symbol) {
    return this.callTool(this.#need("closePosition"), { symbol });
  }
}

export function createBroker(kind = "dry-run", opts = {}) {
  if (kind === "dry-run") return new DryRunBroker(opts);
  if (kind === "robinhood-mcp") return new RobinhoodMcpBroker(opts);
  throw new Error(`Unknown broker "${kind}"`);
}
