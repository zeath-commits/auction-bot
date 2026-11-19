import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { christies, phillips } from './parsers.mjs';
import { Transport } from './transport.mjs';
import { Journal } from './journal.mjs';
import { requireThat, validateConfig, validateWatchlist, artworkKey, checkEvent, checkLot,
  checkFees, quoteBook, checkMarketActive, orderV2, summarizeReceipt, sha, decimal } from './core.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const parsers = { christies, phillips };

export async function readAuction(io, auction) {
  const r = await io.request(auction.sourceUrl);
  return { ...r, rows: parsers[auction.house](r.text, auction.sale), sourceHash: sha(r.text) };
}

async function paged(io, route, field) {
  const rows = []; let cursor = '';
  const seen = new Set();
  do {
    const r = await io.get(route + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), true);
    requireThat(Array.isArray(r.body[field]), 'Account response requires review: ' + field);
    rows.push(...r.body[field]);
    cursor = r.body.cursor || '';
    requireThat(!cursor || !seen.has(cursor), 'Repeated account pagination cursor');
    seen.add(cursor);
    requireThat(seen.size <= 100, 'Account pagination exceeded limit');
  } while (cursor);
  return rows;
}

export async function assertNoExistingExposure(io, auction, target, config, expected = new Map()) {
  // Includes both Klimt event listings: these are the same artwork.
  const events = auction.targets.filter(t => t.id === target.id).map(t => t.event);
  const positions = await paged(io, `/portfolio/positions?limit=1000&subaccount=${config.subaccount}`, 'market_positions');
  const remaining = new Map(expected);
  for (const p of positions.filter(p => events.some(e => p.ticker?.startsWith(e + '-')))) {
    requireThat(typeof p.position_fp === 'string' && /^-?\d+(\.\d{1,2})?$/.test(p.position_fp), 'Invalid account position');
    requireThat(Math.round(Number(p.position_fp)*100) === (remaining.get(p.ticker) ?? 0), 'Existing position on this artwork; skipped to avoid changing manual exposure');
    remaining.delete(p.ticker);
  }
  requireThat([...remaining.values()].every(n=>n===0), 'Existing position differs from journal');
  for (const event of events) {
    const orders = await paged(io, `/portfolio/orders?status=resting&event_ticker=${event}&limit=1000&subaccount=${config.subaccount}`, 'orders');
    requireThat(orders.length === 0, 'Resting order exists on this artwork');
  }
}

function usableQuote(body, side, config) {
  const q = quoteBook(body, side, config.contractsPerOrder, config.maxPriceCents);
  return q && q.reserveCents <= config.maxOrderCostCents && q.conditionalProfitCents >= config.minConditionalProfitCents ? q : null;
}

export async function processTarget({ io, auction, target, source, config, journal, live, log, stop }) {
  const key = artworkKey(auction, target);
  if (journal.blocked(key)) return;
  const lot = checkLot(source.rows, target);
  if (!lot) return;
  const event = await io.get('/events/' + target.event + '?with_nested_markets=true');
  const markets = checkEvent(event.body, target).filter(m => checkMarketActive(m, Date.now()));
  const choices = [];
  for (const m of markets) {
    await stop();
    const side = lot.amount > m.floor_strike ? 'YES' : 'NO';
    const book = await io.get('/markets/' + m.ticker + '/orderbook?depth=100');
    const quote = usableQuote(book.body, side, config);
    if (quote) choices.push({ ticker: m.ticker, side, quote });
    await log('quote_check', { ticker: m.ticker, side, sourcePrice: lot.amount, quote,
      requestedAt: book.requestedAt, receivedAt: book.receivedAt });
    await sleep(150);
  }
  if (!choices.length) return;
  choices.sort((a, b) => b.quote.conditionalProfitCents - a.quote.conditionalProfitCents);
  const chosen = choices[0];
  // Two independent HTTP reads, not a persisted external "signal" file.
  const confirmation = await readAuction(io, auction);
  const confirmedLot = checkLot(confirmation.rows, target);
  requireThat(confirmedLot?.amount === lot.amount, 'Published result changed or became unavailable');
  const fees = await io.get('/series/KXART'); checkFees(fees.body);
  const exchange = await io.get('/exchange/status');
  requireThat(exchange.body.exchange_active === true && exchange.body.trading_active === true, 'Exchange is paused');
  if (live) await assertNoExistingExposure(io, auction, target, config);
  const finalEvent = await io.get('/events/' + target.event + '?with_nested_markets=true');
  const market = checkEvent(finalEvent.body, target).find(m => m.ticker === chosen.ticker);
  requireThat(market && checkMarketActive(market, Date.now()), 'Market closed before execution check');
  const finalBook = await io.get('/markets/' + chosen.ticker + '/orderbook?depth=100');
  const finalQuote = usableQuote(finalBook.body, chosen.side, config);
  if (!finalQuote) { await log('quote_disappeared', { ticker: chosen.ticker }); return; }
  const candidate = { ...chosen, quote: finalQuote, artworkKey: key, clientOrderId: randomUUID(),
    event: target.event, lot: target.lot, artist: target.artist, title: target.title,
    sourcePrice: confirmedLot.amount, sourceUrl: auction.sourceUrl,
    sourceHash: confirmation.sourceHash, sourceReceivedAt: confirmation.receivedAt,
    sourceRequestedAt: confirmation.requestedAt, quoteRequestedAt: finalBook.requestedAt,
    quoteReceivedAt: finalBook.receivedAt,
    url: 'https://kalshi.com/markets/kxart/' + target.event.toLowerCase(),
    settlementSource: 'Artnet', settlementConfirmed: false };
  await submitCandidate({ io, candidate, config, journal, live, stop, log, deadline: Date.parse(auction.deadline) });
}

export async function submitCandidate({ io, candidate, config, journal, live, stop, log, deadline }) {
  function checkFresh() {
    const now = Date.now();
    requireThat(now < deadline, 'Auction watch window expired');
    // Age measured from request start: a slow response does not appear fresh.
    requireThat(now - candidate.sourceRequestedAt <= config.maxSourceAgeMs, 'Auction result check is stale');
    requireThat(now - candidate.quoteRequestedAt <= config.maxQuoteAgeMs, 'Orderbook check is stale');
  }
  await stop(); checkFresh();
  journal.checkBudget(candidate, config);
  const payload = orderV2(candidate, config.subaccount);
  await journal.append({ type: 'intent', ...candidate, payload });
  try {
    // Persist before attempting a POST. Crash/restart will not resubmit this intent.
    await stop(); checkFresh();
    if (!live) {
      await journal.append({ type: 'receipt', clientOrderId: candidate.clientOrderId,
        hypothetical: true, fillAssumed: false, displayedDepthCoveredQuantity: candidate.quote.quantity,
        conditionalProfitCents: candidate.quote.conditionalProfitCents, realizedProfit: null });
      await log('PAPER_OPPORTUNITY', candidate);
    } else {
      requireThat(config.liveEnabled && io.live, 'Live execution is disabled');
      const response = await io.createOrder(payload);
      const receipt = summarizeReceipt(response.body, candidate);
      await journal.append({ type: 'receipt', clientOrderId: candidate.clientOrderId, ...receipt });
      await log('ORDER_RECEIPT', { ...candidate, receipt });
    }
  } catch (e) {
    await journal.append({ type: 'unknown', clientOrderId: candidate.clientOrderId,
      reason: String(e.message), action: 'No retry. Reconcile account before restarting.' });
    throw e;
  }
}

export async function preflight(io, watchlist, sweepCheck) {
  checkFees((await io.get('/series/KXART')).body);
  const summary = [];
  for (const auction of watchlist.auctions) {
    const source = await readAuction(io, auction);
    let published = 0, contracts = 0;
    const books={active:0,quoted:0,fresh:0};
    for (const target of auction.targets) {
      if (checkLot(source.rows, target)) published++;
      const event = await io.get('/events/' + target.event + '?with_nested_markets=true');
      const ms = checkEvent(event.body, target);
      requireThat(ms.length === target.markets.length, 'Frozen contracts missing');
      contracts += ms.length;
      if(sweepCheck){
        const b=await sweepCheck(event.body,target);
        for(const k of Object.keys(books))books[k]+=b[k];
      }
      await sleep(150);
    }
    summary.push({ house: auction.house, targets: auction.targets.length, contracts,
      strictPublishedResults: published, startsAt: auction.startAt, endsAt: auction.deadline,
      sourcesAndRulesMatched: true, ...(sweepCheck?{books}:{}) });
  }
  return summary;
}

export async function main(args = process.argv.slice(2)) {
  const sweepArg=args.find(a=>a.startsWith('--sweep-date='));
  const sweepDate=sweepArg?.slice('--sweep-date='.length);
  if(sweepArg){
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(sweepDate) && !args.some(a=>['--paper-calendar','--paper-bids','--watch-offers','--check-account'].includes(a)),
      'Use --sweep-date=YYYY-MM-DD with the paper, preflight or live session mode');
  }
  const calendar = args.includes('--paper-calendar');
  requireThat(!calendar || (!args.includes('--live') && (args.includes('--paper') || args.includes('--paper-bids'))), 'Additional auction calendar is paper-only');
  const watchFile = calendar || sweepArg ? 'paper-calendar.json' : 'watchlist.json';
  if (args.includes('--paper-bids')) {
    requireThat(args.every(a => ['--paper-bids','--paper-calendar','--once'].includes(a)), 'Bid-threshold mode only supports paper trading');
    return (await import('./paper-bids.mjs')).runBidPaper(args.includes('--once'),watchFile);
  }
  const offers = args.includes('--watch-offers');
  const accountCheck = args.includes('--check-account');
  requireThat(!accountCheck || args.length===1,'Run account check separately');
  const known = new Set(['--paper', '--paper-calendar', '--live', '--acknowledge-live-trading', '--preflight', '--watch-offers', '--once', '--help','--check-account',sweepArg]);
  requireThat(args.every(a => known.has(a)) && new Set(args).size === args.length, 'Unknown or duplicate argument');
  if (args.includes('--help')) {
    console.log('node bot.mjs --preflight | --paper [--watch-offers] [--once] | --live [--watch-offers] --acknowledge-live-trading\nUse --sweep-date=YYYY-MM-DD to size orders from available auction depth. Default: paper. See README.md for setup and limits.');
    return;
  }
  const live = args.includes('--live');
  requireThat(!(live && (args.includes('--paper') || args.includes('--preflight') || args.includes('--once'))), 'Conflicting modes');
  requireThat(!live || args.includes('--acknowledge-live-trading'), 'Live execution requires explicit local activation');
  let configText;
  try { configText = await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    requireThat(!live, 'Create and review config.json before activating live execution');
    configText = await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8');
  }
  const sweep=sweepArg ? await import('./auction-sweep.mjs') : null;
  const baseConfig=validateConfig(JSON.parse(configText));
  const config=sweep ? sweep.datedSweepConfig(baseConfig) : baseConfig;
  if(accountCheck) {
    const reader = new Transport(config,{live:false});
    await reader.loadCredentials(true);
    await reader.get('/portfolio/balance?subaccount='+config.subaccount,true);
    console.log('Authenticated balance read succeeded for subaccount '+config.subaccount+'.');
    return;
  }
  requireThat(!live || config.liveEnabled, 'config.json liveEnabled is false');
  const file = JSON.parse(await fs.readFile(path.join(ROOT, watchFile), 'utf8'));
  const watchlist = validateWatchlist(sweep ? sweep.sessionWatchlist(file,sweepDate) : file);
  let stopped = false;
  const onSignal = () => { stopped = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  async function stop() {
    requireThat(!stopped, 'Stopped by user');
    try { await fs.access(path.join(ROOT, 'STOP')); throw new Error('STOP file present'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const io = new Transport(config, { live, checkStop: stop });
  let journal;
  const mode = live ? 'live' : 'paper';
  const runtime = path.join(ROOT, 'runtime', calendar ? 'paper-calendar' : sweep && !live ? 'paper-sweep-'+sweepDate : mode);
  async function log(type, data) {
    const row = { at: new Date().toISOString(), mode, type, ...data };
    await fs.appendFile(path.join(runtime, 'observations.jsonl'), JSON.stringify(row) + '\n');
    if (['PAPER_OPPORTUNITY', 'ORDER_RECEIPT', 'STOPPED'].includes(type)) console.log('\x07' + JSON.stringify(row, null, 2));
  }
  try {
    await stop();
    if (args.includes('--preflight')) {
      const result = { checkedAt: new Date().toISOString(), readOnly: true, authenticatedRequests: 0,
        orderSubmissions: 0, auctions: await preflight(io, watchlist,sweep && ((body,target)=>sweep.sessionBookCheck(io,body,target,config))) };
      if(sweep)result.session={date:sweepDate,liveEnabled:config.liveEnabled,maxPriceCents:config.maxPriceCents,
        minConditionalProfitCents:config.minConditionalProfitCents,datedAuctionSizing:config.datedAuctionSizing,
        maxTotalReservedCents:config.datedAuctionSizing==='available_cash'?null:config.maxTotalReservedCents,
        paperBudgetCents:config.datedAuctionSizing==='available_cash'?config.datedPaperBankrollCents:config.maxTotalReservedCents,
        sizing:config.datedAuctionSizing==='available_cash'?'Available subaccount cash including fees; paper uses its simulated bankroll':'Repeated whole-contract depth within available cash and remaining journal budget'};
      await fs.mkdir(path.join(ROOT, 'runtime'), { recursive: true });
      await fs.writeFile(path.join(ROOT, 'runtime', 'preflight.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2)); return;
    }
    const tailMs = offers || sweep ? config.offerTailHours * 3600000 : 0;
    const lastDeadline = Math.max(...watchlist.auctions.map(a => Date.parse(a.deadline))) + tailMs;
    requireThat(Date.now() < lastDeadline, 'Watchlist expired; review new auctions before another run');
    journal = new Journal(runtime, mode); await journal.open();
    requireThat(journal.unresolved().length === 0, 'Unresolved order intent; manual account reconciliation required');
    if (live) await io.loadCredentials();
    console.log(`${mode.toUpperCase()} mode. Source polls ${config.pollIntervalMs}ms plus processing; results and fills are not guaranteed. Ctrl+C or create STOP to stop.`);
    do {
      await stop();
      const cycleStarted = Date.now();
      for (const auction of watchlist.auctions) {
        const deadline = Date.parse(auction.deadline) + tailMs;
        if (Date.now() < Date.parse(auction.startAt) || Date.now() >= deadline) continue;
        if(sweep){
          try {await sweep.scanSweep({io,auction,config,journal,live,stop,log,deadline});}
          catch(e){
            await stop();
            if(journal.unresolved().length || !/HTTP (429|5\d\d)|timeout|timed out|fetch failed|Cached response too old/i.test(e.message))throw e;
            await log('sweep_read_deferred',{sale:auction.sale,error:e.message});
          }
          continue;
        }
        if (offers) {
          const {scanOffers} = await import('./watch-offers.mjs');
          await scanOffers({io,auction,config,journal,live,stop,log,deadline});
          continue;
        }
        const source = await readAuction(io, auction);
        // Validate every mapped lot, including already attempted lots, before acting.
        for (const target of auction.targets) checkLot(source.rows, target);
        await log('source_check', { house: auction.house, sourceHash: source.sourceHash,
          requestedAt: source.requestedAt, receivedAt: source.receivedAt,
          lots: source.rows.map(l => ({ lot: l.lot, amount: l.amount, strictPublishedResult: l.strictPublishedResult })) });
        for (const target of auction.targets) {
          if (journal.intents().length >= config.maxOrders) break;
          await processTarget({ io, auction, target, source, config, journal, live, log, stop });
        }
      }
      const status = { mode, at: new Date().toISOString(), state: 'waiting_or_monitoring',
        attemptedArtworks: journal.intents().length,
        reservedCents: journal.committedCents(),
        lastDeadline: new Date(lastDeadline).toISOString(), actualProfit: null };
      await fs.writeFile(path.join(runtime, 'status.json'), JSON.stringify(status, null, 2));
      if (args.includes('--once')) break;
      const nextCycle = Math.min(lastDeadline, cycleStarted + config.pollIntervalMs);
      while (Date.now() < nextCycle) { await sleep(Math.min(1000, nextCycle - Date.now())); await stop(); }
    } while (Date.now() < lastDeadline);
    await log('FINISHED', { reason: args.includes('--once') ? 'One read-only paper cycle' : 'Auction windows ended' });
    await fs.writeFile(path.join(runtime, 'status.json'), JSON.stringify({ mode, at: new Date().toISOString(), state: 'finished' }, null, 2));
  } catch (e) {
    if (journal?.lock) {
      await log('STOPPED', { error: e.message });
      await fs.writeFile(path.join(runtime, 'status.json'), JSON.stringify({ mode, at: new Date().toISOString(), state: 'stopped', error: e.message }, null, 2));
    }
    throw e;
  } finally {
    await journal?.close();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
