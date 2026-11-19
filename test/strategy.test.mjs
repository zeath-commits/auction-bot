import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPaper,
  auditClosingChart,
  captureChart,
  openLedger,
  paperRows,
  recordBtc,
  settle
} from '../strategy-monitor.mjs';
import { chartProjection, closingMargin, marginAllows } from '../bitcoin-reference.mjs';
import { makerQueue, observeMakerQueue, reviewMakerQueue, reviewEndpointBid } from '../btc-maker-study.mjs';

function recordWithMargin(db,market,first,second,rate,side='yes') {
  const strike=market.floor_strike??100, price=strike*(side==='yes'?1.01:0.99);
  const proof={strike,closeMs:Date.parse(market.close_time),projected:price,spot:price,
    lastAt:second.requestedAt-1200,requestedAt:second.requestedAt-100,receivedAt:second.requestedAt-80};
  recordBtc(db,{...market,floor_strike:strike},first,second,rate,proof);
}

test('closing BTC margin requires a fresh spot and projected settlement on the chosen side',()=>{
  const end=1000, strike=55500, at=(end-8)*1000+100;
  const ticks=price=>new Map(Array.from({length:52},(_,i)=>[end-60+i,price]));
  const margin=price=>({...closingMargin(ticks(price),end*1000,strike,at),receivedAt:at+150});
  const passes=(m,side='yes',decision=at+1000)=>marginAllows(m,side,end*1000,strike,at+200,decision);
  assert.equal(passes(margin(55555)),false);
  assert.equal(passes(margin(55583.25)),true);
  assert.equal(passes({...margin(55600),spot:55530}),false);
  assert.equal(passes({...margin(55600),projected:55530}),false);
  assert.equal(passes(margin(55400),'no'),true);
  assert.equal(passes(margin(55400),'yes'),false);
  assert.equal(passes(null),false);
  assert.equal(passes(margin(55600),'yes',at+5000),false);
  assert.equal(passes({...margin(55600),receivedAt:at+300}),false);
  const partial=ticks(55600);partial.delete(end-22);
  assert.equal(closingMargin(partial,end*1000,strike,at),null);
});

test('endpoint forecast uses five completed seconds and requires newer confirmation before a paper purchase',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'btc-endpoint-')),db=openLedger(directory);
  try{
    const close=Math.floor(Date.now()/1000)*1000-1000,end=close/1000;
    const ticks=new Map(Array.from({length:60},(_,i)=>[end-60+i,101]));
    ticks.set(end-15,104);
    const reversal=closingMargin(ticks,close,100,close-9000);
    assert.equal(reversal.lastAt,close-10000);
    assert.ok(reversal.endpoint<100 && reversal.spot>100 && reversal.projected>100);
    const m={ticker:'KXBTC15M-ENDPOINT',floor_strike:100,strike_type:'greater_or_equal',rules_primary:'BRTI',status:'active',close_time:new Date(close).toISOString()};
    const read=(at,size)=>({requestedAt:at,receivedAt:at+50,httpDate:new Date(at).toUTCString(),cacheAge:0,
      body:{orderbook_fp:{yes_dollars:[],no_dollars:[['0.003',size]]}}});
    const proof=at=>({...closingMargin(ticks,close,100,at),receivedAt:at+100});
    const signal=proof(close-9100);
    recordBtc(db,m,read(close-10000,'100'),read(close-8800,'100'),1,signal);
    const entries=()=>paperRows(db).filter(r=>r.strategy==='btc_endpoint10');
    assert.equal(entries().length,0);
    assert.equal(db.prepare('SELECT passed FROM btc_endpoint_signals').get().passed,1);
    recordBtc(db,m,read(close-7000,'100'),read(close-5800,'100'),1,signal);
    assert.equal(entries().length,0);
    recordBtc(db,m,read(close-6000,'99'),read(close-4800,'100'),1,proof(close-5200));
    assert.equal(entries().length,0);
    recordBtc(db,m,read(close-4000,'110'),read(close-2800,'101'),1,proof(close-3200));
    assert.deepEqual(entries().map(r=>[r.side,r.quantity,r.price,r.fees]),[['yes',100,.997,.03]]);
    await settle(db,{get:async()=>({body:{market:{...m,status:'finalized',result:'no'}}})});
    assert.equal(db.prepare('SELECT result FROM btc_endpoint_signals').get().result,'no');
    assert.ok(Math.abs(entries()[0].net+99.73)<1e-9);
    const archive=new Map(ticks);
    archive.set(signal.lastAt/1000,99);
    archive.set(end-1,98.21);
    await auditClosingChart(db,{get:async()=>({body:{market:{...m,status:'finalized',result:'no',expiration_value:'98.21'}}})},
      close+90000,async()=>archive);
    const audit=JSON.parse(db.prepare('SELECT detail FROM btc_chart_audits').get().detail);
    assert.equal(audit.endpointMatched,true);
    assert.equal(audit.matches,0);
    assert.equal(audit.readings[0].live,101);
    assert.equal(audit.readings[0].archived,99);
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('the early trend registers a passive bid before seller volume is known',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'btc-passive-')),db=openLedger(directory);
  try{
    const close=200000, ticker='KXBTC15M-PASSIVE';
    const m={ticker,status:'active',floor_strike:100,strike_type:'greater_or_equal',rules_primary:'BRTI',
      close_time:new Date(close).toISOString(),price_ranges:[{start:'0.9000',end:'1.0000',step:'0.0010'}]};
    const read=(at,other=[])=>({requestedAt:at,receivedAt:at+50,httpDate:new Date(at).toUTCString(),
      body:{orderbook_fp:{yes_dollars:other,no_dollars:[['0.998','12']]}}});
    const margin={strike:100,closeMs:close,requestedAt:close-45200,receivedAt:close-45060,
      lastAt:close-47000,projected:99,spot:99,endpoint:98.7};
    recordBtc(db,m,read(close-47000),read(close-45000),1,margin);
    const trial=db.prepare('SELECT * FROM btc_endpoint_bids WHERE ticker=?').get(ticker);
    assert.equal(trial.side,'no');assert.equal(trial.ahead,12);assert.equal(trial.volume,null);
    recordBtc(db,{...m,ticker:ticker+'-ASK'},read(close-47000,[['0.002','1']]),read(close-45000),1,margin);
    recordBtc(db,{...m,ticker:ticker+'-ASK'},read(close-47000),read(close-45000),1,margin);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM btc_endpoint_bids').get().n,1);
    // A failed chart read triggers a delayed cancellation for this comparison only.
    recordBtc(db,m,read(close-42000),read(close-40000),1,null);
    const cancel=db.prepare('SELECT cancelAt FROM btc_bid_duration WHERE ticker=?').get(ticker).cancelAt;
    assert.equal(cancel,close-38950);
    const sale=(id,price,at,side='yes')=>({ticker,trade_id:id,no_price_dollars:price,count_fp:'101.50',is_block_trade:false,
      created_time:new Date(at).toISOString(),taker_outcome_side:side,taker_book_side:side==='yes'?'bid':'ask'});
    const sales=[sale('valid','.997',trial.arrival+10),sale('equal','.998',trial.arrival+20),
      sale('late','.996',trial.untilAt),sale('early','.994',trial.arrival),sale('wrong-side','.994',trial.arrival+10,'no')];
    sales.push(sale('after-cancel','.97',cancel+10));
    const io={get:async route=>({body:route==='/historical/cutoff'?{trades_created_ts:new Date(trial.arrival+1).toISOString()}:{trades:sales}})};
    await reviewEndpointBid(db,io,close+90000);
    const result=db.prepare('SELECT volume,sales FROM btc_endpoint_bids').get();
    assert.equal(result.volume,203);
    assert.deepEqual(JSON.parse(result.sales).map(t=>t.id),['valid','after-cancel']);
    const compared=JSON.parse(db.prepare('SELECT compared FROM btc_bid_duration').get().compared);
    assert.deepEqual(compared.map(r=>[r.timer,r.price,r.volume]),[
      ['nineSeconds',.98,101.5],['nineSeconds',.998,203],['untilClose',.98,101.5],['untilClose',.998,304.5],
      ['cancelOnMargin',.98,0],['cancelOnMargin',.998,101.5]]);
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('chart-confirmed BTC entries use candles and receipts available before the quote', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoin-chart-'));
  const db = openLedger(directory);
  try {
    const end = Math.floor(Date.now() / 1000) - 100, close = end * 1000;
    const market = {ticker:'KXBTC15M-CHART', status:'active', close_time:new Date(close).toISOString(),
      floor_strike:100, strike_type:'greater_or_equal', rules_primary:'Average of BRTI'};
    const ticks = new Map(Array.from({length:46}, (_,i) => [end - 60 + i, 101]));
    ticks.set(end-14, 1);
    assert.equal(chartProjection(ticks,end,100).mean,101);
    const partial = new Map(ticks);
    partial.delete(end-25);
    assert.equal(chartProjection(partial,end,100),null);
    db.prepare('INSERT INTO btc_chart_windows(ticker,closeAt,strike) VALUES(?,?,?)').run(market.ticker,close,100);
    let reads = 0;
    const times = [close-13000,close-8000];
    await captureChart(db,market,async (start,stop) => {
      reads++;
      assert.deepEqual([start,stop],[end-60,end-15]);
      return ticks;
    },() => times.shift());
    const snap = ms => ({requestedAt:ms,receivedAt:ms+30,
      body:{orderbook_fp:{yes_dollars:[],no_dollars:[['0.0200','1.00']]}}});
    const entered = () => paperRows(db).filter(r=>r.strategy==='btc_chart10');
    recordWithMargin(db,market,snap(close-9000),snap(close-7800),1);
    assert.equal(entered().length,0);
    const cushion=()=>db.prepare('SELECT * FROM btc_cushion_signals WHERE ticker=?').get(market.ticker);
    assert.equal(cushion().observed,close-7770);
    assert.equal(cushion().side,'yes');assert.equal(cushion().passed,1);
    recordWithMargin(db,market,snap(close-7000),snap(close-5800),1);
    assert.equal(entered().length,1);
    assert.equal(cushion().observed,close-7770);
    await captureChart(db,market,async () => { reads++; },() => close-5000);
    assert.equal(reads,1);
    await settle(db, {get: async () => ({body:{market:{...market,status:'finalized',result:'yes'}}})});
    assert.equal(db.prepare('SELECT result FROM btc_chart_windows').get().result,'yes');
    assert.equal(entered()[0].payout,1);
    assert.equal(cushion().result,'yes');
  } finally {
    db.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

for (const strategy of ['auction_pair', 'art_record_pair', 'index_pair', 'nba_total_pair', 'cross_us_btc', 'cross_us_middle'])
  test(strategy + ' return waits for both settlements', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-pair-'));
    const db = openLedger(dir);
    try {
      for (const side of ['yes', 'no'])
        addPaper(db, {
          id: strategy + '/TEST/' + side,
          strategy,
          ticker: side,
          side,
          at: '2026-01-01',
          quantity: 1,
          price: 0.44,
          fees: 0.0173
        });
      db.prepare("UPDATE paper SET payout=1 WHERE side='yes'").run();
      assert.ok(paperRows(db).every((r) => r.net === null));
      db.prepare("UPDATE paper SET payout=0 WHERE side='no'").run();
      assert.ok(
        Math.abs(paperRows(db).reduce((n, r) => n + r.net, 0) - 0.0854) < 1e-8
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('BTC strategies require repeatable size and settle each paper variant only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-paper-')),
    db = openLedger(dir);
  try {
    const close = Date.now() - 1500;
    const market = {
      ticker: 'KXBTC15M-TEST',
      status: 'active',
      close_time: new Date(close).toISOString()
    };
    const book = (ms, price = '0.0200', size = '10.00') => ({
      requestedAt: ms,
      receivedAt: ms + 30,
      body: {
        orderbook_fp: {
          yes_dollars: [['0.9700', '3.00']],
          no_dollars: [[price, size]]
        }
      }
    });
    const enter = (a, b) => recordWithMargin(db, market, a, b, 1);
    const rows = () =>
      db.prepare('SELECT * FROM paper ORDER BY strategy').all();
    enter(book(close - 12000), book(close - 10900, '0.0100')); // offer worsened
    enter(book(close - 7000), book(close - 5800, '0.0200', '0.5')); // too small
    enter(book(close - 1200), book(close)); // close during confirmation
    assert.equal(rows().length, 0);
    enter(book(close - 12000), book(close - 10900));
    assert.deepEqual(
      rows().map((r) => r.strategy),
      ['btc60','btc_band60']
    );
    enter(book(close - 9000), book(close - 7800));
    enter(book(close - 5000), book(close - 3800));
    assert.deepEqual(
      rows().map((r) => r.strategy),
      ['btc10', 'btc60', 'btc_band60']
    );
    assert.equal(rows()[0].fees, 0.0014);
    enter(
      book(close - 3000, '0.0200', '1000'),
      book(close - 1800, '0.0200', '999.99')
    );
    assert.equal(rows().length, 3);
    enter(
      book(close - 2800, '0.0200', '1200'),
      book(close - 1600, '0.0200', '1000')
    );
    assert.equal(rows()[2].strategy, 'btcDepth');
    assert.equal(rows()[2].depth, 1000);
    const io = {
      get: async () => ({
        body: { market: { ...market, status: 'finalized', result: 'no' } }
      })
    };
    await settle(db, io);
    await settle(db, io);
    assert.deepEqual(
      rows().map((r) => r.payout),
      [0, 0, 0, 0]
    );
    const cheap = (ms, bid, size = '1.00') => {
      const snapshot = book(ms, '0.0500');
      snapshot.body.orderbook_fp.yes_dollars = [[bid, size]];
      return snapshot;
    };
    const candidate = { ...market, ticker: 'KXBTC15M-UNDERDOG' };
    const recordCheap = (a,b) => recordWithMargin(db, candidate, a, b, 1, 'no');
    recordCheap(cheap(close-6000,'0.9900'), cheap(close-4500,'0.9800'));
    recordCheap(cheap(close-6000,'0.9800'), cheap(close-4500,'0.9800','0.99'));
    assert.equal(rows().length, 4);
    const confirm = () => recordCheap(cheap(close-6000,'0.9800'), cheap(close-4500,'0.9900'));
    confirm();
    confirm();
    const cheapRows = () => rows().filter(r => r.strategy === 'btc_underdog');
    assert.deepEqual(cheapRows().map(r => [r.side,r.quantity,r.price,r.fees]), [['no',1,0.01,0.0007]]);
    await settle(db, { get: async () => ({
      body: { market: { ...candidate, status: 'finalized', result: 'no' } }
    }) });
    assert.equal(cheapRows()[0].payout, 1);
    const subcent = {...market, ticker:'KXBTC15M-SUBCENT'};
    recordWithMargin(db, subcent, book(close-12000,'0.0140'), book(close-10900,'0.0150'), 1);
    assert.deepEqual(rows().filter(r => r.ticker === subcent.ticker).map(r => [r.strategy,r.price,r.fees]),
      [['btc_band60',0.985,0.0011]]);
    const earlier=book(close-7000,'0.0140'), later=book(close-5000,'0.0150');
    earlier.httpDate=new Date(earlier.requestedAt).toUTCString();
    later.httpDate=earlier.httpDate;
    recordWithMargin(db, subcent, earlier, later, 1);
    assert.equal(rows().filter(r=>r.strategy==='btc_band10').length,0);
    later.httpDate=new Date(later.requestedAt).toUTCString();
    recordWithMargin(db, subcent, earlier, later, 1);
    assert.deepEqual(rows().filter(r=>r.strategy==='btc_band10').map(r=>[r.ticker,r.price]),[[subcent.ticker,0.985]]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('1,000-contract closing test matches depth by price, charges fees and reserves cash until settlement', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-band-depth-')), db=openLedger(dir);
  try {
    const close=Math.floor(Date.now()/1000)*1000-1000;
    const market={ticker:'KXBTC15M-LARGE',status:'active',close_time:new Date(close).toISOString()};
    const book=(t,n,m)=>({requestedAt:t,receivedAt:t+20,httpDate:new Date(t).toUTCString(),cacheAge:'0',
      body:{orderbook_fp:{yes_dollars:[['0.9710','1500']],no_dollars:[['0.0120',m],['0.0180',n]]}}});
    const first=book(close-8000,'500.75','650');
    const second=book(close-6000,'460','600');
    const rows=()=>paperRows(db).filter(r=>r.strategy==='btc_band1000');
    recordBtc(db,{...market,floor_strike:55500},first,second,1);
    assert.equal(rows().length,0);
    recordWithMargin(db,market,first,{...second,httpDate:first.httpDate},1);
    recordWithMargin(db,market,first,book(close-5000,'349.99','652.78'),1);
    assert.equal(rows().length,0);
    recordWithMargin(db,market,first,second,1);
    recordWithMargin(db,market,first,second,1);
    assert.equal(rows().length,1);
    assert.equal(rows()[0].depth,1060);
    assert.equal(rows()[0].quantity,1000);
    assert.ok(Math.abs(rows()[0].price-(460*.982+540*.988)/1000)<1e-9);
    assert.equal(rows()[0].fees,1.02);
    const next={...market,ticker:'KXBTC15M-NEXT'};
    recordWithMargin(db,next,first,second,1);
    assert.equal(rows().length,1);
    await settle(db,{get:async path=>({body:{market:{ticker:path.split('/').at(-1),status:'finalized',result:'yes'}}})});
    recordWithMargin(db,next,book(close-4700,'500','600'),book(close-3200,'500','600'),1);
    assert.equal(rows().length,2);
  } finally {
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('early BTC signal needs a later fresh chart and 100 shares under the same limit on both books', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-early-')),db=openLedger(dir);
  try{
    const close=Math.floor(Date.now()/1000)*1000-1000;
    const market={ticker:'KXBTC15M-EARLY',status:'active',close_time:new Date(close).toISOString(),
      floor_strike:100,strike_type:'greater_or_equal',rules_primary:'Average of BRTI'};
    const book=(secs,size)=>{const t=close-secs*1000;return {requestedAt:t,receivedAt:t+20,httpDate:new Date(t).toUTCString(),
      body:{orderbook_fp:{yes_dollars:[],no_dollars:[['0.0100',size],['0.0020','75'],['0.0010','300']]}}};};
    const paper=()=>paperRows(db).filter(r=>r.strategy==='btc_cushion45');
    recordWithMargin(db,market,book(46,'30'),book(44,'30'),1);
    assert.equal(db.prepare('SELECT passed FROM btc_early_signals').get().passed,1);
    recordWithMargin(db,market,book(44,'30'),book(42,'30'),1);
    recordWithMargin(db,market,book(41,'30'),book(39,'30'),1,'no');
    recordWithMargin(db,market,book(41,'10'),book(39,'40'),1);
    assert.equal(paper().length,0);
    const cheaper=book(38,'35');
    cheaper.body.orderbook_fp.no_dollars=[['0.0110','35'],['0.0030','75']];
    recordWithMargin(db,market,cheaper,book(36,'30'),1);
    recordWithMargin(db,market,book(37,'35'),book(35,'30'),1);
    assert.equal(paper().length,1);assert.equal(paper()[0].depth,105);assert.equal(paper()[0].quantity,100);
    assert.ok(Math.abs(paper()[0].price-(30*.99+70*.998)/100)<1e-9);assert.equal(paper()[0].fees,.04);
    await settle(db,{get:async()=>({body:{market:{...market,status:'finalized',result:'no'}}})});
    assert.equal(paper()[0].payout,0);assert.equal(db.prepare('SELECT result FROM btc_early_signals').get().result,'no');
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('99.9-cent closing test requires fresh repeated depth and available paper cash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-large-favorite-'));
  const db = openLedger(dir);
  try {
    const close = Math.floor(Date.now()/1000)*1000-1000;
    const market = {ticker:'KXBTC15M-999',status:'active',close_time:new Date(close).toISOString()};
    const read = (at, size='100.00') => ({requestedAt:at,receivedAt:at+20,
      httpDate:new Date(at).toUTCString(), cacheAge:'0',
      body:{orderbook_fp:{yes_dollars:[['0.9980','1200']],no_dollars:[['0.0010',size]]}}});
    const first=read(close-8000), second=read(close-6900);
    const rows=() => paperRows(db).filter(r=>r.strategy==='btc999');
    recordWithMargin(db,market,first,{...second,httpDate:first.httpDate},1);
    recordWithMargin(db,market,first,read(close-6500,'99.99'),1);
    recordWithMargin(db,market,read(close-11000),read(close-9800),1);
    assert.equal(rows().length,0);
    recordWithMargin(db,market,first,read(close-6300),1);
    recordWithMargin(db,market,first,read(close-6100),1);
    assert.deepEqual(rows().map(r=>[r.side,r.quantity,r.fees,r.depth]),[['yes',100,0.01,100]]);
    assert.equal(db.prepare('SELECT SUM(fresh) AS n FROM btc_999_books').get().n,3);
    await settle(db,{get:async()=>({body:{market:{...market,status:'finalized',result:'no'}}})});
    assert.ok(Math.abs(rows()[0].net + 99.91)<1e-9);
    db.prepare("UPDATE paper SET quantity=1000,price=0.99 WHERE strategy='btc999'").run();
    recordWithMargin(db,{...market,ticker:'KXBTC15M-NEW'},first,second,1);
    assert.equal(rows().length,1);
  } finally {
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('public maker study selects a side before the tape and excludes ineligible volume', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-maker-'));
  const db=openLedger(dir);
  try {
    const close=Date.now()-90000, arrival=close-6500;
    const book=(size,no=[])=>({orderbook_fp:{yes_dollars:[['0.9990',size]],no_dollars:no}});
    const m={ticker:'KXBTC15M-MAKER',price_ranges:[{start:'0.9000',end:'1.0000',step:'0.0010'}]};
    assert.equal(makerQueue(book('200',[['0.0010','1.00']])),null);
    observeMakerQueue(db,m,{body:book('200')},{body:book('150'),receivedAt:arrival-500},close);
    const trade={ticker:m.ticker,trade_id:'candidate',taker_outcome_side:'no',taker_book_side:'ask',
      yes_price_dollars:'0.9990',count_fp:'250.50',created_time:new Date(arrival).toISOString()};
    const io={get:async route=>{
      if(!route.includes('/trades?'))return {body:{market:{...m,status:'finalized',result:'yes'}}};
      if(route.includes('cursor=second'))return {body:{trades:[trade,{...trade,trade_id:'extra',count_fp:'50.50'}]}};
      return {body:{cursor:'second',trades:[trade,
        {...trade,trade_id:'late',created_time:new Date(close).toISOString()},
        {...trade,trade_id:'early',created_time:new Date(arrival-1).toISOString()},
        {...trade,trade_id:'block',is_block_trade:true},
        {...trade,trade_id:'other',taker_outcome_side:'yes'}]}};
    }};
    await reviewMakerQueue(db,io,Date.now());
    const trial=db.prepare('SELECT * FROM btc_999_queue').get();
    assert.deepEqual([trial.side,trial.arrival,trial.ahead,trial.volume,trial.result],['yes',arrival,200,301,'yes']);
    assert.equal(paperRows(db).length,0);
  } finally {
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
