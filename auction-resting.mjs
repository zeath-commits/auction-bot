import {askLevels} from './core.mjs';

export function initRestingStudy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_resting_trials(ticker TEXT PRIMARY KEY,side TEXT,arrival INTEGER,
    untilAt INTEGER,ahead REAL,source TEXT,amount INTEGER,checked INTEGER,atLimit REAL,belowLimit REAL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS auction_entry_tape(ticker TEXT,at TEXT,checked INTEGER,detail TEXT,PRIMARY KEY(ticker,at))`);
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
  let atLimit=0,belowLimit=0;
  for (const {price,qty} of await auctionTrades(io,trial,side,taker)) {
    if(price===0.95)atLimit+=qty;
    if(price<0.95)belowLimit+=qty;
  }
  db.prepare('UPDATE auction_resting_trials SET atLimit=?,belowLimit=? WHERE ticker=?')
    .run(Math.round(atLimit*100)/100,Math.round(belowLimit*100)/100,trial.ticker);
}

async function auctionTrades(io,trial,side,taker,route='/markets/trades') {
  const params=new URLSearchParams({ticker:trial.ticker,min_ts:String(Math.floor(trial.arrival/1000)),
    max_ts:String(Math.ceil(trial.untilAt/1000)),is_block_trade:'false',limit:'1000'});
  const trades=[];
  const cursors=new Set(),ids=new Set();
  do {
    const {body}=await io.get(route+'?'+params);
    for(const t of body.trades) {
      if(t.ticker!==trial.ticker||!t.trade_id||ids.has(t.trade_id))throw Error('Unexpected auction trade identity');
      ids.add(t.trade_id);
      const at=Date.parse(t.created_time),price=Number(t[side+'_price_dollars']),qty=Number(t.count_fp);
      if(!Number.isFinite(at+price+qty)||qty<=0||price<=0||price>=1)throw Error('Invalid auction trade');
      if(at<=trial.arrival||at>=trial.untilAt||t.is_block_trade!==false||t.taker_outcome_side!==taker||
        t.taker_book_side!==(taker==='yes'?'bid':'ask'))continue;
      trades.push({id:t.trade_id,at:t.created_time,price,qty});
    }
    if(!body.cursor)break;
    if(cursors.has(body.cursor))throw Error('Repeated auction trades cursor');
    cursors.add(body.cursor);params.set('cursor',body.cursor);
  }while(true);
  return trades;
}

const includedStrategies = "('sothebys_sold','late_auction','sale_depth')";
export async function reviewAuctionEntry(db,io,now) {
  // Hold the window open for 30 seconds and allow a minute for exchange publication.
  const pending=db.prepare(`SELECT p.ticker,p.at FROM paper p LEFT JOIN auction_entry_tape a
    ON a.ticker=p.ticker AND a.at=p.at WHERE p.strategy IN ${includedStrategies}
    AND p.at<? AND a.detail IS NULL AND COALESCE(a.checked,0)<? ORDER BY COALESCE(a.checked,0),p.at,p.ticker LIMIT 1`)
    .get(new Date(now-90000).toISOString(),now-60000);
  if (!pending) return;
  const {ticker,at}=pending;
  db.prepare(`INSERT INTO auction_entry_tape(ticker,at,checked) VALUES(?,?,?)
    ON CONFLICT(ticker,at) DO UPDATE SET checked=excluded.checked`).run(ticker,at,now);
  const rows=db.prepare(`SELECT p.*,e.detail FROM paper p LEFT JOIN late_evidence e USING(id)
    WHERE p.ticker=? AND p.at=? AND p.strategy IN ${includedStrategies}`).all(ticker,at);
  const {side,strategy}=rows[0], levels=new Map();
  for(const row of rows) {
    if(row.side!==side || row.strategy!==strategy || !['yes','no'].includes(side)) throw Error('Ambiguous auction entry');
    const booked=row.strategy==='sothebys_sold' ? [row] : JSON.parse(row.detail)?.levels;
    if(!booked?.length || booked.reduce((s,l)=>s+l.quantity,0)!==row.quantity) throw Error('Auction entry lacks original price levels');
    for(const {price,quantity} of booked) {
      if(!(price>0 && price<1 && Number.isSafeInteger(quantity) && quantity>0)) throw Error('Invalid paper price level');
      levels.set(price,(levels.get(price)??0)+quantity);
    }
  }
  const next=db.prepare(`SELECT MIN(at) AS at FROM paper WHERE ticker=? AND at>? AND strategy IN ${includedStrategies}`).get(ticker,at).at;
  const begin=Date.parse(at),arrival=begin+1000;
  const untilAt=Math.min(begin+30000,...rows.map(r=>r.closeAt),next?Date.parse(next):Infinity);
  const cutoff=Date.parse((await io.get('/historical/cutoff')).body.trades_created_ts);
  if(!Number.isFinite(cutoff)) throw Error('Missing trade archive cutoff');
  const routes=[];
  if(untilAt>arrival && arrival<cutoff) routes.push('/historical/trades');
  if(untilAt>arrival && untilAt>=cutoff) routes.push('/markets/trades');
  const matches=new Map();
  for(const route of routes) {
    for(const trade of await auctionTrades(io,{ticker,arrival,untilAt},side,side,route))
      if(levels.has(trade.price)) matches.set(trade.id,trade);
  }
  const detail={ticker,strategy,at,side,arrival,untilAt,levels:[],trades:[...matches.values()]};
  for(const [price,paper] of levels) {
    const printed=Math.round(100*detail.trades.filter(t=>t.price===price).reduce((s,t)=>s+t.qty,0))/100;
    detail.levels.push({price,paper,printed,overlap:Math.min(paper,Math.floor(printed))});
  }
  db.prepare('UPDATE auction_entry_tape SET detail=? WHERE ticker=? AND at=?').run(JSON.stringify(detail),ticker,at);
  return detail;
}
