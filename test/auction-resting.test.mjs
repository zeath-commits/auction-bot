import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initEntryDepth,checkEntryDepth} from '../auction-entry-depth.mjs';
import {initRestingStudy,observeRestingBid,reviewRestingBid,settleRestingBid,restingBalance,reviewAuctionEntry} from '../auction-resting.mjs';

test('delayed auction depth uses a later exchange timestamp, caps each price and reserves earlier inventory',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE paper(id TEXT,ticker TEXT,strategy TEXT,at TEXT,side TEXT,quantity REAL,price REAL,closeAt INTEGER); CREATE TABLE late_evidence(id TEXT,detail TEXT)');
    initEntryDepth(db);
    const iso=t=>new Date(t).toISOString();
    const add=db.prepare("INSERT INTO paper VALUES(?,'T','sothebys_sold',?,'yes',?,?,200000)");
    add.run('prior',iso(90000),1,.92);
    add.run('a',iso(100000),5,.94);add.run('b',iso(100000),4,.96);
    const snapshot={requestedAt:102000,receivedAt:102200,httpDate:iso(101000),cacheAge:1,body:{orderbooks:[
      {ticker:'T',orderbook_fp:{yes_dollars:[],no_dollars:[['0.07','4.50'],['0.06','2.00'],['0.04','3.50']]}}]}};
    const io={get:async()=>snapshot};
    assert.equal(await checkEntryDepth(db,io,102000),0);
    snapshot.httpDate=iso(102000);snapshot.cacheAge=0;
    assert.equal(await checkEntryDepth(db,io,102000),1);
    const {levels,held}=JSON.parse(db.prepare('SELECT detail FROM auction_entry_depth').get().detail);
    assert.equal(held,1);
    assert.deepEqual(levels,[{limit:.94,requested:5,matched:5,cost:4.67},{limit:.96,requested:4,matched:3,cost:2.88}]);
    assert.equal(await checkEntryDepth(db,io,103000),0);
    add.run('expired',iso(120000),1,.99);
    assert.equal(await checkEntryDepth(db,{get:()=>{throw Error('Late request');}},126001),0);
  }finally{db.close();}
});

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
    const io={get:async url=>url==='/historical/cutoff'?{body:{trades_created_ts:new Date(11500).toISOString()}}:
      {body:{trades:url.includes('cursor=')?trades.slice(1):trades.slice(0,1),cursor:url.includes('cursor=')?'':'next'}}};
    await reviewRestingBid(db,io,200000);
    const r=db.prepare('SELECT * FROM auction_resting_trials').get();
    assert.equal(r.atLimit,2.5);
    assert.equal(r.belowLimit,2.5);
    assert.deepEqual(db.prepare('SELECT tradeId FROM auction_resting_sales ORDER BY tradeId').all().map(t=>t.tradeId),['a','b']);
  }finally{db.close();}
});

test('reserves a shared budget before sales, releases unused funds and pays only on final settlement',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    initRestingStudy(db);
    const observation={at:10000,closeAt:100000,side:'NO',url:'house',amount:1,
      book:{orderbook_fp:{yes_dollars:[],no_dollars:[]}}};
    const observe=(ticker,saleSlots)=>observeRestingBid(db,observation,{...observation,ticker,saleSlots});
    observe('old',undefined);
    observe('old',2);
    db.exec('BEGIN IMMEDIATE');
    for(const ticker of ['A','B','C'])observe(ticker,2);
    db.exec('COMMIT');
    const initial=db.prepare("SELECT ticker,shares FROM auction_resting_allocations WHERE policy='equal' ORDER BY ticker").all();
    assert.deepEqual(initial.map(r=>[r.ticker,r.shares]),[['A',526],['B',526],['C',0]]);
    assert.equal(restingBalance(db).available,.60);
    assert.equal(restingBalance(db,'empty').reserved,299.25);
    const io={get:async route=>{
      if(route==='/historical/cutoff')return {body:{trades_created_ts:new Date(0).toISOString()}};
      const ticker=new URL(route,'https://test.invalid').searchParams.get('ticker');
      const trade=(price,count)=>({ticker,trade_id:ticker+price,created_time:new Date(12000).toISOString(),
        taker_outcome_side:'yes',taker_book_side:'bid',is_block_trade:false,no_price_dollars:price,count_fp:count});
      return {body:{trades:ticker==='A'?[trade('0.94','4.75'),trade('0.95','99')]:[],cursor:''}};
    }};
    for(let i=0;i<4;i++)await reviewRestingBid(db,io,200000);
    assert.equal(restingBalance(db).openCost,3.8);
    assert.equal(restingBalance(db).available,996.2);
    let finalized=false;
    const settlement={get:async path=>{
      assert.equal(path,'/markets/A');
      return {body:{market:{ticker:'A',status:finalized?'finalized':'closed',result:'scalar',settlement_value_dollars:'0.6000'}}};
    }};
    await settleRestingBid(db,settlement,200000);
    assert.equal(restingBalance(db).available,996.2);
    finalized=true;
    await settleRestingBid(db,settlement,261000);
    assert.deepEqual(restingBalance(db),{trials:3,available:997.8,reserved:0,openCost:0,settledNet:-2.2});
    await settleRestingBid(db,settlement,400000);
    assert.equal(restingBalance(db).available,997.8);
    assert.equal(restingBalance(db,'empty').available,997.8);
  }finally{db.close();}
});
