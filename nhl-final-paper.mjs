import {setTimeout as sleep} from 'node:timers/promises';
import {captureAuctionQuotes} from './auction-quote-timing.mjs';
import {checkMarketActive} from './core.mjs';
import {nbaQueueAhead} from './nba-final-queue.mjs';
import {windowTrades} from './public-trades.mjs';

const nhl = 'https://api-web.nhle.com/v1/';
const espn = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/';
const target = 30, shares = 5, minute = 60000;
const aliases = {NJD:'NJ', LAK:'LA', TBL:'TB', SJS:'SJ'};
const teamCode = team => aliases[team] ?? team;
const isoDay = at => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York'}).format(at);
const ruleDate = day => new Intl.DateTimeFormat('en-US', {
  timeZone:'UTC', month:'short', day:'numeric', year:'numeric'
}).format(new Date(day+'T12:00:00Z'));
const secondary = 'If the game is postponed but begins within 48 hours of its originally scheduled start time, the market will remain open and resolve based on the official final result. If the game is cancelled or not started within 48 hours of its originally scheduled start, all markets will resolve to a fair price.';

async function read(url) {
  const r = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(6000)});
  if (!r.ok) throw Error(new URL(url).hostname+' HTTP '+r.status);
  const body = await r.json();
  return {body, at:Date.now()};
}

export function scheduledCohort(weeks, start) {
  const games = new Map();
  for (const {date,games:dayGames} of weeks) {
    for (const g of dayGames) {
      const tip = Date.parse(g.startTimeUTC);
      if (g.gameType!==2 || !(tip>=start)) continue;
      const [year,month,day] = date.split('-');
      const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(month)-1];
      const away = g.awayTeam.abbrev, home = g.homeTeam.abbrev;
      const event = 'KXNHLGAME-'+year.slice(-2)+mon+day+teamCode(away)+teamCode(home);
      games.set(g.id, {id:g.id, date, tip, away, home, event, status:'Scheduled', next:tip});
    }
  }
  return [...games.values()].sort((a,b)=>a.tip-b.tip || a.id-b.id).slice(0,target);
}

function espnTeam(competition, side) {
  return competition?.competitors?.find(t=>t.homeAway===side);
}
function sameMatch(c,g) {
  return Date.parse(c?.date)===g.tip && espnTeam(c,'away')?.team.abbreviation===teamCode(g.away) &&
    espnTeam(c,'home')?.team.abbreviation===teamCode(g.home);
}
export function sourceScore(g, source, body) {
  if (source==='nhl') {
    if (body.id!==g.id || body.gameDate!==g.date || Date.parse(body.startTimeUTC)!==g.tip ||
      body.awayTeam?.abbrev!==g.away || body.homeTeam?.abbrev!==g.home) throw Error('NHL game identity changed');
    return {final:['OFF','FINAL'].includes(body.gameState) && body.plays?.at(-1)?.typeDescKey==='game-end',
      live:['LIVE','CRIT'].includes(body.gameState), score:[body.awayTeam.score,body.homeTeam.score],
      period:body.periodDescriptor?.number, seconds:body.clock?.secondsRemaining};
  }
  const c=body.header?.competitions?.[0], play=body.plays?.at(-1);
  if (body.header?.id!==g.espnId || !sameMatch(c,g)) throw Error('ESPN game identity changed');
  const score=['away','home'].map(side=>{
    const v=espnTeam(c,side).score;
    return typeof v==='number'||(typeof v==='string'&&/^\d+$/.test(v)) ? Number(v) : null;
  });
  return {score, live:c.status?.type?.state==='in', end:Date.parse(play?.wallclock),
    final:c.status?.type?.completed===true && play?.type?.text==='End of Game' &&
      score[0]===play.awayScore && score[1]===play.homeScore};
}

function sameScore(a,b) {
  return a?.length===2 && a[0]!==a[1] && a.every((v,i)=>Number.isInteger(v)&&v>=0&&v===b?.[i]);
}

export function checkedMarkets(g,e) {
  if (e?.event_ticker!==g.event || !e.mutually_exclusive || e.markets?.length!==2 ||
    e.fee_type_override!=null || e.fee_multiplier_override!=null ||
    e.settlement_sources?.map(s=>s.name).sort().join(',')!=='ESPN,NHL') throw Error('Unexpected NHL market terms');
  const ms=[g.away,g.home].map(t=>e.markets.find(m=>m.ticker===g.event+'-'+teamCode(t)));
  const matchup=ms.map(m=>m?.yes_sub_title).join(' vs ');
  if (!ms.every(m=>m?.event_ticker===g.event && m.market_type==='binary' && !m.is_provisional &&
    m.price_level_structure==='linear_cent' && Number(m.notional_value_dollars)===1 &&
    m.rules_primary==='If '+m.yes_sub_title+' wins the '+matchup+' NHL game originally scheduled for '+ruleDate(g.date)+', then the market resolves to Yes.' &&
    m.rules_secondary===secondary)) throw Error('Unexpected NHL contract rules');
  return ms;
}

async function queues(io,ms,awayWon) {
  let raw;
  const frame=await captureAuctionQuotes({get:async path=>{
    const r=await io.get(path); raw=r.body.orderbooks; return r;
  }},ms);
  if (!frame) return null;
  const routes=frame.rows.map(row=>{
    const side=((row.ticker===ms[0].ticker)===awayWon)?'yes':'no';
    return {ticker:row.ticker,side,ahead:nbaQueueAhead(raw.find(b=>b.ticker===row.ticker),side)};
  });
  return {at:frame.at, asOf:frame.asOf, routes};
}

export function chooseRoute(first,second,ms,earliest,deadline) {
  if (!first || !second || first.asOf<earliest || second.asOf<=first.asOf) throw Error('Waiting for two fresh books');
  const arrival=second.at+1000;
  const eligible=second.routes.flatMap(r=>{
    const prior=first.routes.find(p=>p.ticker===r.ticker&&p.side===r.side);
    const market=ms.find(m=>m.ticker===r.ticker);
    if (prior?.ahead==null || r.ahead==null || !checkMarketActive(market,arrival) || arrival>=deadline) return [];
    return [{ticker:r.ticker,side:r.side,ahead:Math.max(prior.ahead,r.ahead),arrival,
      untilAt:Math.min(deadline,Date.parse(market.close_time))}];
  });
  return eligible.sort((a,b)=>a.ahead-b.ahead||a.ticker.localeCompare(b.ticker))[0]??null;
}

// Quantities are hundredths of a share. Only later seller-initiated prints enter this model.
export function replayBid(bid,sales,yesValue) {
  let ahead=Math.round(bid.ahead*100), filled=0, atLimit=0, below=0, feeUnits=0, firstFill=null;
  for (const t of [...sales].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
    const at=Date.parse(t.at);
    if (!(at>bid.arrival && at<bid.untilAt) || t.price>.99) continue;
    let size=Math.round(t.qty*100);
    if (t.price===.99) {
      atLimit+=size;
      const consumed=Math.min(size,ahead);
      ahead-=consumed; size-=consumed;
    } else {
      below+=size;
      // A sale through our price supports this print's size. Keep the queue
      // for later equal-price trades to avoid crediting unobserved cancellations.
    }
    const part=Math.min(shares*100-filled,size);
    if (part>0) {
      firstFill??=at;
      feeUnits+=Math.ceil(.0175*.99*.01*(part/100)*10000-1e-10);
      filled+=part;
    }
  }
  const qty=filled/100, fees=feeUnits/10000, payout=qty*(bid.side==='yes'?yesValue:1-yesValue);
  return {qty,fees,payout,net:Number((payout-.99*qty-fees).toFixed(6)),atLimit:atLimit/100,below:below/100,firstFill};
}

export function nhlFinalStudy(db,io,{get=read,now=Date.now,wait=sleep}={}) {
  db.exec('CREATE TABLE IF NOT EXISTS nhl_study_start(singleton INTEGER PRIMARY KEY, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS nhl_final_games(id INTEGER PRIMARY KEY, detail TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO nhl_study_start VALUES(1,?)').run(now());
  const start=db.prepare('SELECT at FROM nhl_study_start WHERE singleton=1').get().at;
  const rows=()=>db.prepare('SELECT detail FROM nhl_final_games ORDER BY id').all().map(x=>JSON.parse(x.detail));
  const save=g=>db.prepare('INSERT OR REPLACE INTO nhl_final_games VALUES(?,?)').run(g.id,JSON.stringify(g));
  const boards=new Map();
  let heartbeat=null, nextEnrollment=0, nextPoll=0, error=null, busy=false;
  async function register() {
    const weeks=[];
    // A second week covers lighter schedules without silently shortening the cohort.
    for(let w=0;w<12;w++) {
      const day=isoDay(start+w*7*86400000);
      weeks.push(...(await get(nhl+'schedule/'+day)).body.gameWeek);
      const games=scheduledCohort(weeks,start);
      if (games.length===target) {
        db.exec('BEGIN IMMEDIATE');
        try { for(const g of games) save(g); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; }
        return;
      }
    }
    throw Error('NHL has published fewer than 30 upcoming regular-season games');
  }
  async function matchEspn(g) {
    let board=boards.get(g.date);
    if (!board || board.expires<now()) {
      board={expires:now()+minute, request:get(espn+'scoreboard?dates='+g.date.replaceAll('-',''))};
      boards.set(g.date,board);
    }
    const matches=(await board.request).body.events.filter(e=>sameMatch(e.competitions?.[0],g));
    if(matches.length!==1) throw Error('Waiting for matching ESPN fixture');
    g.espnId=matches[0].id;
  }
  function finish(g,status) {
    g.status=status; g.done=true; g.finished=now();
  }
  async function review(g) {
    const bid=g.bid;
    let response;
    try {response=await io.get('/markets/'+bid.ticker);}
    catch(e) {
      if (!e.message.includes('HTTP 404')) throw e;
      response=await io.get('/historical/markets/'+bid.ticker);
    }
    const m=response.body.market;
    if (m?.ticker!==bid.ticker) throw Error('Unexpected settlement ticker');
    if (m.status!=='finalized') return;
    if (m.settlement_value_dollars==null || m.settlement_value_dollars==='' ||
      !Number.isFinite(Number(m.settlement_value_dollars)) || Number(m.settlement_value_dollars)<0 ||
      Number(m.settlement_value_dollars)>1) throw Error('Waiting for numeric settlement');
    const close=Date.parse(m.close_time), settled=Date.parse(m.settlement_ts);
    if (!Number.isFinite(close)||!Number.isFinite(settled)) throw Error('Waiting for settlement time');
    const window={...bid,untilAt:Math.min(bid.untilAt,close,settled)};
    const sales=await windowTrades(io,window,bid.side,bid.side==='yes'?'no':'yes');
    const result=replayBid(window,sales,Number(m.settlement_value_dollars));
    g.result={...result,yesValue:Number(m.settlement_value_dollars),settled,untilAt:window.untilAt};
    finish(g,result.qty?'Settled paper fill':'Queue reviewed, no fill');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (result.qty) db.prepare('INSERT OR IGNORE INTO paper(id,strategy,ticker,side,at,quantity,price,fees,closeAt,payout,result) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run('nhl-final/'+g.id,'nhl_final_queue',bid.ticker,bid.side,new Date(result.firstFill).toISOString(),
          result.qty,.99,result.fees,close,result.payout,m.result??'scalar');
      save(g); db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); delete g.done; delete g.result; g.status='Awaiting tape and settlement'; throw e; }
  }
  async function check(g) {
    if (g.bid) {g.next=now()+minute; await review(g); return;}
    const deadline=g.end?g.end+5*minute:g.tip+7*3600000;
    if (now()>=deadline) {
      g.lastIssue=g.error;
      finish(g,g.agreed?'Entry window expired':'Final confirmation missed'); return;
    }
    if (!g.espnId) await matchEspn(g);
    if (now()<g.tip) {g.next=g.tip; return;}
    const feeds=await Promise.allSettled(['nhl','espn'].map(async source=>{
      const url=source==='nhl'?nhl+'gamecenter/'+g.id+'/play-by-play':espn+'summary?event='+g.espnId;
      const {body,at}=await get(url);
      const s=sourceScore(g,source,body);
      if (s.final) g[source+'FinalAt']??=at;
      if (s.live) g.liveAt??=at;
      return {...s,at};
    }));
    for (const f of feeds) if (f.status==='rejected') throw f.reason;
    const [league,media]=feeds.map(f=>f.value);
    g.lastPoll=Math.max(league.at,media.at);
    const late=league.period>3 || (league.period===3 && league.seconds<=180);
    g.next=now()+(late||league.final||media.final?3000:45000);
    g.status='Watching scores';
    if (!(league.final && media.final && sameScore(league.score,media.score))) {
      if(g.agreed) finish(g,'Final score changed before entry');
      return;
    }
    if (!g.liveAt) {finish(g,'Missed live coverage'); return;}
    if (!Number.isFinite(media.end)||media.end<g.tip||media.end>now()+1000) throw Error('Waiting for final play time');
    if (g.agreed && !sameScore(g.score,league.score)) {finish(g,'Final score changed before entry'); return;}
    g.agreed??=g.lastPoll; g.score??=league.score; g.end??=media.end;
    if(now()>=g.end+5*minute) {finish(g,'Entry window expired'); return;}
    const earliest=g.agreed+30000;
    if (now()<earliest+2000) {g.status='Final confirmed'; g.next=earliest+2000; return;}
    const [listing,series]=await Promise.all([io.get('/events/'+g.event+'?with_nested_markets=true'),io.get('/series/KXNHLGAME')]);
    const ms=checkedMarkets(g,listing.body.event), s=series.body.series;
    if (s?.ticker!=='KXNHLGAME'||s.fee_type!=='quadratic_with_maker_fees'||s.fee_multiplier!==1) throw Error('NHL maker fees changed');
    if (!ms.some(m=>checkMarketActive(m,now()))) {finish(g,'Markets already closed'); return;}
    const awayWon=g.score[0]>g.score[1], first=await queues(io,ms,awayWon);
    await wait(1300);
    const second=await queues(io,ms,awayWon);
    const bid=chooseRoute(first,second,ms,earliest,g.end+5*minute);
    g.books=[first,second];
    if (!bid) {finish(g,'No eligible resting bid'); return;}
    g.bid=bid; g.status='Awaiting tape and settlement'; g.next=bid.untilAt+minute;
  }
  async function tick() {
    heartbeat=now();
    if(busy || heartbeat<nextPoll)return;
    busy=true;
    try {
      let games=rows();
      if (!games.length && heartbeat>=nextEnrollment) {
        nextEnrollment=heartbeat+5*minute; await register(); games=rows(); error=null;
      }
      await Promise.all(games.filter(g=>!g.done && (g.next<=heartbeat || (!g.espnId && g.next===g.tip))).map(async g=>{
        try {await check(g); delete g.error;}
        catch(e) {g.error=e.message; g.next=now()+(g.bid||now()<g.tip?minute:5000);}
        save(g);
      }));
      nextPoll=games.length?Math.min(...games.filter(g=>!g.done).map(g=>g.next)):nextEnrollment;
    } catch(e) {error=e.message;}
    finally {busy=false;}
  }
  function summary() {
    const games=rows().sort((a,b)=>a.tip-b.tip||a.id-b.id);
    return {target,start,heartbeat,error,games,complete:games.filter(g=>g.done).length,
      bids:games.filter(g=>g.bid).length, filledGames:games.filter(g=>g.result?.qty>0).length,
      net:games.reduce((n,g)=>n+(g.result?.net??0),0)};
  }
  return {tick,summary};
}
