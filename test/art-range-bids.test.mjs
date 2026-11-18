import assert from 'node:assert/strict';
import test from 'node:test';
import { rangeSignals } from '../art-range-bids.mjs';

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
