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
    function levels(side) {
      return askLevels(book,side,99).filter(l=>l.quantity>=1000000)
        .map(l=>[l.price,Math.floor(l.quantity/1000000)]);
    }
    const depth = {yes:levels('YES'),no:levels('NO')};
    const best = rows => rows.length ? {price:rows[0][0]/1000000,size:rows[0][1]} : null;
    return {event:m.event_ticker,ticker:m.ticker,strike:m.floor_strike,yes:best(depth.yes),no:best(depth.no),depth};
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
  const windowBooks = db.prepare('SELECT at,asOf,detail FROM auction_quote_batches WHERE begin BETWEEN ? AND ? AND asOf>=? AND at<=? ORDER BY at');
  db.exec('CREATE TABLE IF NOT EXISTS auction_presale_depth(event TEXT PRIMARY KEY,at INTEGER NOT NULL,detail TEXT NOT NULL)');
  const baseline = db.prepare('SELECT at,detail FROM auction_presale_depth WHERE event=? AND at<?');
  const saveBaseline = db.prepare('INSERT OR IGNORE INTO auction_presale_depth VALUES(?,?,?)');
  function describe(batch, event, price, anchor, reference) {
    if (!batch) return null;
    const rows = JSON.parse(batch.detail).filter(r => r.event === event);
    if (!rows.length) return null;
    const offers = rows.map(r => price > r.strike ? r.yes : r.no).filter(Boolean);
    let depth95 = null;
    if (rows.every(r=>r.depth)) {
      let shares=0,overlap=0,matched=0;
      for (const r of rows) {
        const side=price>r.strike?'yes':'no';
        const original=reference?.get(r.ticker);
        const previous=new Map(original?.strike===r.strike ? original.depth[side] : []);
        if (original?.strike===r.strike) matched++;
        for (const [p,n] of r.depth[side]) {
          if (p>950000) continue;
          shares+=n;
          overlap+=Math.min(n,previous.get(p)??0);
        }
      }
      depth95={shares,overlap:matched===rows.length ? overlap : null};
    }
    return {lagMs:batch.at-anchor, checked:rows.length, quoted:offers.length,depth95,
      best:offers.length ? Math.min(...offers.map(o => o.price)) : null};
  }
  return {
    laterOffers(event, confirmedAt, price) {
      const end = confirmedAt + 900000;
      const samples = windowBooks.iterate(confirmedAt,end,confirmedAt,end);
      let firstAt = null, previous = null, pairs = 0;
      const initiallyEmpty = new Map(), found = new Map();
      for (const sample of samples) {
        const rows = JSON.parse(sample.detail).filter(r => r.event === event && r.depth);
        if (!rows.length) { previous = null; continue; }
        if (firstAt === null) {
          if (sample.at - confirmedAt > 12000) break;
          firstAt = sample.at;
          for (const r of rows) {
            const side = price > r.strike ? 'yes' : 'no';
            if (!r.depth[side].some(([p,n])=>p<=950000 && n>=1)) initiallyEmpty.set(r.ticker,{side,strike:r.strike});
          }
          continue;
        }
        if (sample.asOf < confirmedAt + 30000) continue;
        const current = new Map();
        for (const r of rows) {
          const initial = initiallyEmpty.get(r.ticker);
          if (initial && initial.strike === r.strike)
            current.set(r.ticker,new Map(r.depth[initial.side].filter(([p,n])=>p<=950000 && n>=1)));
        }
        if (previous && sample.asOf > previous.at && sample.at - previous.at <= 12000) {
          pairs++;
          for (const [ticker,levels] of current) {
            if (found.has(ticker)) continue;
            const prior = previous.levels.get(ticker);
            for (const [p,n] of levels) {
              const size = Math.min(n,prior?.get(p) ?? 0);
              if (size < 1) continue;
              found.set(ticker,{ticker,...initiallyEmpty.get(ticker),at:sample.at,price:p/1000000,size});
              break;
            }
          }
        }
        previous = {at:sample.at,levels:current};
      }
      return {confirmedAt,firstAt,initiallyEmpty:initiallyEmpty.size,pairs,found:[...found.values()]};
    },
    recordBaseline(event,at,rows) {
      if (rows.length && rows.every(r=>r.event===event && r.depth)) saveBaseline.run(event,at,JSON.stringify(rows));
    },
    record: sample => insert.run(sample.at,sample.begin,JSON.stringify(sample.rows),sample.asOf),
    compare(event, at, price) {
      const base=baseline.get(event,at);
      const reference=base && new Map(JSON.parse(base.detail).map(r=>[r.ticker,r]));
      const baselineShares=reference ? [...reference.values()].reduce((sum,r)=>
        sum+r.depth[price>r.strike?'yes':'no'].reduce((n,[p,q])=>n+(p<=950000?q:0),0),0) : null;
      const pre = before.get(at,at-12000);
      const post = delay => describe(after.get(at+delay,at+delay,at+delay+12000),event,price,at,reference);
      return {baselineAt:base?.at??null,baselineShares,before:describe(pre,event,price,at,reference), after:post(0), after30:post(30000), after300:post(300000)};
    }
  };
}

export async function observeAuctionQuotes({db,io,calendar,marketList,stop,status,timing}) {
  const store = quoteTiming(db);
  const start = Date.parse(calendar.start), end = Date.parse(calendar.end) + 912000;
  let markets = [], refresh = 0, preflight = false;
  const later = new Map();
  function summarize() {
    status.comparison = timing.summary().flatMap(r => {
      const first = [r.lot,r.catalog].filter(Boolean).sort((a,b)=>a.at-b.at)[0];
      if (!first) return [];
      if (r.lot && r.catalog && (!r.matched || r.lot.price !== r.catalog.price))
        return [{title:r.title,conflict:true}];
      let followup = null;
      if (r.matched) {
        const confirmedAt = Math.max(r.catalog.at,r.lot.at);
        const cached = later.get(r.event), now = Date.now();
        if (!cached || (cached.at < confirmedAt+900000 && now-cached.at >= 15000)) {
          later.set(r.event,{at:now,value:store.laterOffers(r.event,confirmedAt,first.price)});
        }
        followup = later.get(r.event).value;
      }
      return [{title:r.title, followup, ...store.compare(r.event,first.at,first.price)}];
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
        if (sample.at<start) {
          for (const target of calendar.targets) {
            const rows=sample.rows.filter(r=>r.event===target.event);
            if (rows.length===target.contracts) store.recordBaseline(target.event,sample.at,rows);
          }
        }
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
