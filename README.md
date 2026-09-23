# Index Signal Scanner

A website that lets you pick the **Dow 30**, **S&P 500** or **Nasdaq-100**, browse every stock with its price, recent performance and **P/E ratio**, and see a **BUY / SELL / HOLD** verdict based strictly on five technical indicators. Tap any stock for its trend chart (1D, 1W, 1M, 3M, 1Y, 5Y), its P/E next to its sector's average P/E, and a breakdown of how each indicator voted.

It runs on **Vercel** (free) and needs no installs, no API keys and no coding.

---

## Get a shareable link (about 10 minutes, all in your web browser)

### Part 1 - Put the files on GitHub
1. Unzip `stock-signals-web.zip` on your computer.
2. Go to **github.com** and sign up for a free account (or sign in).
3. Click the **+** in the top-right corner, then **New repository**.
4. Name it `stock-signals`, leave everything else as is, and click **Create repository**.
5. On the next page, click the link **"uploading an existing file"**.
6. Open the unzipped `stock-signals-web` folder, select **everything inside it** (the `api`, `lib` and `public` folders plus the loose files), and drag it all onto the GitHub page.
7. Wait until the file list finishes loading, then click **Commit changes**.
8. Check that the repository now shows the folders `api`, `lib`, `public` and the files `package.json`, `vercel.json` and `README.md` at the top level. (If you instead see a single `stock-signals-web` folder, you dragged the folder itself; that's fine, just remember it for step 13.)

### Part 2 - Publish it on Vercel
9. Go to **vercel.com** and click **Sign Up**. Choose the free **Hobby** plan and **Continue with GitHub**.
10. Allow Vercel to access your GitHub account when asked.
11. On your Vercel dashboard, click **Add New...** then **Project**.
12. Find `stock-signals` in the list and click **Import**. (If it isn't listed, click **Adjust GitHub App Permissions** and give Vercel access to that repository.)
13. Leave **Framework Preset** as **Other**. Only if you saw a `stock-signals-web` folder in step 8: click **Edit** next to **Root Directory** and choose that folder.
14. Click **Deploy** and wait about a minute for the confetti.
15. Click **Continue to Dashboard**. Your link is shown under **Domains**, e.g. `stock-signals-yourname.vercel.app`.

That's your shareable link. It works on any phone or computer, and anyone you send it to can open it without an account.

**Link straight to a stock:** the address updates as you click, e.g. `.../#sp500/NVDA` (or `#dow/...`, `#nasdaq100/...`), so you can copy it and send someone a specific stock.

**Add it to your phone's home screen:** open the link in Safari (iPhone) or Chrome (Android), tap Share or the menu, then **Add to Home Screen**. It opens like an app.

---

## Making changes later
Edit or re-upload files in your GitHub repository (**Add file > Upload files** replaces files with the same name). Vercel notices the change and republishes the site within a minute or two, at the same link.

**Changing the indicator rules:** all the numbers (RSI 30/70, the +3/-3 thresholds, etc.) are in the `SETTINGS` block at the top of `lib/indicators.js`. On GitHub, open that file, click the pencil icon, edit the numbers, then **Commit changes**.

**Renaming your link:** in Vercel, open the project, go to **Settings > Domains**, and edit the `.vercel.app` name (or connect a domain you own).

---

## How the verdict works

Each indicator looks at the latest **daily** data and votes **+1 (buy)**, **-1 (sell)** or **0 (neutral)**:

| Indicator | Buy vote | Sell vote |
|---|---|---|
| RSI (14) | below 30 (oversold) | above 70 (overbought) |
| MACD (12, 26, 9) | MACD line above its signal line | MACD line below its signal line |
| 50-day vs 200-day moving average | 50-day above 200-day (uptrend) | 50-day below 200-day (downtrend) |
| Bollinger Bands (20, 2 std dev) | price in the bottom 20% of the bands or below | price in the top 20% or above |
| Stochastic (14, 3) | %K below 20 | %K above 80 |

Tap any indicator on a stock's page for a plain-English explanation with an example.

Votes are added up: **+3 or more = BUY**, **-3 or less = SELL**, anything else = **HOLD**. Expect HOLD most of the time: two indicators follow the trend and three look for overbought/oversold conditions, so they often disagree.

## P/E ratios
- **P/E (TTM):** share price divided by the last 12 months of earnings per share. It's blank for companies that lost money.
- **Forward P/E:** the same, using analysts' estimate of the next 12 months' earnings.
- **Sector average P/E:** the plain average P/E of every profitable S&P 500 company in the same sector. The S&P 500 is used as the yardstick for every index, so a Dow or Nasdaq-100 stock is compared against a full sector rather than a handful of companies. It's refreshed every 6 hours.

The list shows each stock's P/E next to its sector's average (on phones, swipe the list sideways to see all columns).

P/E is shown for context only; it doesn't change the BUY / SELL / HOLD verdict.

---

## Good to know
- **Data:** prices come from Yahoo Finance, fetched by the site's own server functions, so no API key is needed. They're usually delayed about 15 minutes.
- **Caching:** results are cached for 15 minutes (charts for 5), so everyone who visits in that window shares one set of Yahoo requests. That keeps the site fast and makes it unlikely Yahoo will throttle it.
- **Cost:** Vercel's Hobby plan is free for personal, non-commercial use. If you ever want to charge for access, you'd move to their Pro plan.
- **If prices stop loading:** Yahoo is either limiting requests (wait a few minutes) or has changed something on its side. The fix is usually a small update to `lib/yahoo.js`.

## Project layout
- `public/` - the website itself (`index.html`, `styles.css`, `app.js`)
- `api/` - server functions: `constituents` (index members), `quotes` (prices, P/E + verdicts), `chart` (trend chart data), `sector-pe` (sector average P/E)
- `lib/` - shared code: indicator math, Yahoo fetching, index member lists

*Signals are mechanical rules applied to past prices, not predictions, and nothing in this site is financial advice.*
