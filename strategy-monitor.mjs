import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { chartProjection, referencePrices } from './bitcoin-reference.mjs';

export const strategies = {
  cs2_reference: 'CS2 · Kalshi offer below Polymarket US bid',
  weather_three: 'Weather · 3 p.m. station readings',
  weather_high: 'Weather · afternoon high already crossed',
  nba_five: 'NBA · five-point lead with 35–50 seconds left',
  nba_best_route: 'NBA · five-point leader, better of two offers',
  sothebys_sold: 'Sotheby’s · published sale price and available quantity',
  sothebys_live_bid: 'Sotheby’s · live bids above a threshold',
  sothebys_bid_high: 'Sotheby’s · live bid with a 97–98¢ offer',
  us_btc10: 'Polymarket US · BTC final 10 seconds',
  cross_us_btc: 'Bitcoin · Kalshi and Polymarket US pair',
  cross_us_middle: 'Bitcoin · wide opening-price gap',
  late_auction: 'Auction · offers after the sale',
  sale_depth: 'Auction · available quantity after confirmed results',
  auction_pair: 'Auction · paired thresholds',
  art_record_pair: 'Auction · Van Gogh annual record and individual lot',
  crypto_pair: 'Crypto · paired thresholds',
  btc60: 'Bitcoin · final minute',
  btc_band60: 'Bitcoin · final minute, all prices from 98¢ to 99¢',
  btc_underdog: 'Bitcoin · 1–2¢ offer in the final minute',
  btc10: 'Bitcoin · final 10 seconds',
  btc_chart10: 'Bitcoin · final 10 seconds with chart confirmation',
  btcDepth: 'Bitcoin · 1,000 contracts displayed',
  published_sale: 'Published auction price',
  unsold: 'Explicitly unsold lot',
  live_bid: 'Live bid above threshold',
  quake: 'Earthquake magnitude',
  college: 'College basketball opening odds'
};

export function openLedger(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'strategies.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS paper(id TEXT PRIMARY KEY, strategy TEXT, ticker TEXT, side TEXT, at TEXT,
      quantity REAL, price REAL, fees REAL, depth REAL, closeAt INTEGER, payout REAL, result TEXT);
    CREATE TABLE IF NOT EXISTS windows(ticker TEXT PRIMARY KEY, closeAt INTEGER, checks INTEGER DEFAULT 0,
      firstCheck INTEGER, lastCheck INTEGER);
    CREATE TABLE IF NOT EXISTS results(ticker TEXT PRIMARY KEY, checked INTEGER);
    CREATE TABLE IF NOT EXISTS btc_chart_windows(ticker TEXT PRIMARY KEY, closeAt INTEGER NOT NULL,
      strike REAL, requestedAt INTEGER, receivedAt INTEGER, projected REAL, gapBps REAL, side TEXT,
      error TEXT, result TEXT);
  `);
  return db;
}

function bestMatchingQuote(book, matchesPrice) {
  const fp = book?.orderbook_fp;
  if (!Array.isArray(fp?.yes_dollars) || !Array.isArray(fp?.no_dollars))
    return null;
  const choices = [];
  for (const [side, bids] of [
    ['yes', fp.no_dollars],
    ['no', fp.yes_dollars]
  ]) {
    const valid = bids
      .map(([p, n]) => [Number(p), Number(n)])
      .filter(([p, n]) => p > 0 && p < 1 && n > 0);
    const bid = Math.max(...valid.map(([p]) => p));
    const price = Math.round((1 - bid) * 10000) / 10000;
    const size = valid
      .filter(([p]) => p === bid)
      .reduce((sum, [, n]) => sum + n, 0);
    if (matchesPrice(price) && size >= 1)
      choices.push({ side, price, size });
  }
  return choices.length === 1 ? choices[0] : null;
}

export function bestFavorite(book) {
  return bestMatchingQuote(book, p => p === 0.98 || p === 0.99);
}

export async function captureChart(db, market, read = referencePrices, now = Date.now) {
  const close = Date.parse(market.close_time);
  const begin = now();
  if (!(begin >= close - 14000 && begin < close - 1000)) return;
  const started = db.prepare('UPDATE btc_chart_windows SET requestedAt=? WHERE ticker=? AND requestedAt IS NULL')
    .run(begin, market.ticker);
  if (!started.changes) return;
  try {
    if (market.strike_type !== 'greater_or_equal' || !market.rules_primary?.includes('BRTI'))
      throw Error('Unrecognized Bitcoin settlement terms');
    const ticks = await read(close / 1000 - 60, close / 1000 - 15);
    const forecast = chartProjection(ticks, close / 1000, market.floor_strike);
    if (!forecast) throw Error('Missing chart observations or strike');
    const received = now();
    if (received >= close) throw Error('Chart arrived after close');
    db.prepare('UPDATE btc_chart_windows SET receivedAt=?,projected=?,gapBps=?,side=? WHERE ticker=?')
      .run(received, forecast.mean, forecast.gapBps, forecast.side, market.ticker);
  } catch (e) {
    db.prepare('UPDATE btc_chart_windows SET receivedAt=?,error=? WHERE ticker=?')
      .run(now(), e.message, market.ticker);
  }
}

export function recordBtc(db, market, first, second, multiplier) {
  const close = Date.parse(market.close_time);
  const observed = second.receivedAt;
  if (
    market.status !== 'active' ||
    !market.ticker.startsWith('KXBTC15M-') ||
    !(multiplier >= 0 && Number.isFinite(multiplier)) ||
    first.requestedAt < close - 60000 ||
    second.requestedAt - first.receivedAt < 900 ||
    observed >= close ||
    first.receivedAt - first.requestedAt > 1500 ||
    observed - second.requestedAt > 1500
  )
    return;
  db.prepare(
    `INSERT INTO windows VALUES(?,?,1,?,?) ON CONFLICT(ticker) DO UPDATE SET
    checks=checks+1,lastCheck=excluded.lastCheck`
  ).run(market.ticker, close, observed, observed);
  function recordOffer(strategy, seconds, minimumSize, a, b) {
    if (!a || !b || b.side !== a.side || b.price > a.price) return;
    const depth = Math.min(a.size, b.size);
    if (first.requestedAt < close - seconds * 1000 || depth < minimumSize) return;
    const fee =
      Math.ceil(0.07 * multiplier * b.price * (1 - b.price) * 10000 - 1e-9) /
      10000;
    addPaper(db, {
      id: strategy + '/' + market.ticker,
      strategy,
      ticker: market.ticker,
      side: b.side,
      at: new Date(observed).toISOString(),
      quantity: 1,
      price: b.price,
      fees: fee,
      depth,
      closeAt: close
    });
  }
  const favoriteA = bestFavorite(first.body);
  const favoriteB = bestFavorite(second.body);
  recordOffer('btc60', 60, 1, favoriteA, favoriteB);
  const inBand = p => p >= 0.98 && p <= 0.99;
  recordOffer('btc_band60', 60, 1,
    bestMatchingQuote(first.body, inBand), bestMatchingQuote(second.body, inBand));
  recordOffer('btc10', 10, 1, favoriteA, favoriteB);
  if (favoriteA && first.requestedAt >= close - 10000) {
    const chart = db.prepare('SELECT side FROM btc_chart_windows WHERE ticker=? AND closeAt=? AND strike=? AND receivedAt<=? AND ABS(gapBps)>=5')
      .get(market.ticker, close, market.floor_strike ?? null, first.requestedAt);
    if (chart?.side === favoriteA.side)
      recordOffer('btc_chart10', 10, 1, favoriteA, favoriteB);
  }
  recordOffer('btcDepth', 60, 1000, favoriteA, favoriteB);
  const cheap = p => p === 0.01 || p === 0.02;
  recordOffer('btc_underdog', 60, 1,
    bestMatchingQuote(first.body, cheap), bestMatchingQuote(second.body, cheap));
}

export function addPaper(db, r) {
  db.prepare(
    'INSERT OR IGNORE INTO paper(id,strategy,ticker,side,at,quantity,price,fees,depth,closeAt) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(
    r.id,
    r.strategy,
    r.ticker,
    r.side,
    r.at,
    r.quantity,
    r.price,
    r.fees,
    r.depth ?? null,
    r.closeAt ?? null
  );
}

export function paperRows(db) {
  return db
    .prepare(
      `SELECT p.*, CASE
    WHEN p.strategy IN ('auction_pair','art_record_pair','crypto_pair','cross_us_btc','cross_us_middle') AND peer.payout IS NULL THEN NULL
    ELSE p.payout-p.price*p.quantity-p.fees END AS net
    FROM paper p LEFT JOIN paper peer ON p.strategy IN ('auction_pair','art_record_pair','crypto_pair','cross_us_btc','cross_us_middle')
    AND peer.id=substr(p.id,1,length(p.id)-length(p.side)) ||
      (CASE p.side WHEN 'yes' THEN 'no' ELSE 'yes' END)
    ORDER BY p.at DESC`
    )
    .all();
}

export async function settle(db, io) {
  const pending = db
    .prepare(
      `SELECT pending.ticker FROM (
    SELECT ticker FROM paper WHERE payout IS NULL AND ticker NOT LIKE 'cpc-btc-updown-5m-%'
    AND (strategy NOT IN ('btc60','btc_band60','btc10','btc_chart10','btcDepth','btc_underdog','cross_us_btc','cross_us_middle') OR closeAt<=?)
    UNION SELECT ticker FROM btc_chart_windows WHERE side IS NOT NULL AND result IS NULL AND closeAt<=?
    ) pending LEFT JOIN results r USING(ticker) WHERE COALESCE(r.checked,0)<?
    ORDER BY COALESCE(r.checked,0) LIMIT 10`
    )
    .all(Date.now(), Date.now(), Date.now() - 60000);
  for (const { ticker } of pending) {
    const { market: m } = (
      await io.get('/markets/' + encodeURIComponent(ticker))
    ).body;
    if (m.ticker !== ticker) throw Error('Unexpected settlement ticker');
    if (m.status === 'finalized' && ['yes','no','scalar'].includes(m.result))
      db.prepare('UPDATE btc_chart_windows SET result=? WHERE ticker=? AND result IS NULL').run(m.result, ticker);
    if (m.status === 'finalized' && ['yes', 'no'].includes(m.result)) {
      db.prepare(
        'UPDATE paper SET payout=CASE WHEN side=? THEN quantity ELSE 0 END,result=? WHERE ticker=? AND payout IS NULL'
      ).run(m.result, m.result, ticker);
    } else if (
      m.status === 'finalized' &&
      m.result === 'scalar' &&
      typeof m.settlement_value_dollars === 'string' &&
      /^0\.\d+$|^1(?:\.0+)?$/.test(m.settlement_value_dollars)
    ) {
      const value = Number(m.settlement_value_dollars);
      db.prepare(
        "UPDATE paper SET payout=quantity*(CASE WHEN side='yes' THEN ? ELSE 1-? END), result='scalar' WHERE ticker=? AND payout IS NULL"
      ).run(value, value, ticker);
    }
    db.prepare('INSERT OR REPLACE INTO results VALUES(?,?)').run(
      ticker,
      Date.now()
    );
  }
}

export async function observe({ db, config, stop, status }) {
  const io = new Transport(
    { ...config, maxHttpAgeSeconds: 1 },
    { live: false }
  );
  let market,
    fee,
    lastFees = 0,
    lastDiscovery = 0;
  while (!stop()) {
    let delay = 1500;
    try {
      const now = Date.now();
      if (
        !market ||
        now >= Date.parse(market.close_time) ||
        now - lastDiscovery > 60000
      ) {
        const listing = (
          await io.get('/markets?series_ticker=KXBTC15M&status=open&limit=100')
        ).body;
        market = listing.markets
          .filter(
            (m) =>
              m.status === 'active' &&
              Date.parse(m.open_time) <= Date.now() &&
              Date.parse(m.close_time) > Date.now()
          )
          .sort(
            (a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)
          )[0];
        lastDiscovery = Date.now();
        if (market)
          db.prepare('INSERT OR IGNORE INTO btc_chart_windows(ticker,closeAt,strike) VALUES(?,?,?)')
            .run(market.ticker, Date.parse(market.close_time), market.floor_strike ?? null);
      }
      if (!fee || now - lastFees >= 60000) {
        const { series } = (await io.get('/series/KXBTC15M')).body;
        if (
          series.ticker !== 'KXBTC15M' ||
          series.fee_type !== 'quadratic' ||
          !Number.isFinite(series.fee_multiplier)
        )
          throw Error('Unrecognized BTC fee schedule');
        fee = series.fee_multiplier;
        lastFees = Date.now();
      }
      const left = Date.parse(market?.close_time) - Date.now();
      status.ticker = market?.ticker ?? null;
      status.close = market?.close_time ?? null;
      if (left > 0 && left <= 60000) {
        if (left <= 14000) captureChart(db, market).catch(e => { status.chartError = e.message; });
        const route = '/markets/' + market.ticker + '/orderbook?depth=100';
        const first = await io.get(route);
        await sleep(1000);
        const second = await io.get(route);
        recordBtc(db, market, first, second, fee);
        status.state = 'Sampling final minute';
        delay = 250;
      } else {
        await settle(db, io);
        status.state = market
          ? 'Waiting for final minute'
          : 'Waiting for next listing';
        delay = market ? Math.max(250, Math.min(12000, left - 60000)) : 4000;
      }
      status.error = null;
    } catch (e) {
      status.state = 'Retrying';
      status.error = e.message;
      delay = 3000;
    }
    status.at = new Date().toISOString();
    await sleep(delay);
  }
}
