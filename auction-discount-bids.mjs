import {askLevels, checkMarketActive, MICRO} from './core.mjs';

const cents=80;
export function initDiscountBids(db){
  db.exec(`CREATE TABLE IF NOT EXISTS auction_discount_bids(ticker TEXT PRIMARY KEY,cents INTEGER,side TEXT,
    event TEXT,source TEXT,amount REAL,publishedAt INTEGER,arrival INTEGER,untilAt INTEGER,shares INTEGER,
    ahead REAL,proof TEXT,checked INTEGER,through REAL,equalVolume REAL,matched INTEGER,
    complete INTEGER DEFAULT 0,settleValue REAL,trades TEXT)`);
}

export function discountBalance(db){
  const r=db.prepare(`SELECT COUNT(*) bids,COUNT(DISTINCT event) events,COALESCE(SUM(matched),0) matched,
    COALESCE(SUM(CASE WHEN complete=0 THEN shares WHEN settleValue IS NULL THEN matched ELSE 0 END),0) reservedShares,
    COALESCE(SUM(matched*(settleValue-cents/100.0)),0) settledNet FROM auction_discount_bids`).get();
  return {...r,available:1000+r.settledNet-r.reservedShares*cents/100};
}

export function discountWindow(publishedAt,now){
  return Number.isSafeInteger(publishedAt) && now>=publishedAt+120000 && now<=publishedAt+420000;
}

// The caller verifies the same published price, matched Artnet rules, exchange
// availability, and an independently generated book on each side of the wait.
export function registerDiscountBid(db,{market,first,second,publishedAt,amount,source,slots}){
  const side=amount>market.floor_strike?'YES':'NO',arrival=second.receivedAt+1000;
  const serverTime=r=>Date.parse(r.httpDate)-Number(r.cacheAge??0)*1000;
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isFinite(market.floor_strike)||market.strike_type!=='greater'||
      !Number.isSafeInteger(slots)||slots<1||!discountWindow(publishedAt,first.requestedAt)||
      !discountWindow(publishedAt,second.receivedAt)||!checkMarketActive(market,arrival)||
      second.requestedAt-first.receivedAt<900||second.receivedAt-first.receivedAt>15000||
      !(serverTime(second)>serverTime(first))||
      ![first,second].every(r=>r.body.ticker===market.ticker&&r.receivedAt>=r.requestedAt&&r.receivedAt-r.requestedAt<=2500&&
        serverTime(r)>=publishedAt+120000&&serverTime(r)>=r.receivedAt-2500&&
        serverTime(r)<=r.receivedAt+1000&&!askLevels(r.body,side,cents).length))return;
  const opposite=side==='YES'?'NO':'YES';
  const ahead=Math.max(...[first,second].map(r=>askLevels(r.body,opposite,100-cents).reduce((s,l)=>s+l.quantity/MICRO,0)));
  db.exec('SAVEPOINT discount_bid');
  try{
    const shares=Math.min(Math.floor(10000/(cents*slots)),Math.floor(Math.round(discountBalance(db).available*100)/cents));
    if(shares>0)db.prepare(`INSERT OR IGNORE INTO auction_discount_bids
      (ticker,cents,side,event,source,amount,publishedAt,arrival,untilAt,shares,ahead,proof) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(market.ticker,cents,side.toLowerCase(),market.event_ticker,source,amount,publishedAt,arrival,Date.parse(market.close_time),shares,ahead,
        JSON.stringify({slots,reads:[first,second].map(r=>({requested:r.requestedAt,received:r.receivedAt,server:serverTime(r),book:r.body}))}));
    db.exec('RELEASE discount_bid');
  }catch(e){db.exec('ROLLBACK TO discount_bid; RELEASE discount_bid');throw e;}
}
