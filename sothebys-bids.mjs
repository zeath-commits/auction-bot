import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Transport } from './transport.mjs';
import { askLevels, checkFees, checkMarketActive } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';

import { initSoldStudy, scanSold, publishedVerdicts } from './sothebys-sold.mjs';

import { saleTiming } from './sale-timing.mjs';
import { observeAuctionQuotes } from './auction-quote-timing.mjs';

const calendar = JSON.parse(
  fs.readFileSync(new URL('./sothebys-bid-calendar.json', import.meta.url))
);
const strategy = 'sothebys_live_bid';
const saleSlots = calendar.targets.reduce((sum, target) => sum + target.contracts, 0);

export function extractSothebys(html, c, detailTarget = null) {
  const raw = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!raw) throw Error('Sotheby’s public catalog data missing');
  const p = JSON.parse(raw[1]).props?.pageProps;
  if (p?.auctionId !== c.auctionId || !p.apolloCache)
    throw Error('Auction identity changed');
  if (detailTarget && p.lotId !== detailTarget.id)
    throw Error('Lot page identity changed');
  return (detailTarget ? [detailTarget] : c.targets).map((t) => {
    const matches = Object.values(p.apolloCache).filter(
      (x) =>
        x.__typename === (detailTarget ? 'LotV2' : 'LotCard') &&
        x.lotNumber?.lotDisplayNumber === t.lot &&
        x.sapAuctionSaleNumber === c.sale
    );
    const card = matches[0];
    if (
      matches.length !== 1 ||
      card.lotId !== t.id ||
      card.title !== t.title ||
      card.creatorsDisplayTitle !== t.artist ||
      c.url + '/' + (detailTarget ? card.slug : card.slug?.lotSlug) !== t.url
    )
      throw Error('Lot identity changed: ' + t.lot);
    const state = p.apolloCache[card.bidState?.__ref];
    if (!state) throw Error('Bid state missing: ' + t.lot);
    const withdrawal = detailTarget
      ? p.apolloCache[card.withdrawnState?.__ref]?.state
      : card.withdrawnState?.state;
    const included = ['NotAffected', 'UnWithdrawn'].includes(withdrawal);
    const phase = state.bidTypeV2?.liveBidPhase,
      price = Number(state.currentBidV2?.amount);
    const eligible =
      included &&
      state.isClosed === false &&
      phase === 'Live' &&
      state.sold?.isSold === false &&
      state.currentBidV2?.currency === 'USD' &&
      Number.isSafeInteger(state.numberOfBids) &&
      state.numberOfBids > 0 &&
      Number.isSafeInteger(price) &&
      price > 0;
    const final = state.sold?.premiums?.finalPriceV2;
    const auction = detailTarget && p.apolloCache[card.auction?.__ref];
    const inheritedUSD =
      auction?.auctionId === c.auctionId &&
      auction.currency === 'USD' &&
      auction.currencyV2 === 'USD';
    const currency = final?.currency ?? (inheritedUSD ? 'USD' : null);
    const closed =
      state.isClosed === true &&
      phase === 'Closed' &&
      included &&
      state.sold?.__typename === 'ResultVisible';
    const salePrice =
      closed &&
      state.sold.isSold === true &&
      currency === 'USD' &&
      final != null &&
      Number.isSafeInteger(Number(final.amount)) &&
      Number(final.amount) > 0
        ? Number(final.amount)
        : null;
    return {
      event: t.event,
      lot: t.lot,
      irrevocableBid: detailTarget && Array.isArray(card.symbolsV2) &&
        card.symbolsV2.every(s => typeof s?.lotSymbolId === 'string')
        ? card.symbolsV2.some(s => s.lotSymbolId === 'IrrevocableBids') : null,
      phase,
      closed: state.isClosed,
      withdrawn: withdrawal,
      reserveMet: state.reserveMet,
      count: state.numberOfBids,
      bid: eligible ? price : null,
      salePrice,
      explicitUnsold: closed && state.sold.isSold === false
    };
  });
}

export function sourceGeneration(at, httpDate, age) {
  // The CDN can advance Date and Age together while returning the same cached page.
  return Math.min(httpDate, Math.floor(at / 1000) * 1000 - age * 1000);
}
export async function readSalePage(target = null) {
  const start = Date.now();
  const r = await fetch(target?.url ?? calendar.url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(7500),
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!r.ok) throw Error('Sotheby’s catalog HTTP ' + r.status);
  const data = await r.text(),
    at = Date.now(),
    httpDate = Date.parse(r.headers.get('date')),
    age = Number(r.headers.get('age') ?? 0),
    generation = sourceGeneration(at, httpDate, age);
  return {
    kind: target ? 'lot' : 'catalog',
    url: target?.url ?? calendar.url,
    at,
    requestedAt: start,
    httpDate,
    etag: r.headers.get('etag'),
    generation,
    age,
    soldFresh:
      at - start <= 2000 &&
      Number.isFinite(generation) &&
      httpDate <= at + 1000 &&
      Number.isInteger(age) &&
      at - generation >= -1000 &&
      at - generation <= 120000 &&
      age >= 0 &&
      age <= 120,
    fresh:
      at - start <= 2000 &&
      Number.isFinite(generation) &&
      httpDate <= at + 1000 &&
      Number.isInteger(age) &&
      at - generation >= -1000 &&
      at - generation <= 6000 &&
      age >= 0 &&
      age <= 4,
    lots: extractSothebys(data, calendar, target)
  };
}

export async function marketList(io, t) {
  const { body } = await io.get(
      '/events/' + t.event + '?with_nested_markets=true'
    ),
    e = body.event;
  if (
    e?.event_ticker !== t.event || e.fee_type_override != null || e.fee_multiplier_override != null ||
    e.settlement_sources?.length !== 1 ||
    e.settlement_sources[0].name !== 'Sotheby’s' ||
    e.settlement_sources[0].url !== t.source
  )
    throw Error('Settlement source changed: ' + t.event);
  const markets = body.markets?.length ? body.markets : e.markets;
  const rules = markets
    .map((m) => [
      m.ticker,
      m.rules_primary,
      m.rules_secondary,
      m.floor_strike,
      m.strike_type,
      m.notional_value_dollars,
      m.market_type
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (
    createHash('sha256').update(JSON.stringify(rules)).digest('hex') !==
      t.ruleHash ||
    markets.length !== t.contracts
  )
    throw Error('Market rules changed: ' + t.event);
  return markets;
}

function repeatedBid(first, second) {
  return first && second &&
    first.ticker === second.ticker &&
    second.strike === first.strike &&
    second.bid >= first.bid &&
    second.count >= first.count &&
    second.generation - first.generation >= 2000 &&
    second.at - first.at >= 1000 &&
    second.at - first.at <= 30000;
}

function repeatedOffer(first, second, highPriceStudy) {
  return [first, second].every(
      (q) =>
        q.size >= 1 &&
        (highPriceStudy
          ? [0.97, 0.98].includes(q.price)
          : q.price > 0 && q.price <= 0.95)
    ) &&
    second.price <= first.price;
}

export function confirmedBid(first, second, highPriceStudy = false) {
  return repeatedBid(first, second) && first.bid > first.strike && repeatedOffer(first, second, highPriceStudy);
}

// Standard New York fine-art buyer's premium, used as a forecast for this sale.
// Even a closed lot's displayed bid can produce a different published total.
export function estimatedSalePrice(bid) {
  if (!Number.isSafeInteger(bid) || bid <= 0) return null;
  const cents = 100 * bid + 28 * Math.min(bid, 2000000) +
    22 * Math.min(Math.max(bid - 2000000, 0), 6000000) + 15 * Math.max(bid - 8000000, 0);
  return Number.isSafeInteger(cents) ? cents / 100 : null;
}

export function confirmedPremiumSignal(first, second) {
  return repeatedBid(first,second) && second.bid <= second.strike && estimatedSalePrice(first.bid) > first.strike;
}

export function confirmedPremiumBid(first, second) {
  return confirmedPremiumSignal(first,second) && second.bookAsOf > first.bookAsOf && repeatedOffer(first,second,false);
}

export async function observeSothebysBids({
  db,
  config,
  stop,
  status,
  limits
}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS sothebys_bid_scans(at INTEGER PRIMARY KEY, fresh INTEGER, detail TEXT);CREATE TABLE IF NOT EXISTS sothebys_bid_quotes(ticker TEXT,at INTEGER,detail TEXT,PRIMARY KEY(ticker,at))'
  );
  const io = new Transport({ ...config, maxHttpAgeSeconds: 2 });
  Object.assign(status, {
    scheduled: calendar.scheduled,
    url: calendar.url,
    targets: calendar.targets.map((t) => ({ event: t.event, title: t.title })),
    state: 'Scheduled',
    at: new Date().toISOString()
  });
  initSoldStudy(db);
  const timing = saleTiming(db, calendar.targets);
  const verdicts=publishedVerdicts(db);
  status.quotes = {};
  observeAuctionQuotes({db,io,calendar,marketList,stop,status:status.quotes,timing})
    .catch(e => { status.quotes.error = e.message; });
  status.timing = timing.summary();
  let previous = new Map(),
    previousSold = new Map();
  const lotBooks=new Map();
  status.lotSales={};
  let nextDisclosureCheck = 0;
  const deadline = Date.parse(calendar.settlementWatchEnd);
  while (!stop()) {
    const now = Date.now(),
      toStart = Date.parse(calendar.start) - now;
    const tail = now >= Date.parse(calendar.end);
    if (now >= deadline) {
      status.state = 'Window ended';
      status.at = new Date().toISOString();
      return;
    }
    if (toStart > 0) {
      if (now >= nextDisclosureCheck && toStart > 10000) {
        const checks = await Promise.allSettled(calendar.targets.map(async t => {
          const read = await readSalePage(t);
          timing.recordDisclosure(read);
        }));
        const failed = checks.filter(r => r.status === 'rejected').length;
        status.disclosureErrors = failed;
        nextDisclosureCheck = Date.now() + (failed ? 60000 : 900000);
      }
      await sleep(Math.max(0, Math.min(60000, Date.parse(calendar.start) - Date.now())));
      continue;
    }
    let delay = tail ? 60000 : 10000;
    const conflicts=verdicts.conflicts();
    const waiting=tail ? [] : timing.remaining();
    const remaining=calendar.targets.filter(t=>conflicts.has(t.event)||waiting.includes(t));
    const ctx = { io, marketList, stop };
    const timingErrors = [];
    const track = (promise) =>
      promise.catch((e) => {
        timingErrors.push(e.message);
      });
    const reads = remaining.map(t=>track((async ()=>{
      const read=await readSalePage(t);
      verdicts.record('lot',read);
      const recordTiming=track(timing.record('lot',read,ctx));
      try {
        const lot=read.lots[0], prior=lotBooks.get(t.event) ?? new Map();
        if (!read.soldFresh || !(lot.salePrice>0) || !verdicts.accepts(t.event,lot.salePrice)) {
          lotBooks.delete(t.event);
          return;
        }
        const scan=async (source,previous)=>{
          const outcome=await scanSold({db,io,source,targets:[t],saleSlots,marketList,previous,stop,tail:false,deadline,
            accept:verdicts.accepts});
          if (limits && outcome.next.size) limits.record([...outcome.next.values()],previous,30000);
          lotBooks.set(t.event,outcome.next);
          status.lotSales[t.event]={...outcome.status,at:new Date().toISOString(),price:source.lots[0].salePrice};
          return outcome.next;
        };
        const quotes=await scan(read,prior);
        if (!prior.size && [...quotes.values()].some(q=>askLevels(q.book,q.side,99).some(l=>l.quantity>=1e6))) {
          await sleep(2200);
          if (stop() || Date.now()>=deadline) return;
          const confirm=await readSalePage(t);
          verdicts.record('lot',confirm);
          await scan(confirm,quotes);
        }
      } catch(e) {
        lotBooks.delete(t.event);
        status.lotSales[t.event]={at:new Date().toISOString(),error:e.message};
        throw e;
      } finally {
        await recordTiming;
      }
    })()));

    try {
      const s = await readSalePage(),
        next = new Map();
      verdicts.record('catalog',s);
      if (remaining.length)
        reads.push(
          track(
            timing.record(
              'catalog',
              {
                ...s,
                lots: s.lots.filter((l) =>
                  remaining.some((t) => t.event === l.event)
                )
              },
              ctx
            )
          )
        );
      let priced = 0, premiumCrossings = 0,
        crossed = 0;
      db.prepare('INSERT OR IGNORE INTO sothebys_bid_scans VALUES(?,?,?)').run(
        s.at,
        Number(s.fresh),
        JSON.stringify(s)
      );
      const live = s.fresh && !tail ? s.lots.filter((l) => l.bid !== null) : [];
      for (const l of live) {
        const t = calendar.targets.find((t) => t.event === l.event),
          estimated = estimatedSalePrice(l.bid),
          markets = (await marketList(io, t)).filter(
            (m) => (m.floor_strike < l.bid || m.floor_strike < estimated) && checkMarketActive(m, Date.now())
          );
        const rawCrossings = markets.filter(m=>m.floor_strike < l.bid).length;
        crossed += rawCrossings;
        premiumCrossings += markets.length - rawCrossings;
        if (!markets.length) continue;
        checkFees((await io.get('/series/KXART')).body);
        const ex = (await io.get('/exchange/status')).body;
        if (!ex.trading_active || !ex.exchange_active) continue;
        const q = new URLSearchParams(
          markets.map((m) => ['tickers', m.ticker])
        );
        q.set('depth', '100');
        const books = await io.get('/markets/orderbooks?' + q);
        if (
          books.receivedAt - s.at > 5000 ||
          books.receivedAt - books.requestedAt > 2000 ||
          books.receivedAt >= Date.parse(calendar.end) ||
          stop()
        )
          continue;
        for (const m of markets) {
          const b = books.body.orderbooks.find((b) => b.ticker === m.ticker);
          if (!b || !checkMarketActive(m, books.receivedAt)) continue;
          const best = askLevels(b, 'YES', 100).find(
            (level) => level.quantity >= 1e6
          );
          const entry = {
            ticker: m.ticker,
            strike: m.floor_strike,
            bid: l.bid,
            estimatedSalePrice: estimated,
            bookAsOf: Date.parse(books.httpDate)-1000*Number(books.cacheAge??0),
            count: l.count,
            generation: s.generation,
            sourceAt: s.at,
            at: books.receivedAt,
            price: best ? best.price / 1e6 : null,
            size: best ? best.quantity / 1e6 : 0
          };
          db.prepare(
            'INSERT OR IGNORE INTO sothebys_bid_quotes VALUES(?,?,?)'
          ).run(m.ticker, entry.at, JSON.stringify(entry));
          if (best && m.floor_strike < l.bid && entry.price <= 0.95) priced++;
          next.set(m.ticker, entry);
          const prior = previous.get(m.ticker);
          if (confirmedPremiumSignal(prior,entry))
            db.prepare('INSERT OR IGNORE INTO auction_premium_signals(ticker,event,at,bid,estimated,strike) VALUES(?,?,?,?,?,?)')
              .run(m.ticker,t.event,entry.at,l.bid,estimated,m.floor_strike);
          const cohort = confirmedBid(prior, entry)
            ? strategy
            : confirmedBid(prior, entry, true)
              ? 'sothebys_bid_high'
              : confirmedPremiumBid(prior, entry) ? 'sothebys_bid_premium' : null;
          if (cohort)
            addPaper(db, {
              id: cohort + '/' + m.ticker,
              strategy: cohort,
              ticker: m.ticker,
              at: new Date(entry.at).toISOString(),
              side: 'yes',
              quantity: 1,
              price: entry.price,
              depth: Math.min(previous.get(m.ticker).size, entry.size),
              fees: Math.ceil(7 * entry.price * (1 - entry.price) - 1e-9) / 100,
              closeAt: Date.parse(m.close_time)
            });
        }
      }
      previous = next;
      try {
        const sold = await scanSold({
          db,
          io,
          source: s,
          targets: calendar.targets,
          saleSlots,
          marketList,
          previous: previousSold,
          stop,
          tail,
          deadline,
          accept:verdicts.accepts
        });
        if (limits && sold.next.size)
          limits.record(
            [...sold.next.values()],
            previousSold,
            tail ? 95000 : 30000
          );
        previousSold = sold.next;
        status.sold = { ...sold.status, at: new Date().toISOString() };
      } catch (e) {
        previousSold.clear();
        status.sold = { error: e.message, at: new Date().toISOString() };
      }
      Object.assign(status, {
        at: new Date().toISOString(),
        state: s.fresh
          ? tail
            ? 'Watching published sale prices'
            : 'Watching bids and published sale prices'
          : 'Stale or slow catalog read',
        liveLots: live.length,
        crossed,
        premiumCrossings,
        priced,
        error: null
      });
    } catch (e) {
      previous.clear();
      previousSold.clear();
      status.state = 'Retrying public data';
      status.error = e.message;
      status.at = new Date().toISOString();
      delay = 60000;
    }
    await Promise.all(reads);
    status.timing = timing.summary();
    status.timingError = timingErrors.join(' · ') || null;
    await sleep(delay);
  }
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const io = new Transport(
    JSON.parse(
      fs.readFileSync(new URL('./config.example.json', import.meta.url))
    )
  );
  const s = await readSalePage();
  let n = 0;
  for (const t of calendar.targets) n += (await marketList(io, t)).length;
  console.log(
    'Matched lots',
    s.lots.length,
    'matched direct-source contract rules',
    n,
    'currently live',
    s.lots.filter((x) => x.bid !== null).length,
    'HTTP age',
    s.age
  );
}
