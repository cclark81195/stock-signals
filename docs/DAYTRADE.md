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

The scan also has a "Where the money is going" section: average win and loss, result before and after costs, average stop distance (with the cost it implies), average hold, results by setup, and how trades ended (target, stop, gap through stop, end-of-day close). These come from extra detail on each stock's totals (`compactStats(trades, true)`), merged on the page. Use them to find the leak before changing rules: costs large next to a near-zero "before costs" result mean there is no edge to protect; a big share of end-of-day closes suggests the target is too far away; a setup with a low win rate and a negative after-costs result is a candidate to switch off.

How to read it: the whole-index and sector rows are the test; the ranked stock list is not a shopping list. With about 500 stocks and about 60 days of data, the top of the list is mostly luck (on random, edge-free test data the best stocks still show a clearly positive result). Prefer results where the older and newer halves agree, and change one setting at a time between scans.

## Fixed dollars per buy

"Dollars per buy" (`dollarsPerTrade`, `dollars=` in the API) makes every buy the same dollar amount, as a fractional quantity (down to 6 decimals), capped by the account size. Blank or 0 keeps the default: whole shares sized so a stop-out loses `riskPct` of the account. In fixed-dollar mode the risk percentage is ignored, so a stopped-out trade loses more or less depending on how far the stop is; R-multiples are unchanged because they are per share. `checkOrder` allows fractional stock quantities only in this mode.

Not verified: how Robinhood handles fractional-share orders (whether limit orders, attached stop-losses and extended hours are supported, and its minimum order). The safety rules here require limit orders with a protective stop, so check this against the real account and the MCP's tool list before any live stage.

## Account balance chart

Under the cumulative-R chart, "Account balance, with every buy and sell" starts from the account size and steps at each sold trade by that trade's dollar result. Up triangles are buys; down triangles are sells (green profit, red loss). Overnight and weekend gaps are squeezed out of the time axis so a day's trading is readable; use 1 day / 5 days / 20 days / All and Earlier / Later to zoom, and click a marker for the trade's details. Overlapping trades on different stocks are added to one balance as if there were enough money for all of them, and nothing compounds. The API returns up to 1,500 trades (newest first); the chart says when it is showing a subset.

The S&P 500 scan has the same two charts (cumulative R and account balance with buy/sell markers). Scan batches also return a trimmed trade list per stock (`/api/daytrade?scan=1`), and the page draws the charts when a scan finishes: all stocks added together, or one stock chosen from the menu or by clicking its symbol in the table. The combined balance treats every stock as having its own account of the chosen size, so it is a sum of independent backtests, not one account's history. The balance chart opens on the widest range with 150 or fewer markers.

## More setups, partial exit and the midday option (all off by default)

Added from a review of common day-trading strategy guides. Each is a strict, fixed rule set, not a drawn pattern:

- **Pullback to moving average** (`pullback`): price above VWAP, 9-bar EMA above a rising 20-bar EMA, the stock up at least 0.5% from its session low; within the last 5 bars price tested the 20-bar EMA; entry on a green bar that closes above the 9-bar EMA and the previous high on at least average volume. Stop under the lowest low of the last 6 bars.
- **Fibonacci pullback** (`fib`): a swing low then swing high in the last 36 bars, the move at least 8 normal bar-ranges and 0.5% of price, a pullback of 36% to 64% of it that never breaks the swing low, entry on a green bar closing above the previous high but below the swing high. Stop just under the 78.6% level. The move's size is the measured-move target. It fires rarely.
- **Double bottom** (`dbottom`): two local lows within 0.25% of each other, 6 to 30 bars apart, a rally between them of at least 3 normal bar-ranges and 0.4% of price; entry on the first close above the middle peak on volume. Stop under the lows; pattern height is the measured move.
- **Gap and go** (`gap`): stocks only. Opened at least 2% above yesterday's close, the opening range's low is still above that close and price is above VWAP; entry on the first close above the first 15 minutes' high before 10:30 ET on volume. It is checked before the plain opening-range breakout. Crypto never uses it.
- **Sell half at +1R** (`partial`): a limit sale of half the shares at +1R (same fill rule as the target: price must trade a cent through), and the stop on the rest moves to the buy price. If one bar hits both the stop and the +1R level the stop is assumed to hit first. Whole-share trades that cannot be split (one share) skip it. The trade is recorded once, with the average sell price and the total result in R of the original risk.
- **Skip the midday lull** (`avoidMidday`): no new entries from 11:30 to 14:00 ET (stocks only).

Not built, on purpose: RSI/MACD overbought-oversold, Bollinger Band fades, order blocks, and reversal/short setups (long-only account, lagging or subjective rules).

Sanity check used while building: on 150 random-walk stocks (no edge by construction) every setup came out slightly negative after costs, which is what a bug-free, look-ahead-free test should show. Real-data results are still unknown.

## Known limits

- Each symbol is backtested independently; the live guard is portfolio-wide, so the real bot will trade less than the backtest implies.
- Long only (retail stock accounts generally cannot short). Earnings days and FOMC/CPI days are not filtered; add dates to `noTradeDates`.
- Fills are modelled, not observed. Real slippage on volatile opens can be worse than 2 bps.
- Taxes: short-term gains are taxed as ordinary income, and wash-sale rules apply to repeated trades.

*Simulations on past prices are not predictions, and nothing here is financial advice.*

## Swing Lab (`/swing.html`)

A second research page for **multi-day trades on daily prices** (up to 10 years, every S&P 500 stock). It exists because the Day Trade Lab's real-data scan showed no edge before costs: day-trade stops average ~0.6% of price, so even small slippage costs ~0.06R per trade. On daily bars stops are ~3-5%, costs fall to a few hundredths of an R, and ten years spans several market regimes.

- **Engine:** `lib/swing/engine.js`. Long only. Signal at the close, fill at the next open plus slippage. ATR-based stop (the distance is 1R); a day that trades through the stop exits at the stop (plus slippage), a day that opens beyond it exits at the open. One position per stock at a time. No peeking: a test checks that cutting off later data never changes closed trades.
- **Strategies:** *Buy sharp dips* (close above the 200-day average and 2-day RSI under 10; sell above the 5-day average, after 10 days, or at the stop) and *Buy new highs* (close above the prior 55-day high; sell below the prior 20-day low or at the stop). Optional filters: stock above its 200-day average, SPY above its 200-day average.
- **API:** `api/swing.js` returns addable per-stock totals (same shape as the Day Trade Lab scan) plus a by-year split and buy-and-hold for reference. The page runs 25 stocks per request.
- **Read it by year.** The by-year table is the most useful output: an edge that holds in 2018, 2020 and 2022 is believable; one that comes from a single year is not.
- **Known biases:** the stock list is today's S&P 500 (survivorship bias flatters long-only results); Yahoo prices are split-adjusted but not dividend-adjusted. Historical P/E is not available from Yahoo (only today's), so valuation is deliberately not used: back-testing it would use information that was unknown at the time.
- **Day Trade Lab addition:** the S&P 500 scan now has a *By time of day* table (entry hour, Eastern) so you can see whether any window earns its costs.
- Not yet verified on real Yahoo data from the build environment (it is blocked there); the first real run is the user's.

### Updates: S&P 500 comparison, menu, one Run button
- **Swing Lab vs the S&P 500.** A "Versus the S&P 500" section shows average annual return (mean of the full calendar years), average daily return, compound growth per year and total return, each next to SPY's. The strategy's money is one slot of "dollars per buy" per stock tested, open trades are valued at each day's close, idle cash earns nothing, and nothing compounds. SPY is price-only. The year-by-year table gains a strategy-return and an S&P 500 column per calendar year. A test checks the day-by-day P&L adds up exactly to the trades' P&L. `GET /api/swing?bench=1` serves SPY's closes.
- **Menu.** All three pages share a menu button (`public/nav.js`) that opens a side panel to switch pages.
- **Day Trade Lab Run button.** Leave Symbols empty and Run tests the whole S&P 500 (stocks only, as the old scan did); pick up to 10 symbols and the same button runs the quick test with today's setups and every trade. The page no longer auto-runs a default list: a first visit waits, and a remembered symbol list still auto-runs.
- **Swing Lab starting balance.** A "Starting balance ($)" input (default $10,000, like the Day Trade Lab's account size). The comparison with the S&P 500 then replays every trade through one cash-limited account: it can hold (balance / dollars per buy) positions at once, extra same-day signals are skipped (ties broken by a fixed pseudo-random key, not alphabetically), and profit or loss is counted when a trade is sold. Changing the balance updates the comparison instantly, with no re-run. Blank or 0 keeps the old unlimited-cash mode (every signal taken, one slot per stock). The tiles, R figures and year table's trade columns still describe *all* signals. The replay lives in `public/swing-account.js` and is unit-tested.
- **Swing Lab charts fill in as the scan runs.** The cumulative-R chart, the new balance chart and the trade list redraw after every batch of stocks; the S&P 500 comparison section waits for the finished scan.
- **Swing Lab balance chart with every buy and sell** (`public/swing-chart.js`, like the Day Trade Lab's): a triangle per buy (blue) and sell (green profit, red loss), zoom 1 month / 3 months / 1 year / All, page earlier/later, click a marker for the trade. Markers are drawn only when a range has 300 or fewer buys and sells, so on "All" it shows the line and asks you to zoom. It opens on the widest readable range once the scan finishes. The S&P 500 line is the true value of the same money from the start, and rebased to your balance at the start of the range when zoomed in. With the starting balance blank it shows running profit from every signal instead.
