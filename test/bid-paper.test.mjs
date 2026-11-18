import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { activeSales, scan, saveObservation } from '../paper-bids.mjs';
import { christiesUnsold } from '../paper-unsold.mjs';

test('selects each sale during its own watch window, including overlapping houses', () => {
  const a={house:'christies',startAt:'2026-11-19T20:00Z',deadline:'2026-11-19T23:00Z'};
  const b={house:'christies',startAt:'2026-11-20T15:25Z',deadline:'2026-11-21T01:00Z'};
  const c={...b,house:'phillips'};
  assert.deepEqual(activeSales([a,b,c],Date.parse(b.startAt)),[b,c]);
  assert.deepEqual(activeSales([a,b,c],Date.parse(b.deadline)),[]);
});

test('unsold requires matching explicit status without a price, then counts once against the paper budget', () => {
  const target={id:'1',lot:'9A',artist:'A',title:'B'};
  const lot={object_id:'1',lot_id_txt:'9 A',title_primary_txt:'A',title_secondary_txt:'B',analytics_id:'42.9.A',price_realised:0};
  const html=()=> 'window.chrComponents.lotHeader_1 = '+JSON.stringify({data:{sale:{sale_number:'42'},lots:[lot]},labels:{currency_txt:'USD'}})+';';
  assert.equal(christiesUnsold(html(),'42',target),false);
  lot.is_unsold=true;
  assert.equal(christiesUnsold(html(),'42',target),true);
  assert.equal(christiesUnsold(html(),'43',target),false);
  lot.lot_withdrawn=true; assert.equal(christiesUnsold(html(),'42',target),false);
  lot.lot_withdrawn=false; lot.price_realised=500000; assert.equal(christiesUnsold(html(),'42',target),false);
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE signals(ticker TEXT PRIMARY KEY,reserve INTEGER NOT NULL,detail TEXT NOT NULL)');
    const config={maxOrders:1,maxTotalReservedCents:100};
    const entry=()=>({ticker:'KXART-T-25',decision:'paper_buy_no',quote:{reserveCents:50}});
    assert.equal(saveObservation(db,entry(),config,'lot-one'),true);
    assert.equal(saveObservation(db,entry(),config,'lot-one'),false);
    const second=entry(); saveObservation(db,second,config,'lot-two'); assert.equal(second.decision,'budget_limit');
    assert.equal(db.prepare('SELECT SUM(reserve) AS cost FROM signals').get().cost,50);
  } finally { db.close(); }
});

test('only published bids strictly above a strike can generate one depth-backed paper entry', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE signals(ticker TEXT PRIMARY KEY,reserve INTEGER NOT NULL,detail TEXT NOT NULL)');
  const event = 'KXART-TEST';
  const strikes = [90,95,100].map(threshold => ({ticker:event+'-'+threshold,threshold,primary:'p',secondary:'s',strikeType:'greater'}));
  const target = {id:'123',lot:'7A',artist:'Artist',title:'Title',event,markets:strikes};
  const auction = {targets:[target],sale:'24266',sourceUrl:'source',deadline:new Date(Date.now()+60000).toISOString()};
  const config = {contractsPerOrder:1,maxPriceCents:95,minConditionalProfitCents:2,maxOrderCostCents:100,maxTotalReservedCents:500,maxOrders:5,maxSourceAgeMs:15000,maxQuoteAgeMs:2000};
  const l = {object_id:'123',analytics_id:'24266.7.A',lot_id_txt:'7 A',title_primary_txt:'Artist',title_secondary_txt:'Title',
    is_in_progress:true,is_auction_over:false,lot_withdrawn:false,current_bid:100,current_bid_txt:'',estimate_low:200};
  const markets = strikes.map(m=>({ticker:m.ticker,event_ticker:event,rules_primary:'p',rules_secondary:'s',market_type:'binary',
    status:'active',close_time:auction.deadline,notional_value_dollars:'1.00',strike_type:'greater',floor_strike:m.threshold}));
  let bookReads=0, lowerAvailable=false;
  const io = {
    async request() {
      const data={data:{lots:[l],total_hits_filtered:1},labels:{currency_txt:'USD'}};
      return {text:'<script>window.chrComponents.lots = '+JSON.stringify(data)+';</script>',requestedAt:Date.now(),receivedAt:Date.now()};
    },
    async get(route) {
      let body;
      if(route==='/series/KXART') body={series:{ticker:'KXART',fee_type:'quadratic',fee_multiplier:1}};
      else if(route==='/exchange/status') body={exchange_active:true,trading_active:true};
      else if(route.startsWith('/events/')) body={event:{event_ticker:event,settlement_sources:[{name:'Artnet',url:'https://www.artnet.com/'}],markets}};
      else { bookReads++; body={orderbook_fp:{no_dollars:[[route.includes('-90/')&&!lowerAvailable?'0.0100':'0.1800','2.00']]}}; }
      return {body,requestedAt:Date.now(),receivedAt:Date.now()};
    }
  };
  const records=[];
  const run=()=>scan({auction,config,io,db,log:async row=>records.push(row)});
  try {
    await run(); assert.equal(bookReads,0);
    l.current_bid_txt='USD 100';
    l.lot_withdrawn=true; await run(); assert.equal(bookReads,0);
    l.lot_withdrawn=false; await run(); await run();
    assert.equal(bookReads,3);
    assert.deepEqual(records.map(x=>[x.threshold,x.decision]),[[95,'paper_buy_yes'],[90,'insufficient_depth_or_price']]);
    assert.equal(records[0].quote.limitCents,82);
    lowerAvailable=true;
    await run(); await run();
    assert.equal(bookReads,4);
    assert.equal(records.length,3);
    assert.equal(records[2].threshold,90);
    assert.equal(records[2].decision,'paper_buy_yes');
  } finally { db.close(); }
});
