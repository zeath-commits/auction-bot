import {
  persistentOffer,
  auctionDepthCash,
  affordableLevel
} from './late-auction.mjs';
import { addPaper } from './strategy-monitor.mjs';
import { checkFees, checkMarketActive } from './core.mjs';
import { offerSide } from './watch-offers.mjs';

const strategy = 'sothebys_sold';
export function initSoldStudy(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS sothebys_sold_books(ticker TEXT, at INTEGER, detail TEXT NOT NULL, PRIMARY KEY(ticker,at)); CREATE TABLE IF NOT EXISTS sothebys_sold_entries(id TEXT PRIMARY KEY, amount INTEGER, detail TEXT NOT NULL)'
  );
}

// Use the result shown with buyer's premium on two distinct catalog generations.
export function recordSoldBooks(db, quotes, previous, maxGapMs) {
  let entries = 0,
    contracts = 0;
  const levels = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const q of quotes) {
      db.prepare('INSERT OR IGNORE INTO sothebys_sold_books VALUES(?,?,?)').run(
        q.ticker,
        q.at,
        JSON.stringify(q)
      );
      const p = previous.get(q.ticker);
      if (
        !p ||
        !Number.isSafeInteger(q.amount) ||
        q.amount <= 0 ||
        p.amount !== q.amount ||
        p.side !== q.side ||
        p.generation >= q.generation ||
        q.at - p.at < 1000 ||
        q.at - p.at > maxGapMs
      )
        continue;
      const prior = db
        .prepare(
          'SELECT p.quantity,p.side,p.payout,e.amount FROM paper p LEFT JOIN sothebys_sold_entries e USING(id) WHERE p.strategy=? AND p.ticker=?'
        )
        .all(strategy, q.ticker);
      if (
        prior.some(
          (r) =>
            r.payout !== null ||
            r.side !== q.side.toLowerCase() ||
            r.amount !== q.amount
        )
      )
        continue;
      const held = prior.reduce((sum, r) => sum + r.quantity, 0);
      const available = persistentOffer(p.book, q.book, q.side, Infinity, held);
      if (available)
        for (const l of available.levels)
          levels.push({ p, q, l, held, depth: available.displayed });
    }
    // Allocate cash across simultaneously observed thresholds, cheapest units first.
    let cash = auctionDepthCash(db);
    for (const { p, q, l, held, depth } of levels.sort(
      (a, b) => a.l.price - b.l.price || a.q.ticker.localeCompare(b.q.ticker)
    )) {
      const fill = affordableLevel(l.price, l.quantity, cash);
      if (!fill) continue;
      const id = [strategy, q.ticker, q.at, l.price].join('/');
      const seen = db.prepare('SELECT 1 FROM paper WHERE id=?').get(id);
      if (seen) continue;
      addPaper(db, {
        id,
        strategy,
        ticker: q.ticker,
        side: q.side.toLowerCase(),
        at: new Date(q.at).toISOString(),
        quantity: fill.quantity,
        price: l.price,
        fees: fill.fee,
        depth,
        closeAt: q.closeAt
      });
      db.prepare('INSERT INTO sothebys_sold_entries VALUES(?,?,?)').run(
        id,
        q.amount,
        JSON.stringify({
          first: p.at,
          second: q.at,
          source: q.url,
          held,
          depth,
          level: l.price
        })
      );
      cash -= fill.quantity * l.price + fill.fee;
      entries++;
      contracts += fill.quantity;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { entries, contracts };
}

export async function scanSold({
  db,
  io,
  source,
  targets,
  marketList,
  previous,
  stop,
  tail,
  deadline
}) {
  const sold = source.soldFresh
    ? source.lots.filter(
        (l) => Number.isSafeInteger(l.salePrice) && l.salePrice > 0
      )
    : [];
  const quotes = [],
    eligible = [];
  for (const lot of sold) {
    const target = targets.find((t) => t.event === lot.event);
    const markets = await marketList(io, target);
    for (const m of markets) {
      if (!checkMarketActive(m, Date.now()) || m.strike_type !== 'greater')
        continue;
      const side = offerSide(
        { kind: 'published_sale', amount: lot.salePrice },
        m.floor_strike
      );
      if (side) eligible.push({ m, side, lot, target });
    }
  }
  if (eligible.length) {
    checkFees((await io.get('/series/KXART')).body);
    const ex = (await io.get('/exchange/status')).body;
    if (ex.trading_active && ex.exchange_active) {
      const query = new URLSearchParams(
        eligible.map(({ m }) => ['tickers', m.ticker])
      );
      query.set('depth', '100');
      const read = await io.get('/markets/orderbooks?' + query);
      const books = new Map(read.body.orderbooks.map((b) => [b.ticker, b]));
      if (
        books.size !== eligible.length ||
        eligible.some(({ m }) => !books.has(m.ticker))
      )
        throw Error('Incomplete sold-price order books');
      if (
        read.receivedAt - source.at <= 5000 &&
        read.receivedAt - read.requestedAt <= 2000 &&
        Date.now() < deadline &&
        !stop()
      ) {
        for (const { m, side, lot, target } of eligible) {
          if (!checkMarketActive(m, Date.now())) continue;
          quotes.push({
            ticker: m.ticker,
            at: read.receivedAt,
            amount: lot.salePrice,
            side,
            generation: source.generation,
            sourceAt: source.at,
            sourceCacheAgeSeconds: source.age,
            url: target.url,
            closeAt: Date.parse(m.close_time),
            book: books.get(m.ticker)
          });
        }
      }
    }
  }
  const added = recordSoldBooks(db, quotes, previous, tail ? 95000 : 30000);
  return {
    next: new Map(quotes.map((q) => [q.ticker, q])),
    status: { published: sold.length, books: quotes.length, ...added }
  };
}
