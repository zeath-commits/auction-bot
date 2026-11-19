import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initWithdrawalBids,registerWithdrawalBids,reviewWithdrawalBid,withdrawalAccounts} from '../withdrawal-bids.mjs';

test('withdrawal NO bids reserve each limit independently, count trade-through once, and reconcile scalar settlement',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    initWithdrawalBids(db);
    const start=Date.parse('2026-11-18T10:00:00Z'),event='KXART-TEST',ticker=event+'-1000';
    const market={event_ticker:event,ticker,status:'active',close_time:new Date(start+302000).toISOString()};
    const book=(at,yesBid='0.0300')=>({requestedAt:at-50,receivedAt:at+10,httpDate:new Date(at).toUTCString(),
      body:{orderbooks:[{ticker,orderbook_fp:{yes_dollars:[[yesBid,'4.00']],no_dollars:[['0.88','8.25'],['0.95','2.00']]}}]}});
    const trial={event,source:'public catalog',observed:start-2*3600000,slots:10,markets:[market],first:book(start),second:book(start+2000)};
    registerWithdrawalBids(db,{...trial,observed:start-1000});
    assert.equal(withdrawalAccounts(db)[0].bids,0);
    registerWithdrawalBids(db,{...trial,second:book(start+2000,'0.10')});
    assert.deepEqual(withdrawalAccounts(db).map(a=>a.bids),[1,0]);
    registerWithdrawalBids(db,trial);
    registerWithdrawalBids(db,trial);
    const bids=db.prepare('SELECT * FROM withdrawal_bids ORDER BY cents').all();
    assert.deepEqual(bids.map(r=>[r.shares,r.ahead]),[[12,10.25],[10,2]]);
    assert.deepEqual(withdrawalAccounts(db).map(r=>r.available),[990.4,990.5]);
    const arrival=bids[0].arrival;
    const trade=(id,at,p,qty)=>({trade_id:id,ticker,created_time:new Date(at).toISOString(),is_block_trade:false,
      taker_book_side:'bid',taker_outcome_side:'yes',no_price_dollars:p,count_fp:qty});
    const tape=[trade('early',arrival-10,'0.70','80'),trade('strict',arrival+500,'0.75','2.50'),
      trade('equal',arrival+600,'0.80','8.00'),trade('after-close',Date.parse(market.close_time)+500,'0.60','99')];
    let finalized=false;
    const io={async get(route){if(route==='/markets/'+ticker)return {body:{market:finalized?{...market,status:'finalized',result:'scalar',settlement_value_dollars:'0.25'}:market}};
      if(route==='/historical/cutoff')return {body:{trades_created_ts:'2026-10-01T00:00:00Z'}};
      if(route.startsWith('/markets/trades?'))return {body:{trades:tape,cursor:''}};
      throw Error(route);}};
    await reviewWithdrawalBid(db,io,arrival+120000);
    assert.deepEqual(withdrawalAccounts(db).map(r=>[r.matched,r.settledNet]),[[2,0],[10,0]]);
    assert.equal(db.prepare('SELECT equalVolume FROM withdrawal_bids WHERE cents=80').get().equalVolume,8);
    finalized=true;
    await reviewWithdrawalBid(db,io,Date.parse(market.close_time)+120000);
    await reviewWithdrawalBid(db,io,Date.parse(market.close_time)+240000);
    assert.deepEqual(withdrawalAccounts(db).map(r=>[r.reservedShares,Number(r.settledNet.toFixed(2)),r.available]),[[0,-.1,999.9],[0,-2,998]]);
  }finally{db.close();}
});
