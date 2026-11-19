import {askLevels,MICRO} from './core.mjs';
import {auctionEntryStrategies,originalEntry} from './auction-resting.mjs';

const pendingByDb=new WeakMap();
export function initEntryDepth(db){
  db.exec(`CREATE TABLE IF NOT EXISTS auction_entry_depth(ticker TEXT,at TEXT,detail TEXT,PRIMARY KEY(ticker,at));
    CREATE INDEX IF NOT EXISTS auction_paper_by_time ON paper(at,ticker) WHERE strategy IN ${auctionEntryStrategies}`);
  pendingByDb.set(db,db.prepare(`SELECT DISTINCT p.ticker,p.at FROM paper p LEFT JOIN auction_entry_depth d USING(ticker,at)
    WHERE p.strategy IN ${auctionEntryStrategies} AND p.at>=? AND p.at<=? AND d.ticker IS NULL AND p.closeAt>?
    ORDER BY p.at,p.ticker LIMIT 100`));
}

function matchDepth(book,side,levels,held){
  const asks=askLevels(book,side.toUpperCase(),100);
  if(new Set(asks.map(l=>l.price)).size!==asks.length)throw Error('Duplicate delayed auction price');
  const available=asks.map(l=>{
    const depth=Math.floor(l.quantity/MICRO),prior=Math.min(held,depth);
    held-=prior;
    return {price:l.price,remaining:depth-prior};
  });
  return [...levels].sort((a,b)=>a[0]-b[0]).map(([limit,requested])=>{
    let matched=0,costMicros=0;
    for(const l of available){
      if(l.price>Math.round(limit*MICRO) || matched===requested)break;
      const n=Math.min(requested-matched,l.remaining);
      matched+=n;l.remaining-=n;costMicros+=n*l.price;
    }
    return {limit,requested,matched,cost:costMicros/MICRO};
  });
}

export async function checkEntryDepth(db,io,now){
  const due=pendingByDb.get(db).all(new Date(now-6000).toISOString(),new Date(now-1000).toISOString(),now);
  if(!due.length)return 0;
  const tickers=[...new Set(due.map(p=>p.ticker))];
  const query=new URLSearchParams(tickers.map(t=>['tickers',t]));query.set('depth','100');
  const read=await io.get('/markets/orderbooks?'+query);
  const asOf=Date.parse(read.httpDate)-1000*Number(read.cacheAge??0);
  if(!Number.isFinite(asOf)||asOf<read.receivedAt-2500||asOf>read.receivedAt+500||read.receivedAt-read.requestedAt>2000)return 0;
  const books=new Map(read.body.orderbooks.map(b=>[b.ticker,b]));
  if(books.size!==tickers.length || read.body.orderbooks.length!==tickers.length || !tickers.every(t=>books.has(t)))
    throw Error('Incomplete delayed auction order books');
  let recorded=0;
  for(const {ticker,at} of due){
    const start=Date.parse(at);
    if(Math.min(asOf,read.requestedAt)<start+1000 || Math.max(asOf,read.receivedAt)>start+6000)continue;
    const {strategy,side,levels,closeAt}=originalEntry(db,ticker,at);
    if(Math.max(asOf,read.receivedAt)>=closeAt)continue;
    const replaced=db.prepare(`SELECT 1 FROM paper WHERE ticker=? AND at>? AND at<=? AND strategy IN ${auctionEntryStrategies} LIMIT 1`)
      .get(ticker,at,new Date(read.receivedAt).toISOString());
    if(replaced)continue;
    const held=db.prepare(`SELECT COALESCE(SUM(quantity),0) AS shares FROM paper WHERE ticker=? AND side=? AND at<?
      AND strategy IN ${auctionEntryStrategies} AND (strategy='art_withdrawn')=?`).get(ticker,side,at,Number(strategy==='art_withdrawn')).shares;
    const book=books.get(ticker);
    const proof={ticker,at,side,strategy,asOf,requestedAt:read.requestedAt,receivedAt:read.receivedAt,held,book,levels:matchDepth(book,side,levels,held)};
    recorded+=db.prepare('INSERT OR IGNORE INTO auction_entry_depth VALUES(?,?,?)').run(ticker,at,JSON.stringify(proof)).changes;
  }
  return recorded;
}
