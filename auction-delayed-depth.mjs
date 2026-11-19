import {checkMarketActive, overlappingAskLevels} from './core.mjs';
import {windowTrades} from './public-trades.mjs';

const offsets = [15, 30, 60];
const windowMs = 120000;

export function delayedAuctionDepth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_delayed_depth(
    event TEXT, minutes INTEGER, amount REAL, due INTEGER, revised INTEGER DEFAULT 0,
    firstBook TEXT, secondBook TEXT, levels TEXT, checked INTEGER, tape TEXT,
    PRIMARY KEY(event,minutes))`);
  const plan = db.prepare('INSERT OR IGNORE INTO auction_delayed_depth(event,minutes,amount,due) VALUES(?,?,?,?)');
  const planned = db.prepare('SELECT COUNT(*) AS n FROM auction_delayed_depth WHERE event=?');
  const due = db.prepare('SELECT * FROM auction_delayed_depth WHERE event=? AND revised=0 AND secondBook IS NULL AND due BETWEEN ? AND ? ORDER BY due LIMIT 1');
  function verify(event,signal){
    db.prepare('UPDATE auction_delayed_depth SET revised=1 WHERE event=? AND revised=0 AND (amount IS NOT ? OR ? != \'published_sale\')')
      .run(event,signal.amount,signal.kind);
  }
  function register(event, history) {
    if(history.length !== 1 || history[0].kind !== 'published_sale'){
      db.prepare('UPDATE auction_delayed_depth SET revised=1 WHERE event=? AND revised=0').run(event);
      return;
    }
    const {seenAt,amount}=history[0], release=Date.parse(seenAt);
    if(!Number.isFinite(release)||!(amount>0)||planned.get(event).n===offsets.length)return;
    for(const minutes of offsets)plan.run(event,minutes,amount,release+minutes*60000);
  }
  function record(target, signal, markets, books, config, now) {
    const row=due.get(target.event,now-windowMs,now);
    if(!row || row.amount!==signal.amount || signal.kind!=='published_sale' ||
      !Number.isFinite(signal.requestedAt) || signal.requestedAt>now || now-signal.requestedAt>config.maxSourceAgeMs ||
      markets.length!==target.markets.length || books.size!==markets.length)return;
    const tickers=new Set(target.markets.map(m=>m.ticker)), frame={source:signal.url,sourceAt:signal.requestedAt,at:0,asOf:Infinity,books:{}};
    for(const m of markets){
      const r=books.get(m.ticker);
      if(!r||!tickers.delete(m.ticker)||r.body.ticker!==m.ticker || m.is_provisional ||
        !checkMarketActive(m,now)||m.strike_type!=='greater'||!Number.isFinite(m.floor_strike))return;
      const date=Date.parse(r.httpDate), age=Number(r.cacheAge??0);
      if(!Number.isFinite(date+r.receivedAt+r.requestedAt)||!Number.isInteger(age)||age<0||age>2||
        date>r.receivedAt+1000||date<r.receivedAt-4000||r.requestedAt<signal.requestedAt||
        r.receivedAt<r.requestedAt||r.receivedAt>now||now-r.requestedAt>config.maxQuoteAgeMs)return;
      frame.asOf=Math.min(frame.asOf,r.requestedAt,date-1000,r.receivedAt-(age+1)*1000);
      frame.at=Math.max(frame.at,r.receivedAt);
      frame.books[m.ticker]={side:row.amount>m.floor_strike?'YES':'NO',body:r.body};
    }
    if(!markets.length || frame.asOf<row.due)return;
    if(!row.firstBook){
      db.prepare('UPDATE auction_delayed_depth SET firstBook=? WHERE event=? AND minutes=? AND firstBook IS NULL')
        .run(JSON.stringify(frame),row.event,row.minutes);
      return;
    }
    const first=JSON.parse(row.firstBook);
    if(frame.asOf<first.at+1000 || first.source!==frame.source || frame.sourceAt<=first.at)return;
    const levels=[];
    for(const [ticker,{side,body}] of Object.entries(frame.books)){
      const before=first.books[ticker];
      if(!before||before.side!==side)return;
      for(const q of overlappingAskLevels(before.body,body,side,95)){
        if(q.quantity>0)levels.push({ticker,side,price:q.price,quantity:q.quantity});
      }
    }
    levels.sort((a,b)=>a.price-b.price||a.ticker.localeCompare(b.ticker));
    db.prepare('UPDATE auction_delayed_depth SET secondBook=?,levels=? WHERE event=? AND minutes=? AND secondBook IS NULL')
      .run(JSON.stringify(frame),JSON.stringify(levels),row.event,row.minutes);
  }
  async function review(io,now){
    const row=db.prepare(`SELECT event,minutes,levels,json_extract(secondBook,'$.at') AS at
      FROM auction_delayed_depth WHERE revised=0 AND levels IS NOT NULL AND levels!='[]'
      AND tape IS NULL AND COALESCE(checked,0)<? AND json_extract(secondBook,'$.at')<=?
      ORDER BY COALESCE(checked,0),due LIMIT 1`).get(now-60000,now-66000);
    if(!row)return;
    db.prepare('UPDATE auction_delayed_depth SET checked=? WHERE event=? AND minutes=?').run(now,row.event,row.minutes);
    const pick=JSON.parse(row.levels)[0], side=pick.side.toLowerCase();
    const trades=await windowTrades(io,{ticker:pick.ticker,arrival:row.at+1000,untilAt:row.at+6000},side,side);
    const atLimit=trades.filter(t=>t.price<=pick.price);
    db.prepare('UPDATE auction_delayed_depth SET tape=? WHERE event=? AND minutes=?')
      .run(JSON.stringify(atLimit),row.event,row.minutes);
  }
  function summary(now){
    return db.prepare(`SELECT event,minutes,due,revised,levels,tape,firstBook IS NOT NULL AS started,
      json_extract(secondBook,'$.at')-json_extract(firstBook,'$.at') AS elapsedMs
      FROM auction_delayed_depth ORDER BY due DESC,event`).all().map(r=>{
      const levels=JSON.parse(r.levels), trades=JSON.parse(r.tape), pick=levels?.[0]??null;
      const volume=trades?.reduce((n,t)=>n+Math.round(100*t.qty),0);
      return {event:r.event,minutes:r.minutes,due:r.due,elapsedMs:r.elapsedMs,
        state:r.revised?'Revised result':levels?'Observed':now>r.due+windowMs?'Missed window':r.started?'Awaiting second book':'Scheduled',
        repeated:levels?.reduce((n,l)=>n+l.quantity,0)??null,pick,
        supported:trades&&pick&&!r.revised?Math.min(pick.quantity,Math.floor(volume/100)):null};
    });
  }
  return {register,verify,record,review,summary};
}
