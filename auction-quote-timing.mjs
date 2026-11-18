import { setTimeout as sleep } from 'node:timers/promises';
import { askLevels, checkMarketActive } from './core.mjs';

// Save both sides before learning the price. A market without a whole
// contract on one side is a usable observation with an empty ask.
export async function captureAuctionQuotes(io, markets) {
  const active = markets.filter(m => checkMarketActive(m, Date.now()));
  if (!active.length) return null;
  const q = new URLSearchParams(active.map(m => ['tickers', m.ticker]));
  q.set('depth', '100');
  const read = await io.get('/markets/orderbooks?' + q);
  if (read.receivedAt - read.requestedAt > 2000) throw Error('Slow auction quote response');
  const serverDate = Date.parse(read.httpDate);
  const age = Number(read.cacheAge ?? 0);
  if (!Number.isFinite(serverDate) || !Number.isInteger(age) || age < 0 || age > 2 ||
      serverDate > read.receivedAt + 1000 || serverDate < read.receivedAt - 4000)
    throw Error('Auction quote response has an uncertain timestamp');
  // Allow one second for header precision and clock differences. A cached
  // response crossing the publication time cannot count as a later sample.
  const asOf = Math.min(read.requestedAt,serverDate-1000,read.receivedAt-(age+1)*1000);
  const books = new Map(read.body.orderbooks.map(b => [b.ticker,b]));
  if (books.size !== active.length || books.size !== read.body.orderbooks.length)
    throw Error('Incomplete auction quote batch');
  const rows = active.filter(m => checkMarketActive(m,read.receivedAt)).map(m => {
    const book = books.get(m.ticker);
    if (!book) throw Error('Missing auction book ' + m.ticker);
    function best(side) {
      const level = askLevels(book, side, 99).find(l => l.quantity >= 1000000);
      return level ? {price:level.price/1000000, size:Math.floor(level.quantity/1000000)} : null;
    }
    return {event:m.event_ticker,ticker:m.ticker,strike:m.floor_strike,yes:best('YES'),no:best('NO')};
  });
  return {begin:read.requestedAt, at:read.receivedAt, asOf, rows};
}

export function quoteTiming(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_quote_batches(at INTEGER PRIMARY KEY,begin INTEGER NOT NULL,detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS auction_quote_batches_begin ON auction_quote_batches(begin)`);
  if (!db.prepare('PRAGMA table_info(auction_quote_batches)').all().some(c=>c.name==='asOf'))
    db.exec('ALTER TABLE auction_quote_batches ADD COLUMN asOf INTEGER');
  const insert = db.prepare('INSERT OR IGNORE INTO auction_quote_batches(at,begin,detail,asOf) VALUES(?,?,?,?)');
  const before = db.prepare('SELECT * FROM auction_quote_batches WHERE at<? AND at>=? ORDER BY at DESC LIMIT 1');
  const after = db.prepare('SELECT * FROM auction_quote_batches WHERE begin>=? AND asOf>=? AND at<=? ORDER BY begin LIMIT 1');
  function describe(batch, event, price, anchor) {
    if (!batch) return null;
    const rows = JSON.parse(batch.detail).filter(r => r.event === event);
    if (!rows.length) return null;
    const offers = rows.map(r => price > r.strike ? r.yes : r.no).filter(Boolean);
    return {lagMs:batch.at-anchor, checked:rows.length, quoted:offers.length,
      best:offers.length ? Math.min(...offers.map(o => o.price)) : null};
  }
  return {
    record: sample => insert.run(sample.at,sample.begin,JSON.stringify(sample.rows),sample.asOf),
    compare(event, at, price) {
      const pre = before.get(at,at-12000);
      const post = delay => describe(after.get(at+delay,at+delay,at+delay+12000),event,price,at);
      return {before:describe(pre,event,price,at), after:post(0), after30:post(30000), after300:post(300000)};
    }
  };
}

export async function observeAuctionQuotes({db,io,calendar,marketList,stop,status,timing}) {
  const store = quoteTiming(db);
  const start = Date.parse(calendar.start), end = Date.parse(calendar.end) + 312000;
  let markets = [], refresh = 0, preflight = false;
  function summarize() {
    status.comparison = timing.summary().flatMap(r => {
      const first = [r.lot,r.catalog].filter(Boolean).sort((a,b)=>a.at-b.at)[0];
      if (!first) return [];
      if (r.lot && r.catalog && (!r.matched || r.lot.price !== r.catalog.price))
        return [{title:r.title,conflict:true}];
      return [{title:r.title, ...store.compare(r.event,first.at,first.price)}];
    });
  }
  summarize();
  while (!stop() && Date.now() <= end) {
    if (Date.now() < start && preflight) {
      await sleep(Math.min(60000,start-Date.now()));
      continue;
    }
    try {
      if (Date.now() >= refresh) {
        markets = (await Promise.all(calendar.targets.map(t=>marketList(io,t)))).flat();
        refresh = Date.now() + 60000;
      }
      const sample = await captureAuctionQuotes(io,markets);
      if (sample && !stop()) {
        store.record(sample);
        status.at = sample.at;
        status.checked = sample.rows.length;
      }
      status.error = null;
      preflight = true;
      summarize();
    } catch (e) {
      status.error = e.message;
    }
    await sleep(status.error ? 15000 : 5000);
  }
  summarize();
}
