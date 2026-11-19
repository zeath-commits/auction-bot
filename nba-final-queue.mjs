import {setTimeout as sleep} from 'node:timers/promises';
import {askLevels,checkMarketActive} from './core.mjs';

export async function nbaDailyScores(date){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Invalid NBA game date');
  const r=await fetch('https://www.nba.com/games?date='+date,{cache:'no-store',signal:AbortSignal.timeout(6500)});
  if(!r.ok)throw Error('NBA scoreboard HTTP '+r.status);
  const match=(await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const page=match&&JSON.parse(match[1]).props?.pageProps;
  if(page?.selectedDate!==date||!Array.isArray(page.gameCardFeed?.modules))throw Error('NBA scoreboard date or format changed');
  return page.gameCardFeed.modules.flatMap(m=>m.cards??[]).map(c=>c.cardData).filter(c=>c?.leagueId==='00')
    .map(c=>({id:c.gameId,home:c.homeTeam?.teamTricode,away:c.awayTeam?.teamTricode,homeScore:c.homeTeam?.score,
      awayScore:c.awayTeam?.score,status:c.gameStatus,period:c.period,tip:Date.parse(c.gameTimeUtc)}));
}
export function matchingFinal(game,teams,summary,cards,now){
  const c=summary.header?.competitions?.[0],p=summary.plays?.at(-1), tip=Date.parse(game.date);
  const official=cards.filter(c=>c.home===teams.home&&c.away===teams.away&&Math.abs(c.tip-tip)<=3600000);
  if(official.length!==1||official[0].status!==3||official[0].period!==p?.period?.number||
    String(summary.header?.id)!==game.id||!c?.status?.type?.completed||!game.status?.type?.completed||
    p?.type?.text!=='End Game'||!/^0+(?::00)?(?:\.0+)?$/.test(p.clock?.displayValue)||
    p.period.number<4||p.period.number!==game.status.period)return null;
  const s=official[0],at=Date.parse(p.wallclock);
  if(![s.homeScore,s.awayScore].every(n=>Number.isInteger(n)&&n>=0)||s.homeScore===s.awayScore||
    !(at>=tip+3600000&&at<=tip+5*3600000&&now>=at&&now<at+300000)||
    p.homeScore!==s.homeScore||p.awayScore!==s.awayScore)return null;
  for(const team of ['home','away']){
    if(![c,game.competitions[0]].every(v=>Number(v.competitors.find(t=>t.homeAway===team)?.score)===s[team+'Score']))return null;
  }
  return {end:at,leader:s.homeScore>s.awayScore?teams.home:teams.away,
    opponent:s.homeScore>s.awayScore?teams.away:teams.home,home:s.homeScore,away:s.awayScore,official:s.id};
}
export function nbaQueueAhead(book,side){
  if(!Array.isArray(book?.orderbook_fp?.yes_dollars)||!Array.isArray(book.orderbook_fp.no_dollars))return null;
  if(askLevels(book,side.toUpperCase(),99).some(l=>l.quantity>0))return null;
  const opposite=side==='yes'?'NO':'YES';
  return askLevels(book,opposite,1).reduce((sum,l)=>sum+l.quantity,0)/1e6;
}
export function initNBAFinalQueue(db,io,helpers){
  db.exec(`CREATE TABLE IF NOT EXISTS nba_final_receipts(game TEXT PRIMARY KEY,at INTEGER,score TEXT,decision TEXT);
    CREATE TABLE IF NOT EXISTS nba_final_live_games(game TEXT PRIMARY KEY,firstLive INTEGER,expired INTEGER);
    CREATE TABLE IF NOT EXISTS nba_final_queue(game TEXT PRIMARY KEY,ticker TEXT,side TEXT,arrival INTEGER,untilAt INTEGER,
    ahead REAL,detail TEXT,atLimit REAL,belowLimit REAL,result TEXT,reviewed INTEGER)`);
  const lookup=db.prepare('SELECT * FROM nba_final_receipts WHERE game=?');
  const save=db.prepare('INSERT OR IGNORE INTO nba_final_receipts VALUES(?,?,?,NULL)');
  const finish=db.prepare('UPDATE nba_final_receipts SET decision=? WHERE game=? AND decision IS NULL');
  const sawLive=db.prepare('INSERT OR IGNORE INTO nba_final_live_games(game,firstLive) VALUES(?,?)');
  const expire=db.prepare('UPDATE nba_final_live_games SET expired=? WHERE game=? AND expired IS NULL');
  // Keep both types of seller volume in hundredths until whole shares are counted.
  const evaluated=`SELECT ticker,side,arrival,ahead,atLimit,belowLimit,result,
    MIN(5,CAST((ROUND(belowLimit*100)+MAX(0,ROUND(atLimit*100)-ROUND(ahead*100)))/100 AS INTEGER)) AS supported
    FROM nba_final_queue`;
  const evidence=db.prepare(`SELECT COUNT(*) trials,COUNT(result) reviewed,
    COUNT(CASE WHEN supported=5 THEN 1 END) reachedFive,
    COUNT(CASE WHEN result<>side AND supported=5 THEN 1 END) adverseFive FROM (${evaluated})`);
  const recent=db.prepare(`SELECT * FROM (${evaluated}) ORDER BY arrival DESC LIMIT 12`);
  const lastCheck=new Map();
  async function check(game,day,readOfficial){
    const now=Date.now(),old=lookup.get(game.id);
    if(old?.decision||now<(lastCheck.get(game.id)??0)||old&&now<old.at+30000)return;
    if(old&&now>=JSON.parse(old.score).end+300000){finish.run('Window ended',game.id);return;}
    lastCheck.set(game.id,now+5000);
    const summary=await helpers.summary(game.id),end=summary.plays?.at(-1);
    if(String(summary.header?.id)===game.id&&summary.header?.competitions?.[0]?.status?.type?.completed&&
      end?.type?.text==='End Game'&&Date.parse(end.wallclock)>=Date.parse(game.date)+3600000&&
      Date.now()>=Date.parse(end.wallclock)+300000){
      if(old)finish.run('Window ended',game.id);
      else expire.run(now,game.id);
      lastCheck.set(game.id,Date.parse(game.date)+6*3600000);
      return;
    }
    const cards=await readOfficial(day);
    const f=matchingFinal(game,helpers.teams(game.competitions[0]),summary,cards,Date.now());
    if(!f)return;
    if(!old){save.run(game.id,Date.now(),JSON.stringify(f));return;}
    if(JSON.stringify(f)!==old.score){finish.run('Final score changed',game.id);return;}
    const event=helpers.event(game), listing=(await io.get('/events/'+event+'?with_nested_markets=true')).body;
    const routes=helpers.routes(listing,{ticker:event+'-'+f.leader,opponent:event+'-'+f.opponent},event);
    if(!routes.length){finish.run('Markets closed or terms unavailable',game.id);return;}
    const q=new URLSearchParams(routes.map(r=>['tickers',r.market.ticker]));q.set('depth','100');
    const read=()=>io.get('/markets/orderbooks?'+q);
    const a=await read();await sleep(1250);const b=await read();
    const asOf=r=>Math.min(r.requestedAt,Date.parse(r.httpDate)-1000*(1+Number(r.cacheAge??0)));
    if(helpers.stop()||![a,b].every(r=>r.receivedAt-r.requestedAt<=2000&&Date.parse(r.httpDate)<=r.receivedAt+1500&&asOf(r)>=r.receivedAt-4500)||
      !(asOf(a)>=old.at+30000&&asOf(b)>asOf(a)))return;
    const arrival=b.receivedAt+1000;
    const candidates=routes.flatMap(({market,side})=>{
      const untilAt=Math.min(Date.parse(market.close_time),f.end+300000);
      if(!checkMarketActive(market,arrival)||arrival>=untilAt)return [];
      const ahead=[a,b].map(r=>nbaQueueAhead(r.body.orderbooks.find(x=>x.ticker===market.ticker),side));
      return ahead.some(x=>x===null)?[]:[{ticker:market.ticker,side,untilAt,ahead:Math.max(...ahead),samples:ahead}];
    }).sort((x,y)=>x.ahead-y.ahead||x.ticker.localeCompare(y.ticker));
    if(!candidates.length)return;
    const p=candidates[0];
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare('INSERT OR IGNORE INTO nba_final_queue(game,ticker,side,arrival,untilAt,ahead,detail) VALUES(?,?,?,?,?,?,?)')
        .run(game.id,p.ticker,p.side,arrival,p.untilAt,p.ahead,JSON.stringify({candidates,first:a.receivedAt,second:b.receivedAt}));
      finish.run('Queue recorded',game.id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  async function review(){
    const now=Date.now(),t=db.prepare('SELECT * FROM nba_final_queue WHERE result IS NULL AND untilAt<=? AND COALESCE(reviewed,0)<? ORDER BY COALESCE(reviewed,0) LIMIT 1').get(now-60000,now-60000);
    if(!t)return;
    db.prepare('UPDATE nba_final_queue SET reviewed=? WHERE game=?').run(now,t.game);
    const m=(await io.get('/markets/'+t.ticker)).body.market;
    if(m?.ticker!==t.ticker||m.status!=='finalized'||!['yes','no'].includes(m.result))return;
    const cutoff=Date.parse((await io.get('/historical/cutoff')).body.trades_created_ts);
    if(!Number.isFinite(cutoff))throw Error('Missing NBA trade archive cutoff');
    let atLimit=0,belowLimit=0;
    const ids=new Set(),until=Math.min(t.untilAt,Date.parse(m.close_time));
    if(!Number.isFinite(until))throw Error('Unknown final market close time');
    for(const path of [t.arrival<until&&t.arrival<cutoff&&'/historical/trades',t.arrival<until&&until>=cutoff&&'/markets/trades'].filter(Boolean)){
      const q=new URLSearchParams({ticker:t.ticker,min_ts:Math.floor(t.arrival/1000),max_ts:Math.ceil(until/1000),limit:1000,is_block_trade:false});
      let cursor;const seen=new Set();
      do{
        if(cursor)q.set('cursor',cursor);
        const page=(await io.get(path+'?'+q)).body;
        for(const x of page.trades){
          if(x.ticker!==t.ticker||!x.trade_id||x.is_block_trade!==false)throw Error('Unexpected NBA tape');
          if(ids.has(x.trade_id))continue;
          ids.add(x.trade_id);
          const at=Date.parse(x.created_time),price=Number(x[t.side+'_price_dollars']),size=Number(x.count_fp);
          if(!Number.isFinite(at)||!(price>0&&price<1&&size>0))throw Error('Invalid NBA trade');
          const buyer=t.side==='yes'?'no':'yes';
          if(at<t.arrival||at>=until||x.taker_outcome_side!==buyer||x.taker_book_side!==(buyer==='yes'?'bid':'ask'))continue;
          if(price===.99)atLimit+=Math.round(100*size);
          if(price<.99)belowLimit+=Math.round(100*size);
        }
        cursor=page.cursor;if(cursor&&seen.has(cursor))throw Error('Repeated NBA trade cursor');seen.add(cursor);
      }while(cursor);
    }
    db.prepare('UPDATE nba_final_queue SET result=?,atLimit=?,belowLimit=? WHERE game=?').run(m.result,atLimit/100,belowLimit/100,t.game);
  }
  return async games=>{
    const daily=new Map();
    const readOfficial=date=>{
      if(!daily.has(date))daily.set(date,(helpers.scores??nbaDailyScores)(date));
      return daily.get(date);
    };
    const now=Date.now(),eligible=games.filter(g=>g.status?.type?.completed&&now-Date.parse(g.date)<=5.1*3600000);
    for(const game of games)if(game.status?.type?.state==='in')sawLive.run(game.id,now);
    const outcomes=await Promise.allSettled(eligible.map(g=>check(g,helpers.day(g),readOfficial)));
    await review();
    return {...evidence.get(),recent:recent.all(),confirmed:db.prepare('SELECT COUNT(*) n FROM nba_final_receipts').get().n,
      missedFinal:db.prepare('SELECT COUNT(expired) n FROM nba_final_live_games').get().n,
      pending:db.prepare('SELECT COUNT(*) n FROM nba_final_receipts WHERE decision IS NULL AND at>=?').get(now-300000).n,
      error:outcomes.find(r=>r.status==='rejected')?.reason?.message??null};
  };
}
