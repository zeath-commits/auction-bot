import { createHash } from 'node:crypto';
import { christies, phillips } from './parsers.mjs';
import { checkEvent, checkFees, checkMarketActive, quoteBook, requireThat } from './core.mjs';

const termsUrl = 'https://assets.kalshi.com/contract_terms/ITEMPRICESART.pdf';
// Reviewed page 2: if there is no eligible prior price, all strikes settle NO.
const termsHash = 'dd458f0d8b451463ca8ef72e2608b940ed11e667b4cdddc14bb3d43a38fa2fae';

export function christiesLotHeader(html, sale, target) {
  const header = html.match(/^\s*window\.chrComponents\.lotHeader_\d+\s*=\s*(\{[^\n]*\});/m);
  if (!header) return false;
  const {data, labels} = JSON.parse(header[1]);
  if (String(data?.sale?.sale_number) !== sale || labels?.currency_txt !== 'USD') return false;
  const lots = data.lots.filter(l => l.object_id === target.id && l.lot_id_txt?.replace(/\s/g,'') === target.lot);
  if (lots.length !== 1) return false;
  const l = lots[0];
  return l.title_primary_txt === target.artist && l.title_secondary_txt === target.title &&
    l.analytics_id?.startsWith(sale + '.') ? l : null;
}

export function christiesUnsold(html, sale, target) {
  const l = christiesLotHeader(html, sale, target);
  return !!l && l.is_unsold === true && l.lot_withdrawn !== true &&
    (l.price_realised == null || l.price_realised === 0) && !l.price_realised_txt?.trim();
}

export async function verifyTerms(io) {
  const series = (await io.get('/series/KXART')).body;
  checkFees(series);
  requireThat(series.series.contract_terms_url === termsUrl, 'Unsold settlement terms URL changed');
  const r = await fetch(termsUrl, {redirect:'error', signal:AbortSignal.timeout(6000)});
  requireThat(r.ok && createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') === termsHash,
    'Review changed unsold settlement terms before recording NO');
}

export async function scanUnsold({auction, io, config, db, log, saveObservation}) {
  let source;
  try { source = await io.request(auction.sourceUrl); }
  catch(e) {
    if (e.message !== 'Cached response too old') throw e;
    const fresh = new URL(auction.sourceUrl);
    fresh.searchParams.set('_checked',String(Date.now()));
    source = await io.request(fresh.href);
  }
  const rows = auction.house === 'phillips'
    ? phillips(source.text, auction.sale, {allowPartialCatalogue:true}) : christies(source.text, auction.sale);
  const ids = new Set(auction.targets.map(t=>t.id));
  const summary = {explicitUnsold:[], paperEntries:0};
  for (const id of ids) {
    const listings = auction.targets.filter(t=>t.id===id);
    const target = listings[0];
    const matches = rows.filter(r=>r.identityValid && r.id===id && r.lot===target.lot &&
      r.artist===target.artist && r.title===target.title && r.currency==='USD');
    if (matches.length!==1 || matches[0].withdrawn || matches[0].amount !== null) continue;
    let evidence = source, url = auction.sourceUrl;
    if (auction.house === 'christies') {
      url = target.url;
      evidence = await io.request(url);
      if (!christiesUnsold(evidence.text, auction.sale, target)) continue;
    } else if (!matches[0].explicitUnsold) continue;
    summary.explicitUnsold.push(target.lot);
    const key = 'unsold:'+auction.house+':'+auction.sale+':'+id;
    if (db.prepare('SELECT 1 FROM signals WHERE ticker=?').get(key)) continue;
    await verifyTerms(io);
    const exchange = (await io.get('/exchange/status')).body;
    if (!exchange.exchange_active || !exchange.trading_active) continue;
    const choices = [];
    for (const listing of listings) {
      const event = (await io.get('/events/'+listing.event+'?with_nested_markets=true')).body;
      for (const market of checkEvent(event,listing)) {
        if (market.floor_strike<=0 || !checkMarketActive(market,Date.now())) continue;
        const book = await io.get('/markets/'+market.ticker+'/orderbook?depth=100');
        const quote = quoteBook(book.body,'NO',config.contractsPerOrder,config.maxPriceCents);
        if (quote && quote.reserveCents<=config.maxOrderCostCents && quote.conditionalProfitCents>=config.minConditionalProfitCents)
          choices.push({market,quote,listing});
      }
    }
    const best = choices.sort((a,b)=>a.quote.reserveCents-b.quote.reserveCents)[0];
    if (!best) continue;
    const book = await io.get('/markets/'+best.market.ticker+'/orderbook?depth=100');
    const quote = quoteBook(book.body,'NO',config.contractsPerOrder,config.maxPriceCents);
    const now = Date.now();
    if (!quote || quote.reserveCents>config.maxOrderCostCents || quote.conditionalProfitCents<config.minConditionalProfitCents ||
        now-evidence.requestedAt>config.maxSourceAgeMs || now-book.requestedAt>config.maxQuoteAgeMs ||
        now>=Date.parse(auction.deadline) || !checkMarketActive(best.market,now)) continue;
    const row = {ticker:best.market.ticker, sale:auction.sale, event:best.listing.event, artist:target.artist, lot:target.lot,
      threshold:best.market.floor_strike, side:'NO', decision:'paper_buy_no', strategy:'explicit_unsold',
      source:url, observedAt:new Date(evidence.receivedAt).toISOString(), bookAt:new Date(book.receivedAt).toISOString(),
      auctionStatus:auction.house==='phillips'?'BoughtIn':'is_unsold=true', settlementSource:'Artnet',
      termsUrl, quote, hypothetical:true, actualProfit:null};
    if (saveObservation(db,row,config,key)) {
      await log(row);
      if(row.decision==='paper_buy_no') summary.paperEntries++;
    }
  }
  return summary;
}
