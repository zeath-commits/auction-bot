import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {API} from './transport.mjs';

// First complete batch independently timestamped after the first published sale.
// A later buyer at the same price can corroborate availability, never our fill.
const calendar=JSON.parse(await fs.readFile(new URL('./sothebys-bid-calendar.json',import.meta.url)));
const runtime=new URL('./runtime/',import.meta.url);
const db=new DatabaseSync(new URL('strategies.sqlite',runtime),{readOnly:true});
const first=db.prepare('SELECT * FROM sale_first_prices WHERE event=? ORDER BY at,source');
const batches=db.prepare('SELECT * FROM auction_quote_batches WHERE begin>=? AND asOf>=? AND at<=? ORDER BY at');
const depthFile=new URL('auction-release-depth.sqlite',runtime);
const depth=existsSync(depthFile)?new DatabaseSync(depthFile,{readOnly:true}):null;
const rapid=depth?.prepare('SELECT offset,sample,error FROM frames WHERE event=? AND release=? ORDER BY offset');
const output=[];
for(const lot of calendar.targets) {
  const sources=first.all(lot.event);
  const r=sources[0];
  const row={event:lot.event,published:r?.at??null,amount:r?.price??null};
  output.push(row);
  if(!r) {row.status='Awaiting first public price';continue;}
  // Keep separately collected snapshots out of the previously specified replay.
  const observations=rapid?.all(lot.event,r.at)??[];
  if(observations.length){
    row.additionalBooks=observations.map(f=>{
      if(!f.sample)return {offset:f.offset,error:f.error};
      const s=JSON.parse(f.sample);
      if(s.asOf<r.at)return {offset:f.offset,status:'Book timestamp overlaps publication'};
      const offers=s.rows.flatMap(q=>q.depth[r.price>q.strike?'yes':'no'].map(([p,n])=>({ticker:q.ticker,price:p/1e6,size:n})));
      return {offset:f.offset,lag:s.at-r.at,thresholds:s.rows.length,
        lowest:offers.sort((a,b)=>a.price-b.price||a.ticker.localeCompare(b.ticker))[0]??null};
    });
  }
  if(Date.now()<=r.at+6000){row.status='Observation window open';continue;}
  row.sourceAgreement=sources.length===2&&sources.every(s=>s.price===r.price);
  const books=batches.all(r.at,r.at,r.at+3000);
  let levels;
  for (const b of books) {
    const quotes=JSON.parse(b.detail).filter(q=>q.event===lot.event);
    if(quotes.length!==lot.contracts||new Set(quotes.map(q=>q.ticker)).size!==lot.contracts)continue;
    row.bookAt=b.at;
    levels=quotes.flatMap(q=>{
      if(!Number.isFinite(q.strike)||!q.depth||!q.ticker.startsWith(lot.event+'-'))throw Error('Unexpected book');
      const side=r.price>q.strike?'yes':'no';
      return q.depth[side].filter(([price,size])=>price>0&&price<=950000&&size>=1)
        .map(([price,size])=>({ticker:q.ticker,side,price:price/1e6,size}));
    });
    break;
  }
  if(!levels){row.status='No complete book within three seconds';continue;}
  if(!levels.length){row.status='No qualifying offer';continue;}
  const top=levels.sort((a,b)=>a.price-b.price||a.ticker.localeCompare(b.ticker))[0];
  row.offer=top;
  const after=row.bookAt+250, end=row.bookAt+2000;
  const q=new URLSearchParams({ticker:top.ticker,limit:1000,min_ts:Math.floor(after/1000),max_ts:Math.ceil(end/1000),is_block_trade:false});
  const ids=new Set(),cursors=new Set();let units=0, legs=0, cursor;
  do {
    if(cursor)q.set('cursor',cursor);
    const res=await fetch(API+'/markets/trades?'+q,{signal:AbortSignal.timeout(8000)});
    if(!res.ok)throw Error('Kalshi public trades HTTP '+res.status);
    const body=await res.json();
    if(!Array.isArray(body.trades))throw Error('Missing trade page');
    for(const t of body.trades){
      if(t.ticker!==top.ticker||t.is_block_trade!==false||!t.trade_id||ids.has(t.trade_id))throw Error('Unexpected trade');
      ids.add(t.trade_id);
      const at=Date.parse(t.created_time), qty=Number(t.count_fp);
      if(!(qty>0)||!Number.isFinite(at))throw Error('Invalid execution time or size');
      if(at>=after&&at<end&&t.taker_outcome_side===top.side&&t.taker_book_side===(top.side==='yes'?'bid':'ask')&&
        Number(t[top.side+'_price_dollars'])===top.price){units+=Math.round(qty*100);legs++;}
    }
    cursor=body.cursor;
    if(cursor&&cursors.has(cursor))throw Error('Repeated trade cursor');
    cursors.add(cursor);
  }while(cursor);
  row.samePricePurchases=legs;
  row.samePriceUnits=units/100;
  row.overlappingUnits=Math.min(top.size,Math.floor(units/100));
  row.status=row.overlappingUnits?'Subsequent buyer observed':'No matching purchase observed';
  // Display a capped, fee-inclusive illustration separately from the paper ledger.
  const qty=row.overlappingUnits;
  const fee=Math.ceil(7*qty*top.price*(1-top.price)-1e-9)/100;
  row.illustration={qty,fee,netIfCorrect:+(qty*(1-top.price)-fee).toFixed(4),netIfWrong:+(-qty*top.price-fee).toFixed(4)};
}
db.close();
depth?.close();
const report={checked:new Date().toISOString(),rows:output};
const file=new URL('auction-postrelease-replay.json',runtime);
const tmp=new URL('auction-postrelease-replay.'+process.pid+'.tmp',runtime);
await fs.writeFile(tmp,JSON.stringify(report,null,2));
await fs.rename(tmp,file);
console.log(JSON.stringify(report));
