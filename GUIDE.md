# StockLens

A dependency-free Indian-market portfolio research dashboard. It supports manual/CSV portfolios, imported OHLCV history, separate swing, long-term thesis and intraday/F&O analysis, conditional review horizons, a research shortlist and read-only Kite/Groww broker adapters.

## Run locally for free

Requires Node.js 22–24 (tested with Node.js 24). No package install, paid AI model or database is needed.

```sh
npm run build
npm test
npm start
```

Open http://127.0.0.1:4173. Stop with Ctrl+C. Bindings are loopback-only. The Render entrypoint below supports HTTPS behind the Render proxy. The generated Worker is in `worker/index.js`; editable source is in `src/`. Run the build again after edits and restart the server.

## Family accounts and research desk

Add demat accounts from **Family & accounts** or **Connections**, using aliases and assigning an existing or new family member. Kite and Groww each support multiple separately connected accounts; other brokers use account-targeted CSV snapshots. Account, member, and all-family selectors drive the holdings views. Family totals exclude the synthetic demo and show missing/stale quote coverage. Same exchange/symbol positions combine with weighted average cost; the original account positions remain separate. NSE/BSE listings stay separate because an ISIN-based cross-exchange merge is not provided.

A broker sync replaces only its selected account; a failed sync preserves existing holdings. A CSV import likewise replaces only the destination account. Optional `last_price,price_as_of` fields allow INR snapshot valuation; the timestamp must include timezone and remains unverified. Quotes and credentials are isolated by account, and tokens are never persisted. Reusing a currently connected token for another alias is blocked; different tokens for the same real account cannot be detected automatically, so add each real account only once.

The **Research desk** implements INR whole-share position sizing capped by the user's risk budget, cash and remaining stock allocation. It records a thesis/evidence checklist and compares user-authored target weights in percentage points. These deterministic methods adapt ideas from [trader-skill](https://github.com/Jakeschincariol/trader-skill) and [claude-trading-skills](https://github.com/tradermonty/claude-trading-skills); see `THIRD_PARTY_NOTICES.md` for MIT attribution. No external agent runtime, forecasting accuracy claim, or trade execution is introduced.

The browser migrates `stocklens.v1` data into an account-aware model, saving future edits under `stocklens.v2` while preserving v1 as a fallback. All family records remain local to this browser. This is not shared family login access, cloud account synchronization, or a total-net-worth statement; cash, liabilities and unadded accounts are excluded. Obtain each account owner's authorization before connecting their data.

## Deploy to Render

Use a **Web Service** on the **Free** compute plan in Singapore. A static site cannot run the broker proxy. Commit this source to a GitHub repository and connect it to Render.

- Runtime: Node.js 24 (set `NODE_VERSION=24`).
- Build command: `npm run build:render && npm test`.
- Start command: `npm run start:render`.
- Environment: `NODE_ENV=production`.
- Health check path: `/healthz`.
- No database, disk, or paid AI subscription is required.

The production HTTP adapter binds `0.0.0.0` on Render's `PORT`. It uses the platform's `RENDER_EXTERNAL_URL` as its canonical public origin, preserving the broker API's same-origin protection behind HTTPS. For a custom domain, set `PUBLIC_ORIGIN` to that exact HTTPS origin. Never put broker API tokens in GitHub or Render environment variables; enter your current token in the dashboard's Connections dialog.

Render's free web service sleeps after 15 minutes without inbound requests and may take about a minute to wake. It shares the workspace's free instance-hour and other usage allowances. See [Render's free-service limits](https://render.com/docs/free). Browser-saved portfolios are per browser and per site origin; CSV export/import can move them from the local app to the hosted app.

## Separate strategy workspaces

- Swing: completed daily price/volume analysis and an illustrative 5–15-session review policy.
- Long-term: your own business thesis, sourced fundamental figures, fair-value assumption, holding plan and review date. Figures are entered by you, not fetched or independently verified. Unknown or stale evidence blocks a passing conclusion. Default ratio examples are editable and are not calibrated for all sectors.
- Intraday / F&O: daily underlying bias with completed five-minute contract-volume confirmation, quote liquidity and contract-specific risk sizing. These are not predictions of an option premium.
- Opportunities: rank your tracked stocks or scan the named 12-stock NSE starter universe through either connected broker. Quantity zero denotes a research watchlist entry and does not add portfolio investment value. This is a limited list, not an exchange-wide or current market-capitalization ranking.

## Connect your account

Use Connections in the app. The app accepts an existing broker session token; it does not ask for a brokerage password, PIN, API secret or TOTP. The token stays in JavaScript memory until disconnect/reload and is sent by same-origin POST to the app server. The server uses it only for allowlisted GET requests to the selected broker. It is not logged, stored or included in a URL. The app has no order-placement endpoints. A broker token may have wider permissions outside this app. The hosted dashboard is publicly reachable, but each visitor supplies their own token and browser-held portfolio; portfolios and tokens are not shared between visitors.

- **Kite:** enter your developer API key and current access token. Obtain a token through the official Kite Connect login/session flow. A request_token is not an access_token. Free Personal supports portfolio access but excludes live/historical market data. Connect is ₹500 per app per month, subject to current terms and conditional credits.
- **Groww:** generate a current API access token from your account's API settings. The advertised API plan is ₹499 plus tax per month; offers may differ. Historical data uses `/v1/historical/candles`, not the deprecated range endpoint.
- Tokens can expire or be revoked; reconnect when the app reports this. Broker documentation describes daily 06:00 expiry. No credentials have been supplied or real account requests verified during development.
- Other platforms: import their holdings CSV using the documented columns. There is no universal broker login standard; add another read-only adapter to `src/brokers.js` for another live API.

## Data behavior

The initial portfolio and prices are deliberately synthetic and labeled DEMO. They are never silently used as a replacement for failed broker data. Holdings, preferences and imported candles are saved in this browser, independently of broker credentials. Disconnect/reload clears the current token; use the app's reset/clear actions to remove browser data.

Connected quotes use periodic polling, not exchange tick streaming. Show the actual quote timestamp and treat old quotes as stale. A fetched response timestamp is not a substitute for exchange time. Market holidays and special sessions are not independently verified. Daily broker history deliberately uses sessions before today (IST), avoiding incomplete daily candles even while markets trade; after today's close, its daily bar becomes available to analysis tomorrow. Five-minute history excludes the unfinished bar. Candle data is not adjusted by this app for corporate actions: splits/bonuses may distort indicators if the source is unadjusted.

Free workflow: import your own holdings and an OHLCV CSV for each stock. At least 20 complete candles are needed for basic analysis; 60 daily candles for eligible directional research. CSV data remains historical/imported and cannot establish a live F&O quote.

## What the analysis means

- SMA20/50, EMA20, Wilder RSI14 and ATR14 describe the supplied price history.
- Volume factor compares the last complete candle with the preceding 20 complete candles, excluding the evaluated candle from its own baseline. Intraday comparisons are not normalized for time-of-day seasonality.
- The signed score is a transparent combination of trend and momentum rules, **not a calibrated probability or tested accuracy percentage**.
- Holding periods are review windows, conditional on the underlying scenario remaining intact. Technical rules cannot determine the correct long-term holding period; earnings, valuation, portfolio needs and taxes require additional review.
- Entry, invalidation and target are ATR-based scenarios, not promised future prices. Gross reward/risk excludes fees, taxes, slippage and gaps. A 2:1 constructed scenario does not establish positive expected return.
- F&O uses daily underlying direction, contract liquidity, fresh quote and verified lot/expiry data. Long options reserve the full premium as possible loss. Underlying targets are not option-premium targets. Futures margin, IV, Greeks, time decay and event risk are not fully modeled. A checklist pass is a research signal and does not submit a trade.
- No model has been backtested or calibrated on an out-of-sample Indian-market dataset. Do not interpret the dashboard as a proven forecasting system.

## Tests and architecture

`src/app.test.js` executes templates and handlers with minimal DOM doubles; it is not browser/visual verification. `src/longterm.js` checks user-authored investment criteria. `src/engine.js` is pure JavaScript with native `node:test` coverage for indicator formulas, freshness, volume baseline leakage, invalid candles and contract/risk gates. `src/brokers.test.js` uses mocked upstream requests to check endpoint mapping and error handling. Live broker integration still requires testing with your own valid account and subscription.

`src/page.html`, `styles.css`, `app.js`, `demo.js` form the client. `src/brokers.js` normalizes upstream data. `src/server.js` only serves local assets and the allowlisted read-only broker route. `scripts/bundle.mjs` embeds these into the single-file Cloudflare Worker used by Sites. There are no third-party runtime dependencies or analytics trackers.

## Official sources checked 23 October 2026

- Kite fees: https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/what-are-the-charges-for-kite-apis
- Kite authentication: https://kite.trade/docs/connect/v3/user/
- Kite holdings: https://kite.trade/docs/connect/v3/portfolio/
- Kite quotes/instruments: https://kite.trade/docs/connect/v3/market-quotes/
- Kite historical data: https://kite.trade/docs/connect/v3/historical/
- Groww plans: https://groww.in/trade-api
- Groww authentication: https://groww.in/trade-api/docs/curl
- Groww holdings: https://groww.in/trade-api/docs/curl/portfolio
- Groww instruments: https://groww.in/trade-api/docs/curl/instruments
- Groww live data: https://groww.in/trade-api/docs/curl/live-data
- Groww historical data: https://groww.in/trade-api/docs/curl/backtesting

## Verification and hosting status

All 82 automated tests passed locally and in Render's production build. On 25 October 2026 (IST), the hosted family screen, add-account form, Research desk, sample checklist/allocation controls and both broker connection options were inspected in the browser. HTTPS checks returned 200 for health, HTML, CSS, JavaScript and notices; deployed source assets matched the reviewed local release. No live broker credentials were supplied, so authenticated Kite/Groww integration still requires account testing.

StockLens is live at https://stocklens-xope.onrender.com/, deployed from commit `45f57b81751a27224f3e108c7db770d7fac49020` in https://github.com/Hemendra001/Stock-Lens. Render deploy `dep-dbegahc9v7es73cgcvqg` is live. Service `srv-dbe70c1srm7s73b4j790` runs on the Free plan in Singapore in My Workspace. The deployment dashboard is https://dashboard.render.com/web/srv-dbe70c1srm7s73b4j790. Health check: `/healthz`; automatic deployments: on commit. The earlier Sites project identity is retained only in the authoring checkout; Render does not need it.

The standalone StockLens.html runs demo and CSV analysis directly in a browser, with no Node install. Direct broker APIs require the local server or the hosted Render app because they need a server for same-origin requests; the standalone HTML explains this.
