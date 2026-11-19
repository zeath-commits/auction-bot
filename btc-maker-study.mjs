import {measureSales,windowTrades} from './public-trades.mjs';
import {marginAllows} from './bitcoin-reference.mjs';
import { askLevels, MICRO } from './core.mjs';

// Observe an existing 99.9-cent bid, then measure how much traded against
// that bid after a hypothetical arrival. Queue changes can't be reconstructed.
export function makerQueue(book) {
  const fp = book?.orderbook_fp;
  if (!Array.isArray(fp?.yes_dollars) || !Array.isArray(fp.no_dollars)) return null;
  const yesAsks = askLevels(book,'YES',100), noAsks = askLevels(book,'NO',100);
  for (const [side,offers,oppositeOffers] of [['yes',yesAsks,noAsks],['no',noAsks,yesAsks]]) {
    if (offers[0]?.price <= 999000 || oppositeOffers[0]?.price !== 1000) continue;
    const ahead = oppositeOffers.filter(l=>l.price===1000).reduce((sum,l)=>sum+l.quantity,0) / MICRO;
    return {side,ahead};
  }
  return null;
}

export function observeMakerQueue(db, market, first, second, close) {
  if (!market.price_ranges?.some(r=>r.start==='0.9000' && r.end==='1.0000' && r.step==='0.0010')) return;
  const a = makerQueue(first.body), b = makerQueue(second.body);
  const arrival = second.receivedAt + 500;
  if (!a || !b || b.side!==a.side || arrival>=close) return;
  db.prepare('INSERT OR IGNORE INTO btc_999_queue(ticker,side,arrival,closeAt,ahead) VALUES(?,?,?,?,?)')
    .run(market.ticker,b.side,arrival,close,Math.max(a.ahead,b.ahead));
}

// Register at the first 42–45 second signal, before inspecting subsequent trades.
export function observeEndpointBid(db,market,first,second,margin){
  if(!market.price_ranges?.some(r=>r.start==='0.9000'&&r.end==='1.0000'&&r.step==='0.0010'))return;
  const side=margin.endpoint>=market.floor_strike?'yes':'no',upper=side.toUpperCase();
  const opposite=upper==='YES'?'NO':'YES';
  const depth=read=>{
    if(!Array.isArray(read.body?.orderbook_fp?.yes_dollars)||!Array.isArray(read.body?.orderbook_fp?.no_dollars))return null;
    if(askLevels(read.body,upper,99.8).length)return null;
    return askLevels(read.body,opposite,0.2).reduce((n,l)=>n+l.quantity/MICRO,0);
  };
  const a=depth(first),b=depth(second);
  if(a==null||b==null)return;
  const at=second.receivedAt;
  const proof=({body,httpDate,cacheAge,requestedAt,receivedAt})=>({body,httpDate,cacheAge,requestedAt,receivedAt});
  db.exec('SAVEPOINT btc_resting_bid');
  try{
    const inserted=db.prepare('INSERT OR IGNORE INTO btc_endpoint_bids(ticker,side,arrival,untilAt,ahead,proof) VALUES(?,?,?,?,?,?)')
      .run(market.ticker,side,at+1000,at+10000,Math.max(a,b),JSON.stringify({margin,first:proof(first),second:proof(second)}));
    if(inserted.changes)db.prepare('INSERT INTO btc_bid_duration(ticker,closeAt,lastSeen) VALUES(?,?,?)')
      .run(market.ticker,margin.closeMs,at);
    db.exec('RELEASE btc_resting_bid');
  }catch(e){db.exec('ROLLBACK TO btc_resting_bid; RELEASE btc_resting_bid');throw e;}
}

export function recheckEndpointBid(db,market,book,margin){
  const t=db.prepare(`SELECT d.closeAt,d.lastSeen,b.side FROM btc_bid_duration d JOIN btc_endpoint_bids b USING(ticker)
    WHERE ticker=? AND cancelAt IS NULL AND compared IS NULL AND lastSeen<? AND closeAt>?`).get(market.ticker,book.receivedAt,book.receivedAt);
  if(!t)return;
  const pass=marginAllows(margin,t.side,t.closeAt,market.floor_strike,book.requestedAt,book.receivedAt);
  db.prepare(`UPDATE btc_bid_duration SET checks=checks+1,lastSeen=?,maxGap=MAX(maxGap,?),cancelAt=?,cancelProof=?
    WHERE ticker=? AND lastSeen=?`).run(book.receivedAt,book.receivedAt-t.lastSeen,pass?null:Math.min(book.receivedAt+1000,t.closeAt),
    pass?null:JSON.stringify({observed:book.receivedAt,requested:book.requestedAt,margin}),market.ticker,t.lastSeen);
}

export async function reviewEndpointBid(db,io,now){
  const trial=db.prepare(`SELECT b.*,d.closeAt,d.cancelAt,d.lastSeen,d.maxGap FROM btc_endpoint_bids b LEFT JOIN btc_bid_duration d USING(ticker)
    WHERE (volume IS NULL OR (d.closeAt IS NOT NULL AND d.compared IS NULL)) AND COALESCE(d.closeAt,untilAt)<=?
    AND COALESCE(checked,0)<? ORDER BY COALESCE(checked,0),untilAt LIMIT 1`).get(now-60000,now-60000);
  if(!trial)return;
  db.prepare('UPDATE btc_endpoint_bids SET checked=? WHERE ticker=?').run(now,trial.ticker);
  const aggressor=trial.side==='yes'?'no':'yes';
  const untilAt=trial.closeAt??trial.untilAt;
  const sales=(await windowTrades(io,{...trial,untilAt},trial.side,aggressor)).filter(t=>t.price<0.998);
  const early=sales.filter(t=>Date.parse(t.at)<trial.untilAt);
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('UPDATE btc_endpoint_bids SET volume=?,sales=? WHERE ticker=?')
      .run(measureSales(early,.998,trial.untilAt).volume,JSON.stringify(early),trial.ticker);
    if(trial.closeAt!=null){
      const compared=[];
      for(const [timer,end] of [['nineSeconds',trial.untilAt],['untilClose',untilAt],['cancelOnMargin',trial.cancelAt??untilAt]]){
        for(const price of [.98,.998])compared.push({timer,price,...measureSales(sales,price,end)});
      }
      const gap=trial.cancelAt==null?Math.max(trial.maxGap,untilAt-trial.lastSeen):trial.maxGap;
      db.prepare('UPDATE btc_bid_duration SET maxGap=?,compared=?,sales=? WHERE ticker=?').run(gap,JSON.stringify(compared),JSON.stringify(sales),trial.ticker);
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

export async function reviewMakerQueue(db, io, now) {
  const trial = db.prepare(`SELECT * FROM btc_999_queue WHERE volume IS NULL AND closeAt<=?
    AND COALESCE(checked,0)<? ORDER BY COALESCE(checked,0),closeAt LIMIT 1`).get(now-60000,now-60000);
  if (!trial) return;
  db.prepare('UPDATE btc_999_queue SET checked=? WHERE ticker=?').run(now,trial.ticker);
  const ticker = encodeURIComponent(trial.ticker);
  const m = (await io.get('/markets/'+ticker)).body.market;
  if (m.ticker!==trial.ticker || m.status!=='finalized' || !['yes','no','scalar'].includes(m.result)) return;
  const route = '/markets/trades?ticker='+ticker+'&limit=1000&min_ts='+Math.floor(trial.arrival/1000)+'&max_ts='+Math.ceil(trial.closeAt/1000);
  const cursors = new Set(), ids = new Set();
  let cursor='', hundredths=0;
  do {
    const page = (await io.get(route+(cursor?'&cursor='+encodeURIComponent(cursor):''))).body;
    for (const trade of page.trades) {
      const at = Date.parse(trade.created_time);
      const aggressor = trial.side==='yes'?'no':'yes';
      if (trade.ticker!==trial.ticker || !trade.trade_id || ids.has(trade.trade_id) || trade.is_block_trade ||
        !(at>=trial.arrival && at<trial.closeAt) || trade.taker_outcome_side!==aggressor ||
        trade.taker_book_side!==(aggressor==='yes'?'bid':'ask') || Number(trade[trial.side+'_price_dollars'])!==0.999) continue;
      const size = Number(trade.count_fp);
      if (!(Number.isFinite(size) && size>0)) throw Error('Invalid maker study trade size');
      ids.add(trade.trade_id);
      hundredths+=Math.round(size*100);
    }
    cursor=page.cursor;
    if (cursor && cursors.has(cursor)) throw Error('Repeated maker study trade cursor');
    cursors.add(cursor);
  } while (cursor);
  db.prepare('UPDATE btc_999_queue SET volume=?,result=? WHERE ticker=?').run(hundredths/100,m.result,trial.ticker);
}
