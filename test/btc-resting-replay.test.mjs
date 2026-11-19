import test from 'node:test';
import assert from 'node:assert/strict';
import {cancelTime,summarize} from '../btc-resting-replay.mjs';
import {measureSales} from '../public-trades.mjs';

test('cancellation waits for the completed candle, delayed read and one second of transit',()=>{
  const end=1000,close=end*1000,decision=close-45000;
  const prices=new Map(Array.from({length:60},(_,i)=>[end-60+i,101]));
  assert.equal(cancelTime(prices,close,100,decision,'yes'),close);
  prices.set(end-40,99);
  const until=cancelTime(prices,close,100,decision,'yes');
  assert.equal(until,close-36000);
  const sale=(at,price,qty)=>({at:new Date(at).toISOString(),price,qty});
  const sales=[sale(until-5,.998,500),sale(until-3,.990,3.5),sale(until-1,.997,2.1),sale(until,.98,100)];
  assert.deepEqual(measureSales(sales,.998,until),{volume:5.6,shares:5});
  assert.deepEqual(measureSales(sales,.980,until+1),{volume:0,shares:0});
});

test('the resting replay keeps losses and requires funds for the full order until prior payouts arrive',()=>{
  const rows=Array.from({length:12},(_,i)=>({
    close:100000+i*900000,settled:100000+10*900000,won:i!==0,ticker:String(i),
    scenarios:{untilClose:{998:{shares:i===10?1:100}}}
  }));
  const s=summarize(rows,998,'untilClose');
  assert.deepEqual([s.filled,s.losses,s.wins,s.unfunded,s.shares,s.gross],[11,1,10,1,1100,-97.8]);
});

test('full cash sensitivity caps shares before seeing the volume and never double spends an unsettled position',()=>{
  const example=(ticker,close,settled,won,volume)=>({ticker,close,settled,won,scenarios:{nineSeconds:{998:{volume}}}});
  const rows=[example('loss',100000,2000000,false,1500),example('waiting',1000000,1100000,true,1100),
    example('later',3000000,3100000,true,100)];
  const s=summarize(rows,998,'nineSeconds',true);
  assert.deepEqual([s.shares,s.maxCost,s.gross,s.filled,s.unfunded],[1002,999.996,-999.996,1,2]);
});
