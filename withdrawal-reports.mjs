import {setTimeout as sleep} from 'node:timers/promises';
import {checkEvent,checkFees,checkMarketActive,overlappingAskLevels} from './core.mjs';
import {Transport} from './transport.mjs';

const listing='https://heni.com/news';
function lotKey(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
  if(!['www.christies.com','www.phillips.com','www.sothebys.com'].includes(url.hostname))return null;
  return url.origin+url.pathname.replace(/\/$/,'');
}
export function withdrawalListing(html){
  const marker='title:"Highest Value Withdrawn Lots"',start=html.indexOf(marker);
  const end=html.indexOf('}]},{column_names:',start);
  if(start<0||start!==html.lastIndexOf(marker)||end<0)throw Error('Withdrawal table unavailable');
  const section=html.slice(start,end);
  const links=[...section.matchAll(/__typename:"HENI_News_Articles",id:"([a-f\d-]{36})",url:"([^"]+)",publishDate:"([^"]+)"/g)];
  if(!links.length||links.length!==(section.match(/news_link:/g)??[]).length)throw Error('Incomplete withdrawal table');
  const reports=new Map();
  for(const [,id,url,published] of links){
    const key=lotKey(url);
    if(!key)continue;
    if(reports.has(key))throw Error('Ambiguous lot in withdrawal table');
    reports.set(key,{id,source:'https://heni.com/news/view/'+id,lot:key,publisherTime:published});
  }
  return {reports,count:links.length};
}

export async function observeWithdrawalReports({db,config,auctions,status,stop,registerBids,
  io=new Transport({...config,requestTimeoutMs:5000,maxHttpAgeSeconds:2}),fetchPage=fetch,pause=sleep}){
  db.exec(`CREATE TABLE IF NOT EXISTS auction_withdrawal_reports(event TEXT,article TEXT,at INTEGER,detail TEXT,
      PRIMARY KEY(event,article));
    CREATE TABLE IF NOT EXISTS auction_withdrawal_quotes(ticker TEXT,article TEXT,kind TEXT,at INTEGER,detail TEXT,
      PRIMARY KEY(ticker,article,kind))`);
  const terminal=new Set();
  while(!stop()){
    try{
      const now=Date.now();
      const targets=auctions.filter(a=>Date.parse(a.startAt)-7*86400000<=now&&Date.parse(a.deadline)+2*86400000>=now)
        .flatMap(a=>a.targets);
      if(!targets.length){Object.assign(status,{at:now,targets:0,listed:null,matched:0,open:0,error:null});}
      else{
        const response=await fetchPage(listing,{signal:AbortSignal.timeout(10000),redirect:'error',cache:'no-store'});
        if(!response.ok)throw Error('HENI HTTP '+response.status);
        const {reports,count}=withdrawalListing(await response.text());
        const received=Date.now();
        let matched=0,open=0;
        for(const t of targets){
          const report=reports.get(lotKey(t.url));
          if(!report)continue;
          matched++;
          if(terminal.has(t.event))continue;
          const body=(await io.get('/events/'+t.event+'?with_nested_markets=true')).body;
          const markets=checkEvent(body,t);
          if(markets.length!==t.markets.length||new Set(markets.map(m=>m.ticker)).size!==markets.length)throw Error('Incomplete auction markets');
          if(markets.every(m=>m.status==='finalized')){terminal.add(t.event);continue;}
          const active=markets.filter(m=>checkMarketActive(m,Date.now()));
          if(!active.length)continue;
          open++;
          db.prepare('INSERT OR IGNORE INTO auction_withdrawal_reports VALUES(?,?,?,?)').run(t.event,report.id,received,JSON.stringify(report));
          const observed=db.prepare('SELECT at FROM auction_withdrawal_reports WHERE event=? AND article=?').get(t.event,report.id).at;
          let studyOpen=false;
          if(registerBids && received>=observed+3600000){
            checkFees((await io.get('/series/KXART')).body);
            const exchange=(await io.get('/exchange/status')).body;
            studyOpen=exchange.exchange_active && exchange.trading_active;
          }
          const q=new URLSearchParams(active.map(m=>['tickers',m.ticker]));q.set('depth','100');
          const read=()=>io.get('/markets/orderbooks?'+q);
          // HTTP Date has one-second precision. Make the first response distinguishable from the source receipt.
          await pause(Math.max(0,(Math.floor(received/1000)+1)*1000+20-Date.now()));
          const first=await read();await pause(1500);const second=await read();
          const asOf=r=>Date.parse(r.httpDate)-Number(r.cacheAge??0)*1000;
          if(![first,second].every(r=>asOf(r)>=received&&asOf(r)>=r.receivedAt-3000&&asOf(r)<=r.receivedAt+1000&&r.receivedAt-r.requestedAt<=2500)||
            asOf(second)<=asOf(first))throw Error('Waiting for fresh withdrawal books');
          const maps=[first,second].map(r=>new Map(r.body.orderbooks.map(b=>[b.ticker,b])));
          if(![first,second].every(r=>r.body.orderbooks.length===active.length)||
            !maps.every(map=>map.size===active.length&&active.every(m=>map.has(m.ticker))))throw Error('Incomplete withdrawal books');
          if(studyOpen && !stop())registerBids(db,{event:t.event,source:report.source,observed,markets:active,slots:markets.length,first,second});
          for(const m of active){
            if(!checkMarketActive(m,second.receivedAt))continue;
            const books=maps.map(map=>map.get(m.ticker));
            const levels=overlappingAskLevels(...books,'NO',99).filter(l=>l.quantity>0);
            const detail=JSON.stringify({event:t.event,source:report.source,received,bookTimes:[asOf(first),asOf(second)],levels,books});
            for(const kind of ['first',...(levels.length?['through99']:[]),...(levels.some(l=>l.price<=.95)?['through95']:[])])
              db.prepare('INSERT OR IGNORE INTO auction_withdrawal_quotes VALUES(?,?,?,?,?)').run(m.ticker,report.id,kind,second.receivedAt,detail);
          }
        }
        Object.assign(status,{at:received,targets:targets.length,listed:count,matched,open,error:null});
      }
    }catch(e){Object.assign(status,{error:e.message,lastAttempt:Date.now()});}
    if(!stop())await pause(120000);
  }
}
