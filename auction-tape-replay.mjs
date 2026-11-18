import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { API } from './transport.mjs';
import { persistentOffer } from './late-auction.mjs';

async function get(route) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(400);
    const response = await fetch(API + route, {
      signal: AbortSignal.timeout(12000)
    });
    if (response.ok) return response.json();
    if (![429, 502, 503, 504].includes(response.status) || attempt === 4)
      throw Error('Public market data HTTP ' + response.status);
    const retry = response.headers.get('retry-after');
    const delay =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now();
    await sleep(
      Math.max(2000 * 2 ** attempt, Number.isFinite(delay) ? delay : 0)
    );
  }
}

export function matchBook(books, trade) {
  const time = Date.parse(trade.at);
  // Check the most recent observed book. An older offer can have disappeared.
  const book = books.filter((b) => Date.parse(b.at) < time).at(-1);
  if (!book) return 0;
  const age = time - Date.parse(book.at);
  if (age < 1000 || age > 30000) return 0;
  return book.levels.find(([p]) => p === trade.price)?.[1] ?? 0;
}

export function simulate(
  trades,
  maxPerEntry,
  delayMs,
  requireBook,
  repeatAfterMs = Infinity,
  positiveUpsideOnly = false
) {
  const used = new Map(),
    entries = [];
  let cash = 100000,
    payout = 0,
    unsettled = 0;
  for (const t of trades) {
    if (
      t.elapsedMs < delayMs ||
      (used.has(t.ticker) && t.elapsedMs - used.get(t.ticker) < repeatAfterMs)
    )
      continue;
    let quantity = Math.min(
      maxPerEntry,
      Math.floor(t.size),
      requireBook ? t.shown : Infinity
    );
    const cents = Math.round(t.price * 10000) / 100;
    const fee = (n) => Math.ceil(7 * n * t.price * (1 - t.price) - 1e-9);
    quantity = Math.min(quantity, Math.floor(cash / cents));
    while (
      quantity > 0 &&
      Math.ceil(quantity * cents - 1e-9) + fee(quantity) > cash
    )
      quantity--;
    if (!quantity) continue;
    const debit = Math.ceil(quantity * cents - 1e-9) + fee(quantity);
    if (positiveUpsideOnly && debit >= quantity * 100) continue;
    cash -= debit;
    payout += t.won ? quantity * 100 : 0;
    if (t.won == null) unsettled += debit;
    used.set(t.ticker, t.elapsedMs);
    entries.push({
      ticker: t.ticker,
      event: t.event,
      artwork: t.artwork,
      at: t.at,
      elapsedMs: t.elapsedMs,
      price: t.price,
      quantity,
      debitCents: debit,
      netCents: t.won == null ? null : (t.won ? 100 * quantity : 0) - debit
    });
  }
  return {
    entries,
    tickers: used.size,
    lots: new Set(entries.map((e) => e.artwork)).size,
    quantity: entries.reduce((n, e) => n + e.quantity, 0),
    cost: (100000 - cash) / 100,
    pendingCost: unsettled / 100,
    net: unsettled ? null : (payout + cash - 100000) / 100
  };
}

function microseconds(at) {
  const fraction = at.match(/\.(\d+)Z$/)?.[1] ?? '';
  return Date.parse(at) * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
}

function groupedExecutions(trades) {
  // Fills at a common timestamp can belong to the same incoming order.
  // Use only the highest observed qualifying price in each such group.
  const groups = new Map();
  for (const t of trades) {
    const timestamp = microseconds(t.at),
      key = t.ticker + '/' + timestamp,
      prior = groups.get(key);
    if (!prior || t.price > prior.price) groups.set(key, { ...t, timestamp });
    else if (t.price === prior.price)
      prior.size = Math.round((prior.size + t.size) * 100) / 100;
  }
  return [...groups.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.ticker.localeCompare(b.ticker)
  );
}

export function repeatStudy(trades) {
  const prints = groupedExecutions(trades);
  return {
    first: simulate(prints, 5, 30000, false),
    repeat: simulate(prints, 5, 30000, false, 60000),
    volumeLimited: simulate(prints, Infinity, 30000, false, 60000)
  };
}

// Compare price caps on the same time-ordered executions and bankroll.
// Missing the first eligible execution at each threshold models a competing buyer.
export function priceSensitivity(tape) {
  const grouped = groupedExecutions(tape),
    models = [];
  for (const delay of [30, 300])
    for (const cap of [0.95, 0.98, 0.99])
      for (const missFirst of [false, true]) {
        const seen = new Set();
        const prints = grouped.filter((t) => {
          if (t.elapsedMs < delay * 1000 || t.price > cap || t.size < 1)
            return false;
          const first = !seen.has(t.ticker);
          seen.add(t.ticker);
          return !missFirst || !first;
        });
        const run = (rows) =>
          simulate(rows, Infinity, delay * 1000, false, 60000, true);
        const result = run(prints);
        const lots = new Map();
        for (const e of result.entries) {
          const row = lots.get(e.artwork) ?? {
            artwork: e.artwork,
            costCents: 0,
            netCents: 0
          };
          row.costCents += e.debitCents;
          row.netCents =
            e.netCents === null || row.netCents === null
              ? null
              : row.netCents + e.netCents;
          lots.set(e.artwork, row);
        }
        const ranked = [...lots.values()].sort((a, b) =>
          result.pendingCost
            ? b.costCents - a.costCents
            : b.netCents - a.netCents
        );
        const top = ranked[0] ?? null;
        const excluded = top
          ? run(prints.filter((t) => t.artwork !== top.artwork))
          : null;
        models.push({
          delay,
          cap,
          missFirst,
          entries: result.entries.length,
          lots: result.lots,
          tickers: result.tickers,
          quantity: result.quantity,
          cost: result.cost,
          pendingCost: result.pendingCost,
          net: result.net,
          top,
          withoutTop: excluded && {
            cost: excluded.cost,
            net: excluded.net,
            quantity: excluded.quantity
          }
        });
      }
  return {
    publicExecutions: tape.length,
    groupedExecutions: grouped.length,
    models
  };
}

// Reconstruct only the depth frozen in the original <=95-cent book archive.
// Removing the first unit per ticker represents a competing small buyer.
// Previously attributed units remain reserved if displayed volume reappears.
export function confirmedDepthReplay(lots, checked, competitorUnits) {
  const outcomes = new Map(checked.map((c) => [c.ticker, c.aligned]));
  const books = lots
    .flatMap((l) =>
      l.books.map((b) => ({
        ...b,
        event: l.event,
        artwork: l.sale + '/' + l.lot,
        seenAt: l.seenAt
      }))
    )
    .sort(
      (a, b) =>
        Date.parse(a.at) - Date.parse(b.at) || a.ticker.localeCompare(b.ticker)
    );
  const previous = new Map(),
    held = new Map(),
    entries = [];
  let cash = 1000;
  for (const b of books) {
    if (Date.parse(b.at) < Date.parse(b.seenAt)) continue;
    const sideBook = {
      orderbook_fp: {
        no_dollars: b.levels.map(([price, quantity]) => [
          (1 - price).toFixed(6),
          String(quantity)
        ])
      }
    };
    const prior = previous.get(b.ticker);
    previous.set(b.ticker, { at: b.at, sideBook });
    if (!prior) continue;
    const age = Date.parse(b.at) - Date.parse(prior.at);
    if (age < 1000 || age > 30000) continue;
    const bought = held.get(b.ticker) ?? 0;
    // Source files store asks already normalized to the side implied by the result.
    const r = persistentOffer(
      prior.sideBook,
      sideBook,
      'YES',
      cash,
      bought + competitorUnits
    );
    if (!r) continue;
    const debit = r.quantity * r.price + r.fees;
    cash -= debit;
    held.set(b.ticker, bought + r.quantity);
    const outcome = outcomes.get(b.ticker);
    entries.push({
      ticker: b.ticker,
      artwork: b.artwork,
      firstAt: prior.at,
      at: b.at,
      quantity: r.quantity,
      debit,
      levels: r.levels,
      net:
        typeof outcome === 'boolean' ? (outcome ? r.quantity : 0) - debit : null
    });
  }
  return {
    competitorUnits,
    entries,
    sampled: new Set(lots.flatMap((l) => l.sampled ?? [])).size,
    tickers: held.size,
    quantity: entries.reduce((n, e) => n + e.quantity, 0),
    cost: 1000 - cash,
    net: entries.some((e) => e.net === null)
      ? null
      : entries.reduce((n, e) => n + e.net, 0)
  };
}

async function readTape(lot, m, c) {
  const from = Date.parse(lot.seenAt),
    close = Math.min(Date.parse(m.close_time), Date.now());
  const side = lot.price > c.threshold ? 'yes' : 'no';
  const books = lot.books
    .filter((b) => b.ticker === c.ticker)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const trades = [],
    cursors = new Set(),
    ids = new Set();
  let cursor = '';
  do {
    const qs = new URLSearchParams({
      ticker: c.ticker,
      min_ts: String(Math.floor(from / 1000)),
      max_ts: String(Math.ceil(close / 1000)),
      limit: '1000',
      is_block_trade: 'false'
    });
    if (cursor) qs.set('cursor', cursor);
    const page = await get('/markets/trades?' + qs);
    if (!Array.isArray(page.trades)) throw Error('Missing public trades');
    for (const r of page.trades) {
      if (r.ticker !== c.ticker || !r.trade_id || ids.has(r.trade_id))
        throw Error('Invalid trade identity');
      ids.add(r.trade_id);
      const at = Date.parse(r.created_time),
        price = Number(r[side + '_price_dollars']),
        size = Number(r.count_fp);
      if (!Number.isFinite(at + price + size))
        throw Error('Incomplete public trade');
      if (
        r.is_block_trade !== false ||
        at < from ||
        at >= close ||
        r.taker_outcome_side !== side ||
        r.taker_book_side !== (side === 'yes' ? 'bid' : 'ask') ||
        price <= 0 ||
        price > 1 ||
        size <= 0
      )
        continue;
      const trade = {
        ticker: c.ticker,
        event: lot.event,
        artwork: lot.sale + '/' + lot.lot,
        id: r.trade_id,
        at: r.created_time,
        elapsedMs: (microseconds(r.created_time) - from * 1000) / 1000,
        price,
        size,
        side,
        won:
          m.status === 'finalized' && ['yes', 'no'].includes(m.result)
            ? side === m.result
            : null
      };
      trade.shown = matchBook(books, trade);
      trades.push(trade);
    }
    cursor = page.cursor;
    if (cursor && cursors.has(cursor))
      throw Error('Repeated public trade cursor');
    cursors.add(cursor);
  } while (cursor);
  return trades;
}

async function main() {
  const desktop = process.argv.includes('--desktop');
  const { lots } = JSON.parse(
    await fs.readFile(
      new URL(
        desktop
          ? './auction-desktop-input.json'
          : './auction-replay-input.json',
        import.meta.url
      ),
      'utf8'
    )
  );
  if (desktop) {
    const { auctions } = JSON.parse(
      await fs.readFile(new URL('./watchlist.json', import.meta.url), 'utf8')
    );
    for (const lot of lots) {
      const a = auctions.find((a) =>
        a.targets.some((t) => t.event === lot.event)
      );
      const t = a?.targets.find((t) => t.event === lot.event);
      if (!t || (lot.source !== a.sourceUrl && lot.source !== t.url))
        throw Error('Desktop alert identity mismatch');
      Object.assign(lot, {
        sale: a.sale,
        lot: t.lot,
        books: [],
        contracts: t.markets.map((m) => ({
          ticker: m.ticker,
          threshold: m.threshold,
          rulesHash: createHash('sha256')
            .update(
              [m.primary, m.secondary, m.strikeType, m.threshold].join('\n')
            )
            .digest('hex')
        }))
      });
    }
  }
  const s = (await get('/series/KXART')).series;
  if (s.fee_type !== 'quadratic' || s.fee_multiplier !== 1)
    throw Error('Review fee assumptions');
  const fullTape = [],
    checked = [],
    pending = [];
  for (const lot of lots) {
    const body = await get(
      '/events/' + lot.event + '?with_nested_markets=true'
    );
    if (
      body.event?.event_ticker !== lot.event ||
      !body.event.settlement_sources?.length ||
      !body.event.settlement_sources.every(
        (s) =>
          s.name === 'Artnet' &&
          /(^|\.)artnet\.com$/i.test(new URL(s.url).hostname)
      )
    )
      throw Error('Settlement source changed');
    const markets = body.markets?.length ? body.markets : body.event.markets;
    for (const c of lot.contracts) {
      const m = markets.find((x) => x.ticker === c.ticker);
      if (
        !m ||
        m.event_ticker !== lot.event ||
        m.market_type !== 'binary' ||
        m.strike_type !== 'greater' ||
        Number(m.notional_value_dollars) !== 1 ||
        m.floor_strike !== c.threshold ||
        createHash('sha256')
          .update(
            [
              m.rules_primary,
              m.rules_secondary,
              m.strike_type,
              m.floor_strike
            ].join('\n')
          )
          .digest('hex') !== c.rulesHash
      )
        throw Error('Market rules or final result need review: ' + c.ticker);
      if (m.status !== 'finalized' || !['yes', 'no'].includes(m.result)) {
        pending.push({ ticker: c.ticker, event: lot.event, status: m.status });
      } else {
        checked.push({
          ticker: c.ticker,
          aligned: (lot.price > c.threshold ? 'yes' : 'no') === m.result
        });
      }
      fullTape.push(...(await readTape(lot, m, c)));
    }
  }
  const trades = fullTape.filter((t) => t.price <= 0.95);
  trades.sort(
    (a, b) =>
      microseconds(a.at) - microseconds(b.at) || a.id.localeCompare(b.id)
  );
  const models = [];
  for (const delay of [0, 5, 30, 60, 300])
    for (const max of [1, 5, 1000])
      for (const book of desktop ? [false] : [false, true])
        models.push({
          delay,
          max,
          book,
          ...simulate(trades, max, delay * 1000, book)
        });
  const result = {
    at: new Date().toISOString(),
    checked,
    pending,
    trades,
    models,
    repeated: repeatStudy(trades),
    additionalTrades: fullTape.filter((t) => t.price > 0.95),
    priceSensitivity: priceSensitivity(fullTape),
    confirmedDepth: desktop
      ? null
      : [0, 1].map((units) => confirmedDepthReplay(lots, checked, units))
  };
  const dir = new URL('./runtime/', import.meta.url);
  await fs.mkdir(dir, { recursive: true });
  const file = desktop
    ? 'auction-desktop-replay.json'
    : 'auction-tape-replay.json';
  const tmp = new URL(file + '.' + process.pid + '.tmp', dir);
  await fs.writeFile(tmp, JSON.stringify(result));
  await fs.rename(tmp, new URL(file, dir));
  console.log(
    'Settled contracts',
    checked.length,
    'pending',
    pending.length,
    'aligned',
    checked.filter((x) => x.aligned).length,
    'eligible public trades',
    trades.length
  );
  console.table(
    models
      .filter((m) => m.max === 5)
      .map(({ delay, book, entries, lots, quantity, cost, net }) => ({
        delay,
        book,
        contracts: entries.length,
        lots,
        quantity,
        cost,
        net
      }))
  );
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main();
