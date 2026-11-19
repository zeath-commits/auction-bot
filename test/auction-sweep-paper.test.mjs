import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {paperSweepAudit} from '../auction-sweep-paper.mjs';

test('paper sweep audit grades only corroborated whole shares and accepts an official scalar settlement',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const a=paperSweepAudit(db),at=Date.parse('2026-11-19T20:00:00Z'),session='2026-11-19',ticker='KXART-EXAMPLE-50000';
    const intent={mode:'paper',type:'intent',strategy:'auction_sweep',clientOrderId:'a',recordedAt:new Date(at).toISOString(),
      ticker,side:'NO',quote:{quantity:3,limitCents:64,reserveCents:200}};
    const receipt={mode:'paper',type:'receipt',clientOrderId:'a',hypothetical:true,fillAssumed:false};
    const records=[intent,receipt,{...intent,clientOrderId:'open'},{...intent,mode:'live',clientOrderId:'cash'}];
    a.ingest(session,records);a.ingest(session,records);
    let calls=0;
    function trade(id,ms,side,price,count){
      return {ticker,trade_id:id,is_block_trade:false,created_time:new Date(at+ms).toISOString(),no_price_dollars:price,
        taker_outcome_side:side,taker_book_side:side==='no'?'ask':'bid',count_fp:count};
    }
    const io={get:async route=>{
      calls++;
      if(route==='/historical/cutoff')return {body:{trades_created_ts:'2026-01-01T00:00:00Z'}};
      if(route.startsWith('/markets/trades?'))return {body:{trades:[
        trade('ok',2000,'no','.63','1.80'),trade('early',1000,'no','.60','8'),trade('expensive',2200,'no','.65','8'),
        trade('seller',2500,'yes','.60','8'),trade('late',6000,'no','.63','8')]}};
      assert.equal(route,'/markets/'+ticker);
      return {body:{market:{ticker,status:'finalized',is_provisional:false,settlement_ts:new Date(at+40000).toISOString(),settlement_value_dollars:'0.2000'}}};
    }};
    await a.review(io,at+6000);assert.equal(calls,0);
    await a.review(io,at+67000);await a.review(io,at+68000);assert.equal(calls,3);
    const [s]=a.summary();
    assert.equal(s.attempts,1);assert.equal(s.requested,3);assert.equal(s.supported,1);assert.equal(s.settledShares,1);
    assert.ok(Math.abs(s.modeledNet-.13)<1e-8);
  }finally{db.close();}
});
