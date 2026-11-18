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
