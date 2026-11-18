# Auction bot

This Node.js worker reads public Phillips and Christie’s auction data and compares it with Kalshi order books. The paper strategy models YES entries when a published live bid crosses a price threshold and NO entries when a watched lot is explicitly marked unsold. Each entry records the observed price and available depth.

## Run the paper worker

Use Node.js 24. From the repository root:

```sh
npm test
npm run paper
```

The paper worker needs no API credentials or package installation. The bundled watchlist covers the November 17, 2026 sales and expires after those auctions. Review the sale windows, lot identities, contract rules, and market tickers before using a new watchlist.

For hosting, select a background worker, use `npm run paper` as its start command, and give one instance persistent writable storage at `runtime/` for the SQLite ledger. [Operating details](README.txt) cover the configuration, separate final-result strategy, and limits of the simulated results.

## Watch for later offers

Run `node bot.mjs --paper --watch-offers --once` for one read-only scan. Omit `--once` to keep watching. The watchlist covers specific sales. Offer monitoring continues for 12 hours after each configured observation window, subject to the contract remaining active. Use a reviewed watchlist for future auctions.

* A published current USD bid strictly above a threshold supports a speculative YES entry. This source currently supports Christie’s catalogue when it displays the bid. A bid can be withdrawn or the lot can go unsold.
* A verified premium-inclusive sale supports YES or NO according to the exact threshold. Christie’s individual lot pages can publish the price before the catalogue does. Artnet is the designated settlement source.
* An explicit unsold result supports a conditional NO entry under the reviewed series terms. Missing lots and ambiguous prices are skipped.

The worker revisits eligible contracts while offers remain available. Each order uses a fresh depth check and an immediate-or-cancel limit. Defaults are one contract per order, at most 95¢, two attempts per artwork at least 60 seconds apart, five attempts in total, and a $5 lifetime reserve across the shared live journal. Partial and zero fills still consume an attempt and its reservation. Live positions must match recorded fills for the artwork. A change of signal never causes the worker to buy the opposite side of a ticker it already attempted. Run one instance per account with persistent `runtime/` storage.

### Connect your Kalshi account

1. Copy `config.example.json` to the ignored local `config.json` and review its limits. Store your private signing key **outside the repository**. Set `KALSHI_API_KEY_ID` to the key ID and `KALSHI_PRIVATE_KEY_PATH` to the key file path in the worker’s environment.
2. Run `node bot.mjs --check-account` to verify an authenticated balance read. This prints only the connection status.
3. To activate real orders, set `liveEnabled` to `true` in your local config and run `node bot.mjs --live --watch-offers --acknowledge-live-trading`. Running this command authorizes the worker to spend up to the configured limits. Ctrl+C or the `STOP` file stops future submissions. An uncertain order receipt requires reconciliation before restarting.
