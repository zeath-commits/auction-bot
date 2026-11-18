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
export function recordSoldBooks(
  db,
  quotes,
  previous,
  maxGapMs,
  comparisonCap = null
) {
  let entries = 0,
    contracts = 0;
  const levels = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const q of quotes) {
      if (comparisonCap === null)
        db.prepare(
          'INSERT OR IGNORE INTO sothebys_sold_books VALUES(?,?,?)'
        ).run(q.ticker, q.at, JSON.stringify(q));
      const p = previous.get(q.ticker);
      if (
        !p ||
        !Number.isSafeInteger(q.amount) ||
        q.amount <= 0 ||
        p.amount !== q.amount ||
        p.side !== q.side ||
        (q.sourceKind === 'lot' && !(p.sourceKind === 'lot' &&
          q.bookAsOf > p.bookAsOf && q.bookAsOf >= p.sourceAt)) ||
        !(q.generation - p.generation >= 2000) ||
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
      const available = persistentOffer(
        p.book,
        q.book,
        q.side,
        Infinity,
        held,
        comparisonCap ?? 99
      );
      if (available)
        for (const l of available.levels)
          levels.push({ p, q, l, held, depth: available.displayed });
    }
    // Allocate cash across simultaneously observed thresholds, cheapest units first.
    let cash =
      comparisonCap === null
        ? auctionDepthCash(db)
        : 1000 -
          db
            .prepare(
              'SELECT COALESCE(SUM(price*quantity+fees),0) AS total FROM paper'
            )
            .get().total;
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
          sourceKind: q.sourceKind ?? 'catalog',
          firstSourceAt: p.sourceAt,
          secondSourceAt: q.sourceAt,
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
  deadline,
  accept = () => true
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
      const bookAsOf=Date.parse(read.httpDate)-1000*Number(read.cacheAge??0);
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
          if (source.kind==='lot' && !(read.requestedAt>=source.at &&
            bookAsOf>=read.receivedAt-3500 && bookAsOf<=read.receivedAt+1000)) continue;
          quotes.push({
            ticker: m.ticker,
            event: lot.event,
            at: read.receivedAt,
            amount: lot.salePrice,
            side,
            generation: source.generation,
            sourceAt: source.at,
            bookAsOf: Number.isFinite(bookAsOf) ? bookAsOf : null,
            sourceCacheAgeSeconds: source.age,
            url: source.url ?? target.url,
            sourceKind: source.kind ?? 'catalog',
            closeAt: Date.parse(m.close_time),
            book: books.get(m.ticker)
          });
        }
      }
    }
  }
  const accepted=quotes.filter(q=>accept(q.event,q.amount));
  const added = recordSoldBooks(db, accepted, previous, tail ? 95000 : 30000);
  return {
    next: new Map(accepted.map((q) => [q.ticker, q])),
    status: { published: sold.length, books: accepted.length, ...added }
  };
}

// A published result on either official page can contradict the other page.
// Preserve the latest dated, explicit verdict per source, including an unsold verdict.
export function publishedVerdicts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sothebys_verdicts(event TEXT,kind TEXT,generation INTEGER,at INTEGER,
    amount INTEGER,PRIMARY KEY(event,kind))`);
  const write=db.prepare(`INSERT INTO sothebys_verdicts VALUES(?,?,?,?,?) ON CONFLICT(event,kind) DO UPDATE SET
    generation=excluded.generation,at=excluded.at,amount=excluded.amount WHERE excluded.generation>sothebys_verdicts.generation
    OR (excluded.generation=sothebys_verdicts.generation AND excluded.at>sothebys_verdicts.at)`);
  const conflicting=db.prepare('SELECT 1 FROM sothebys_verdicts WHERE event=? AND amount<>? LIMIT 1');
  return {
    record(kind,read) {
      if (!read.soldFresh || !Number.isFinite(read.generation)) return;
      for (const lot of read.lots) {
        const noSale=lot.explicitUnsold || lot.withdrawn==='Withdrawn';
        const amount=noSale ? 0 : lot.salePrice;
        if (Number.isSafeInteger(amount) && (amount>0 || noSale))
          write.run(lot.event,kind,read.generation,read.at,amount);
      }
    },
    accepts:(event,amount)=>!conflicting.get(event,amount),
    conflicts:()=>new Set(db.prepare('SELECT event FROM sothebys_verdicts GROUP BY event HAVING MIN(amount)<>MAX(amount)').all().map(r=>r.event))
  };
}
