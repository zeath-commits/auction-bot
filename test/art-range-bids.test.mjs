import assert from 'node:assert/strict';
import test from 'node:test';
import { rangeSignals, rangeSide, resolvedRange } from '../art-range-bids.mjs';

test('resolved buckets imply a side only outside the interval and honor equality at its upper end',()=>{
  const m={closed:true,umaResolutionStatus:'resolved',groupItemTitle:'$75m-$90m',outcomes:'["Yes","No"]',outcomePrices:'["1","0"]'};
  const e={closed:true,markets:[m]};
  const range=resolvedRange(e);
  assert.equal(rangeSide(range,74e6),'yes');
  assert.equal(rangeSide(range,75e6),null);
  assert.equal(rangeSide(range,86e6),null);
  assert.equal(rangeSide(range,90e6),'no');
  assert.equal(rangeSide(resolvedRange({...e,markets:[{...m,groupItemTitle:'<$75m'}]}),75e6),'no');
  assert.equal(rangeSide(resolvedRange({...e,markets:[{...m,groupItemTitle:'$90m+'}]}),90e6),null);
  assert.equal(resolvedRange({...e,closed:false}),null);
  assert.throws(()=>resolvedRange({...e,markets:[m,m]}));
  assert.throws(()=>resolvedRange({...e,markets:[{...m,outcomePrices:'["0.5","0.5"]'}]}));
});

test('price-range signal excludes the equality bracket, stale bids and insufficient Kalshi depth',()=>{
  const at=1000000;
  const levels=[{floor:120,bid:.04,observed:at},{floor:130,bid:.38,observed:at-15000},
    {floor:140,bid:.493,observed:at+100},{floor:150,bid:.03,observed:at-60001}];
  const quote={strike:120,ticker:'ART120',yes:{price:.81,size:5}};
  const [p]=rangeSignals(levels,[quote],at);
  assert.deepEqual(p.supporting.map(b=>b.floor),[130,140]);
  assert.equal(p.fees,.06);
  assert.ok(Math.abs(p.gap-.051)<1e-8);
  assert.deepEqual(rangeSignals(levels,[{...quote,yes:{price:.81,size:4}}],at),[]);
  assert.deepEqual(rangeSignals([...levels,{floor:155,bid:.50,observed:at}],[quote],at),[]);
});
