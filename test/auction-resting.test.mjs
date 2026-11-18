import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initRestingStudy,observeRestingBid,reviewRestingBid} from '../auction-resting.mjs';

test('resting study excludes immediately available asks and measures opposing executions once',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    initRestingStudy(db);
    const second={ticker:'T',side:'YES',url:'source',amount:500000,at:10000,closeAt:100000,
      book:{orderbook_fp:{yes_dollars:[['0.96','7.50'],['0.95','4']],no_dollars:[['0.04','12']]}}};
    const crosses={...second,book:{orderbook_fp:{yes_dollars:[],no_dollars:[['0.05','0.5']]}}};
    observeRestingBid(db,crosses,second);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auction_resting_trials').get().n,0);
    observeRestingBid(db,second,second);
    observeRestingBid(db,second,{...second,at:20000});
    const saved=db.prepare('SELECT * FROM auction_resting_trials').get();
    assert.equal(saved.ahead,11.5);
    assert.equal(saved.arrival,11000);
    const trade=(id,price,changes={})=>({trade_id:id,ticker:'T',created_time:new Date(12000).toISOString(),
      is_block_trade:false,yes_price_dollars:price,count_fp:'2.50',taker_outcome_side:'no',taker_book_side:'ask',...changes});
    const trades=[trade('a','.95'),trade('b','.91'),trade('c','.96'),trade('d','.93',{is_block_trade:true}),
      trade('e','.88',{taker_outcome_side:'yes',taker_book_side:'bid'}),trade('f','.8',{created_time:new Date(11000).toISOString()})];
    const io={get:async url=>({body:{trades:url.includes('cursor=')?trades.slice(1):trades.slice(0,1),cursor:url.includes('cursor=')?'':'next'}})};
    await reviewRestingBid(db,io,200000);
    const r=db.prepare('SELECT * FROM auction_resting_trials').get();
    assert.equal(r.atLimit,2.5);
    assert.equal(r.belowLimit,2.5);
  }finally{db.close();}
});
