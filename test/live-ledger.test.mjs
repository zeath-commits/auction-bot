import test from 'node:test';
import assert from 'node:assert/strict';
import {botFills,reconcileLedger,verifySettlement} from '../live-ledger.mjs';

const ticker='KXART-PILOT-50000';
const orders=[{orderId:'one',ticker,subaccount:2,side:'NO',quantity:.5,cost:.33},
  {orderId:'two',ticker,subaccount:2,side:'NO',quantity:1.5,cost:.98}];
const fills=orders.map((o,i)=>({ticker,exchange_index:0,market_ticker:ticker,order_id:o.orderId,fill_id:'fill-'+i,
  subaccount_number:2,outcome_side:'no',book_side:'ask',count_fp:o.quantity.toFixed(2),yes_price_dollars:'0.3600',
  no_price_dollars:'0.6400',fee_cost:i?'0.0190':'0.0070'}));
const settlement={ticker,exchange_index:0,yes_count_fp:'0.00',no_count_fp:'2.00',yes_total_cost_dollars:'0.0000',
  no_total_cost_dollars:'1.2800',fee_cost:'0.0260',revenue:200,market_result:'no',settled_time:'2026-11-20T15:10:00Z'};

test('one account payout covers two fractional bot orders, their exact fees and overlap across archives',()=>{
  const v=verifySettlement(orders,[...fills,fills[0]],[settlement]);
  assert.deepEqual([v.quantity,v.principal,v.fees,v.proceeds,v.tradingNet,v.fillCount],[2,1.28,.026,2,.694,2]);
  assert.equal(verifySettlement(orders,fills,[{...settlement,market_result:'yes',revenue:0}]).tradingNet,-1.306);
  assert.equal(verifySettlement(orders,fills,[{...settlement,market_result:'scalar',value:25,revenue:150}]).tradingNet,.194);
});
test('mixed manual activity, missing fills, changed payouts and inconsistent charges require review',()=>{
  for(const bad of [
    ()=>verifySettlement(orders,[...fills,{...fills[0],order_id:'manual',fill_id:'extra'}],[settlement]),
    ()=>verifySettlement(orders,fills.slice(0,1),[settlement]),
    ()=>verifySettlement(orders,[...fills,{...fills[0],count_fp:'0.10'}],[settlement]),
    ()=>verifySettlement(orders,fills,[{...settlement,no_count_fp:'1.99'}]),
    ()=>verifySettlement(orders,fills,[{...settlement,revenue:199}]),
    ()=>verifySettlement(orders,fills,[{...settlement,fee_cost:'0.02'}])
  ])assert.throws(bad);
});
test('read-only reconciliation scopes every page and withholds total while expenses or receipts are unknown',async()=>{
  const routes=[];
  const io={get:async(route,auth)=>{
    assert.equal(auth,true);
    const [path,query]=route.split('?'),q=new URLSearchParams(query);routes.push(path);
    assert.equal(q.get('ticker'),ticker);assert.equal(q.get('subaccount'),'2');
    if(path==='/portfolio/settlements')return {body:{settlements:[settlement]}};
    if(path==='/historical/fills')return {body:{fills:[fills[0]]}};
    assert.equal(path,'/portfolio/fills');
    return {body:q.has('cursor')?{fills:[fills[1]]}:{fills:[fills[0]],cursor:'next'}};
  }};
  const journal={history:orders,conflicts:0,unresolved:0};
  const checked=await reconcileLedger(io,journal,.15);
  assert.equal(checked.pilotNet,.544);assert.equal(checked.markets.length,1);
  assert.deepEqual(routes,['/portfolio/settlements','/portfolio/fills','/portfolio/fills','/historical/fills']);
  assert.equal((await reconcileLedger(io,journal,null)).pilotNet,null);
  assert.equal((await reconcileLedger(io,{...journal,unresolved:1},0)).pilotNet,null);
  const empty=await reconcileLedger(undefined,botFills([]),0);
  assert.equal(empty.tradingNet,null);assert.equal(empty.pilotNet,null);
});
