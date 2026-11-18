AUCTION RESULT MONITOR — NOVEMBER 17, 2026

This standalone Node.js program reads the auction houses directly. It does not
accept signals from ChatGPT or another program. The default mode is paper-only.
The live adapter is included for you to inspect and activate locally; it has not
been used with your account, credentials, or real orders.

Tonight's existing Codex manual alerts remain separate and active:
  Phillips: checks start 4:25 PM Eastern; sale starts 4:30 PM.
  Christie's: checks start 6:25 PM Eastern; sale starts 6:30 PM.
The independent bot does not modify those alerts or share their execution state.

GET STARTED

Node.js 22 or newer is required. Node 24.21.0 was available on this computer.
There are no npm dependencies to install. Open PowerShell in this directory:

  node bot.mjs --preflight
  node bot.mjs --paper-bids

Start-Paper.cmd runs the Christie’s current-bid experiment. During this sale,
it checks the public catalogue every 10 seconds plus processing time. On the
first observed USD bid strictly above each strike, it checks the YES order book.
The experiment records one decision per contract, including skipped quotes.
A paper buy uses displayed depth and a fee reserve. An actual fill and final
Artnet settlement are unknown. Blank live-bid fields produce no signal.
The status, SQLite ledger and JSONL observations are in runtime/paper-bids/24266.
This launcher also checks watched Phillips and Christie’s lots for an explicit
bought-in or unsold status. It compares NO offers on eligible above-price
contracts and models one purchase per unsold artwork at the best observed cost,
using the same paper budget. Missing prices and withdrawals do not qualify.
The recorded price is a current simulation, including for results already known
when the monitor starts. Kalshi’s Artnet settlement may differ.
Use --paper for the older final-result strategy.

Preflight only reads public sources and checks catalogue identities, frozen
contract rules, Artnet settlement sources, and supported fees. Paper mode waits
for the auction windows, polls public pages, and logs hypothetical opportunities.
Paper mode cannot load credentials or submit orders, even if liveEnabled is true.
You can also double-click Start-Paper.cmd to run it in a visible console.

Use Ctrl+C to stop. Alternatively, create an empty file named STOP in this
directory. The STOP file is checked before network requests and order submission.
It cannot undo an order already submitted or filled. Remove STOP yourself when
you intend to run again. Keep your computer awake and connected during monitoring.

DEFAULTS TO REVIEW

  mode: paper
  polling: every 10 seconds per scan, plus processing time
  quantity: 1 whole contract per attempt
  maximum contract price: 95 cents
  minimum conditional profit after reserve: 2 cents
  maximum reserved cost per order: $1.00
  maximum total reserved cost: $5.00
  maximum attempts: 5, with at most one attempt per artwork
  quote request age: at most 2 seconds at submission
  source confirmation request age: at most 15 seconds at submission

These are small illustrative limits, not recommendations or a proven profitable
strategy. Copy config.example.json to config.json to customize them. The original
example remains paper-only. Existing persisted reservations still count after
restart and after changing configuration. No profits are recycled into the budget.

HOW IT DECIDES

The included watchlist maps 19 artworks to 20 event listings and 150 contracts.
It is restricted to these November 17 sales and expires automatically. It requires:

1. Exact auction, lot ID, lot number, artist, and title matches.
2. A visible sold/closed result in USD, including buyer's premium. Estimates,
   current bids, hammer-only figures, withdrawn lots and ambiguous states fail.
3. The event explicitly designating Artnet as its sole settlement source, and
   the full market rules matching the frozen watchlist. New contracts are ignored.
4. A $1 binary contract with an unchanged, strictly-greater threshold and active
   trading before its close time. Equality implies NO.
5. Available opposite-side orderbook bids covering the configured quantity.
6. A second source read confirming the same result, a fresh fee/exchange check,
   and another event/orderbook read before the decision.

The bot selects the largest conditional surplus among the available thresholds
on a given event. It does not estimate a probability that Artnet will agree and
does not claim that the surplus is statistical expected value. It considers
events in watchlist order, not a globally optimal portfolio.

Christie's parser requires terminal flags. If those flags change only after the
whole sale, the bot may detect a result too late. Phillips also must expose its
final sold-price fields. Live publication timing for these sites is unproven.
Ten-second polls are not instantaneous, and processing can extend that interval.
HTTP checks can reject an explicitly old cache, but cannot prove origin freshness
when cache headers are missing or misleading. Source timestamps are observations,
not proof of the moment the house first published.

FEES AND LIMITS

Only KXART's standard quadratic fee type with multiplier 1 is supported.
The budget reserves 3 cents per contract for fees: the standard formula's maximum
rounded fee plus a cushion. The chosen contract price is rounded upward to a
cent limit, with no further slippage allowed. The profit shown is conditional on
the recorded side eventually paying $1. It excludes taxes and operating costs.
Fee assumptions are not a guarantee of the exchange's actual charges. A receipt
that exceeds the reserve stops further execution for review; it cannot undo a fill.

LIVE MODE — USER ACTIVATION ONLY

No API key is needed for preflight or paper mode. Do not paste private keys into
chat or this repository. Keep your private key in a local file outside this folder.
The adapter supports Ed25519 and RSA-PSS keys and sends signed requests only to
the fixed official Kalshi HTTPS API host; it never uploads the private key.

If, after reviewing the program and paper evidence, you choose to activate it:

1. Copy config.example.json to config.json.
2. Edit config.json: review every limit, set privateKeyPath to your local key
   file (forward slashes work on Windows), and set liveEnabled to true.
3. In your own PowerShell session, set your API key ID:

     $env:KALSHI_API_KEY_ID = Read-Host 'Kalshi API key ID'

4. You can then explicitly start live execution yourself:

     node bot.mjs --live --acknowledge-live-trading

That command can place real orders automatically when the program's rules pass.
The assistant has not run it. There is no automatic startup or installed service.

Live mode reads account positions and resting orders before each attempt. It
refuses an artwork with existing exposure, including another threshold/event on
that artwork. Do not trade the same artworks manually while live mode is running:
the account read and submission are not an atomic operation, so concurrent manual
orders can race these checks. The manual alerts remain useful for paper-mode use.
The application budget covers this instance's attempts, not other account trades.

Orders use Kalshi's current /portfolio/events/orders API. YES buys are bids on
the YES book; NO buys are asks at the complementary YES price. Orders are limit
IOC (immediate-or-cancel), so partial fills are possible and unfilled remainder
should cancel. There is no market-order fallback, automatic repricing, selling,
cash-out, cancellation of your other orders, or automatic retry of an order.
API authentication and submission have only been tested with generated local
test keys and a fake exchange. Production permissions/fills remain unvalidated.

JOURNAL, RESTARTS AND FAILURES

runtime/paper and runtime/live are separate. Each contains:
  orders.jsonl       durable intents and receipts; reservations survive restart
  observations.jsonl source checks, quote failures, candidates and errors
  status.json        latest process state
  process.lock       exclusive process lock while running

An intent is written and flushed before submission. Each artwork gets only one
attempt, including zero/partial fills. A timeout, malformed receipt, or crash
leaves an unresolved intent and blocks further orders. No POST is retried. Do not
assume a timeout means no fill. Inspect Kalshi's actual order history using the
recorded client order ID. This version deliberately has no automatic reconciliation
or retry command. An unresolved journal needs explicit manual/code review before
execution can resume. Do not delete the journal to get around that stop.

A crash may leave process.lock. Before removing that lock yourself, verify that
no bot process is still running. Never run multiple folder copies with the same
account: their locks and budgets are independent. Corrupt/incomplete journal
records stop execution rather than resetting the budget.

Any network error, access/rate response, schema change, changed final result,
rule mismatch or stale execution check stops the program. It does not bypass
blocks or retry aggressively. The console and status file show the reason.
This conservative behavior can miss opportunities. Monitor the process itself;
the separate Codex auction alarm is not an uptime guarantee for this program.

WHAT PAPER RESULTS MEAN

PAPER_OPPORTUNITY records displayed depth and a conditional payoff calculation.
It is not an actual fill, an Artnet confirmation, or realized profit. Queue changes,
competing orders, latency and settlement disagreements can change the outcome.
One artwork can have multiple correlated contracts; they are not independent wins.
The bot never labels an order receipt as realized profit. It does not automatically
verify final settlements or portfolio P&L.

VALIDATION

Run: npm test
The tests use generated disposable keys and fake network responses; no live orders.
In a restricted workspace, set AUCTION_TEST_TEMP_DIR to a writable scratch folder.
The preflight command separately checks real public data without authentication.
The frozen watchlist was checked against public data on November 17, 2026.

Official implementation references, checked November 17, 2026:
  https://docs.kalshi.com/api-reference/orders/create-order-v2
  https://docs.kalshi.com/getting_started/api_keys
  https://docs.kalshi.com/api-reference/market/get-market-orderbook
  https://docs.kalshi.com/api-reference/market/get-series
  https://docs.kalshi.com/api-reference/portfolio/get-positions
  https://docs.kalshi.com/api-reference/orders/get-orders
  https://kalshi.com/fee-schedule
