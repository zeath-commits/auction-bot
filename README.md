# Auction bot

This Node.js worker reads public Phillips and Christie’s auction data and compares it with Kalshi order books. The paper strategy models YES entries when a published live bid crosses a price threshold and NO entries when a watched lot is explicitly marked unsold. Each entry records the observed price and available depth.

## Run the paper worker

Use Node.js 24. From the repository root:

```sh
npm test
npm run paper
```

The paper worker needs no API credentials or package installation. The bundled watchlist covers the November 17, 2026 sales and expires after those auctions. Review the sale windows, lot identities, contract rules, and market tickers before using a new watchlist.

Run `npm start` to open the strategy dashboard at http://127.0.0.1:8787. The service runs the two BTC paper experiments continuously and starts the auction workers for the configured sales. Railway supplies `PORT`. Deploy one instance with persistent storage at `/app/runtime` so observations survive redeployment. [Operating details](README.txt) cover the existing auction worker.

### Strategy dashboard

* **Paper trading** shows modeled entries, entry cost, estimated fees, outstanding positions and net results after official settlement. The Bitcoin strategies each model one contract per window on the first qualifying 98¢ or 99¢ best ask that holds or improves across two public book reads at least one second apart and shows size for one contract on both reads. The two variants require the entire check to fall in the last 60 or 10 seconds. They may select the same outcome. Paper execution does not verify a fill. Auction observations retain the original conservative fee reserve. The bundled auction watchlist expires.
* **Historical tests** shows the first trade print at either exact price during each closing minute and the outcomes of the independently measured final-ten-second rule when available. Prints are counted once per rule per market. The service checks hourly for yesterday's finished Eastern-day replay; missing settlements defer the run. To replay a chosen period, run `node btc-replay.mjs 2026-11-14T05:00:00Z 2026-11-18T05:00:00Z`. For a DST transition pass that day's individual midnight boundaries.
* **Real trades** reads the latest 100 fills and settlements for the configured subaccount once per minute if the existing API credentials are configured. Settlement payout is shown separately from net profit. Imported account records live in the ignored file `runtime/account-history.json` as an array of `{ticker, side, quantity, cost, at, source, net}`. Use null for unknowns. On a network listener set `DASHBOARD_PASSWORD` and use the username `owner` over HTTPS to view this tab. Without a password the network listener serves public research only. Loopback access is local to the machine. The dashboard starts only paper workers.

## Watch for later offers

Run `node bot.mjs --paper --watch-offers --once` for one read-only scan. Omit `--once` to keep watching. The watchlist covers specific sales. Offer monitoring continues for 12 hours after each configured observation window, subject to the contract remaining active. Use a reviewed watchlist for future auctions.

During paper scans, `runtime/paper/observations.jsonl` records a `paper_depth` observation for each eligible order book the worker examines, including empty books. It records the auction signal, timestamps and returned price levels up to the configured price ceiling. Prices and quantities in these levels are integers in millionths of a dollar and millionths of a contract. These snapshots measure displayed capacity before fees. Order sizing still uses the configured quantity and risk limits. The API request is limited to 100 levels and the scan skips artworks that have already hit their attempt limit.

* A published current USD bid strictly above a threshold supports a speculative YES entry. This source currently supports Christie’s catalogue when it displays the bid. A bid can be withdrawn or the lot can go unsold.
* A verified premium-inclusive sale supports YES or NO according to the exact threshold. Christie’s individual lot pages can publish the price before the catalogue does. Artnet is the designated settlement source.
* An explicit unsold result supports a conditional NO entry under the reviewed series terms. Missing lots and ambiguous prices are skipped.

The worker revisits eligible contracts while offers remain available. Each order uses a fresh depth check and an immediate-or-cancel limit. Defaults are one contract per order, at most 95¢, two attempts per artwork at least 60 seconds apart, five attempts in total, and a $5 lifetime reserve across the shared live journal. Partial and zero fills still consume an attempt and its reservation. Live positions must match recorded fills for the artwork. A change of signal never causes the worker to buy the opposite side of a ticker it already attempted. Run one instance per account with persistent `runtime/` storage.

### Connect your Kalshi account

1. Copy `config.example.json` to the ignored local `config.json` and review its limits. Store your private signing key **outside the repository**. Set `KALSHI_API_KEY_ID` to the key ID and `KALSHI_PRIVATE_KEY_PATH` to the key file path in the worker’s environment.
2. Run `node bot.mjs --check-account` to verify an authenticated balance read. This prints only the connection status.
3. To activate real orders, set `liveEnabled` to `true` in your local config and run `node bot.mjs --live --watch-offers --acknowledge-live-trading`. Running this command authorizes the worker to spend up to the configured limits. Ctrl+C or the `STOP` file stops future submissions. An uncertain order receipt requires reconciliation before restarting.
