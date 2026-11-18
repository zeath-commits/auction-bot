import { setTimeout as sleep } from 'node:timers/promises';
import { usPublic } from './bitcoin-reference.mjs';
import { askLevels } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';
import { Transport } from './transport.mjs';

const strategy = 'cs2_reference';
const name = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu,'').trim().toLowerCase();
const iso = n => new Date(n).toISOString();
function scheduled(rule) {
  const parts = rule?.match(/originally scheduled for (\w+ \d+, \d{4}) at (\d+:\d+ [AP]M) (EST|EDT), then the market resolves to Yes\.$/);
  return parts ? Date.parse(parts.slice(1).join(' ')) : NaN;
}

export function matchCS2(e, pm, now) {
  const markets = e.markets ?? [], sides = pm.marketSides ?? [];
  const start = Date.parse(pm.gameStartTime);
  if (!(start > now + 120000 && start <= now + 21600000) ||
      e.series_ticker !== 'KXCS2GAME' || e.mutually_exclusive !== true || markets.length !== 2 ||
      !pm.active || pm.closed || pm.archived || pm.status !== 'MARKET_STATUS_OPEN' ||
      !pm.slug?.startsWith('aec-cs2-') || pm.sportsMarketType !== 'esports_match_winner' ||
      pm.marketType !== 'moneyline' || !pm.description?.includes('CS2 match') || sides.length !== 2 ||
      !sides.some(s=>s.long===true) || !sides.some(s=>s.long===false)) return null;
  const routes = [];
  for (const s of sides) {
    const found = markets.filter(m => name(s.description) === name(m.yes_sub_title));
    if (!s.tradable || s.team?.league !== 'cs2' || !name(s.description) || found.length !== 1) return null;
    const m = found[0];
    if (m.event_ticker !== e.event_ticker || !m.ticker?.startsWith(e.event_ticker+'-') ||
        m.status !== 'active' || m.market_type !== 'binary' || Number(m.notional_value_dollars) !== 1 ||
        !m.rules_primary?.startsWith('If '+m.yes_sub_title+' wins the ') || scheduled(m.rules_primary) !== start ||
        !m.rules_secondary?.includes('full match') || m.rules_secondary !== markets[0].rules_secondary ||
        !(Date.parse(m.close_time) > start)) return null;
    routes.push({ ticker:m.ticker, team:m.yes_sub_title, long:s.long, closeAt:Date.parse(m.close_time) });
  }
  if (routes[0].ticker === routes[1].ticker) return null;
  return { event:e.event_ticker, slug:pm.slug, start, routes };
}

// Price of the fifth displayed reference contract on each side. Ignore dust at better prices.
function fifth(levels, descending) {
  const valid = (levels ?? []).filter(l => l.px?.currency === 'USD' &&
    Number(l.px.value)>0 && Number(l.px.value)<1 && Number.isFinite(Number(l.qty)) && Number(l.qty)>0);
  valid.sort((a,b)=>(Number(a.px.value)-Number(b.px.value))*(descending?-1:1));
  let depth=0;
  for (const l of valid) {
    depth+=Number(l.qty);
    if (depth>=5) return Math.round(Number(l.px.value)*10000);
  }
}

export function cs2Quotes(match, reference, books, at) {
  const age = at-Date.parse(reference?.transactTime);
  if (reference?.marketSlug!==match.slug || reference.state!=='MARKET_STATE_OPEN' ||
      !(age>=0 && age<=60000) || at>=match.start-120000) return [];
  const bid=fifth(reference.bids,true), ask=fifth(reference.offers,false);
  if (!(ask>=bid && ask-bid<=400)) return [];
  const rows=[];
  for (const r of match.routes) {
    const book=books.find(b=>b.ticker===r.ticker);
    if(!book) continue;
    const quote=askLevels(book,'YES',99)[0];
    if(!quote || quote.quantity<1000000) continue;
    const price=quote.price/1000000, depth=quote.quantity/1000000;
    const fees=Math.ceil(0.07*price*(1-price)*10000-1e-9)/10000;
    const referenceBid=(r.long?bid:10000-ask)/10000;
    const gap=Math.round((referenceBid-price-fees)*10000)/10000;
    rows.push({...r,price,fees,depth,gap,referenceBid});
  }
  return rows.sort((a,b)=>b.gap-a.gap || a.ticker.localeCompare(b.ticker));
}

export function confirmedCS2(first,second) {
  for (const b of second) {
    const a=first.find(x=>x.ticker===b.ticker);
    if (a && a.gap>=0.02 && b.gap>=0.02 && b.price<=a.price)
      return {...b,depth:Math.min(a.depth,b.depth)};
  }
  return null;
}

export async function observeCS2({db,config,status,stop}) {
  const io=new Transport({...config,maxHttpAgeSeconds:1,requestTimeoutMs:2500});
  db.exec('CREATE TABLE IF NOT EXISTS cs2_comparisons(event TEXT PRIMARY KEY, slug TEXT, scans INTEGER, priced INTEGER, lastAt TEXT, maxGap REAL, evidence TEXT)');
  const record=db.prepare(`INSERT INTO cs2_comparisons VALUES(?,?,1,?,?,?,NULL)
    ON CONFLICT(event) DO UPDATE SET scans=scans+1, priced=priced+excluded.priced,lastAt=excluded.lastAt,
    maxGap=CASE WHEN excluded.maxGap IS NULL THEN maxGap WHEN maxGap IS NULL THEN excluded.maxGap ELSE MAX(maxGap,excluded.maxGap) END`);
  async function discover() {
    const [us,schedule]=await Promise.all([
      usPublic('/v1/events?seriesId=32&active=true&closed=false&limit=100'),
      io.get('/series/KXCS2GAME')
    ]);
    if (schedule.body.series?.ticker!=='KXCS2GAME' || schedule.body.series.fee_type!=='quadratic' ||
        schedule.body.series.fee_multiplier!==1) throw Error('CS2 fee schedule needs review');
    if (!Array.isArray(us.events) || us.events.length>=100) throw Error('US CS2 listings incomplete');
    const pm=us.events.flatMap(x=>x.markets??[]), matches=[], seen=new Set();
    let cursor='';
    do {
      const page=(await io.get('/events?series_ticker=KXCS2GAME&status=open&limit=200&with_nested_markets=true'+
        (cursor?'&cursor='+encodeURIComponent(cursor):''))).body;
      for(const event of page.events){
        const found=pm.map(m=>matchCS2(event,m,Date.now())).filter(Boolean);
        if(found.length===1) matches.push(found[0]);
      }
      cursor=page.cursor;
      if(cursor && seen.has(cursor)) throw Error('Repeated CS2 event cursor');
      seen.add(cursor);
    } while(cursor);
    return matches;
  }
  async function snapshot(m) {
    const begin=Date.now(), q=new URLSearchParams(m.routes.map(r=>['tickers',r.ticker]));
    const [us,k]=await Promise.all([usPublic('/v1/markets/'+m.slug+'/book'),io.get('/markets/orderbooks?'+q)]);
    const at=Date.now();
    return {at,referenceAt:us.marketData?.transactTime,rows:at-begin<=2500?
      cs2Quotes(m,us.marketData,k.body.orderbooks,at):[]};
  }
  let matches=[],refresh=0;
  while (!stop()) {
    let delay=30000;
    try {
      if (Date.now()>=refresh) {
        matches=await discover();
        refresh=Date.now()+300000;
      }
      const upcoming=matches.filter(m=>Date.now()<m.start-120000);
      Object.assign(status,{matched:upcoming.length,priced:0,errors:[],best:null,error:null});
      for (const m of upcoming) {
        if (stop()) return;
        try {
          const first=await snapshot(m), best=first.rows[0];
          record.run(m.event,m.slug,Number(!!best),iso(first.at),best?.gap??null);
          if (!best) continue;
          status.priced++;
          if (!status.best || best.gap>status.best.gap) status.best={team:best.team,gap:best.gap};
          const id=strategy+'/'+m.event;
          if (best.gap<0.02 || db.prepare('SELECT 1 FROM paper WHERE id=?').get(id)) continue;
          await sleep(1000);
          const [event,exchange,pm]=await Promise.all([io.get('/events/'+m.event+'?with_nested_markets=true'),
            io.get('/exchange/status'),usPublic('/v1/market/slug/'+m.slug)]);
          const fresh=matchCS2(event.body.event,pm.market,Date.now());
          if (!fresh || !exchange.body.trading_active || !exchange.body.exchange_active) continue;
          const second=await snapshot(fresh), pick=confirmedCS2(first.rows,second.rows);
          if (!pick || stop()) continue;
          db.exec('BEGIN IMMEDIATE');
          try {
            addPaper(db,{...pick,id,strategy,side:'yes',quantity:1,at:iso(second.at)});
            db.prepare('UPDATE cs2_comparisons SET evidence=? WHERE event=?')
              .run(JSON.stringify({first,second,team:pick.team}),m.event);
            db.exec('COMMIT');
          } catch(e) { db.exec('ROLLBACK'); throw e; }
        } catch(e) {
          status.errors.push(m.event+' '+e.message);
          if(e.status===429) { delay=Math.max(60000,e.retryAfterMs||0); break; }
        }
      }
    } catch(e) { status.error=e.message; delay=Math.max(60000,e.retryAfterMs||0); }
    status.at=iso(Date.now());
    await sleep(delay);
  }
}
