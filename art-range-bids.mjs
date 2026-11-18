import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import calendar from './sothebys-bid-calendar.json' with { type: 'json' };
import { marketList } from './sothebys-bids.mjs';
import { captureAuctionQuotes } from './auction-quote-timing.mjs';
import { checkFees } from './core.mjs';
import { Transport } from './transport.mjs';
import { addPaper } from './strategy-monitor.mjs';

const quantity = 5;
const strategy = 'art_range_bids';
const end = Date.parse(calendar.scheduled);
const targets = [
  { lot:'9', slug:'paul-cezannes-arlequin-sale-price', hash:'ed99ddf98c48ed3d74ebcd2038c3dd6991847a8a8697e63251880abc733eff02' },
  { lot:'5', slug:'van-gogh-chataigniers-en-fleurs-sale-price', hash:'b90e0ccf776502d77c81d2ef8b488787cadb9387d12421e33b94430d9ed2e5f3' }
];

async function publicJSON(url,maxAge=2) {
  const r = await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000)});
  if (!r.ok) throw Error('Polymarket public data HTTP '+r.status);
  if (Number(r.headers.get('age') ?? 0)>maxAge) throw Error('Cached international market data');
  return r.json();
}

async function ranges(target) {
  // Listing metadata is cached for five minutes. Tradable prices come from separate time-stamped books.
  const e=await publicJSON('https://gamma-api.polymarket.com/events/slug/'+target.slug,300);
  if(e.slug!==target.slug || !e.active || e.closed || !e.negRisk || !e.markets?.length ||
      e.markets.some(m=>!m.active || m.closed || !m.negRisk || !m.acceptingOrders || !m.enableOrderBook))
    throw Error('Range markets unavailable');
  const rules=e.markets.map(m=>[m.groupItemTitle,m.description,m.conditionId,m.clobTokenIds,m.outcomes,m.negRiskMarketID])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  if(createHash('sha256').update(JSON.stringify(rules)).digest('hex')!==target.hash)
    throw Error('Range rules or outcome tokens changed');
  return e.markets.map(m=>({label:m.groupItemTitle, floor:Number(m.groupItemTitle.match(/^\$(\d+)m/i)?.[1] ?? 0)*1e6,
    token:JSON.parse(m.clobTokenIds)[JSON.parse(m.outcomes).indexOf('Yes')], condition:m.conditionId}));
}

async function bidAtSize(bucket) {
  const b=await publicJSON('https://clob.polymarket.com/book?token_id='+bucket.token);
  if (b.asset_id!==bucket.token || b.market!==bucket.condition || !Array.isArray(b.bids))
    throw Error('Wrong range book');
  const bids=b.bids.map(l=>({price:Number(l.price),size:Number(l.size)})).sort((a,b)=>b.price-a.price);
  if(bids.some(l=>!(l.price>0 && l.price<1 && l.size>0 && Number.isFinite(l.size)))) throw Error('Invalid range bid');
  let size=0;
  const bid=bids.find(l=>(size+=l.size)>=quantity)?.price ?? 0;
  return {label:bucket.label,floor:bucket.floor,bid,observed:Number(b.timestamp),size};
}

export function rangeSignals(buckets,quotes,at) {
  const fresh=buckets.filter(b=>Number.isFinite(b.observed) && b.observed>=at-60000 && b.observed<=at+1000);
  const total=fresh.reduce((sum,b)=>sum+b.bid,0);
  if(total>1+1e-9) return [];
  const rows=[];
  for(const q of quotes) {
    if(!q.yes || q.yes.size<quantity) continue;
    // A range starting exactly at the strike includes equality, which loses Kalshi YES.
    const supporting=fresh.filter(b=>b.floor>q.strike && b.bid>0);
    const reference=supporting.reduce((sum,b)=>sum+b.bid,0);
    const price=q.yes.price,fees=Math.ceil(7*quantity*price*(1-price)-1e-9)/100;
    const gap=reference-price-fees/quantity;
    rows.push({ticker:q.ticker,price,fees,depth:q.yes.size,reference,gap,supporting});
  }
  return rows.sort((a,b)=>b.gap-a.gap || a.ticker.localeCompare(b.ticker));
}

export async function observeRangeBids({db,config,stop,status}) {
  const io=new Transport({...config,maxHttpAgeSeconds:1,requestTimeoutMs:2500});
  db.exec('CREATE TABLE IF NOT EXISTS art_range_signals(id TEXT PRIMARY KEY,detail TEXT NOT NULL)');
  status.lots={};
  while(!stop() && Date.now()<end) {
    for(const target of targets) {
      if(stop() || Date.now()>=end) break;
      const lot=calendar.targets.find(t=>t.lot===target.lot), id=strategy+'/'+lot.event;
      if(db.prepare('SELECT 1 FROM paper WHERE id=?').get(id)) {
        status.lots[lot.title]={state:'Paper position recorded'};
        continue;
      }
      try {
        const [buckets,markets,fees,ex]=await Promise.all([ranges(target),marketList(io,lot),
          io.get('/series/KXART'),io.get('/exchange/status')]);
        checkFees(fees.body);
        if (!ex.body.exchange_active || !ex.body.trading_active) throw Error('Exchange paused');
        async function sample() {
          const begin=Date.now();
          const [bounds,k]=await Promise.all([Promise.all(buckets.map(bidAtSize)),captureAuctionQuotes(io,markets)]);
          const at=Date.now();
          if(!k || at>=end || at-begin>2500) throw Error('Outside pre-auction quote window');
          return {at,asOf:k.asOf,rows:rangeSignals(bounds,k.rows,at)};
        }
        const first=await sample(), best=first.rows[0];
        if(!best || best.gap<0.02) {
          status.lots[lot.title]={state:'No qualifying difference',gap:best?.gap??null};
          continue;
        }
        await sleep(1250);
        const second=await sample();
        const pick=second.rows.find(b=>b.gap>=0.02 && first.rows.some(a=>
          a.ticker===b.ticker && a.gap>=0.02 && b.price<=a.price));
        if(!pick || stop() || second.asOf<=first.asOf) {
          status.lots[lot.title]={state:'Awaiting repeated prices'};
          continue;
        }
        const prior=first.rows.find(r=>r.ticker===pick.ticker);
        db.exec('BEGIN IMMEDIATE');
        try {
          const m=markets.find(m=>m.ticker===pick.ticker);
          addPaper(db,{id,strategy,ticker:m.ticker,side:'yes',quantity,price:pick.price,fees:pick.fees,
            depth:Math.min(pick.depth,prior.depth),at:new Date(second.at).toISOString(),closeAt:Date.parse(m.close_time)});
          db.prepare('INSERT INTO art_range_signals VALUES(?,?)').run(id,JSON.stringify({slug:target.slug,
            first:{at:first.at,pick:prior},second:{at:second.at,pick}}));
          db.exec('COMMIT');
        } catch(e) {db.exec('ROLLBACK');throw e;}
        status.lots[lot.title]={state:'Paper position recorded'};
      } catch(e) {status.lots[lot.title]={state:e.message};}
    }
    status.at=new Date().toISOString();
    await sleep(Math.min(60000,Math.max(0,end-Date.now())));
  }
  status.ended=true;
}
