import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { API } from './transport.mjs';

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

export function simulate(trades, maxPerTicker, delayMs, requireBook) {
  const used = new Set(),
    entries = [];
  let cash = 100000,
    payout = 0,
    unsettled = 0;
  for (const t of trades) {
    if (used.has(t.ticker) || t.elapsedMs < delayMs) continue;
    let quantity = Math.min(
      maxPerTicker,
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
    cash -= debit;
    payout += t.won ? quantity * 100 : 0;
    if (t.won == null) unsettled += debit;
    used.add(t.ticker);
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
    lots: new Set(entries.map((e) => e.artwork)).size,
    quantity: entries.reduce((n, e) => n + e.quantity, 0),
    cost: (100000 - cash) / 100,
    pendingCost: unsettled / 100,
    net: unsettled ? null : (payout + cash - 100000) / 100
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
        price > 0.95 ||
        size < 1
      )
        continue;
      const trade = {
        ticker: c.ticker,
        event: lot.event,
        artwork: lot.sale + '/' + lot.lot,
        id: r.trade_id,
        at: r.created_time,
        elapsedMs: at - from,
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
  const trades = [],
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
      trades.push(...(await readTape(lot, m, c)));
    }
  }
  trades.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
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
    models
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
