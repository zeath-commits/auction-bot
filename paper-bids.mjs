import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { christies } from './parsers.mjs';
import { Transport } from './transport.mjs';
import { scanUnsold } from './paper-unsold.mjs';
import { checkEvent, checkFees, checkMarketActive, quoteBook, requireThat, validateConfig, validateWatchlist } from './core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

export function crossedContracts(target, row) {
  if (!row?.identityValid || row.id !== target.id || row.lot !== target.lot ||
      row.artist !== target.artist || row.title !== target.title || !row.inProgress ||
      row.closed || row.withdrawn || row.amount !== null || row.currency !== 'USD' ||
      !Number.isSafeInteger(row.liveBid) || row.liveBid <= 0) return [];
  return target.markets.filter(m => m.strikeType === 'greater' && row.liveBid > m.threshold);
}

// One independent paper observation per contract. The transaction also caps
// simultaneous entries if two readers happen to observe the same threshold.
export function saveObservation(db, row, config, key=row.ticker) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(reserve),0) AS cost FROM signals WHERE reserve > 0').get();
    if (row.quote && (totals.count >= config.maxOrders || totals.cost + row.quote.reserveCents > config.maxTotalReservedCents)) row.decision = 'budget_limit';
    const reserve = ['paper_buy_yes','paper_buy_no'].includes(row.decision) ? row.quote.reserveCents : 0;
    const result = db.prepare(`INSERT INTO signals(ticker,reserve,detail) VALUES(?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET reserve=excluded.reserve, detail=excluded.detail
      WHERE signals.reserve=0 AND excluded.reserve>0`).run(key, reserve, JSON.stringify(row));
    db.exec('COMMIT');
    return result.changes === 1;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function scan({auction, io, config, db, log}) {
  const source = await io.request(auction.sourceUrl);
  const rows = christies(source.text, auction.sale);
  let matched = 0, bids = 0;
  for (const target of auction.targets) {
    const matches = rows.filter(r => r.lot === target.lot && r.id === target.id && r.artist === target.artist && r.title === target.title && r.identityValid);
    if (matches.length !== 1) continue;
    matched++;
    const row = matches[0];
    if (row.liveBid) bids++;
    const crossed = crossedContracts(target, row).filter(m => !db.prepare('SELECT 1 FROM signals WHERE ticker=? AND reserve>0').get(m.ticker));
    if (!crossed.length) continue;
    checkFees((await io.get('/series/KXART')).body);
    const exchange = (await io.get('/exchange/status')).body;
    const markets = checkEvent((await io.get('/events/' + target.event + '?with_nested_markets=true')).body, target);
    // Start at the highest threshold below this bid when several appear at once.
    for (const contract of crossed.sort((a,b) => b.threshold-a.threshold)) {
      const market = markets.find(m => m.ticker === contract.ticker);
      const signal = {ticker:contract.ticker, sale:auction.sale, lot:row.lot, artist:row.artist, threshold:contract.threshold,
        observedBidUSD:row.liveBid, source:auction.sourceUrl, observedAt:new Date(source.receivedAt).toISOString(),
        side:'YES', decision:'market_inactive', quote:null, hypothetical:true, actualProfit:null};
      if (exchange.exchange_active && exchange.trading_active && market && checkMarketActive(market, Date.now())) {
        const book = await io.get('/markets/' + contract.ticker + '/orderbook?depth=100');
        signal.bookAt = new Date(book.receivedAt).toISOString();
        if (Date.now() >= Date.parse(auction.deadline) || Date.now()-source.requestedAt > config.maxSourceAgeMs || Date.now()-book.requestedAt > config.maxQuoteAgeMs) continue;
        signal.quote = quoteBook(book.body, 'YES', config.contractsPerOrder, config.maxPriceCents);
        signal.decision = signal.quote && signal.quote.reserveCents <= config.maxOrderCostCents &&
          signal.quote.conditionalProfitCents >= config.minConditionalProfitCents ? 'paper_buy_yes' : 'insufficient_depth_or_price';
      }
      if (saveObservation(db, signal, config)) await log(signal);
    }
  }
  return {matchedEvents:matched, eventsWithPublishedBid:bids};
}

export function activeSales(auctions, now) {
  return auctions.filter(a => now>=Date.parse(a.startAt) && now<Date.parse(a.deadline));
}

export async function runBidPaper(once=false, watchFile='watchlist.json') {
  let raw;
  try { raw=await fs.readFile(path.join(root,'config.json'),'utf8'); }
  catch(e) { if(e.code!=='ENOENT') throw e; raw=await fs.readFile(path.join(root,'config.example.json'),'utf8'); }
  const config=validateConfig(JSON.parse(raw));
  const {auctions}=validateWatchlist(JSON.parse(await fs.readFile(path.join(root,watchFile),'utf8')));
  const end=Math.max(...auctions.map(a=>Date.parse(a.deadline)));
  requireThat(Date.now()<end,'No remaining auction watch window');
  // Keep the existing journal name and shared paper budget across this calendar.
  const journalSale=auctions.find(a=>a.house==='christies') ?? auctions[0];
  const dir=path.join(root,'runtime','paper-bids',journalSale.sale);
  await fs.mkdir(dir,{recursive:true});
  const db=new DatabaseSync(path.join(dir,'signals.sqlite'));
  db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS signals(ticker TEXT PRIMARY KEY, reserve INTEGER NOT NULL, detail TEXT NOT NULL)');
  const io=new Transport(config,{live:false});
  const log = row => fs.appendFile(path.join(dir,'signals.jsonl'),JSON.stringify(row)+'\n');
  try {
    do {
      try { await fs.access(path.join(root,'STOP')); break; } catch(e) { if(e.code!=='ENOENT') throw e; }
      const now=Date.now(), active=activeSales(auctions,now);
      let delay=active.length ? config.pollIntervalMs : Math.min(60000,...auctions.map(a=>Date.parse(a.startAt)-now).filter(ms=>ms>0));
      const status={state:active.length?'monitoring':'waiting',bids:{},unsold:{},unsoldBySale:{}};
      for (const sale of active) {
        if (sale.house==='christies') {
          try {
            const observed=await scan({auction:sale,io,config,db,log});
            status.bids[sale.sale]=observed;
            status.matchedEvents=(status.matchedEvents??0)+observed.matchedEvents;
            status.eventsWithPublishedBid=(status.eventsWithPublishedBid??0)+observed.eventsWithPublishedBid;
          }
          catch(e) { status.bids[sale.sale]={error:e.message}; status.state='read_error'; status.error=e.message; delay=Math.max(delay,30000); }
        }
        try { status.unsoldBySale[sale.sale]=await scanUnsold({auction:sale,io,config,db,log,saveObservation}); }
        catch(e) { status.unsoldBySale[sale.sale]={error:e.message}; delay=Math.max(delay,30000); }
        status.unsold[sale.house]=status.unsoldBySale[sale.sale];
      }
      const counts=db.prepare('SELECT COUNT(*) AS observed,COUNT(CASE WHEN reserve>0 THEN 1 END) AS paperBuys FROM signals').get();
      await fs.writeFile(path.join(dir,'status.json'),JSON.stringify({...status,...counts,at:new Date().toISOString(),pid:process.pid},null,2));
      if(once) break;
      await sleep(Math.min(delay,Math.max(0,end-Date.now())));
    } while(Date.now()<end);
  } finally { db.close(); }
}
