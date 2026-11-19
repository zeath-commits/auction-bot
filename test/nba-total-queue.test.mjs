import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {crossedScore,totalMarkets,queueShares,initTotalStudy} from '../nba-total-queue.mjs';

test('NBA totals require the same live game and use the lower score for each team',()=>{
  const date='2026-11-18T23:30:00Z',tip=Date.parse(date);
  const game={id:'12',date,status:{period:4,type:{state:'in'}},competitions:[{competitors:[
    {homeAway:'home',score:'109'},{homeAway:'away',score:'102'}]}]};
  const row={id:'9',home:'AAA',away:'BBB',tip,period:4,status:2,homeScore:108,awayScore:104};
  const read=rows=>crossedScore(game,{home:'AAA',away:'BBB'},rows,tip+6000000);
  assert.equal(read([row]).total,210);
  assert.equal(read([row,row]),null);
  assert.equal(read([{...row,home:'BBB',away:'AAA'}]),null);
  assert.equal(read([{...row,status:3}]),null);
  game.competitions[0].competitors[0].score=null;
  assert.equal(read([row]),null);
});
test('NBA total market identity includes the score rule, game and date',()=>{
  const event='KXNBATOTAL-26NOV18MEMCLE';
  const m={event_ticker:event,ticker:event+'-208',market_type:'binary',floor_strike:207.5,strike_type:'greater',notional_value_dollars:'1.0000',
    title:'Full Game: Over 207.5 points scored',rules_primary:'If over 207.5 total points are scored in the Memphis vs Cleveland Pro Basketball game originally scheduled for Nov 18, 2026, then the market resolves to Yes.'};
  const e={event_ticker:event,series_ticker:'KXNBATOTAL',title:'Memphis vs Cleveland: Total Points',settlement_sources:[{url:'https://www.nba.com'},{url:'https://espn.com'}],markets:[m]};
  assert.deepEqual(totalMarkets(e,event,'2026-11-18'),[m]);
  assert.throws(()=>totalMarkets(e,event,'2026-11-19'));
  assert.throws(()=>totalMarkets({...e,markets:[{...m,title:'First half'}]},event,'2026-11-18'));
});
test('99-cent sales behind the visible queue and sales at lower prices use whole shares',()=>{
  const tape=[{price:.99,qty:403.22},{price:.98,qty:2.2},{price:.999,qty:50}];
  assert.deepEqual(queueShares(401.1,tape),{atLimit:403.22,below:2.2,shares:4});
  assert.equal(queueShares(450,tape).shares,2);
  assert.equal(queueShares(0,tape).shares,5);
});
test('NBA total bid requires a second score check and grades seller volume only after arrival',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const now=Date.now(),date=new Date(now-5400000).toISOString(),day=date.slice(0,10);
    const formatted=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(date));
    const event='KXNBATOTAL-TEST',ticker=event+'-208';
    const market={ticker,event_ticker:event,market_type:'binary',floor_strike:207.5,strike_type:'greater',notional_value_dollars:'1.0000',
      title:'Full Game: Over 207.5 points scored',status:'active',close_time:new Date(now+3600000).toISOString(),
      rules_primary:'If over 207.5 total points are scored in the Memphis vs Cleveland Pro Basketball game originally scheduled for '+formatted+', then the market resolves to Yes.'};
    const listing={event_ticker:event,series_ticker:'KXNBATOTAL',title:'Memphis vs Cleveland: Total Points',settlement_sources:[{url:'https://www.nba.com'},{url:'https://espn.com'}],markets:[market]};
    const game={id:'12',date,status:{type:{state:'in'},period:4},competitions:[{competitors:[{homeAway:'home',score:'105'},{homeAway:'away',score:'107'}]}]};
    const official={home:'CLE',away:'MEM',status:2,period:4,tip:Date.parse(date),homeScore:105,awayScore:107};
    const arrival=now-480000;
    const io={async get(route){
      if(route.startsWith('/events/'))return {body:{event:listing}};
      if(route.startsWith('/markets/orderbooks?')){
        const ts=Date.now();
        return {requestedAt:ts,receivedAt:ts,httpDate:new Date(ts).toUTCString(),body:{orderbooks:[{ticker,orderbook_fp:{no_dollars:[],yes_dollars:[['0.9900','100.00']]}}]}};
      }
      if(route==='/markets/'+ticker)return {body:{market:{...market,result:'yes',status:'finalized',settlement_value_dollars:'1.0000'}}};
      if(route==='/historical/cutoff')return {body:{trades_created_ts:new Date(arrival-86400000).toISOString()}};
      if(route.startsWith('/markets/trades?')){
        const trade=(id,ms,qty,price)=>({ticker,trade_id:id,created_time:new Date(arrival+ms).toISOString(),count_fp:qty,yes_price_dollars:price,
          is_block_trade:false,taker_outcome_side:'no',taker_book_side:'ask'});
        return {body:{trades:[trade('before',0,'500','.99'),trade('queue',100,'102','.99'),trade('below',200,'1.4','.98')]}};
      }
      throw Error('Unexpected '+route);
    }};
    const scan=initTotalStudy(db,io,{stop:()=>false,scores:async()=>[official],day:()=>day,event:()=>event,teams:()=>({home:'CLE',away:'MEM'})});
    assert.equal((await scan([game])).trials,0);
    db.prepare('UPDATE nba_total_signals SET firstAt=firstAt-31000').run();
    assert.equal((await scan([game])).trials,1);
    db.prepare('UPDATE nba_total_queue SET arrival=?,untilAt=?').run(arrival,arrival+300000);
    const r=await scan([]);
    assert.equal(r.reviewed,1);assert.equal(r.wins,1);assert.equal(r.shares,3);assert.equal(r.recent[0].atLimit,102);
  }finally{db.close();}
});
