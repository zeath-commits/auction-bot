import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initDiscountBids,registerDiscountBid,discountBalance} from '../auction-discount-bids.mjs';
import {reviewAuctionBid} from '../withdrawal-bids.mjs';

test('published price bids observe the delay, reserve a share of the lot and record an adverse official settlement',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    initDiscountBids(db);
    const start=Date.parse('2026-11-19T19:00:00Z'),ticker='KXART-TEST-500000',close=start+3600000;
    const market={ticker,event_ticker:'KXART-TEST',strike_type:'greater',floor_strike:500000,status:'active',close_time:new Date(close).toISOString()};
    const book=(at,noBid)=>({requestedAt:at,receivedAt:at+80,httpDate:new Date(at).toUTCString(),
      body:{ticker,orderbook_fp:{yes_dollars:[['0.80','12.50'],['0.85','5.50']],no_dollars:[[noBid,'7.00']]}}});
    const attempt=(seconds,noBid)=>registerDiscountBid(db,{market,first:book(start+seconds*1000,noBid),
      second:book(start+(seconds+2)*1000,noBid),publishedAt:start,amount:600000,slots:10,source:'Phillips'});
    attempt(0,'0.05');attempt(122,'0.20');attempt(420,'0.05');
    assert.equal(discountBalance(db).bids,0);
    attempt(122,'0.05');attempt(126,'0.05');
    const r=db.prepare('SELECT * FROM auction_discount_bids').get();
    assert.deepEqual([r.side,r.shares,r.ahead,r.untilAt],['yes',12,18,close]);
    assert.equal(discountBalance(db).available,990.4);
    const trade=(id,offset,side,price,size)=>({trade_id:id,ticker,created_time:new Date(r.arrival+offset).toISOString(),
      taker_outcome_side:side,taker_book_side:side==='no'?'ask':'bid',is_block_trade:false,yes_price_dollars:price,count_fp:size});
    const tape=[trade('before',-1,'no','0.65','10'),trade('seller',1700,'no','0.60','3.99'),
      trade('at',2000,'no','0.80','100'),trade('other',3000,'yes','0.70','50')];
    const io={async get(route){
      if(route==='/markets/'+ticker)return {body:{market:{...market,status:'finalized',result:'no',settlement_value_dollars:'0.00'}}};
      if(route==='/historical/cutoff')return {body:{trades_created_ts:'2026-11-01T00:00:00Z'}};
      if(route.startsWith('/markets/trades?'))return {body:{trades:tape,cursor:''}};
      throw Error(route);
    }};
    await reviewAuctionBid(db,io,close+120000,'published_sale');
    const bal=discountBalance(db);
    assert.deepEqual([bal.available,bal.matched,bal.reservedShares],[997.6,3,0]);
    assert.equal(Number(bal.settledNet.toFixed(2)),-2.4);
  }finally{db.close();}
});
