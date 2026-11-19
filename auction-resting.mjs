import {windowTrades} from './public-trades.mjs';
import {askLevels,decimal,MICRO} from './core.mjs';

const startingCash=1000, bidCents=95, bidMicros=bidCents*MICRO/100;

export function initRestingStudy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_resting_trials(ticker TEXT PRIMARY KEY,side TEXT,arrival INTEGER,
    untilAt INTEGER,ahead REAL,source TEXT,amount INTEGER,checked INTEGER,atLimit REAL,belowLimit REAL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS auction_entry_tape(ticker TEXT,at TEXT,checked INTEGER,detail TEXT,PRIMARY KEY(ticker,at))`);
  db.exec(`CREATE TABLE IF NOT EXISTS auction_resting_plans(ticker TEXT PRIMARY KEY,slots INTEGER NOT NULL,
    proof TEXT NOT NULL,settleChecked INTEGER,settleValue INTEGER,settledAt INTEGER);
    CREATE TABLE IF NOT EXISTS auction_resting_allocations(ticker TEXT,policy TEXT,shares INTEGER NOT NULL,PRIMARY KEY(ticker,policy));
    CREATE TABLE IF NOT EXISTS auction_resting_sales(ticker TEXT,tradeId TEXT,at TEXT,price REAL,quantity REAL,
      PRIMARY KEY(ticker,tradeId));
    CREATE VIEW IF NOT EXISTS auction_resting_positions AS
    SELECT f.ticker,a.policy,t.side,t.arrival,t.untilAt,f.slots,a.shares,t.ahead,t.atLimit,t.belowLimit,
      CASE WHEN t.belowLimit IS NOT NULL THEN MIN(a.shares,CAST(t.belowLimit AS INTEGER)) END AS matched,
      f.settleValue,f.settledAt
    FROM auction_resting_plans f JOIN auction_resting_trials t USING(ticker) JOIN auction_resting_allocations a USING(ticker)`);
}

export function restingBalance(db,policy='equal'){
  const p=db.prepare(`SELECT COUNT(*) trials, COALESCE(SUM(shares) FILTER(WHERE matched IS NULL),0) reserved,
    COALESCE(SUM(matched) FILTER(WHERE settleValue IS NULL),0) open,
    COALESCE(SUM(matched*(settleValue-?)) FILTER(WHERE settleValue IS NOT NULL),0) realized
    FROM auction_resting_positions WHERE policy=?`).get(bidMicros,policy);
  const available=(startingCash*MICRO+p.realized-(p.reserved+p.open)*bidMicros)/MICRO;
  return {trials:p.trials,available,reserved:p.reserved*bidMicros/MICRO,openCost:p.open*bidMicros/MICRO,settledNet:p.realized/MICRO};
}

// Observe a hypothetical 95-cent resting bid only after two confirmed sold-price reads.
export function observeRestingBid(db,first,second) {
  const side=second.side, other=side==='YES'?'NO':'YES';
  function queue(q) {
    const book=q.book?.orderbook_fp;
    if (!Array.isArray(book?.yes_dollars)||!Array.isArray(book.no_dollars)) return null;
    if (askLevels(q.book,side,bidCents).length) return null;
    // An opposite-side ask of 5 cents corresponds to a 95-cent bid on this side.
    return askLevels(q.book,other,100-bidCents).reduce((sum,l)=>sum+l.quantity/MICRO,0);
  }
  const a=queue(first), b=queue(second), arrival=second.at+1000;
  if (a===null||b===null||!(arrival<second.closeAt)) return;
  db.exec('SAVEPOINT record_auction_bid');
  try{
    const saved=db.prepare('INSERT OR IGNORE INTO auction_resting_trials(ticker,side,arrival,untilAt,ahead,source,amount) VALUES(?,?,?,?,?,?,?)')
      .run(second.ticker,side,arrival,Math.min(arrival+3600000,second.closeAt),Math.max(a,b),second.url,second.amount);
    // Only allocate to a newly observed trial, before any subsequent tape is available.
    if(saved.changes && Number.isSafeInteger(second.saleSlots) && second.saleSlots>0){
      db.prepare('INSERT INTO auction_resting_plans(ticker,slots,proof) VALUES(?,?,?)')
        .run(second.ticker,second.saleSlots,JSON.stringify({first,second}));
      const reserve=(policy,slots)=>{
        const cash=restingBalance(db,policy).available;
        const shares=Math.min(Math.floor(startingCash*MICRO/(bidMicros*slots)),Math.floor(Math.round(cash*MICRO)/bidMicros));
        if(shares<0)throw Error('Auction resting model overspent its balance');
        db.prepare('INSERT INTO auction_resting_allocations(ticker,policy,shares) VALUES(?,?,?)').run(second.ticker,policy,shares);
      };
      reserve('equal',second.saleSlots);
      // Separate prospective comparison with a $100 cap per threshold and zero visible shares ahead on both reads.
      if(a===0 && b===0)reserve('empty',10);
    }
    db.exec('RELEASE record_auction_bid');
  }catch(e){db.exec('ROLLBACK TO record_auction_bid; RELEASE record_auction_bid');throw e;}
}

export async function reviewRestingBid(db,io,now) {
  const trial=db.prepare(`SELECT * FROM auction_resting_trials WHERE belowLimit IS NULL AND untilAt<=?
    AND COALESCE(checked,0)<? ORDER BY COALESCE(checked,0),arrival,ticker LIMIT 1`).get(now-60000,now-60000);
  if (!trial) return;
  db.prepare('UPDATE auction_resting_trials SET checked=? WHERE ticker=?').run(now,trial.ticker);
  const side=trial.side.toLowerCase(), taker=side==='yes'?'no':'yes';
  let atLimit=0,belowLimit=0;
  const trades=await windowTrades(io,trial,side,taker);
  const record=db.prepare('INSERT OR IGNORE INTO auction_resting_sales VALUES(?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const {id,at,price,qty} of trades) {
      if(price>bidCents/100)continue;
      if(price===bidCents/100)atLimit+=qty;
      else belowLimit+=qty;
      record.run(trial.ticker,id,at,price,qty);
    }
    db.prepare('UPDATE auction_resting_trials SET atLimit=?,belowLimit=? WHERE ticker=?')
      .run(Math.round(atLimit*100)/100,Math.round(belowLimit*100)/100,trial.ticker);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

export async function settleRestingBid(db,io,now){
  const t=db.prepare(`SELECT p.ticker,p.side FROM auction_resting_positions p JOIN auction_resting_plans f USING(ticker)
    WHERE p.matched>0 AND p.settleValue IS NULL AND COALESCE(f.settleChecked,0)<?
    ORDER BY COALESCE(f.settleChecked,0),p.arrival LIMIT 1`).get(now-60000);
  if(!t)return;
  db.prepare('UPDATE auction_resting_plans SET settleChecked=? WHERE ticker=?').run(now,t.ticker);
  const path='/markets/'+encodeURIComponent(t.ticker);
  let read;
  try{read=await io.get(path);}catch(e){if(!/HTTP 404\b/.test(e.message))throw e;read=await io.get('/historical'+path);}
  const m=read.body.market;
  if(m?.ticker!==t.ticker)throw Error('Auction resting settlement ticker mismatch');
  if(m.status!=='finalized')return;
  const yes=decimal(m.settlement_value_dollars);
  if(!['yes','no','scalar'].includes(m.result)||yes>MICRO||m.result==='yes'&&yes!==MICRO||m.result==='no'&&yes!==0)
    throw Error('Unexpected auction resting settlement value');
  db.prepare('UPDATE auction_resting_plans SET settleValue=?,settledAt=? WHERE ticker=? AND settleValue IS NULL')
    .run(t.side==='YES'?yes:MICRO-yes,now,t.ticker);
}

const includedStrategies = "('sothebys_sold','late_auction','sale_depth','art_withdrawn')";
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
    const booked=['sothebys_sold','art_withdrawn'].includes(row.strategy) ? [row] : JSON.parse(row.detail)?.levels;
    if(!booked?.length || booked.reduce((s,l)=>s+l.quantity,0)!==row.quantity) throw Error('Auction entry lacks original price levels');
    for(const {price,quantity} of booked) {
      if(!(price>0 && price<1 && Number.isSafeInteger(quantity) && quantity>0)) throw Error('Invalid paper price level');
      levels.set(price,(levels.get(price)??0)+quantity);
    }
  }
  const next=db.prepare(`SELECT MIN(at) AS at FROM paper WHERE ticker=? AND at>? AND strategy IN ${includedStrategies}`).get(ticker,at).at;
  const begin=Date.parse(at),arrival=begin+1000;
  const untilAt=Math.min(begin+30000,...rows.map(r=>r.closeAt),next?Date.parse(next):Infinity);
  const trades=(await windowTrades(io,{ticker,arrival,untilAt},side,side)).filter(t=>levels.has(t.price));
  const detail={ticker,strategy,at,side,arrival,untilAt,levels:[],trades};
  for(const [price,paper] of levels) {
    const printed=Math.round(100*detail.trades.filter(t=>t.price===price).reduce((s,t)=>s+t.qty,0))/100;
    detail.levels.push({price,paper,printed,overlap:Math.min(paper,Math.floor(printed))});
  }
  db.prepare('UPDATE auction_entry_tape SET detail=? WHERE ticker=? AND at=?').run(JSON.stringify(detail),ticker,at);
  return detail;
}
