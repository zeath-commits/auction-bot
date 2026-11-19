import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { askLevels, MICRO, overlappingAskLevels } from './core.mjs';
import { chartProjection, referencePrices, readClosingMargin, currentMargin, marginAllows } from './bitcoin-reference.mjs';
import { observeMakerQueue, reviewMakerQueue, observeEndpointBid, reviewEndpointBid } from './btc-maker-study.mjs';

export const strategies = {
  cs2_reference: 'CS2 · Kalshi offer below Polymarket US bid',
  weather_three: 'Weather · 3 p.m. station readings',
  weather_high: 'Weather · afternoon high already crossed',
  weather_bracket: 'Weather · afternoon high predicts final range',
  nba_five: 'NBA · five-point lead with 35–50 seconds left',
  nba_best_route: 'NBA · five-point leader, better of two offers',
  sothebys_sold: 'Sotheby’s · published sale price and available quantity',
  sothebys_live_bid: 'Sotheby’s · live bids above a threshold',
  sothebys_bid_high: 'Sotheby’s · live bid with a 97–98¢ offer',
  sothebys_bid_premium: 'Sotheby’s · estimated sale price with buyer’s premium',
  us_btc10: 'Polymarket US · BTC final 10 seconds',
  cross_us_btc: 'Bitcoin · Kalshi and Polymarket US pair',
  cross_us_middle: 'Bitcoin · wide opening-price gap',
  late_auction: 'Auction · offers after the sale',
  sale_depth: 'Auction · available quantity after confirmed results',
  auction_pair: 'Auction · paired thresholds',
  art_record_pair: 'Auction · Van Gogh annual record and individual lot',
  art_published_record: 'Auction · annual record after a confirmed sale',
  art_withdrawn: 'Auction · publicly withdrawn lot',
  art_range_bids: 'Auction · Polymarket range bids vs. Kalshi thresholds',
  crypto_pair: 'Crypto · paired thresholds',
  index_pair: 'Stock indices · paired thresholds',
  btc60: 'Bitcoin · final minute',
  btc_band60: 'Bitcoin · final minute, all prices from 98¢ to 99¢',
  btc_band10: 'Bitcoin · final 10 seconds, all prices from 98¢ to 99¢',
  btc_band1000: 'Bitcoin · 1,000 contracts at 98–99¢ in the final 10 seconds',
  btc_underdog: 'Bitcoin · 1–2¢ offer in the final minute',
  btc10: 'Bitcoin · final 10 seconds',
  btc_chart10: 'Bitcoin · final 10 seconds with chart confirmation',
  btc_cushion45: 'Bitcoin · 45-second cushion, up to 99.8¢',
  btc_endpoint10: 'Bitcoin · closing chart trend, up to 99.8¢',
  btc_endpoint_bid45: 'Bitcoin · 99.8¢ resting bid with 42–45 seconds left',
  btc999: 'Bitcoin · 100 contracts at 99.9¢ in final 10 seconds',
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
    CREATE TABLE IF NOT EXISTS btc_999_books(ticker TEXT, at INTEGER, closeAt INTEGER, firstQuote TEXT,
      secondQuote TEXT, fresh INTEGER, PRIMARY KEY(ticker,at));
    CREATE TABLE IF NOT EXISTS btc_999_queue(ticker TEXT PRIMARY KEY,side TEXT,arrival INTEGER,
      closeAt INTEGER,ahead REAL,checked INTEGER,volume REAL,result TEXT);
    CREATE TABLE IF NOT EXISTS btc_cushion_signals(ticker TEXT PRIMARY KEY,closeAt INTEGER,observed INTEGER,
      side TEXT,passed INTEGER,detail TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS btc_early_signals(ticker TEXT PRIMARY KEY,closeAt INTEGER,observed INTEGER,
      side TEXT,passed INTEGER,detail TEXT,result TEXT,checks INTEGER DEFAULT 0,depth99 INTEGER DEFAULT 0,depth998 INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS btc_early_books(ticker TEXT,observed INTEGER,detail TEXT,PRIMARY KEY(ticker,observed));
    CREATE TABLE IF NOT EXISTS btc_endpoint_signals(ticker TEXT PRIMARY KEY,closeAt INTEGER,observed INTEGER,
      side TEXT,passed INTEGER,detail TEXT,result TEXT,checks INTEGER DEFAULT 0,depth99 INTEGER DEFAULT 0,depth998 INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS btc_endpoint_books(ticker TEXT,observed INTEGER,detail TEXT,PRIMARY KEY(ticker,observed));
    CREATE TABLE IF NOT EXISTS btc_chart_audits(ticker TEXT PRIMARY KEY,checked INTEGER,detail TEXT);
    CREATE TABLE IF NOT EXISTS btc_endpoint_bids(ticker TEXT PRIMARY KEY,side TEXT,arrival INTEGER,untilAt INTEGER,
      ahead REAL,proof TEXT,checked INTEGER,volume REAL,sales TEXT);
    CREATE TABLE IF NOT EXISTS btc_band_depth(ticker TEXT,at INTEGER,fresh INTEGER,side TEXT,
      depth INTEGER,detail TEXT NOT NULL,PRIMARY KEY(ticker,at));
    CREATE TABLE IF NOT EXISTS auction_premium_signals(ticker TEXT PRIMARY KEY,event TEXT,at INTEGER,
      bid INTEGER,estimated REAL,strike REAL,result TEXT);
    CREATE TABLE IF NOT EXISTS auction_exit_trials(id TEXT PRIMARY KEY,strategy TEXT,registered INTEGER,
      holdings TEXT,soldAt INTEGER,proceeds REAL,evidence TEXT);
    CREATE TABLE IF NOT EXISTS weather_forecasts(event TEXT PRIMARY KEY,ticker TEXT,report TEXT,high INTEGER,
      at INTEGER,closeAt INTEGER,checks INTEGER DEFAULT 0,result TEXT,proof TEXT);
  `);
  return db;
}

function bestMatchingQuote(book, matchesPrice, minimumSize = 1) {
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
    if (matchesPrice(price) && size >= minimumSize)
      choices.push({ side, price, size });
  }
  return choices.length === 1 ? choices[0] : null;
}

export function bestFavorite(book) {
  return bestMatchingQuote(book, p => p === 0.98 || p === 0.99);
}

function independentBtcBooks(first,second) {
  const asOf = read => Date.parse(read.httpDate) - 1000 * Number(read.cacheAge ?? 0);
  return [first, second].every(read =>
    asOf(read) >= read.receivedAt - 2500 && asOf(read) <= read.receivedAt + 500
  ) && asOf(second) > asOf(first);
}

function recordBandDepth(db,market,close,first,second,multiplier,inBand,margin) {
  const at=second.receivedAt, ticker=market.ticker, strategy='btc_band1000';
  const asOf=read=>Date.parse(read.httpDate)-1000*Number(read.cacheAge??0);
  const fresh=independentBtcBooks(first,second) && asOf(first)>=close-10000 && asOf(second)<close;
  const a=bestMatchingQuote(first.body,inBand,0), b=bestMatchingQuote(second.body,inBand,0);
  const side=fresh && a && b && a.side===b.side && b.price<=a.price ? b.side : null;
  const levels=side ? overlappingAskLevels(first.body,second.body,side.toUpperCase(),99)
    .filter(l=>inBand(l.price)&&l.quantity>0) : [];
  const depth=levels.reduce((sum,l)=>sum+l.quantity,0);
  const permitted=marginAllows(margin,side,close,market.floor_strike,second.requestedAt,at);
  const proof={firstAt:first.receivedAt,secondAt:at,firstAsOf:asOf(first),secondAsOf:asOf(second),a,b,levels,margin,permitted};
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO btc_band_depth VALUES(?,?,?,?,?,?)')
      .run(ticker,at,Number(fresh),side,depth,JSON.stringify(proof));
    if(depth>=1000 && permitted) {
      let remaining=1000, principal=0, feeCents=0;
      for(const {price,quantity} of levels) {
        const size=Math.min(remaining,quantity);
        principal+=size*price;
        feeCents+=Math.ceil(7*multiplier*size*price*(1-price)-1e-9);
        remaining-=size;
        if(!remaining)break;
      }
      const cash=db.prepare('SELECT 1000+COALESCE(SUM(COALESCE(payout,0)-quantity*price-fees),0) AS balance FROM paper WHERE strategy=?').get(strategy).balance;
      const fees=feeCents/100, cost=principal+fees;
      if(cost<=cash+1e-9 && cost<1000)
        addPaper(db,{id:strategy+'/'+ticker,strategy,ticker,side,at:new Date(at).toISOString(),
          quantity:1000,price:principal/1000,fees,depth,closeAt:close});
    }
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function recordLargeFavorite(db, market, close, first, second, multiplier, margin) {
  if (first.requestedAt < close - 10000) return;
  const at = second.receivedAt;
  const offer = read => bestMatchingQuote(read.body, price => price === 0.999);
  const a = offer(first), b = offer(second);
  const fresh = independentBtcBooks(first,second);
  db.prepare('INSERT OR IGNORE INTO btc_999_books VALUES(?,?,?,?,?,?)')
    .run(market.ticker, at, close, JSON.stringify(a), JSON.stringify(b), Number(fresh));
  if (fresh) observeMakerQueue(db,market,first,second,close);
  const quantity = 100;
  if (!fresh || !a || !b || a.side !== b.side || Math.min(a.size,b.size) < quantity) return;
  if (!marginAllows(margin,b.side,close,market.floor_strike,second.requestedAt,at)) return;
  const fees = Math.ceil(100 * 0.07 * multiplier * quantity * b.price * (1-b.price) - 1e-9) / 100;
  const cost = quantity * b.price + fees;
  const cash = db.prepare("SELECT 1000 + COALESCE(SUM(COALESCE(payout,0)-quantity*price-fees),0) AS balance FROM paper WHERE strategy='btc999'").get().balance;
  if (cost >= quantity || cost > cash) return;
  addPaper(db, { id:'btc999/'+market.ticker, strategy:'btc999', ticker:market.ticker, side:b.side,
    at:new Date(at).toISOString(), quantity, price:b.price, fees, depth:Math.min(a.size,b.size), closeAt:close });
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

function earlyBook(read,side,multiplier) {
  const levels=askLevels(read.body,side.toUpperCase(),99.8);
  if(new Set(levels.map(l=>l.price)).size!==levels.length)throw Error('Repeated BTC book level');
  let remaining=100,principal=0,fees=0,depth99=0,depth998=0;
  for(const level of levels) {
    const price=level.price/MICRO,quantity=Math.floor(level.quantity/MICRO);
    const count=Math.min(remaining,quantity);
    remaining-=count;
    principal+=count*price;
    fees+=Math.ceil(7*multiplier*count*price*(1-price)-1e-9)/100;
    depth998+=quantity;
    if(price<=.99)depth99+=quantity;
  }
  return {at:read.receivedAt,httpDate:read.httpDate,age:read.cacheAge??0,levels,principal,fees,depth99,depth998};
}

function priceCushionSignal(db,market,first,second,multiplier,margin,close,strategy) {
  const {ticker,floor_strike:strike}=market, at=second.receivedAt;
  const prefix=strategy==='btc_endpoint10'?'btc_endpoint':'btc_early';
  const signal=db.prepare(`SELECT observed,side,detail FROM ${prefix}_signals WHERE ticker=? AND passed=1`).get(ticker);
  if(!signal || first.requestedAt<signal.observed+1000 || at>=signal.observed+10000 || !independentBtcBooks(first,second) ||
    Date.parse(first.httpDate)-1000*Number(first.cacheAge??0)<signal.observed+1000 ||
    !marginAllows(margin,signal.side,close,strike,second.requestedAt,at))return;
  if(strategy==='btc_endpoint10' && margin.lastAt<=JSON.parse(signal.detail).margin.lastAt)return;
  const a=earlyBook(first,signal.side,multiplier),b=earlyBook(second,signal.side,multiplier);
  const depth99=Math.min(a.depth99,b.depth99),depth998=Math.min(a.depth998,b.depth998);
  const {principal,fees}=a.principal+a.fees>b.principal+b.fees?a:b;
  db.exec('BEGIN IMMEDIATE');
  try {
    const saved=db.prepare(`INSERT OR IGNORE INTO ${prefix}_books VALUES(?,?,?)`)
      .run(ticker,at,JSON.stringify({side:signal.side,margin,first:a,second:b}));
    if(saved.changes)db.prepare(`UPDATE ${prefix}_signals SET checks=checks+1,depth99=max(depth99,?),depth998=max(depth998,?) WHERE ticker=?`)
      .run(depth99,depth998,ticker);
    if(depth998>=100 && principal+fees<100){
      const cash=db.prepare('SELECT 1000+COALESCE(SUM(COALESCE(payout,0)-quantity*price-fees),0) balance FROM paper WHERE strategy=?').get(strategy).balance;
      if(cash+1e-9>=principal+fees)addPaper(db,{id:strategy+'/'+ticker,strategy,ticker,side:signal.side,at:new Date(at).toISOString(),
        quantity:100,price:principal/100,fees,depth:depth998,closeAt:close});
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

export function recordBtc(db, market, first, second, multiplier, margin = null) {
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
  // Freeze the first observation even if the feed was stale or no offer existed.
  const secondsLeft=(close-observed)/1000;
  const signalTable=secondsLeft>=6 && secondsLeft<=10 ? 'btc_cushion_signals'
    : secondsLeft>=42 && secondsLeft<=45 ? 'btc_early_signals' : null;
  const endpointMargin=margin?.endpoint>0?{...margin,projected:margin.endpoint}:null;
  function freezeSignal(table,reading){
    const strike=market.floor_strike;
    const usable=currentMargin(reading,close,strike,second.requestedAt,observed);
    const side=usable?(reading.projected>=strike?'yes':'no'):null;
    const passed=marginAllows(reading,side,close,strike,second.requestedAt,observed);
    return db.prepare('INSERT OR IGNORE INTO '+table+'(ticker,closeAt,observed,side,passed,detail) VALUES(?,?,?,?,?,?)')
      .run(market.ticker,close,observed,side,Number(passed),JSON.stringify({strike,margin:reading,bookStart:second.requestedAt})).changes;
  }
  if(signalTable && market.strike_type==='greater_or_equal' && market.rules_primary?.includes('BRTI')){
    const firstSignal=freezeSignal(signalTable,margin);
    if(signalTable==='btc_early_signals' && firstSignal && endpointMargin && independentBtcBooks(first,second)){
      const side=endpointMargin.projected>=market.floor_strike?'yes':'no';
      if(marginAllows(endpointMargin,side,close,market.floor_strike,second.requestedAt,observed))
        observeEndpointBid(db,market,first,second,endpointMargin);
    }
    if(signalTable==='btc_cushion_signals')freezeSignal('btc_endpoint_signals',endpointMargin);
  }
  if(secondsLeft>=32 && secondsLeft<=44)priceCushionSignal(db,market,first,second,multiplier,margin,close,'btc_cushion45');
  if(secondsLeft<10 && endpointMargin)priceCushionSignal(db,market,first,second,multiplier,endpointMargin,close,'btc_endpoint10');
  recordLargeFavorite(db, market, close, first, second, multiplier, margin);
  function recordOffer(strategy, seconds, minimumSize, a, b) {
    if (!a || !b || b.side !== a.side || b.price > a.price) return;
    if (!marginAllows(margin,b.side,close,market.floor_strike,second.requestedAt,observed)) return;
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
  if (first.requestedAt >= close-10000) recordBandDepth(db,market,close,first,second,multiplier,inBand,margin);
  const bandA = bestMatchingQuote(first.body, inBand), bandB = bestMatchingQuote(second.body, inBand);
  recordOffer('btc_band60', 60, 1, bandA, bandB);
  if (first.requestedAt >= close-10000 && independentBtcBooks(first,second))
    recordOffer('btc_band10', 10, 1, bandA, bandB);
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
    WHEN p.strategy IN ('auction_pair','art_record_pair','crypto_pair','index_pair','cross_us_btc','cross_us_middle') AND peer.payout IS NULL THEN NULL
    ELSE p.payout-p.price*p.quantity-p.fees END AS net
    FROM paper p LEFT JOIN paper peer ON p.strategy IN ('auction_pair','art_record_pair','crypto_pair','index_pair','cross_us_btc','cross_us_middle')
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
    AND (strategy NOT IN ('btc60','btc_band60','btc_band10','btc_band1000','btc10','btc_chart10','btc_cushion45','btc_endpoint10','btc999','btcDepth','btc_underdog','cross_us_btc','cross_us_middle') OR closeAt<=?)
    UNION SELECT ticker FROM btc_chart_windows WHERE side IS NOT NULL AND result IS NULL AND closeAt<=?
    UNION SELECT ticker FROM btc_cushion_signals WHERE side IS NOT NULL AND result IS NULL AND closeAt<=?
    UNION SELECT ticker FROM btc_early_signals WHERE side IS NOT NULL AND result IS NULL AND closeAt<=?
    UNION SELECT ticker FROM btc_endpoint_signals WHERE side IS NOT NULL AND result IS NULL AND closeAt<=?
    UNION SELECT ticker FROM auction_premium_signals WHERE result IS NULL
    UNION SELECT ticker FROM weather_forecasts WHERE result IS NULL AND closeAt<=?
    ) pending LEFT JOIN results r USING(ticker) WHERE COALESCE(r.checked,0)<?
    ORDER BY COALESCE(r.checked,0) LIMIT 10`
    )
    .all(Date.now(), Date.now(), Date.now(), Date.now(), Date.now(), Date.now(), Date.now() - 60000);
  for (const { ticker } of pending) {
    const { market: m } = (
      await io.get('/markets/' + encodeURIComponent(ticker))
    ).body;
    if (m.ticker !== ticker) throw Error('Unexpected settlement ticker');
    if (m.status === 'finalized' && ['yes','no','scalar'].includes(m.result)) {
      db.prepare('UPDATE btc_chart_windows SET result=? WHERE ticker=? AND result IS NULL').run(m.result, ticker);
      db.prepare('UPDATE btc_cushion_signals SET result=? WHERE ticker=? AND result IS NULL').run(m.result,ticker);
      db.prepare('UPDATE btc_early_signals SET result=? WHERE ticker=? AND result IS NULL').run(m.result,ticker);
      db.prepare('UPDATE btc_endpoint_signals SET result=? WHERE ticker=? AND result IS NULL').run(m.result,ticker);
      db.prepare('UPDATE auction_premium_signals SET result=? WHERE ticker=? AND result IS NULL').run(m.result,ticker);
      db.prepare('UPDATE weather_forecasts SET result=? WHERE ticker=? AND result IS NULL').run(m.result,ticker);
    }
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

export async function auditClosingChart(db,io,now,read=referencePrices){
  const t=db.prepare(`SELECT s.ticker,s.closeAt FROM (
    SELECT ticker,closeAt FROM btc_cushion_signals WHERE side IS NOT NULL AND result IN ('yes','no')
    UNION SELECT ticker,closeAt FROM btc_early_signals WHERE side IS NOT NULL AND result IN ('yes','no')
    ) s LEFT JOIN btc_chart_audits a USING(ticker)
    WHERE s.closeAt<=? AND a.detail IS NULL AND COALESCE(a.checked,0)<? ORDER BY COALESCE(a.checked,0),s.closeAt LIMIT 1`).get(now-60000,now-60000);
  if(!t)return;
  db.prepare('INSERT INTO btc_chart_audits(ticker,checked) VALUES(?,?) ON CONFLICT(ticker) DO UPDATE SET checked=excluded.checked').run(t.ticker,now);
  const end=t.closeAt/1000;
  const m=(await io.get('/markets/'+encodeURIComponent(t.ticker))).body.market;
  if(m?.ticker!==t.ticker || m.status!=='finalized' || Date.parse(m.close_time)!==t.closeAt ||
    !['yes','no'].includes(m.result) || !(Number(m.expiration_value)>0))throw Error('Unverified BTC chart audit settlement');
  const prices=await read(end-60,end-1);
  const rows=db.prepare(`SELECT observed,detail FROM btc_cushion_signals WHERE ticker=? AND side IS NOT NULL
    UNION ALL SELECT observed,detail FROM btc_early_signals WHERE ticker=? AND side IS NOT NULL`).all(t.ticker,t.ticker);
  const readings=rows.map(r=>{
    const {margin}=JSON.parse(r.detail);
    if(!(margin.lastAt<margin.receivedAt && margin.receivedAt<=r.observed && r.observed<t.closeAt))throw Error('Invalid pre-close receipt');
    return {observed:r.observed,lastAt:margin.lastAt,receivedAt:margin.receivedAt,live:margin.spot,archived:prices.get(margin.lastAt/1000)??null};
  });
  const final=Number(m.expiration_value),endpoint=prices.get(end-1)??null;
  const detail={readings,endpoint,final,matches:readings.filter(r=>r.live===r.archived).length,
    missing:readings.filter(r=>r.archived==null).length,endpointMatched:endpoint===final};
  db.prepare('UPDATE btc_chart_audits SET detail=? WHERE ticker=?').run(JSON.stringify(detail),t.ticker);
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
        const closing=Date.parse(market.close_time);
        const read=market.strike_type==='greater_or_equal' && market.rules_primary?.includes('BRTI')
          ? readClosingMargin(closing,market.floor_strike).catch(e=>{status.marginError=e.message;return null;}) : null;
        const [margin]=await Promise.all([read,sleep(1000)]);
        status.margin=margin;
        if(margin) delete status.marginError;
        const second = await io.get(route);
        recordBtc(db, market, first, second, fee, margin);
        status.state = 'Sampling final minute';
        delay = 250;
      } else {
        await settle(db, io);
        if (left > 75000) {
          await reviewMakerQueue(db, io, Date.now());
          try {await reviewEndpointBid(db,io,Date.now());delete status.endpointBidError;}
          catch(e){status.endpointBidError=e.message;}
          try {await auditClosingChart(db,io,Date.now());delete status.chartAuditError;}
          catch(e){status.chartAuditError=e.message;}
        }
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
