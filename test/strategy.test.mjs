import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPaper,
  captureChart,
  openLedger,
  paperRows,
  recordBtc,
  settle
} from '../strategy-monitor.mjs';
import { chartProjection } from '../bitcoin-reference.mjs';
import { makerQueue, observeMakerQueue, reviewMakerQueue } from '../btc-maker-study.mjs';

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
    recordBtc(db,market,snap(close-9000),snap(close-7800),1);
    assert.equal(entered().length,0);
    recordBtc(db,market,snap(close-7000),snap(close-5800),1);
    assert.equal(entered().length,1);
    await captureChart(db,market,async () => { reads++; },() => close-5000);
    assert.equal(reads,1);
    await settle(db, {get: async () => ({body:{market:{...market,status:'finalized',result:'yes'}}})});
    assert.equal(db.prepare('SELECT result FROM btc_chart_windows').get().result,'yes');
    assert.equal(entered()[0].payout,1);
  } finally {
    db.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

for (const strategy of ['auction_pair', 'art_record_pair', 'index_pair', 'cross_us_btc', 'cross_us_middle'])
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
    const enter = (a, b) => recordBtc(db, market, a, b, 1);
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
    const recordCheap = (a,b) => recordBtc(db, candidate, a, b, 1);
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
    recordBtc(db, subcent, book(close-12000,'0.0140'), book(close-10900,'0.0150'), 1);
    assert.deepEqual(rows().filter(r => r.ticker === subcent.ticker).map(r => [r.strategy,r.price,r.fees]),
      [['btc_band60',0.985,0.0011]]);
    const earlier=book(close-7000,'0.0140'), later=book(close-5000,'0.0150');
    earlier.httpDate=new Date(earlier.requestedAt).toUTCString();
    later.httpDate=earlier.httpDate;
    recordBtc(db, subcent, earlier, later, 1);
    assert.equal(rows().filter(r=>r.strategy==='btc_band10').length,0);
    later.httpDate=new Date(later.requestedAt).toUTCString();
    recordBtc(db, subcent, earlier, later, 1);
    assert.deepEqual(rows().filter(r=>r.strategy==='btc_band10').map(r=>[r.ticker,r.price]),[[subcent.ticker,0.985]]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    recordBtc(db,market,first,{...second,httpDate:first.httpDate},1);
    recordBtc(db,market,first,read(close-6500,'99.99'),1);
    recordBtc(db,market,read(close-11000),read(close-9800),1);
    assert.equal(rows().length,0);
    recordBtc(db,market,first,read(close-6300),1);
    recordBtc(db,market,first,read(close-6100),1);
    assert.deepEqual(rows().map(r=>[r.side,r.quantity,r.fees,r.depth]),[['yes',100,0.01,100]]);
    assert.equal(db.prepare('SELECT SUM(fresh) AS n FROM btc_999_books').get().n,3);
    await settle(db,{get:async()=>({body:{market:{...market,status:'finalized',result:'no'}}})});
    assert.ok(Math.abs(rows()[0].net + 99.91)<1e-9);
    db.prepare("UPDATE paper SET quantity=1000,price=0.99 WHERE strategy='btc999'").run();
    recordBtc(db,{...market,ticker:'KXBTC15M-NEW'},first,second,1);
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
