import { setTimeout as sleep } from 'node:timers/promises';
import { askLevels, checkEvent, checkFees, checkMarketActive, decimal, MICRO } from './core.mjs';
import { catalogObservations, catalogObservedAt, catalogSource } from './catalog-results.mjs';
import { Transport } from './transport.mjs';
import { windowTrades } from './public-trades.mjs';

const prices = [80, 95];
const hour = 3600000;
const serverTime = r => Date.parse(r.httpDate) - Number(r.cacheAge ?? 0) * 1000;

export function initWithdrawalBids(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS withdrawal_bids(ticker TEXT, cents INTEGER, event TEXT, source TEXT,
    observed INTEGER, arrival INTEGER, untilAt INTEGER, shares INTEGER, ahead REAL, proof TEXT,
    checked INTEGER, through REAL, equalVolume REAL, matched INTEGER, complete INTEGER DEFAULT 0, noValue REAL, trades TEXT,
    PRIMARY KEY(ticker,cents))`);
}

export function withdrawalAccounts(db) {
  return prices.map(cents => {
    const row = db.prepare(`SELECT count(*) bids,count(DISTINCT event) lots,COALESCE(sum(matched),0) matched,
      COALESCE(sum(CASE WHEN complete=0 THEN shares WHEN noValue IS NULL THEN matched ELSE 0 END),0) reservedShares,
      COALESCE(sum(matched*(noValue-cents/100.0)),0) settledNet FROM withdrawal_bids WHERE cents=?`).get(cents);
    return { cents, ...row, available: 1000 + row.settledNet - row.reservedShares * cents/100 };
  });
}

export function registerWithdrawalBids(db, { event, source, observed, slots, markets, first, second }) {
  const arrival = second.receivedAt + 1000;
  if (!Number.isSafeInteger(slots) || slots < markets.length || slots < 1 || !Number.isFinite(observed) ||
      first.requestedAt < observed + hour || second.requestedAt < first.receivedAt + 1000 ||
      !(serverTime(second) > serverTime(first)) ||
      ![first, second].every(r => serverTime(r) >= r.receivedAt-3000 && serverTime(r) <= r.receivedAt+1000 &&
        r.receivedAt>=r.requestedAt && r.receivedAt-r.requestedAt<=2500)) return;
  const maps = [first,second].map(r => new Map(r.body.orderbooks.map(b => [b.ticker,b])));
  if (![first,second].every(r => r.body.orderbooks.length===markets.length) ||
      !maps.every(map => map.size===markets.length && markets.every(m=>map.has(m.ticker)))) throw Error('Incomplete withdrawal books');
  const record = db.prepare(`INSERT OR IGNORE INTO withdrawal_bids
    (ticker,cents,event,source,observed,arrival,untilAt,shares,ahead,proof) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const account of withdrawalAccounts(db)) {
      let available = Math.round(account.available * 100);
      for (const m of markets) {
        if (m.event_ticker!==event || !checkMarketActive(m,arrival)) continue;
        const books = maps.map(map => map.get(m.ticker));
        if (books.some(b => askLevels(b,'NO',account.cents).length)) continue;
        const ahead = Math.max(...books.map(b => askLevels(b,'YES',100-account.cents).reduce((s,l)=>s+l.quantity/MICRO,0)));
        const n = Math.min(Math.floor(10000 / (slots * account.cents)), Math.floor(available/account.cents));
        if (n<1) continue;
        const proof = JSON.stringify({ books, serverTimes:[serverTime(first),serverTime(second)], slots });
        const w = record.run(m.ticker,account.cents,event,source,observed,arrival,Date.parse(m.close_time),n,ahead,proof);
        available -= w.changes*n*account.cents;
      }
    }
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}

export async function reviewWithdrawalBid(db, io, now) {
  const next = db.prepare(`SELECT ticker FROM withdrawal_bids WHERE noValue IS NULL AND arrival<? AND COALESCE(checked,0)<?
    ORDER BY COALESCE(checked,0),ticker LIMIT 1`).get(now-60000,now-60000);
  if (!next) return;
  const {ticker} = next;
  const rows = db.prepare('SELECT * FROM withdrawal_bids WHERE ticker=? AND noValue IS NULL').all(ticker);
  db.prepare('UPDATE withdrawal_bids SET checked=? WHERE ticker=?').run(now,ticker);
  let response;
  try { response = await io.get('/markets/'+ticker); }
  catch(e) { if (!/HTTP 404\b/.test(e.message)) throw e; response = await io.get('/historical/markets/'+ticker); }
  const m = response.body.market, close = Date.parse(m.close_time);
  if (m.ticker!==ticker || !Number.isFinite(close)) throw Error('Withdrawal payout market changed');
  let noValue = null;
  if (m.status==='finalized') {
    const yes = decimal(m.settlement_value_dollars);
    if (yes>MICRO || !['yes','no','scalar'].includes(m.result) || m.result==='yes' && yes!==MICRO ||
        m.result==='no' && yes!==0) throw Error('Unknown withdrawal settlement');
    noValue = 1-yes/MICRO;
  }
  const untilAt = Math.min(now-60000,close,Math.max(...rows.map(r=>r.untilAt)));
  const trades = await windowTrades(io,{ticker,arrival:Math.min(...rows.map(r=>r.arrival)),untilAt},'no','yes');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const end = Math.min(close,row.untilAt), complete = untilAt>=end;
      const eligible = trades.filter(t => Date.parse(t.at)>row.arrival && Date.parse(t.at)<end && t.price<=row.cents/100);
      const volume = eq => eligible.filter(t=>(t.price===row.cents/100)===eq).reduce((s,t)=>s+Math.round(t.qty*100),0)/100;
      const through=volume(false);
      db.prepare('UPDATE withdrawal_bids SET through=?,equalVolume=?,matched=?,complete=?,noValue=?,trades=? WHERE ticker=? AND cents=?')
        .run(through,volume(true),Math.min(row.shares,Math.floor(through)),Number(complete),complete?noValue:null,JSON.stringify(eligible),ticker,row.cents);
    }
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}

export async function observeWithdrawalBids({db, config, auctions, stop, status}) {
  const io = new Transport({...config,requestTimeoutMs:5000,maxHttpAgeSeconds:2});
  const targets = auctions.flatMap(a=>a.targets), terminal = new Set();
  let nextCatalog = 0;
  while (!stop()) {
    try {
      await reviewWithdrawalBid(db,io,Date.now());
      if (Date.now()>=nextCatalog) {
        nextCatalog=Date.now()+120000;
        for (const c of catalogObservations.filter(c=>c.label==='Withdrawn'&&!terminal.has(c.event))) {
          const t = targets.find(t=>t.event===c.event);
          if (!t) continue;
          const all = checkEvent((await io.get('/events/'+c.event+'?with_nested_markets=true')).body,t);
          if (all.length!==t.markets.length || new Set(all.map(m=>m.ticker)).size!==all.length) throw Error('Incomplete public catalog event');
          const active = all.filter(m=>checkMarketActive(m,Date.now()));
          if (!active.length) { if (all.every(m=>m.status==='finalized')) terminal.add(c.event); continue; }
          if (db.prepare('SELECT count(*) n FROM withdrawal_bids WHERE event=?').get(c.event).n===all.length*prices.length) continue;
          checkFees((await io.get('/series/KXART')).body);
          const exchange = (await io.get('/exchange/status')).body;
          if (!exchange.exchange_active||!exchange.trading_active) continue;
          const q = new URLSearchParams(active.map(m=>['tickers',m.ticker])); q.set('depth','100');
          const read = () => io.get('/markets/orderbooks?'+q);
          const first = await read(); await sleep(1500); const second=await read();
          if (!stop()) registerWithdrawalBids(db,{event:c.event,source:catalogSource,observed:Date.parse(catalogObservedAt),
            markets:active,slots:all.length,first,second});
        }
      }
      status.at=Date.now(); status.error=null;
    } catch(e) { status.error=e.message; status.lastAttempt=Date.now(); }
    await sleep(9000);
  }
}
