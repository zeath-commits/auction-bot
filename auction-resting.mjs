import {askLevels} from './core.mjs';

export function initRestingStudy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_resting_trials(ticker TEXT PRIMARY KEY,side TEXT,arrival INTEGER,
    untilAt INTEGER,ahead REAL,source TEXT,amount INTEGER,checked INTEGER,atLimit REAL,belowLimit REAL)`);
}

// Observe a hypothetical 95-cent resting bid only after two confirmed sold-price reads.
export function observeRestingBid(db,first,second) {
  const side=second.side, other=side==='YES'?'NO':'YES';
  function queue(q) {
    const book=q.book?.orderbook_fp;
    if (!Array.isArray(book?.yes_dollars)||!Array.isArray(book.no_dollars)) return null;
    if (askLevels(q.book,side,95).length) return null;
    // An opposite-side ask of 5 cents corresponds to a 95-cent bid on this side.
    return askLevels(q.book,other,5).reduce((sum,l)=>sum+l.quantity/1e6,0);
  }
  const a=queue(first), b=queue(second), arrival=second.at+1000;
  if (a===null||b===null||!(arrival<second.closeAt)) return;
  db.prepare('INSERT OR IGNORE INTO auction_resting_trials(ticker,side,arrival,untilAt,ahead,source,amount) VALUES(?,?,?,?,?,?,?)')
    .run(second.ticker,side,arrival,Math.min(arrival+3600000,second.closeAt),Math.max(a,b),second.url,second.amount);
}

export async function reviewRestingBid(db,io,now) {
  const trial=db.prepare(`SELECT * FROM auction_resting_trials WHERE belowLimit IS NULL AND untilAt<=?
    AND COALESCE(checked,0)<? ORDER BY COALESCE(checked,0),arrival,ticker LIMIT 1`).get(now-60000,now-60000);
  if (!trial) return;
  db.prepare('UPDATE auction_resting_trials SET checked=? WHERE ticker=?').run(now,trial.ticker);
  const side=trial.side.toLowerCase(), taker=side==='yes'?'no':'yes';
  const params=new URLSearchParams({ticker:trial.ticker,min_ts:String(Math.floor(trial.arrival/1000)),
    max_ts:String(Math.ceil(trial.untilAt/1000)),is_block_trade:'false',limit:'1000'});
  let atLimit=0,belowLimit=0;
  const cursors=new Set(),ids=new Set();
  do {
    const {body}=await io.get('/markets/trades?'+params);
    for(const t of body.trades) {
      if(t.ticker!==trial.ticker||!t.trade_id||ids.has(t.trade_id))throw Error('Unexpected auction trade identity');
      ids.add(t.trade_id);
      const at=Date.parse(t.created_time),price=Number(t[side+'_price_dollars']),qty=Number(t.count_fp);
      if(!Number.isFinite(at+price+qty)||qty<=0||price<=0||price>=1)throw Error('Invalid auction trade');
      if(at<=trial.arrival||at>=trial.untilAt||t.is_block_trade!==false||t.taker_outcome_side!==taker||
        t.taker_book_side!==(taker==='yes'?'bid':'ask'))continue;
      if(price===0.95)atLimit+=qty;
      if(price<0.95)belowLimit+=qty;
    }
    if(!body.cursor)break;
    if(cursors.has(body.cursor))throw Error('Repeated auction trades cursor');
    cursors.add(body.cursor);params.set('cursor',body.cursor);
  }while(true);
  db.prepare('UPDATE auction_resting_trials SET atLimit=?,belowLimit=? WHERE ticker=?')
    .run(Math.round(atLimit*100)/100,Math.round(belowLimit*100)/100,trial.ticker);
}
