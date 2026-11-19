import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {initNBAFinalQueue,matchingFinal,nbaQueueAhead} from '../nba-final-queue.mjs';

test('postgame observer waits for corroboration and ranks repeated queues on the two equivalent routes',async()=>{
  const now=Date.now(),tip=now-2*3600000,cut=now-60000,e='KXNBAGAME-TEST';
  const teams={home:'NYK',away:'PHI'};
  const c={status:{type:{completed:true}},competitors:[{homeAway:'home',score:'110'},{homeAway:'away',score:'101'}]};
  const game={id:'game',date:new Date(tip).toISOString(),status:{period:4,type:{completed:true}},competitions:[c]};
  const summary={header:{id:'game',competitions:[c]},plays:[{type:{text:'End Game'},clock:{displayValue:'0.0'},
    period:{number:4},wallclock:new Date(cut).toISOString(),homeScore:110,awayScore:101}]};
  const card={id:'NBA',home:'NYK',away:'PHI',homeScore:110,awayScore:101,status:3,tip,period:4};
  assert.equal(matchingFinal(game,teams,summary,[{...card,homeScore:108}],now),null);
  assert.equal(matchingFinal(game,teams,summary,[{...card,status:2}],now),null);
  assert.equal(matchingFinal(game,teams,summary,[card,card],now),null);
  const home={ticker:e+'-NYK',status:'active',close_time:new Date(now+360000).toISOString()};
  const away={...home,ticker:e+'-PHI'};
  const book=(m,y,n)=>({ticker:m.ticker,orderbook_fp:{yes_dollars:y,no_dollars:n}});
  assert.equal(nbaQueueAhead(book(home,[['0.99','30']],[['0.01','1']]),'yes'),null);
  const db=new DatabaseSync(':memory:');
  try{
    let reads=0;
    const io={get:async route=>{
      if(route.startsWith('/events/'))return {body:{}};
      if(route.startsWith('/markets/orderbooks?')){
        const at=Date.now();reads++;
        return {requestedAt:at,receivedAt:at+1,httpDate:new Date(at).toUTCString(),body:{orderbooks:[
          book(home,[['0.99','1000']],[]),book(away,[],[['0.99',reads===1?'45.5':'40']])]}};
      }
      throw Error('Unexpected route '+route);
    }};
    const helpers={teams:()=>teams,day:()=>'',scores:async()=>[card],summary:async()=>summary,event:()=>e,
      routes:()=>[{market:home,side:'yes'},{market:away,side:'no'}],stop:()=>false};
    let scan=initNBAFinalQueue(db,io,helpers);
    assert.equal((await scan([game])).confirmed,1);
    assert.equal(reads,0);
    // Resume from a persisted receipt once the 30-second wait has elapsed.
    db.prepare('UPDATE nba_final_receipts SET at=?').run(now-45000);
    scan=initNBAFinalQueue(db,io,helpers);
    assert.equal((await scan([game])).trials,1);
    const t=db.prepare('SELECT * FROM nba_final_queue').get();
    assert.equal(t.ticker,away.ticker);assert.equal(t.side,'no');assert.equal(t.ahead,45.5);
    await scan([game]);assert.equal(reads,2);
    const start=now-180000,end=now-90000;
    db.prepare('UPDATE nba_final_queue SET arrival=?,untilAt=?').run(start,end);
    const settled={get:async route=>{
      if(route==='/markets/'+t.ticker)return {body:{market:{ticker:t.ticker,status:'finalized',result:'no',close_time:new Date(end).toISOString()}}};
      if(route==='/historical/cutoff')return {body:{trades_created_ts:new Date(start-1000).toISOString()}};
      if(route.startsWith('/markets/trades?'))return {body:{trades:[{ticker:t.ticker,trade_id:'a',created_time:new Date(start+2000).toISOString(),
        is_block_trade:false,taker_outcome_side:'yes',taker_book_side:'bid',no_price_dollars:'0.99',count_fp:'50.50'}],cursor:''}};
      throw Error('Unexpected review '+route);
    }};
    const reviewed=await initNBAFinalQueue(db,settled,helpers)([]);
    assert.equal(reviewed.reviewed,1);assert.equal(reviewed.reachedFive,1);assert.equal(reviewed.adverseFive,0);
    const missed={...game,id:'late'};
    const delayed={...summary,header:{...summary.header,id:'late'},plays:[{...summary.plays[0],wallclock:new Date(now-360000).toISOString()}]};
    const lateScan=initNBAFinalQueue(db,io,{...helpers,summary:async()=>delayed});
    await lateScan([{...missed,status:{type:{state:'in'}}}]);
    assert.equal((await lateScan([missed])).missedFinal,1);
  }finally{db.close();}
});
