import {setTimeout as sleep} from 'node:timers/promises';
import {checkMarketActive} from './core.mjs';
import {nbaDailyScores,nbaQueueAhead} from './nba-final-queue.mjs';
import {windowTrades} from './public-trades.mjs';

export function crossedScore(game,clubs,official,at){
  const tip=Date.parse(game.date),ep=game.status?.period;
  if(game.status?.type?.state!=='in'||!Number.isInteger(ep)||ep<3||!(at>=tip&&at<tip+5*3600000))return null;
  const match=official.filter(c=>c.home===clubs.home&&c.away===clubs.away&&Math.abs(c.tip-tip)<=3600000);
  if(match.length!==1)return null;
  const o=match[0],teams=game.competitions[0].competitors;
  if(o.status!==2||!Number.isInteger(o.period)||o.period<3||Math.abs(ep-o.period)>1)return null;
  const espn=['home','away'].map(side=>{
    const t=teams.find(t=>t.homeAway===side);
    return /^\d+$/.test(String(t?.score))?Number(t.score):NaN;
  });
  const nba=[o.homeScore,o.awayScore];
  if(![...espn,...nba].every(n=>Number.isSafeInteger(n)&&n>=0))return null;
  return {official:o.id,espnGame:game.id,nba,espn,periods:[o.period,ep],at,
    total:Math.min(nba[0],espn[0])+Math.min(nba[1],espn[1])};
}
export function totalMarkets(e,event,day){
  if(e?.event_ticker!==event||e.series_ticker!=='KXNBATOTAL'||!e.title?.endsWith(': Total Points')||
    !e.settlement_sources?.some(s=>s.url==='https://www.nba.com')||!e.settlement_sources.some(s=>s.url==='https://espn.com')||
    !e.markets?.length||new Set(e.markets.map(m=>m.ticker)).size!==e.markets.length)throw Error('Unexpected NBA total event');
  const date=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z'));
  for(const m of e.markets){
    const k=m.floor_strike;
    if(m.event_ticker!==event||m.ticker!==event+'-'+Math.ceil(k)||k%1!==.5||m.market_type!=='binary'||
      m.title!=='Full Game: Over '+k+' points scored'||m.strike_type!=='greater'||Number(m.notional_value_dollars)!==1||
      m.rules_primary!=='If over '+k+' total points are scored in the '+e.title.slice(0,-14)+' Pro Basketball game originally scheduled for '+date+', then the market resolves to Yes.')
      throw Error('Unrecognized NBA total terms');
  }
  return e.markets;
}
export function queueShares(ahead,sales){
  const volume=check=>sales.filter(check).reduce((n,t)=>n+Math.round(t.qty*100),0)/100;
  const atLimit=volume(t=>t.price===.99),below=volume(t=>t.price<.99);
  return {atLimit,below,shares:Math.min(5,Math.floor(below+Math.max(0,atLimit-ahead)+1e-8))};
}
export function initTotalStudy(db,io,helpers){
  db.exec(`CREATE TABLE IF NOT EXISTS nba_total_signals(ticker TEXT PRIMARY KEY,event TEXT,firstAt INTEGER,lastAt INTEGER,firstScore TEXT);
    CREATE TABLE IF NOT EXISTS nba_total_queue(event TEXT PRIMARY KEY,ticker TEXT,arrival INTEGER,untilAt INTEGER,ahead REAL,
      proof TEXT,checked INTEGER,sales TEXT,result TEXT,atLimit REAL,below REAL,shares INTEGER)`);
  const markets=new Map();
  let nextListing=0;
  const signals=db.prepare('SELECT * FROM nba_total_signals WHERE ticker=?');
  const upsert=db.prepare('INSERT OR REPLACE INTO nba_total_signals VALUES(?,?,?,?,?)');
  async function observe(game,official,day){
    const p=crossedScore(game,helpers.teams(game.competitions[0]),official,Date.now());
    if(!p)return;
    const event=helpers.event(game).replace(/^KXNBAGAME-/,'KXNBATOTAL-');
    if(db.prepare('SELECT 1 FROM nba_total_queue WHERE event=?').get(event))return;
    let listing=markets.get(event);
    if(!listing||p.at-listing.at>=60000){
      const slot=Math.max(Date.now(),nextListing);
      nextListing=slot+300;
      if(slot>Date.now())await sleep(slot-Date.now());
      const e=(await io.get('/events/'+event+'?with_nested_markets=true')).body.event;
      listing={at:p.at,rows:totalMarkets(e,event,day)};markets.set(event,listing);
    }
    const eligible=[];
    for(const m of listing.rows){
      if(!checkMarketActive(m,p.at)||m.floor_strike>=p.total-4){
        db.prepare('DELETE FROM nba_total_signals WHERE ticker=?').run(m.ticker);
        continue;
      }
      const prev=signals.get(m.ticker);
      if(!prev||p.at-prev.lastAt>90000){upsert.run(m.ticker,event,p.at,p.at,JSON.stringify(p));continue;}
      db.prepare('UPDATE nba_total_signals SET lastAt=? WHERE ticker=?').run(p.at,m.ticker);
      if(p.at-prev.firstAt>=30000)eligible.push(m);
    }
    if(!eligible.length)return;
    const query=new URLSearchParams(eligible.map(m=>['tickers',m.ticker]));query.set('depth','100');
    const read=()=>io.get('/markets/orderbooks?'+query);
    const a=await read();await sleep(1400);const b=await read();
    const stamp=r=>Date.parse(r.httpDate)-1000*Number(r.cacheAge??0);
    if(helpers.stop()||!(stamp(b)>stamp(a))||a.requestedAt<p.at||b.receivedAt-p.at>8000||
      ![a,b].every(r=>stamp(r)>=r.receivedAt-3000&&stamp(r)<=r.receivedAt+1000&&r.receivedAt-r.requestedAt<=2500))return;
    const books=[a,b].map(r=>new Map(r.body.orderbooks.map(v=>[v.ticker,v])));
    if(!books.every(map=>map.size===eligible.length&&eligible.every(m=>map.has(m.ticker)))||
      ![a,b].every(r=>r.body.orderbooks.length===eligible.length))throw Error('Incomplete NBA total books');
    const arrival=b.receivedAt+1000,until=arrival+300000;
    const options=eligible.flatMap(m=>{
      const depths=books.map(book=>nbaQueueAhead(book.get(m.ticker),'yes'));
      if(!checkMarketActive(m,until)||!depths.every(Number.isFinite))return [];
      return [{ticker:m.ticker,strike:m.floor_strike,depths,ahead:Math.max(...depths)}];
    }).sort((x,y)=>x.ahead-y.ahead||x.ticker.localeCompare(y.ticker));
    if(!options.length)return;
    const chosen=options[0],first=JSON.parse(signals.get(chosen.ticker).firstScore);
    const proof=JSON.stringify({first,confirmation:p,books:books.map(map=>map.get(chosen.ticker)),bookTimes:[stamp(a),stamp(b)],options});
    db.prepare('INSERT OR IGNORE INTO nba_total_queue(event,ticker,arrival,untilAt,ahead,proof) VALUES(?,?,?,?,?,?)')
      .run(event,chosen.ticker,arrival,until,chosen.ahead,proof);
  }
  async function review(){
    const now=Date.now(),q=db.prepare('SELECT * FROM nba_total_queue WHERE untilAt<=? AND result IS NULL AND COALESCE(checked,0)<? ORDER BY COALESCE(checked,0) LIMIT 1').get(now-60000,now-60000);
    if(!q)return;
    db.prepare('UPDATE nba_total_queue SET checked=? WHERE event=?').run(now,q.event);
    const m=(await io.get('/markets/'+q.ticker)).body.market;
    if(m.ticker!==q.ticker||!Number.isFinite(Date.parse(m.close_time)))throw Error('Unknown NBA total close');
    const untilAt=Math.min(q.untilAt,Date.parse(m.close_time));
    let saved=q.sales&&JSON.parse(q.sales);
    if(!saved||saved.untilAt!==untilAt){
      const rows=await windowTrades(io,{ticker:q.ticker,arrival:q.arrival,untilAt},'yes','no');
      saved={untilAt,rows:rows.filter(t=>t.price<=.99)};
    }
    const {atLimit,below,shares}=queueShares(q.ahead,saved.rows);
    const settled=m.status==='finalized'&&m.settlement_value_dollars!=null;
    const result=settled?(['yes','no'].includes(m.result)&&Number(m.settlement_value_dollars)===Number(m.result==='yes')?m.result:'other'):null;
    db.prepare('UPDATE nba_total_queue SET atLimit=?,below=?,shares=?,sales=?,result=? WHERE event=?')
      .run(atLimit,below,shares,JSON.stringify(saved),result,q.event);
  }
  return async games=>{
    await review();
    for(const [event,entry] of markets)if(Date.now()-entry.at>24*3600000)markets.delete(event);
    const days=new Map();
    const live=games.filter(g=>g.status?.type?.state==='in'&&g.status.period>=3);
    for(const g of live){
      const day=helpers.day(g);
      if(!days.has(day))days.set(day,await (helpers.scores??nbaDailyScores)(day));
    }
    const checks=await Promise.allSettled(live.map(g=>observe(g,days.get(helpers.day(g)),helpers.day(g))));
    const count=db.prepare(`SELECT COUNT(*) trials,COUNT(shares) reviewed,COALESCE(SUM(shares),0) shares,
      COUNT(CASE WHEN shares>0 THEN 1 END) withSales, COUNT(CASE WHEN shares>0 AND result='yes' THEN 1 END) wins,
      COUNT(CASE WHEN shares>0 AND result='no' THEN 1 END) losses FROM nba_total_queue`).get();
    return {...count,live:live.length,at:Date.now(),error:checks.find(r=>r.status==='rejected')?.reason?.message??null,
      recent:db.prepare('SELECT event,ticker,ahead,shares,arrival,atLimit,below,result FROM nba_total_queue ORDER BY arrival DESC LIMIT 8').all()};
  };
}
