# Auction bot

This Node.js worker reads public Phillips and Christie’s auction data and compares it with Kalshi order books. The paper strategy models YES entries when a published live bid crosses a price threshold and NO entries when a watched lot is explicitly marked unsold. Each entry records the observed price and available depth.

## Run the paper worker

Use Node.js 24. From the repository root:

```sh
npm test
npm run paper
```

The paper worker needs no API credentials or package installation. The bundled watchlist covers the November 17, 2026 sales and expires after those auctions. Review the sale windows, lot identities, contract rules, and market tickers before using a new watchlist.

Run `npm start` to open the strategy dashboard at http://127.0.0.1:8787. The service runs the three BTC paper experiments continuously and starts the auction workers for the configured sales. Railway supplies `PORT`. Deploy one instance with persistent storage at `/app/runtime` so observations survive redeployment. [Operating details](README.txt) cover the existing auction worker.

### Strategy dashboard

* **Paper trading** shows modeled entries, entry cost, estimated fees, outstanding positions and net results after official settlement. The Bitcoin strategies each model one contract per window on the first qualifying 98¢ or 99¢ best ask that holds or improves across two public book reads at least one second apart and shows size for one contract on both reads. The time filters require the entire check to fall in the last 60 or 10 seconds. A third final-minute variant requires visible size of at least 1,000 contracts on both checks and models a single contract for comparison. They may select the same outcome. Paper execution does not verify a fill. Auction observations retain the original conservative fee reserve. The bundled auction watchlist expires.
* **Historical tests** shows the first trade print at either exact price during each closing minute and the outcomes of the independently measured final-ten-second rule when available. Prints are counted once per rule per market. The service checks hourly for yesterday's finished Eastern-day replay; missing settlements defer the run. To replay a chosen period, run `node btc-replay.mjs 2026-11-14T05:00:00Z 2026-11-18T05:00:00Z`. For a DST transition pass that day's individual midnight boundaries.
* **Real trades** reads the bot’s own live order journal. A real fill needs a matching live intent, a positive filled quantity and an exchange order ID. The dashboard starts only paper workers. Network access to this ledger requires HTTPS and the configured `DASHBOARD_PASSWORD` with username `owner`. Local loopback access is available on this machine.

## Five-minute Bitcoin markets

The Polymarket US worker checks for a 98¢ or 99¢ ask in the last ten seconds. It models one share when a second fresh order book, at least one second later and still before expiry, confirms the same side at that price or better. The dashboard counts usable observations and reports stale or late reads. Public feeds can miss the entire entry window.

Every quarter hour, the last five minutes also overlap with a Kalshi BTC contract. When the contracts use the same averaging window, the worker prices Up at the lower opening strike and Down at the higher one. Ten of each pay at least $10 if both settle normally against the same final Bitcoin value. Each leg needs ten displayed contracts on both checks and total modeled cost including venue fees must be below $10. A paper entry models both legs together. Actual exchanges process orders separately. The dashboard records net after both outcomes are final.

One additional paper strategy tests openings where the strikes differ by at least 0.20% of the Kalshi opening strike. It allows a premium for the chance of both legs paying. The first two fresh quotes must arrive within the opening 30 seconds and show ten pairs for $10 through $13 after fees. At $13, ten pairs lose $3 if just one leg pays or earn $7 if both pay. The entry threshold was selected after inspecting two weeks of settlements. Entries with affordable offers can behave differently from all wide-gap windows. The dashboard reports how many openings passed the gap filter and had fresh quotes.

The dashboard checks hourly for the previous Eastern day's completed international Polymarket replay. The archive uses the first qualifying taker buy by block timestamp, which can lag matching. It models one share per market, applies the validated market fee schedule and skips listings with different rules or fee terms. To reproduce the two-week study, run `node polymarket-replay.mjs 2026-11-04T05:00:00Z 2026-11-18T05:00:00Z`. For the three-week US settlement comparison, run `node cross-venue-audit.mjs 2026-10-28T05:00:00Z 2026-11-18T05:00:00Z`. Public observations are saved under `runtime/`.

## Watch for later offers

The November 18 Sotheby’s live-bid paper test follows five lots in the Blaquier-Arrieta evening auction from 5:55 to 10 p.m. Eastern. These 45 Kalshi thresholds settle from the Sotheby’s lot page. Each test entry requires a live USD bid strictly over the threshold and a YES offer of 95¢ or less with a whole contract available. Two recent source responses with distinct HTTP dates and two fresh order books must confirm the signal, with the bid holding or increasing and the offer holding or improving. A second paper cohort, chosen after the historical review, tests best YES offers of exactly 97¢ or 98¢ on both checks. Each cohort records at most one share per threshold and waits for official settlement. A lot can go unsold after bidding begins.

Run `node sothebys-bids.mjs` to recheck the five lot identities and exchange rules. Run `node live-bid-replay.mjs` to compare the November 16 archived bids against public trades and final Kalshi outcomes. Replay windows cover one through ten seconds after each observation and end earlier if another catalog sample arrives.

Every ten minutes the dashboard compares open KXART contracts with the reviewed calendar, checks the named settlement source and flags new or changed Artnet thresholds for review. The post-sale scan also lists lots still missing a verified result.

From the start of each scheduled sale, a paper monitor records when it first verifies a published sale or explicit unsold result and checks available depth. It continues through the 12-hour offer window. Afterward, the post-sale monitor revisits active contracts. Both phases share a $1,000 paper balance and accumulate entries for each ticker on the same verified outcome. It checks current auction-house evidence, exact Artnet rules and current order books. For an entry it verifies the auction source again and checks displayed quantity twice. It sizes a purchase from whole contracts visible at the same prices on both checks through 99¢, including estimated taker fees. On repeat visits it reserves the quantity already modeled at the cheapest visible prices before sizing any addition. Repricing an unchanged quantity or briefly removing and restoring an offer cannot generate another entry. This can undercount genuine turnover. Prices, quantities, source and timestamps are saved with the paper entry. The exchange can remove orders between observations, and Artnet determines the contract result. Outcomes on multiple thresholds for one lot are correlated.

Run `node auction-tape-replay.mjs` to compare the November 16 Sotheby’s signals to public non-block trades and official settlements. Add `--desktop` to use the November 17 Christie’s and Phillips alert timestamps. The replay accepts buys on the side implied by the result through 95¢. It budgets $1,000 without recycling proceeds, caps quantity per ticker, and rounds modeled fees up to a cent. The November 16 archive can also require visible size at the exact trade price 1–30 seconds earlier. Historical purchases show what another trader obtained. A bot arriving at the same time could miss the offer. The repeat-purchase comparison groups fills at the same exchange timestamp and ticker, retaining only quantity at the highest qualifying price. After a 30-second signal delay, the model compares one entry per ticker with repeat entries at least 60 seconds apart. It also measures volume-limited sizing using the same $1,000 without recycling proceeds. The dashboard checks the November 17 replay every six hours while payouts are pending.

The dashboard also scans open KXART, KXBTCD and KXETHD contracts for paired thresholds. It compares two strikes on the same event only when the primary rules differ solely by the strike and the secondary rules and close times match. Under ordinary binary settlement, one lower-strike YES and one higher-strike NO together pay at least one dollar. The paper monitor needs two book checks with a whole contract on each side, a combined cost below one dollar after estimated fees and a current exchange status. Separate live orders could fill only one leg. Paper net for a pair appears after both contracts settle.

The paper calendar covers Phillips lot 301 and eight Christie’s lots on November 19. On November 20 it also covers 33 thresholds across seven Christie’s lots. Lots 719 and 721 are in the 10:30 a.m. Eastern session, and lots 910, 913, 926, 938 and 941 are in the 2 p.m. session. Individual lot times depend on the auction. The dashboard links each lot to the auction house and Kalshi. The Friday worker loads all 343 catalog entries and uses the same reviewed Artnet rules as the other paper watches. Run `node bot.mjs --paper --paper-calendar --preflight` to recheck the public sources and contract rules.

For an independent BTC final-ten-second study, add `--final-ten` to the replay command. It writes separate daily observations under `runtime/holdout-ten/`, including the trade size and aggressor. These are historical print tests.

Run `node bot.mjs --paper --watch-offers --once` for one read-only scan. Omit `--once` to keep watching. The watchlist covers specific sales. Offer monitoring continues for 12 hours after each configured observation window, subject to the contract remaining active. Use a reviewed watchlist for future auctions.

During paper scans, `runtime/paper/observations.jsonl` records a `paper_depth` observation for each eligible order book the worker examines, including empty books. It records the auction signal, timestamps and returned price levels up to the configured price ceiling. Prices and quantities in these levels are integers in millionths of a dollar and millionths of a contract. These snapshots measure displayed capacity before fees. Order sizing still uses the configured quantity and risk limits. The API request is limited to 100 levels and the scan skips artworks that have already hit their attempt limit.

* A published current USD bid strictly above a threshold supports a speculative YES entry. This source currently supports Christie’s catalogue when it displays the bid. A bid can be withdrawn or the lot can go unsold.
* A verified premium-inclusive sale supports YES or NO according to the exact threshold. Christie’s individual lot pages can publish the price before the catalogue does. Artnet is the designated settlement source.
* An explicit unsold result supports a conditional NO entry under the reviewed series terms. Missing lots and ambiguous prices are skipped.

The worker revisits eligible contracts while offers remain available. Each order uses a fresh depth check and an immediate-or-cancel limit. Defaults are one contract per order, at most 95¢, two attempts per artwork at least 60 seconds apart, five attempts in total, and a $5 lifetime reserve across the shared live journal. Partial and zero fills still consume an attempt and its reservation. Live positions must match recorded fills for the artwork. A change of signal never causes the worker to buy the opposite side of a ticker it already attempted. Run one instance per account with persistent `runtime/` storage.

The replay also compares 95¢, 98¢ and 99¢ limits after 30 seconds and five minutes. Each scenario has a single $1,000 budget for the sale date. The competition scenario skips the first eligible purchase at every threshold. The concentration check reruns the same budget with the largest contributing artwork excluded. The archive records the extra higher-priced executions so each result can be reproduced. The separate two-book replay uses only whole units visible at the same price on consecutive snapshots one to thirty seconds apart. It reserves units already counted and uses the fee precision of the live paper monitor.

On the paper dashboard, select **Sotheby’s · published sale price and available quantity** to compare 95¢ and 99¢ limits prospectively. Each comparison ledger starts with $1,000, records the same verified books and keeps spent cash reserved. Settled net uses the exchange payout and includes modeled fees. Comparison entries stay outside the combined paper and real-trade totals.

### Connect your Kalshi account

1. Copy `config.example.json` to the ignored local `config.json` and review its limits. Store your private signing key **outside the repository**. Set `KALSHI_API_KEY_ID` to the key ID and `KALSHI_PRIVATE_KEY_PATH` to the key file path in the worker’s environment.
2. Run `node bot.mjs --check-account` to verify an authenticated balance read. This prints only the connection status.
3. To activate real orders, set `liveEnabled` to `true` in your local config and run `node bot.mjs --live --watch-offers --acknowledge-live-trading`. Running this command authorizes the worker to spend up to the configured limits. Ctrl+C or the `STOP` file stops future submissions. An uncertain order receipt requires reconciliation before restarting.
