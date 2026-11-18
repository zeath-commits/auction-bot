import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import calendar from './sothebys-bid-calendar.json' with { type: 'json' };
import { askLevels, checkFees, checkMarketActive } from './core.mjs';
import { marketList } from './sothebys-bids.mjs';
import { addPaper } from './strategy-monitor.mjs';
import { Transport } from './transport.mjs';

const strategy = 'art_record_pair';
const annualEvent = 'KXAUCTIONRECORD-27-VIN';
const annualTicker = annualEvent + '-117180000';
const target = calendar.targets.find(t => t.event === 'KXART-VANCHAT18NOV26');
const budget = 1000;

export function recordMarkets(event, lots, now) {
  const annual = event.markets?.find(m => m.ticker === annualTicker);
  if (event.event_ticker !== annualEvent || event.series_ticker !== 'KXAUCTIONRECORD' || !annual)
    throw Error('Annual Van Gogh contract unavailable');
  const fingerprint = createHash('sha256').update(JSON.stringify([event.settlement_sources,
    annual.ticker, annual.rules_primary, annual.rules_secondary, annual.floor_strike,
    annual.strike_type, annual.market_type, annual.notional_value_dollars])).digest('hex');
  if (fingerprint !== '9c03fd44554a6bf718d3d233630a36322f37814318ddd8700009326efb4f9afe' ||
      event.fee_type_override != null || event.fee_multiplier_override != null)
    throw Error('Annual record terms or fees changed');
  if (!checkMarketActive(annual, now)) return [];
  return [annual,...lots.filter(m => m.event_ticker === target.event && m.floor_strike >= annual.floor_strike &&
    checkMarketActive(m, now))];
}

export function pairedLevels(markets, first, second, prior, cash) {
  // Each price level can be used only up to its displayed size less all previous
  // simulated purchases at that price. The annual YES book is shared by every lot strike.
  function available(m, side) {
    const levels = book => {
      const b = book.find(x => x.ticker === m.ticker);
      if (!b) throw Error('Missing Van Gogh book');
      return new Map(askLevels(b, side, 99).map(l => [l.price, Math.floor(l.quantity / 1e6)]));
    };
    const a = levels(first), b = levels(second);
    return [...b].map(([p,n]) => {
      const depth = Math.min(a.get(p) ?? 0, n);
      return {market:m,price:p/1e6,depth,left:depth-(prior.get(m.ticker+'/'+p) ?? 0)};
    }).filter(x => x.left > 0);
  }
  const [annual,...lots] = markets;
  if (!annual || !lots.length) return [];
  const yes = available(annual,'YES');
  const no = lots.flatMap(m => available(m,'NO')).sort((a,b) => a.price-b.price || b.market.floor_strike-a.market.floor_strike);
  const fee = (n,p) => Math.ceil(7*n*p*(1-p)-1e-9)/100;
  const pairs = [];
  let i=0, j=0;
  while (i<yes.length && j<no.length) {
    const a=yes[i], b=no[j], principal=a.price+b.price;
    if (principal >= 1) break;
    let n=Math.min(a.left,b.left,Math.floor(cash/principal));
    const cost = q => q*principal+fee(q,a.price)+fee(q,b.price);
    while (n>0 && cost(n)>cash+1e-9) n--;
    if (!n) break;
    if (cost(n) >= n-1e-9) {
      // A tiny level may fail whole-cent fee rounding. Another price level can have more depth.
      if (a.left<=b.left) i++; else j++;
      continue;
    }
    pairs.push({annual:a.market.ticker,lot:b.market.ticker,n,
      yes:{price:a.price,fees:fee(n,a.price),depth:a.depth},
      no:{price:b.price,fees:fee(n,b.price),depth:b.depth},cost:cost(n)});
    cash-=cost(n);
    if ((a.left-=n)===0) i++;
    if ((b.left-=n)===0) j++;
  }
  return pairs;
}

// At the original price levels, test the original allocation only. Reuse of a
// level across multiple lot strikes or older paper entries consumes its depth.
export function remainingPairs(pairs, books, used) {
  const available=new Map();
  for (const book of books) {
    const side=pairs.some(p=>p.annual===book.ticker) ? 'YES' : 'NO';
    for (const level of askLevels(book,side,99)) {
      const key=book.ticker+'/'+level.price;
      available.set(key,Math.max(0,Math.floor(level.quantity/1e6)-(used.get(key)??0)));
    }
  }
  let count=0;
  for (const p of pairs) {
    const a=p.annual+'/'+Math.round(p.yes.price*1e6), b=p.lot+'/'+Math.round(p.no.price*1e6);
    const qty=Math.min(p.n,available.get(a)??0,available.get(b)??0);
    if (qty) {
      available.set(a,available.get(a)-qty);
      available.set(b,available.get(b)-qty);
      count+=qty;
    }
  }
  return count;
}

export async function observeRecordPair({db,config,stop,status}) {
  const io = new Transport({...config,maxHttpAgeSeconds:1,requestTimeoutMs:2500});
  db.exec('CREATE TABLE IF NOT EXISTS art_record_pair_books(at INTEGER PRIMARY KEY, firstBook TEXT NOT NULL, secondBook TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS art_record_delays(entryAt INTEGER,seconds INTEGER,requested INTEGER,checked INTEGER,available INTEGER,detail TEXT,PRIMARY KEY(entryAt,seconds))');
  const inventory = db.prepare('SELECT ticker,price,SUM(quantity) AS qty,SUM(quantity*price+fees) AS cost FROM paper WHERE strategy=? GROUP BY ticker,price');
  // The reviewed lot closes no later than the end of the settlement watch.
  while (!stop() && Date.now()<Date.parse(calendar.settlementWatchEnd)) {
    const began=Date.now();
    try {
      const [event,lots,annualFees,lotFees,exchange]=await Promise.all([
        io.get('/events/'+annualEvent+'?with_nested_markets=true'),marketList(io,target),
        io.get('/series/KXAUCTIONRECORD'),io.get('/series/KXART'),io.get('/exchange/status')]);
      checkFees(lotFees.body);
      const f=annualFees.body.series;
      if (f?.ticker!=='KXAUCTIONRECORD' || f.fee_type!=='quadratic' || f.fee_multiplier!==1)
        throw Error('Annual fee schedule changed');
      const markets=recordMarkets(event.body.event,lots,Date.now());
      status.strikes=Math.max(0,markets.length-1);
      status.added=0;
      if (markets.length>1 && exchange.body.exchange_active && exchange.body.trading_active) {
        const q=new URLSearchParams(markets.map(m=>['tickers',m.ticker]));
        q.set('depth','100');
        const read = async () => {
          const r=await io.get('/markets/orderbooks?'+q);
          const date=Date.parse(r.httpDate);
          if (r.receivedAt-r.requestedAt>1800 || !(date>=r.receivedAt-3000 && date<=r.receivedAt+1500) ||
              r.body.orderbooks.length!==markets.length || markets.some(m=>!r.body.orderbooks.some(b=>b.ticker===m.ticker)))
            throw Error('Stale or incomplete paired order books');
          return r;
        };
        const a=await read();
        await sleep(1250);
        const b=await read();
        if (!stop() && markets.every(m=>checkMarketActive(m,b.receivedAt)) &&
            Date.parse(b.httpDate)-Number(b.cacheAge??0)*1000>Date.parse(a.httpDate)-Number(a.cacheAge??0)*1000) {
          db.exec('BEGIN IMMEDIATE');
          let pairs,used;
          try {
            const existing=inventory.all(strategy);
            used=new Map(existing.map(r=>[r.ticker+'/'+Math.round(r.price*1e6),r.qty]));
            const cash=budget-existing.reduce((s,r)=>s+r.cost,0);
            pairs=pairedLevels(markets,a.body.orderbooks,b.body.orderbooks,used,cash);
            if (pairs.length) {
              const evidence = read => JSON.stringify({requested:read.requestedAt,received:read.receivedAt,
                date:read.httpDate,age:read.cacheAge,books:read.body.orderbooks});
              db.prepare('INSERT INTO art_record_pair_books VALUES(?,?,?)').run(b.receivedAt,evidence(a),evidence(b));
              const planned=pairs.reduce((sum,p)=>sum+p.n,0);
              for (const seconds of [5,30]) db.prepare('INSERT INTO art_record_delays(entryAt,seconds,requested) VALUES(?,?,?)')
                .run(b.receivedAt,seconds,planned);
            }
            for (const [index,p] of pairs.entries()) {
              const id=strategy+'/'+b.receivedAt+'/'+index+'/';
              for (const side of ['yes','no']) {
                const ticker=side==='yes'?p.annual:p.lot;
                addPaper(db,{id:id+side,strategy,ticker,side,quantity:p.n,...p[side],
                  at:new Date(b.receivedAt).toISOString(),closeAt:Date.parse(markets.find(m=>m.ticker===ticker).close_time)});
              }
            }
            db.exec('COMMIT');
            status.added=pairs.reduce((s,p)=>s+p.n,0);
          } catch(e) {db.exec('ROLLBACK');throw e;}
          if (pairs.length) for (const seconds of [5,30]) {
            const due=b.receivedAt+seconds*1000;
            await sleep(Math.max(0,due-Date.now()));
            if(stop()) return;
            let available=null,detail;
            try {
              const delayed=await read();
              const generation=Date.parse(delayed.httpDate)-Number(delayed.cacheAge??0)*1000;
              if(delayed.receivedAt>due+2500 || generation<due-1000 ||
                 !markets.every(m=>checkMarketActive(m,delayed.receivedAt)))
                throw Error('Outside delayed quote window');
              available=remainingPairs(pairs,delayed.body.orderbooks,used);
              detail=JSON.stringify({requestedAt:delayed.requestedAt,receivedAt:delayed.receivedAt,
                books:delayed.body.orderbooks});
            } catch(e) {detail=e.message;}
            db.prepare('UPDATE art_record_delays SET checked=?,available=?,detail=? WHERE entryAt=? AND seconds=?')
              .run(Date.now(),available,detail,b.receivedAt,seconds);
          }
        }
      }
      status.error=null;
    } catch(e) {status.error=e.message;}
    status.at=new Date().toISOString();
    await sleep(Math.max(1000,30000-(Date.now()-began)));
  }
}
