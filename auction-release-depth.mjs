import fs from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import {Transport} from './transport.mjs';
import {marketList} from './sothebys-bids.mjs';
import {captureAuctionQuotes} from './auction-quote-timing.mjs';

const calendar=JSON.parse(await fs.readFile(new URL('./sothebys-bid-calendar.json',import.meta.url)));
const runtime=new URL('./runtime/',import.meta.url);
const ledger=new DatabaseSync(new URL('strategies.sqlite',runtime),{readOnly:true});
const archive=new DatabaseSync(new URL('auction-release-depth.sqlite',runtime));
archive.exec(`CREATE TABLE IF NOT EXISTS frames(event TEXT,release INTEGER,offset INTEGER,at INTEGER,
  sample TEXT,error TEXT,PRIMARY KEY(event,release,offset))`);
const save=archive.prepare('INSERT OR IGNORE INTO frames VALUES(?,?,?,?,?,?)');
const taken=archive.prepare('SELECT offset FROM frames WHERE event=? AND release=?');
const first=ledger.prepare('SELECT at,price FROM sale_first_prices WHERE event=? ORDER BY at LIMIT 1');
const io=new Transport({requestTimeoutMs:2000,maxHttpAgeSeconds:2});
const offsets=[0,1000,2250,4000,7000,15000,30000];
const deadline=Date.parse(calendar.end)+35000;
const markets=new Map();
let refreshAt=0;
try {
  while(Date.now()<deadline){
    const pending=calendar.targets.map(target=>({target,release:first.get(target.event)}))
      .filter(({release})=>!release||Date.now()<=release.at+32000);
    if(!pending.length)break;
    if(Date.now()>=refreshAt){
      await Promise.all(pending.map(async ({target})=>{
        try {markets.set(target.event,await marketList(io,target));}
        catch(e){markets.delete(target.event);console.error(target.event,e.message);}
      }));
      refreshAt=Date.now()+(pending.every(({target})=>markets.has(target.event))?60000:5000);
    }
    const due=[];
    for(const {target,release} of pending){
      if(!release)continue;
      const prior=new Set(taken.all(target.event,release.at).map(row=>row.offset));
      const elapsed=Date.now()-release.at;
      for(const offset of offsets) {
        if(prior.has(offset)||elapsed<offset)continue;
        if(elapsed-offset>750) {
          save.run(target.event,release.at,offset,Date.now(),null,'Sampling window missed');
        } else {
          due.push({target,release,offset});
        }
      }
    }
    if(due.length){
      const listed=due.flatMap(({target})=>markets.get(target.event)??[]);
      let sample=null,error=null;
      try {if(listed.length)sample=await captureAuctionQuotes(io,listed);}
      catch(e){error=e.message;}
      for(const {target,release,offset} of due){
        const rows=sample?.rows.filter(r=>r.event===target.event);
        const valid=rows?.length===target.contracts&&new Set(rows.map(r=>r.ticker)).size===target.contracts;
        const record=valid?{...sample,rows}:null;
        save.run(target.event,release.at,offset,Date.now(),record&&JSON.stringify(record),valid?null:(error??'Incomplete active books'));
      }
    }
    await sleep(100);
  }
}finally{archive.close();ledger.close();}
