import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chooseRoute,nhlFinalStudy,replayBid,scheduledCohort} from '../nhl-final-paper.mjs';

test('NHL cohort is the first 30 scheduled starts, with stable tiebreaks and no duplicates',()=>{
  const tip=Date.parse('2026-11-20T00:00:00Z');
  const games=Array.from({length:33},(_,id)=>({id,gameType:2,startTimeUTC:new Date(tip).toISOString(),awayTeam:{abbrev:'LAK'},homeTeam:{abbrev:'TOR'}})).reverse();
  games.push({...games[0],id:99,gameType:1},{...games[0],id:100,startTimeUTC:new Date(tip-1).toISOString()});
  const day={date:'2026-11-19',games};
  const rows=scheduledCohort([day,day],tip);
  assert.deepEqual(rows.map(g=>g.id),Array.from({length:30},(_,i)=>i));
  assert.equal(rows[0].event,'KXNHLGAME-26NOV19LATOR');
});

test('Resting bids need two fresh uncrossed books and an open arrival window',()=>{
  const ms=['A','B'].map(ticker=>({ticker,status:'active',close_time:new Date(50000).toISOString()}));
  const book=(at,a,b)=>({at,asOf:at-1000,routes:[{ticker:'A',side:'yes',ahead:a},{ticker:'B',side:'no',ahead:b}]});
  const first=book(8000,10,20),second=book(10000,3,4);
  assert.equal(chooseRoute(first,second,ms,7000,20000).ahead,10);
  assert.equal(chooseRoute(first,book(10000,null,4),ms,7000,20000).ticker,'B');
  assert.throws(()=>chooseRoute(first,second,ms,7001,20000));
  assert.equal(chooseRoute(first,second,ms,7000,11000),null);
});

test('NHL tape charges losses and maker fees only on modeled fills, including partial fills',()=>{
  const bid={arrival:1000,untilAt:30000,ahead:100,side:'yes'};
  const sale=(at,qty,price=.99)=>({at:new Date(at).toISOString(),qty,price});
  const tape=[sale(1000,500),sale(29000,20,.995),sale(2000,101.25),sale(4000,.75,.98),sale(30000,10,.98)];
  assert.deepEqual(replayBid(bid,tape,0),{qty:2,fees:.0005,payout:0,net:-1.9805,atLimit:101.25,below:.75,firstFill:2000});
  assert.equal(replayBid(bid,[sale(2000,100)],1).qty,0);
  assert.equal(replayBid(bid,[sale(2000,111)],1).qty,5);
});

test('A prospective game survives restart, records both receipts, selects one queue and posts one settled paper fill',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE paper(id TEXT PRIMARY KEY,strategy,ticker,side,at,quantity,price,fees,closeAt,payout,result)');
  const base=Date.parse('2027-02-12T00:00:00Z');
  let clock=base-1000, closed=false, reads=0;
  const date='2027-02-11', iso=t=>new Date(t).toISOString();
  const games=Array.from({length:30},(_,i)=>({id:i+1, gameType:2, startTimeUTC:iso(i?base+86400000:base),
    awayTeam:{abbrev:'LAK'},homeTeam:{abbrev:'TOR'}}));
  const teams=(side,id)=>({homeAway:side,team:{abbreviation:id},score:side==='away'?'3':'2'});
  const comp=()=>({date:iso(base),competitors:[teams('away','LA'),teams('home','TOR')],
    status:{type:{state:closed?'post':'in',completed:closed}}});
  const end=base+2*3600000;
  const get=async url=>{
    let body;
    if(url.includes('/schedule/')) body={gameWeek:[{date,games}]};
    else if(url.includes('scoreboard?')) body={events:[{id:'77',competitions:[comp()]}]};
    else if(url.includes('play-by-play')) body={id:1,gameDate:date,startTimeUTC:iso(base),gameState:closed?'OFF':'LIVE',
      awayTeam:{abbrev:'LAK',score:3},homeTeam:{abbrev:'TOR',score:2},plays:[{typeDescKey:closed?'game-end':'shot'}]};
    else body={header:{id:'77',competitions:[comp()]},plays:[{type:{text:'End of Game'},awayScore:3,homeScore:2,wallclock:iso(end)}]};
    return {body,at:clock};
  };
  const event='KXNHLGAME-27FEB11LATOR', market=(team,name)=>({ticker:event+'-'+team,event_ticker:event,market_type:'binary',
    price_level_structure:'linear_cent',notional_value_dollars:'1',status:'active',close_time:'2099-01-01T00:00:00Z',
    yes_sub_title:name,rules_primary:'If '+name+' wins the Los Angeles vs Toronto NHL game originally scheduled for Feb 11, 2027, then the market resolves to Yes.',
    rules_secondary:'If the game is postponed but begins within 48 hours of its originally scheduled start time, the market will remain open and resolve based on the official final result. If the game is cancelled or not started within 48 hours of its originally scheduled start, all markets will resolve to a fair price.'});
  const ms=[market('LA','Los Angeles'),market('TOR','Toronto')];
  const io={get:async path=>{
    if(path.startsWith('/events/')) return {body:{event:{event_ticker:event,markets:ms,mutually_exclusive:true,settlement_sources:[{name:'NHL'},{name:'ESPN'}]}}};
    if(path.startsWith('/series/')) return {body:{series:{ticker:'KXNHLGAME',fee_type:'quadratic_with_maker_fees',fee_multiplier:1}}};
    if(path.startsWith('/markets/orderbooks?')) {
      reads++;
      return {requestedAt:clock,receivedAt:clock+5,httpDate:new Date(clock).toUTCString(),body:{orderbooks:[
        {ticker:ms[0].ticker,orderbook_fp:{yes_dollars:[['0.99','10.00']],no_dollars:[]}},
        {ticker:ms[1].ticker,orderbook_fp:{yes_dollars:[],no_dollars:[['0.99','4.00']]}}]}};
    }
    if(path==='/historical/cutoff') return {body:{trades_created_ts:iso(base)}};
    if(path.startsWith('/markets/trades?')) return {body:{trades:[{ticker:ms[1].ticker,trade_id:'abc',created_time:iso(end+45000),
      no_price_dollars:'0.99',count_fp:'7.00',taker_outcome_side:'yes',taker_book_side:'bid',is_block_trade:false}]}};
    assert.equal(path,'/markets/'+ms[1].ticker);
    return {body:{market:{ticker:ms[1].ticker,status:'finalized',result:'no',settlement_value_dollars:'0.0000',close_time:iso(end+100000),settlement_ts:iso(end+110000)}}};
  }};
  const open=()=>nhlFinalStudy(db,io,{get,now:()=>clock,wait:async ms=>{clock+=ms;}});
  let study=open();
  await study.tick(); clock=base; await study.tick();
  closed=true; clock=end; await study.tick();
  let g=study.summary().games[0];
  assert.equal(g.nhlFinalAt,end); assert.equal(g.espnFinalAt,end); assert.ok(!g.bid);
  study=open(); clock=end+34000; await study.tick();
  g=study.summary().games[0];
  assert.equal(reads,2); assert.equal(g.bid?.side,'no',g.error); assert.equal(g.bid.ahead,4);
  study=open(); clock=end+420000; await study.tick();
  g=study.summary().games[0];
  assert.equal(g.result?.qty,3,g.error); assert.equal(g.result.net,.0294);
  study=open(); await study.tick();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM paper').get().n,1);
  assert.equal(study.summary().games.length,30); db.close();
});
