import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {artworkKey, askLevels, checkEvent, checkFees, checkMarketActive, MICRO, requireThat} from './core.mjs';
import {catalogue, evidence, journalPositions, offerSide} from './watch-offers.mjs';
import {verifyTerms} from './paper-unsold.mjs';
import {assertNoExistingExposure, submitCandidate} from './bot.mjs';

export function sessionWatchlist(calendar, date) {
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date),'Supply an Eastern auction date as YYYY-MM-DD');
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
  const auctions=calendar.auctions.filter(a=>format.format(Date.parse(a.startAt))===date);
  requireThat(auctions.length,'No reviewed auctions for '+date);
  return {...calendar,auctions};
}

// Charge every unit the IOC limit and reserve rounding on every possible fill.
// Price plus the standard quadratic fee increases throughout the binary price range.
export function sweepQuote(initial,current,side,market,config,budgetCents) {
  const first = new Map(askLevels(initial,side,config.maxPriceCents).map(l=>[l.price,l.quantity]));
  let depth=0,best=null;
  for(const {price,quantity} of askLevels(current,side,config.maxPriceCents)){
    const overlap=Math.min(quantity,first.get(price)??0);
    if(!overlap)continue;
    depth+=overlap;
    const limitCents=Math.ceil(price/10000), p=limitCents/100;
    const maxFills=market.fractional_trading_enabled===false?1:100;
    const fee=q=>Math.ceil(q*(7*p*(1-p)+maxFills*.01)-1e-9);
    let low=0,high=Math.min(Math.floor(depth/MICRO),Math.floor(budgetCents/limitCents));
    while(low<high){
      const mid=Math.ceil((low+high)/2);
      if(mid*limitCents+fee(mid)<=budgetCents)low=mid;else high=mid-1;
    }
    if(low<1 || (best&&best.quantity>=low))continue;
    const reserveCents=low*limitCents+fee(low), conditionalProfitCents=100*low-reserveCents;
    if(conditionalProfitCents>=config.minConditionalProfitCents)
      best={quantity:low,limitCents,feeReserveCents:fee(low),reserveCents,conditionalProfitCents};
  }
  return best;
}

function bookTime(read,config) {
  const age=Number(read.cacheAge??0), at=Date.parse(read.httpDate)-age*1000;
  if(!Number.isInteger(age)||age<0||!Number.isFinite(at)||at>read.receivedAt+1000 ||
      read.receivedAt-at>config.maxQuoteAgeMs || read.receivedAt-read.requestedAt>config.maxQuoteAgeMs)return null;
  return at;
}
function marketsFor(body,target) {
  const e=body.event;
  requireThat(e?.fee_type_override==null && e?.fee_multiplier_override==null,'Event fee override requires review');
  const markets=checkEvent(body,target);
  requireThat(markets.length===target.markets.length&&new Set(markets.map(m=>m.ticker)).size===markets.length,'Incomplete reviewed event');
  return markets.filter(m=>checkMarketActive(m,Date.now()) && !m.is_provisional && (m.exchange_index??0)===0);
}
export async function sessionBookCheck(io,body,target,config) {
  const markets=marketsFor(body,target);
  if(!markets.length)return {active:0,quoted:0,fresh:0};
  const first=await batchBooks(io,markets);
  for(const book of first.books.values()){
    askLevels(book,'YES',config.maxPriceCents);
    askLevels(book,'NO',config.maxPriceCents);
  }
  return {active:markets.length,quoted:first.books.size,fresh:bookTime(first.read,config)===null?0:first.books.size};
}
async function batchBooks(io,markets) {
  const query=new URLSearchParams(markets.map(m=>['tickers',m.ticker]));
  query.set('depth','100');
  const read=await io.get('/markets/orderbooks?'+query);
  const books=new Map(read.body.orderbooks.map(b=>[b.ticker,b]));
  requireThat(books.size===markets.length && books.size===read.body.orderbooks.length &&
    markets.every(m=>books.has(m.ticker)),'Incomplete first book batch');
  return {read,books};
}
export async function scanSweep(opts) {
  const {io,journal,auction,config,live,stop,deadline,log}=opts;
  const catalogueRead=await catalogue(io,auction);
  let cash=null;
  for(const t of auction.targets){
    await stop();
    if(Date.now()>=deadline || journal.committedCents()>=config.maxTotalReservedCents)return;
    const key=artworkKey(auction,t),history=()=>journal.intents().filter(i=>i.artworkKey===key);
    const published=await evidence(io,auction,t,catalogueRead);
    if(!['published_sale','unsold'].includes(published?.kind))continue;
    if(history().some(i=>i.strategy==='auction_sweep' && (i.kind!==published.kind || i.sourcePrice!==published.amount)))continue;
    const getMarkets=async()=>marketsFor((await io.get('/events/'+t.event+'?with_nested_markets=true')).body,t);
    const markets=await getMarkets();
    if(!markets.length)continue;
    const {read:batch,books}=await batchBooks(io,markets);
    const start=bookTime(batch,config);
    if(start===null)continue;
    const candidates=[];
    for(const m of markets){
      const side=offerSide(published,m.floor_strike),book=books.get(m.ticker);
      requireThat(book,'Missing reviewed ticker in batch');
      const levels=askLevels(book,side,config.maxPriceCents);
      if(levels.length)candidates.push({m,side,book,firstPrice:levels[0].price});
    }
    if(!candidates.length)continue;
    if(published.kind==='unsold')await verifyTerms(io);
    else checkFees((await io.get('/series/KXART')).body);
    for(const {m,side,book} of candidates.sort((a,b)=>a.firstPrice-b.firstPrice||a.m.ticker.localeCompare(b.m.ticker))){
      await stop();
      const prior=history();
      if(Date.now()>=deadline || journal.committedCents()>=config.maxTotalReservedCents)return;
      if(!journal.canSweep(m.ticker,side,start))continue;
      if(live){
        if(cash===null){
          cash=(await io.get('/portfolio/balance?exchange_index=0&subaccount='+config.subaccount,true)).body.balance;
          requireThat(Number.isSafeInteger(cash)&&cash>=0,'Invalid available cash balance');
        }
        await assertNoExistingExposure(io,auction,t,config,journalPositions(journal,prior));
      }
      const budget=Math.min(cash??Infinity,config.maxTotalReservedCents-journal.committedCents());
      if(!sweepQuote(book,book,side,m,config,budget))continue;
      const exchange=(await io.get('/exchange/status')).body;
      if(!exchange.trading_active||!exchange.exchange_active)return;
      const latest=(await getMarkets()).find(row=>row.ticker===m.ticker);
      if(!latest)continue;
      await sleep(Math.max(0,batch.receivedAt+1050-Date.now()));
      const confirmed=await evidence(io,auction,t,await catalogue(io,auction));
      if(confirmed?.kind!==published.kind||confirmed.amount!==published.amount)break;
      const read=await io.get('/markets/'+m.ticker+'/orderbook?depth=100');
      const stamp=bookTime(read,config);
      if(stamp===null||stamp<=start)continue;
      const quote=sweepQuote(book,read.body,side,latest,config,budget);
      if(!quote)continue;
      const candidate={ticker:m.ticker,side,quote,threshold:m.floor_strike,kind:confirmed.kind,sourcePrice:confirmed.amount,
        strategy:'auction_sweep',clientOrderId:randomUUID(),artworkKey:key,event:t.event,lot:t.lot,title:t.title,artist:t.artist,
        sourceUrl:confirmed.url,sourceRequestedAt:confirmed.requestedAt,quoteRequestedAt:read.requestedAt,firstBookAt:start,
        finalBookAt:stamp,settlementSource:'Artnet',settlementConfirmed:false,
        url:'https://kalshi.com/markets/kxart/what-will-the-price-of-art-be/'+t.event.toLowerCase()};
      await submitCandidate({io,journal,config,live,stop,log,candidate,deadline:Math.min(deadline,Date.parse(latest.close_time))});
      if(live)cash-=journal.entries.find(r=>r.type==='receipt'&&r.clientOrderId===candidate.clientOrderId).costCents;
    }
  }
}
