# Day Trade Lab

A research-and-automation scaffold for quick in-and-out stock trades. **Today it is read-only: it finds setups and backtests them. It cannot place orders.** Live automation is a later, deliberate step (see "Rollout").

Open it at `/daytrade.html`. Run the engine tests with `npm test`.

## Design principle

Strategy code only *proposes*. Plain risk code *decides*. A broker adapter *executes*. Nothing that can lose money depends on a model's judgement.

```
Yahoo 5-min bars -> sessions.js -> setups.js (signal) -> risk.js (plan + limits) -> broker.js (dry-run / Robinhood MCP)
                                        \__ backtest.js runs the SAME three steps over history
```

| File | Job |
|---|---|
| `lib/daytrade/config.js` | Every tunable number (risk %, targets, times, costs, universe) |
| `lib/daytrade/sessions.js` | Groups bars into trading days, adds VWAP and a "noise" yardstick |
| `lib/daytrade/setups.js` | Opening-range breakout and VWAP reclaim, long only |
| `lib/daytrade/risk.js` | `buildPlan` (stop, target, share count), `RiskGuard` (daily limits, kill switch), `checkOrder` (last gate before a broker) |
| `lib/daytrade/backtest.js` | Bar-by-bar simulator with slippage, gap handling, stop-first tie-break; reports gross vs net R |
| `lib/daytrade/executor.js` | `decide()` (pure: returns ENTER / FLATTEN / SKIP) and `execute()` (sends actions to a broker) |
| `lib/daytrade/broker.js` | `DryRunBroker` (records only) and a guarded `RobinhoodMcpBroker` skeleton |
| `api/daytrade.js` | `/api/daytrade` endpoint used by the page |

## Rules in one place

- **Entry:** read a 5-minute bar when it closes, fill at the next open. ORB: first close above the 15-minute range high before 11:30 ET on 1.5x volume and above VWAP. VWAP reclaim: green close back above VWAP after most of the last 6 bars were below it.
- **Exit:** stop (range low / recent lows), profit target at 2R, or flat by 3:45 PM ET. If one bar touches both stop and target, the stop is assumed to hit first.
- **Risk:** 0.5% of the account per trade, no leverage, max 3 trades per day, stop for the day after -2R or 2 losses in a row, skip stops tighter than normal noise or wider than 1% of price.
- **Costs:** 2 bps slippage per side by default. The page shows results before and after costs.

## Robinhood MCP: what is and is not done

Done: the adapter interface, a dry-run broker, order validation (`checkOrder`: allowlist, limit orders only, stop required, size cap), and a skeleton `RobinhoodMcpBroker` that refuses to act unless `liveEnabled: true` **and** real tool names are configured.

Not verified yet (read Robinhood's Trading MCP documentation before wiring):
1. Exact tool names and argument schemas for account, positions, order placement and cancel.
2. Whether bracket / OCO orders (entry + stop + target) are supported. If not, the executor must place the stop as a separate order right after the fill and handle a failure of that second call by flattening.
3. Order types allowed in the ring-fenced agentic account, extended-hours support, fractional shares, and rate limits.
4. Whether quotes from the MCP are fast enough to use. This design assumes market data comes from a separate feed and the MCP is used only for orders and account state.
5. How the agentic account is funded and what its own limits are.

A live loop also needs somewhere to run. Vercel functions are short-lived, so use a cron (every 5 minutes, 9:35-15:50 ET) or a small always-on worker that calls `decide()` then `execute()`.

## Rollout (do not skip stages)

1. **Backtest with costs** (this page). Yahoo only gives ~60 days of 5-minute data, which is enough to catch bugs, not to prove an edge. Store daily snapshots, or buy a longer history (Polygon, Alpaca), before trusting any statistic. Aim for several hundred trades.
2. **Dry-run on live data:** run `decide()` every 5 minutes with `DryRunBroker`, journal every action, compare against what the backtest would have done.
3. **Tiny live size** in the ring-fenced account, with a hard daily loss cap, for weeks.
4. **Scale only if** net expectancy stays positive after real fills and costs.

## Choosing symbols and crypto

The symbol box is a searchable multi-select (up to 10 per run). `api/daytrade-symbols.js` supplies the options: SPY, every S&P 500 stock from the same live list the scanner uses, and the five largest non-stablecoin cryptocurrencies (BTC, ETH, BNB, XRP, SOL, as Yahoo `-USD` symbols).

Crypto uses its own profile in `lib/daytrade/markets.js`: sessions are UTC days (VWAP and the opening range start at 00:00 UTC, everything is flat by 23:45 UTC), sizes are fractional, and slippage is a separate, higher input (default 10 bps). Stock and crypto results are reported separately.

Treat crypto as experimental: the rules are the stock rules re-timed and have not been tuned, Yahoo's 5-minute crypto history has not been checked against real data, real exchange costs may be well above 10 bps, and the Robinhood MCP is reportedly equities-only, so crypto here is research only.

## Pattern setups, filters and the measured-move exit (all off by default)

- **Bull flag** (`flag`): a pole of at least 6 normal bar-ranges (and 0.4% of price), then a 3 to 8 bar pullback on lighter volume that gives back at most half the pole and never exceeds the pole high; entry on the first close above the flag high on volume. Stop under the flag low.
- **Ascending triangle** (`triangle`): in the previous 24 bars, a ceiling touched at least twice (within 0.1%), the lows of each third of the window rising, at least 3 normal bar-ranges tall; entry on the first close above the ceiling on volume. Stop under the most recent low.
- **Market filter** (`filters.market`): stocks only trade while SPY is above its own VWAP at the signal bar. Crypto ignores it. If SPY cannot be loaded the page says so and the filter is not applied.
- **In-play filter** (`filters.inPlay`): the stock's volume over the first up-to-30 minutes must be at least `minRelVol` (1.2) times the average for the same bars over the last 10 sessions. It only uses bars up to the signal bar.
- **Measured-move exit** (`exit: "measured"`): flag and triangle trades aim for the pattern height instead of `targetR`, clamped to between 1R and 4R. Opening-range and VWAP trades keep the fixed target.

Each setup's results are listed separately in "By setup", so you can compare them. The thresholds were chosen from the shape of the patterns, not tuned on data. Judge each by "per trade, after costs" across many symbols; with about 60 days of data a single pattern produces few trades, so a good-looking result is as likely to be luck as an edge.

## S&P 500 scan

The "S&P 500 scan" section of `/daytrade.html` runs the current settings on every S&P 500 stock (the symbols picked at the top are not used). The page sends the list in batches of 10 to `/api/daytrade?scan=1`, two batches at a time, and each batch returns small addable totals per stock (`lib/daytrade/backtest.js: compactStats`) for all tested days and for the older and newer half of them. The page combines them into whole-index, sector and per-stock tables, with sorting, a minimum-trades filter, "Retry failed" and a CSV download.

How to read it: the whole-index and sector rows are the test; the ranked stock list is not a shopping list. With about 500 stocks and about 60 days of data, the top of the list is mostly luck (on random, edge-free test data the best stocks still show a clearly positive result). Prefer results where the older and newer halves agree, and change one setting at a time between scans.

## Fixed dollars per buy

"Dollars per buy" (`dollarsPerTrade`, `dollars=` in the API) makes every buy the same dollar amount, as a fractional quantity (down to 6 decimals), capped by the account size. Blank or 0 keeps the default: whole shares sized so a stop-out loses `riskPct` of the account. In fixed-dollar mode the risk percentage is ignored, so a stopped-out trade loses more or less depending on how far the stop is; R-multiples are unchanged because they are per share. `checkOrder` allows fractional stock quantities only in this mode.

Not verified: how Robinhood handles fractional-share orders (whether limit orders, attached stop-losses and extended hours are supported, and its minimum order). The safety rules here require limit orders with a protective stop, so check this against the real account and the MCP's tool list before any live stage.

## Account balance chart

Under the cumulative-R chart, "Account balance, with every buy and sell" starts from the account size and steps at each sold trade by that trade's dollar result. Up triangles are buys; down triangles are sells (green profit, red loss). Overnight and weekend gaps are squeezed out of the time axis so a day's trading is readable; use 1 day / 5 days / 20 days / All and Earlier / Later to zoom, and click a marker for the trade's details. Overlapping trades on different stocks are added to one balance as if there were enough money for all of them, and nothing compounds. The API returns up to 1,500 trades (newest first); the chart says when it is showing a subset.

## Known limits

- Each symbol is backtested independently; the live guard is portfolio-wide, so the real bot will trade less than the backtest implies.
- Long only (retail stock accounts generally cannot short). Earnings days and FOMC/CPI days are not filtered; add dates to `noTradeDates`.
- Fills are modelled, not observed. Real slippage on volatile opens can be worse than 2 bps.
- Taxes: short-term gains are taxed as ordinary income, and wash-sale rules apply to repeated trades.

*Simulations on past prices are not predictions, and nothing here is financial advice.*
