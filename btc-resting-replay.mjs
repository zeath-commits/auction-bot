import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {API} from './transport.mjs';
import {closingMargin,marginAllows,referencePrices} from './bitcoin-reference.mjs';
import {measureSales,windowTrades} from './public-trades.mjs';

const directory=fileURLToPath(new URL('./runtime/btc-resting-replay/',import.meta.url));
const limits=[980,998]; // Thousandths of a dollar.
const timers=['nineSeconds','untilClose','cancelOnMargin'];

function signal(prices,close,strike,at){
  const requested=at-2000;
  const m=closingMargin(prices,close,strike,requested);
  if(!(m?.endpoint>0))return null;
  const reading={...m,projected:m.endpoint,receivedAt:requested+700};
  const side=m.endpoint>=strike?'yes':'no';
  return {side,chart:m.spot,forecast:m.endpoint,prior:m.prior,lastAt:m.lastAt,
    passed:marginAllows(reading,side,close,strike,requested+800,at)};
}

export function cancelTime(prices,close,strike,decision,side){
  // Recheck each second using chart candles completed before a two-second simulated
  // request. After the first failed check, allow another second for cancellation.
  for(let at=decision+1000;at<close;at+=1000){
    const next=signal(prices,close,strike,at);
    if(!next?.passed || next.side!==side)return Math.min(at+1000,close);
  }
  return close;
}

async function cached(key,read){
  const file=path.join(directory,key+'.json');
  try{return JSON.parse(await fs.readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
  let value;
  for(let i=0;;i++){
    try{value=await read();break;}catch(e){
      if(i>=5)throw e;
      await sleep(Math.max(e.retryAfterMs||0,600*2**i));
    }
  }
  const tmp=file+'.'+process.pid+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(value));await fs.rename(tmp,file);
  return value;
}

let nextPublicRead=0;
async function get(route){
  for(let attempt=0;;attempt++){
    const slot=Math.max(Date.now(),nextPublicRead);
    nextPublicRead=slot+250;
    await sleep(Math.max(0,slot-Date.now()));
    const response=await fetch(API+route,{signal:AbortSignal.timeout(20000)});
    if(response.ok)return {body:await response.json()};
    if(attempt>=6 || (response.status!==429 && response.status<500))throw Error('Kalshi '+response.status);
    await response.body?.cancel();
    // Retry the individual page. Restarting a busy market from page one can
    // repeatedly hit the request limit before reaching the end of its tape.
    const delay=Math.max(1000*Number(response.headers.get('retry-after')??0),800*2**attempt);
    nextPublicRead=Math.max(nextPublicRead,Date.now()+delay);
  }
}

async function inventory(start,end){
  const rows=[],cursors=new Set();
  const params=new URLSearchParams({series_ticker:'KXBTC15M',limit:'1000',min_close_ts:String(start-1),max_close_ts:String(end)});
  do{
    const {body}=await get('/markets?'+params);
    rows.push(...body.markets);
    if(!body.cursor)break;
    if(cursors.has(body.cursor))throw Error('Repeated listing cursor');
    cursors.add(body.cursor);params.set('cursor',body.cursor);
  }while(true);
  return rows.filter(m=>Date.parse(m.close_time)>=start*1000 && Date.parse(m.close_time)<end*1000);
}

export function summarize(rows,price,timer,capitalOnly=false){
  let cash=1000000,pending=[],net=0,filled=0,wins=0,losses=0,shares=0,unfunded=0,partial=0,maxCost=0,feeStressCents=0;
  const lossTickers=[];
  for(const r of rows){
    const at=r.close-45000;
    cash+=pending.filter(p=>p.at<=at).reduce((n,p)=>n+p.payout,0);
    pending=pending.filter(p=>p.at>at);
    // Orders occupy disjoint quarter-hour windows. Previous purchases lock up
    // their principal until exchange settlement. Choose size before reading volume.
    const capacity=capitalOnly?Math.floor(cash/price):100;
    if(capacity===0||cash<capacity*price){unfunded++;continue;}
    const n=capitalOnly?Math.min(capacity,Math.floor(r.scenarios[timer][price].volume)):r.scenarios[timer][price].shares;
    if(!n)continue;
    const payout=r.won?1000*n:0;
    cash-=price*n;
    pending.push({at:r.settled,payout});
    shares+=n;filled++;partial+=Number(n<capacity);net+=payout-n*price;maxCost=Math.max(maxCost,n*price);
    feeStressCents+=Math.ceil(7*n*(price/1000)*(1-price/1000)-1e-9);
    if(r.won)wins++;else{losses++;lossTickers.push(r.ticker);}
  }
  return {price:price/1000,timer,signals:rows.length,filled,wins,losses,partial,shares,unfunded,maxCost:maxCost/1000,gross:net/1000,
    takerFeeSensitivity:feeStressCents/100,lossTickers};
}

async function run(start,end){
  if(![start,end].every(x=>Number.isSafeInteger(x)&&x%900===0) || end<=start || end*1000>Date.now())
    throw Error('Supply past quarter-hour UTC boundaries');
  await fs.mkdir(directory,{recursive:true});
  const cutoff=(await get('/historical/cutoff')).body;
  const archived=Date.parse(cutoff.market_settled_ts);
  if(!Number.isFinite(archived)||start*1000<archived)throw Error('Historical market inventory is required for these dates');
  const markets=await cached('markets-'+start+'-'+end,()=>inventory(start,end));
  if(!markets.length||new Set(markets.map(m=>m.close_time)).size!==markets.length)throw Error('Empty or repeated market close');
  const io={get:route=>route==='/historical/cutoff'?{body:cutoff}:get(route)};
  const prices=new Map();
  for(let t=start;t<end;t+=21600){
    const stop=Math.min(t+21600,end);
    const values=await cached('chart-'+t+'-'+stop,async()=>[...await referencePrices(t-60,stop-61)].filter(([s])=>s%900>=840));
    for(const [ts,p] of values)prices.set(ts,p);
  }
  const rows=[],coverage={listed:markets.length,graded:0,ineligible:0,missingChart:0,signals:0};
  const selected=[];
  for(const m of markets){
    if(m.status!=='finalized'||!['yes','no'].includes(m.result)){coverage.ineligible++;continue;}
    const close=Date.parse(m.close_time),strike=m.floor_strike,settled=Date.parse(m.settlement_ts),at=close-45000;
    if(m.strike_type!=='greater_or_equal'||!(strike>0&&Number(m.expiration_value)>0&&settled>=close)||
      !m.rules_primary.includes('BRTI')||Number(m.notional_value_dollars)!==1||m.result!==(Number(m.expiration_value)>=strike?'yes':'no')||
      !m.price_ranges?.some(v=>v.start==='0.9000'&&v.end==='1.0000'&&v.step==='0.0010'))throw Error('Unverified market '+m.ticker);
    coverage.graded++;
    const s=signal(prices,close,strike,at);
    if(!s){coverage.missingChart++;continue;}
    if(!s.passed)continue;
    selected.push({ticker:m.ticker,close,settled,strike,s,won:s.side===m.result});
  }
  coverage.signals=selected.length;
  for(let i=0;i<selected.length;i+=3){
    const batch=await Promise.all(selected.slice(i,i+3).map(async r=>{
      const decision=r.close-45000,arrival=decision+1000;
      const trial={ticker:r.ticker,arrival,untilAt:r.close};
      const sales=await cached('sellers-'+r.ticker+'-'+r.s.side,async()=>
        (await windowTrades(io,trial,r.s.side,r.s.side==='yes'?'no':'yes')).filter(t=>t.price<.998));
      const deadlines={nineSeconds:decision+10000,untilClose:r.close,cancelOnMargin:cancelTime(prices,r.close,r.strike,decision,r.s.side)};
      const scenarios={};
      for(const timer of timers)scenarios[timer]=Object.fromEntries(limits.map(price=>[price,measureSales(sales,price/1000,deadlines[timer])]));
      return {...r,arrival,deadlines,scenarios};
    }));
    rows.push(...batch);
    if(i%150===0)console.log('Reviewed',rows.length,'of',selected.length);
  }
  rows.sort((a,b)=>a.close-b.close);
  const summaries=timers.flatMap(timer=>limits.map(price=>summarize(rows,price,timer)));
  const capitalSensitivity=timers.flatMap(timer=>limits.map(price=>summarize(rows,price,timer,true)));
  const output={start,end,coverage,incorrectSignals:rows.filter(r=>!r.won).length,summaries,capitalSensitivity,rows};
  await fs.writeFile(path.join(directory,'report-'+start+'-'+end+'.json'),JSON.stringify(output));
  console.log(JSON.stringify({coverage,incorrectSignals:output.incorrectSignals,summaries}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [a,b]=process.argv.slice(2);
  await run(Date.parse(a)/1000,Date.parse(b)/1000);
}
