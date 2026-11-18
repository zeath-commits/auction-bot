import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Transport } from './transport.mjs';
import { askLevels, checkFees, checkMarketActive } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';

import { initSoldStudy, scanSold } from './sothebys-sold.mjs';

import { saleTiming } from './sale-timing.mjs';
import { observeAuctionQuotes } from './auction-quote-timing.mjs';

const calendar = JSON.parse(
  fs.readFileSync(new URL('./sothebys-bid-calendar.json', import.meta.url))
);
const strategy = 'sothebys_live_bid';

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

async function marketList(io, t) {
  const { body } = await io.get(
      '/events/' + t.event + '?with_nested_markets=true'
    ),
    e = body.event;
  if (
    e?.event_ticker !== t.event ||
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

export function confirmedBid(first, second, highPriceStudy = false) {
  return (
    first &&
    second &&
    first.ticker === second.ticker &&
    first.bid > first.strike &&
    second.strike === first.strike &&
    second.bid >= first.bid &&
    second.count >= first.count &&
    second.generation - first.generation >= 2000 &&
    second.at - first.at >= 1000 &&
    second.at - first.at <= 30000 &&
    [first, second].every(
      (q) =>
        q.size >= 1 &&
        (highPriceStudy
          ? [0.97, 0.98].includes(q.price)
          : q.price > 0 && q.price <= 0.95)
    ) &&
    second.price <= first.price
  );
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
  status.quotes = {};
  observeAuctionQuotes({db,io,calendar,marketList,stop,status:status.quotes,timing})
    .catch(e => { status.quotes.error = e.message; });
  status.timing = timing.summary();
  let previous = new Map(),
    previousSold = new Map();
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
      await sleep(Math.min(60000, toStart));
      continue;
    }
    let delay = tail ? 60000 : 10000;
    const remaining = tail ? [] : timing.remaining();
    const ctx = { io, marketList, stop };
    const timingErrors = [];
    const track = (promise) =>
      promise.catch((e) => {
        timingErrors.push(e.message);
      });
    const reads = remaining.map((t) =>
      track(readSalePage(t).then((r) => timing.record('lot', r, ctx)))
    );

    try {
      const s = await readSalePage(),
        next = new Map();
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
      let priced = 0,
        crossed = 0;
      db.prepare('INSERT OR IGNORE INTO sothebys_bid_scans VALUES(?,?,?)').run(
        s.at,
        Number(s.fresh),
        JSON.stringify(s)
      );
      const live = s.fresh && !tail ? s.lots.filter((l) => l.bid !== null) : [];
      for (const l of live) {
        const t = calendar.targets.find((t) => t.event === l.event),
          markets = (await marketList(io, t)).filter(
            (m) => m.floor_strike < l.bid && checkMarketActive(m, Date.now())
          );
        crossed += markets.length;
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
          if (best && entry.price <= 0.95) priced++;
          next.set(m.ticker, entry);
          const prior = previous.get(m.ticker);
          const cohort = confirmedBid(prior, entry)
            ? strategy
            : confirmedBid(prior, entry, true)
              ? 'sothebys_bid_high'
              : null;
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
          marketList,
          previous: previousSold,
          stop,
          tail,
          deadline
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
