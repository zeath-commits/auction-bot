import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Transport } from './transport.mjs';
import { askLevels, checkFees, checkMarketActive } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';

const calendar = JSON.parse(
  fs.readFileSync(new URL('./sothebys-bid-calendar.json', import.meta.url))
);
const strategy = 'sothebys_live_bid';

export function extractSothebys(html, c) {
  const raw = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!raw) throw Error('Sotheby’s public catalog data missing');
  const p = JSON.parse(raw[1]).props?.pageProps;
  if (p?.auctionId !== c.auctionId || !p.apolloCache)
    throw Error('Auction identity changed');
  return c.targets.map((t) => {
    const matches = Object.values(p.apolloCache).filter(
      (x) =>
        x.__typename === 'LotCard' &&
        x.lotNumber?.lotDisplayNumber === t.lot &&
        x.sapAuctionSaleNumber === c.sale
    );
    const card = matches[0];
    if (
      matches.length !== 1 ||
      card.lotId !== t.id ||
      card.title !== t.title ||
      card.creatorsDisplayTitle !== t.artist ||
      c.url + '/' + card.slug?.lotSlug !== t.url
    )
      throw Error('Lot identity changed: ' + t.lot);
    const state = p.apolloCache[card.bidState?.__ref];
    if (!state) throw Error('Bid state missing: ' + t.lot);
    const phase = state.bidTypeV2?.liveBidPhase,
      price = Number(state.currentBidV2?.amount);
    const eligible =
      card.withdrawnState?.state === 'NotAffected' &&
      state.isClosed === false &&
      phase === 'Live' &&
      state.sold?.isSold === false &&
      state.currentBidV2?.currency === 'USD' &&
      Number.isSafeInteger(state.numberOfBids) &&
      state.numberOfBids > 0 &&
      Number.isSafeInteger(price) &&
      price > 0;
    const final = state.sold?.premiums?.finalPriceV2;
    const closed =
      state.isClosed === true &&
      phase === 'Closed' &&
      card.withdrawnState?.state === 'NotAffected' &&
      state.sold?.__typename === 'ResultVisible';
    const salePrice =
      closed &&
      state.sold.isSold === true &&
      final?.currency === 'USD' &&
      Number(final.amount) > 0
        ? Number(final.amount)
        : null;
    return {
      event: t.event,
      lot: t.lot,
      phase,
      closed: state.isClosed,
      withdrawn: card.withdrawnState?.state,
      reserveMet: state.reserveMet,
      count: state.numberOfBids,
      bid: eligible ? price : null,
      salePrice,
      explicitUnsold: closed && state.sold.isSold === false
    };
  });
}

async function source() {
  const start = Date.now();
  const r = await fetch(calendar.url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(7500),
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!r.ok) throw Error('Sotheby’s catalog HTTP ' + r.status);
  const data = await r.text(),
    at = Date.now(),
    generation = Date.parse(r.headers.get('date')),
    age = Number(r.headers.get('age') ?? 0);
  return {
    at,
    generation,
    age,
    fresh:
      at - start <= 2000 &&
      Number.isFinite(generation) &&
      at - generation >= -1000 &&
      at - generation <= 6000 &&
      age >= 0 &&
      age <= 4,
    lots: extractSothebys(data, calendar)
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
    second.generation > first.generation &&
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

export async function observeSothebysBids({ db, config, stop, status }) {
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
  let previous = new Map();
  while (!stop()) {
    const now = Date.now(),
      toStart = Date.parse(calendar.start) - now;
    if (now >= Date.parse(calendar.end)) {
      status.state = 'Window ended';
      status.at = new Date().toISOString();
      return;
    }
    if (toStart > 0) {
      await sleep(Math.min(60000, toStart));
      continue;
    }
    let delay = 10000;
    try {
      const s = await source(),
        next = new Map();
      let priced = 0,
        crossed = 0;
      db.prepare('INSERT OR IGNORE INTO sothebys_bid_scans VALUES(?,?,?)').run(
        s.at,
        Number(s.fresh),
        JSON.stringify(s)
      );
      const live = s.fresh ? s.lots.filter((l) => l.bid !== null) : [];
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
      Object.assign(status, {
        at: new Date().toISOString(),
        state: s.fresh ? 'Watching live bids' : 'Stale or slow catalog read',
        liveLots: live.length,
        crossed,
        priced,
        error: null
      });
    } catch (e) {
      previous.clear();
      status.state = 'Retrying public data';
      status.error = e.message;
      status.at = new Date().toISOString();
      delay = 60000;
    }
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
  const s = await source();
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
