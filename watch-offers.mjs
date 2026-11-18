import {randomUUID} from 'node:crypto';
import {assertNoExistingExposure, submitCandidate} from './bot.mjs';
import {artworkKey, askLevels, checkEvent, checkFees, checkMarketActive, quoteBook, requireThat} from './core.mjs';
import {christies, phillips} from './parsers.mjs';
import {christiesLotHeader, christiesUnsold, verifyTerms} from './paper-unsold.mjs';

async function readSource(io, url) {
  try { return await io.request(url); }
  catch (e) {
    if (e.message !== 'Cached response too old') throw e;
    const fresh = new URL(url);
    fresh.searchParams.set('_checked',String(Date.now()));
    return io.request(fresh.href);
  }
}

async function catalogue(io, auction) {
  const r = await readSource(io,auction.sourceUrl);
  const rows = auction.house === 'christies' ? christies(r.text,auction.sale) :
    phillips(r.text,auction.sale,{allowPartialCatalogue:true});
  return {rows, requestedAt:r.requestedAt};
}

async function evidence(io, auction, target, source) {
  const matches = source.rows.filter(r=>r.lot===target.lot && r.id===target.id);
  if (matches.length!==1) return null;
  const row = matches[0];
  if (!row.identityValid || row.currency!=='USD' || row.withdrawn || row.artist!==target.artist || row.title!==target.title) return null;
  const base = {requestedAt:source.requestedAt, url:auction.sourceUrl};
  if (row.strictPublishedResult) return {...base, kind:'published_sale', amount:row.amount};
  if (row.explicitUnsold) return {...base, kind:'unsold', amount:null};
  if (auction.house !== 'christies') return null;
  const detail = await readSource(io,target.url);
  const lot = christiesLotHeader(detail.text,auction.sale,target);
  if (!lot || lot.lot_withdrawn === true) return null;
  const page = {requestedAt:detail.requestedAt,url:target.url};
  if (christiesUnsold(detail.text,auction.sale,target)) return {...page,kind:'unsold',amount:null};
  if (lot.is_unsold !== false) return null;
  if (lot.price_realised > 0 || lot.price_realised_txt) {
    const text=String(lot.price_realised_txt||'').trim();
    if (Number.isFinite(lot.price_realised) && /^USD\s+[\d,]+(?:\.\d+)?$/.test(text) &&
        Number(text.replace(/^USD\s+/,'').replaceAll(',',''))===lot.price_realised)
      return {...page,kind:'published_sale',amount:lot.price_realised};
    return null;
  }
  if (row.liveBid>0 && row.inProgress && !row.closed && !row.hasExplicitPublishedPrice)
    return {...base, kind:'current_bid',amount:row.liveBid};
  return null;
}

export function offerSide(e,threshold) {
  if (!e || !Number.isFinite(threshold) || threshold<=0) return null;
  if (e.kind==='unsold') return 'NO';
  if (!Number.isFinite(e.amount) || e.amount<=0) return null;
  if (e.kind==='published_sale') return e.amount>threshold?'YES':'NO';
  return e.kind==='current_bid' && e.amount>threshold?'YES':null;
}

export function journalPositions(journal, prior) {
  const expected=new Map();
  for (const intent of prior) {
    const receipt=journal.entries.find(r=>r.type==='receipt' && r.clientOrderId===intent.clientOrderId);
    requireThat(Number.isFinite(receipt?.filled),'Missing confirmed fill quantity');
    const signed=Math.round(receipt.filled*100)*(intent.side==='YES'?1:-1);
    expected.set(intent.ticker,(expected.get(intent.ticker)||0)+signed);
  }
  return expected;
}

function getQuote(body,side,config,priceLimit) {
  const q=quoteBook(body,side,config.contractsPerOrder,priceLimit);
  return q && q.reserveCents<=config.maxOrderCostCents && q.conditionalProfitCents>=config.minConditionalProfitCents ? q : null;
}

async function prepare(opts,target,source,prior) {
  const {io,auction,config,journal,live}=opts;
  const first=await evidence(io,auction,target,source);
  if (!first) return null;
  const loadMarkets=async()=>checkEvent((await io.get('/events/'+target.event+'?with_nested_markets=true')).body,target);
  const book=async ticker=>io.get('/markets/'+ticker+'/orderbook?depth=100');
  let best=null;
  for (const market of await loadMarkets()) {
    if (!checkMarketActive(market,Date.now())) continue;
    const side=offerSide(first,market.floor_strike);
    if (!side || prior.some(i=>i.ticker===market.ticker && i.side!==side)) continue;
    const snapshot=await book(market.ticker);
    if (!live) {
      const levels=askLevels(snapshot.body,side,config.maxPriceCents);
      await opts.log('paper_depth',{ticker:market.ticker,side,kind:first.kind,artwork:target.id,
        source:first.url,sourceAmount:first.amount,sourceRequestedAt:first.requestedAt,
        bookRequestedAt:snapshot.requestedAt,bookReceivedAt:snapshot.receivedAt,
        maxPriceCents:config.maxPriceCents,levels,units:'price in millionths of a dollar; quantity in millionths of a contract',
        displayedOnly:true});
    }
    const q=getQuote(snapshot.body,side,config,config.maxPriceCents);
    if(q && (!best || q.reserveCents<best.quote.reserveCents)) best={market,side,quote:q};
  }
  if (!best) return null;
  if(first.kind==='unsold') await verifyTerms(io);
  else checkFees((await io.get('/series/KXART')).body);
  const exchange=(await io.get('/exchange/status')).body;
  if (!exchange.exchange_active || !exchange.trading_active) return null;
  if(live) await assertNoExistingExposure(io,auction,target,config,journalPositions(journal,prior));
  const confirmed=await evidence(io,auction,target,await catalogue(io,auction));
  const {ticker,floor_strike:threshold}=best.market;
  if (!confirmed || confirmed.kind!==first.kind || offerSide(confirmed,threshold)!==best.side ||
      (first.kind==='published_sale' && confirmed.amount!==first.amount)) return null;
  const market=(await loadMarkets()).find(m=>m.ticker===ticker);
  if (!market || !checkMarketActive(market,Date.now())) return null;
  const freshBook=await book(ticker);
  const quote=getQuote(freshBook.body,best.side,config,best.quote.limitCents);
  if(!quote || Date.now()-confirmed.requestedAt>config.maxSourceAgeMs ||
      Date.now()-freshBook.requestedAt>config.maxQuoteAgeMs) return null;
  const reserved=journal.intents().reduce((s,i)=>s+i.quote.reserveCents,0);
  if(reserved+quote.reserveCents>config.maxTotalReservedCents) return null;
  return {ticker,side:best.side,quote,threshold,kind:confirmed.kind,sourcePrice:confirmed.amount,
    strategy:'watch_offers',clientOrderId:randomUUID(),artworkKey:artworkKey(auction,target),
    event:target.event,lot:target.lot,title:target.title,artist:target.artist,sourceUrl:confirmed.url,
    sourceRequestedAt:confirmed.requestedAt,quoteRequestedAt:freshBook.requestedAt,
    marketClose:Date.parse(market.close_time),settlementConfirmed:false,
    url:'https://kalshi.com/markets/kxart/what-will-the-price-of-art-be/'+target.event.toLowerCase()};
}

export async function scanOffers(opts) {
  const {io,auction,config,journal,stop,log,deadline}=opts;
  if (journal.intents().length>=config.maxOrders) return;
  let source;
  try { source=await catalogue(io,auction); }
  catch(e) {await stop();await log('sale_read_error',{sale:auction.sale,error:e.message});return;}
  for(const target of auction.targets) {
    await stop();
    if(Date.now()>=deadline || journal.intents().length>=config.maxOrders) break;
    const prior=journal.intents().filter(i=>i.artworkKey===artworkKey(auction,target));
    if(prior.length>=config.maxOfferAttemptsPerArtwork ||
        prior.some(i=>Date.now()-Date.parse(i.recordedAt)<config.offerCooldownSeconds*1000)) continue;
    let candidate;
    try {candidate=await prepare(opts,target,source,prior);}
    catch(e) {
      await stop();
      await log('offer_check_skipped',{event:target.event,error:e.message});
      if(/HTTP (401|403|429)/.test(e.message)) break;
      continue;
    }
    // Submission failures must escape the scan. An ambiguous order never gets retried.
    if(candidate) await submitCandidate({...opts,candidate,deadline:Math.min(deadline,candidate.marketClose)});
  }
}
