import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initRestingStudy,observeRestingBid,reviewRestingBid,reviewAuctionEntry} from '../auction-resting.mjs';

test('matches public purchases to original paper levels and truncates overlapping entry windows',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    initRestingStudy(db);
    db.exec('CREATE TABLE paper(id TEXT,ticker TEXT,strategy TEXT,at TEXT,side TEXT,quantity REAL,price REAL,closeAt INTEGER);CREATE TABLE late_evidence(id TEXT,detail TEXT)');
    const iso=t=>new Date(t).toISOString();
    const insert=db.prepare("INSERT INTO paper VALUES(?,'T',?,?,'no',?,?,180000)");
    insert.run('a','late_auction',iso(100000),5,0.948);
    db.prepare('INSERT INTO late_evidence VALUES(?,?)').run('a',JSON.stringify({levels:[{price:0.96,quantity:2},{price:0.94,quantity:3}]}));
    insert.run('b','sothebys_sold',iso(115000),4,0.96);
    const trade=(at,price,count,side='no')=>({ticker:'T',trade_id:String(at),created_time:iso(at),
      is_block_trade:false,no_price_dollars:String(price),count_fp:String(count),taker_outcome_side:side,taker_book_side:side==='no'?'ask':'bid'});
    const prints=[trade(100500,.96,500),trade(105000,.96,5),trade(110000,.94,2.75),trade(113000,.948,10),
      trade(114000,.94,50,'yes'),trade(115000,.94,8),trade(118000,.96,1)];
    const io={get:async route=>route==='/historical/cutoff' ? {body:{trades_created_ts:iso(110000)}} : {body:{trades:prints,cursor:''}}};
    const first=await reviewAuctionEntry(db,io,250000);
    assert.deepEqual(first.levels,[{price:.96,paper:2,printed:5,overlap:2},{price:.94,paper:3,printed:2.75,overlap:2}]);
    assert.equal(first.untilAt,115000);
    assert.deepEqual((await reviewAuctionEntry(db,io,250000)).levels,[{price:.96,paper:4,printed:1,overlap:1}]);
    assert.equal(await reviewAuctionEntry(db,io,250000),undefined);
  } finally {db.close();}
});

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
