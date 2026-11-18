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
