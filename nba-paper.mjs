import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { addPaper } from './strategy-monitor.mjs';

const league = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const aliases = {
  UTAH: 'UTA',
  SA: 'SAS',
  NY: 'NYK',
  WSH: 'WAS',
  GS: 'GSW',
  NO: 'NOP'
};
const eastern = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const months = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
function dates(time) {
  const p = Object.fromEntries(
    eastern.formatToParts(new Date(time)).map((x) => [x.type, x.value])
  );
  return {
    board: p.year + p.month + p.day,
    event: p.year.slice(-2) + months[Number(p.month) - 1] + p.day
  };
}
function clock(display) {
  if (typeof display !== 'string' || !/^(?:\d+:)?\d+(?:\.\d+)?$/.test(display))
    return NaN;
  return display
    .split(':')
    .reduce((value, part) => value * 60 + Number(part), 0);
}
function teams(c) {
  return Object.fromEntries(
    (c?.competitors ?? []).map((t) => [
      t.homeAway,
      aliases[t.team?.abbreviation] ?? t.team?.abbreviation
    ])
  );
}
function eventTicker(game) {
  const t = teams(game.competitions?.[0]);
  return 'KXNBAGAME-' + dates(game.date).event + t.away + t.home;
}
async function espn(path) {
  const r = await fetch(league + path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(4000)
  });
  if (!r.ok) throw Error('ESPN HTTP ' + r.status);
  return r.json();
}
// Require the current scoreboard and last recorded play to agree when the signal arrives.
export function liveSignal(summary, game, now) {
  const c = summary.header?.competitions?.[0],
    s = game?.status,
    p = summary.plays?.at(-1);
  if (
    String(summary.header?.id) !== game.id ||
    c?.status?.type?.state !== 'in' ||
    s?.type?.state !== 'in' ||
    s.period !== 4 ||
    p?.period?.number !== 4
  )
    return null;
  const t = teams(c),
    expected = teams(game.competitions[0]),
    seconds = clock(p.clock?.displayValue),
    current = clock(s.displayClock);
  const age = now - Date.parse(p.wallclock);
  if (
    t.home !== expected.home ||
    t.away !== expected.away ||
    !(
      seconds >= 35 &&
      seconds <= 50 &&
      current >= 35 &&
      current <= seconds &&
      seconds - current <= 5 &&
      age >= 0 &&
      age <= 15000
    )
  )
    return null;
  const scores = Object.fromEntries(
    c.competitors.map((x) => [x.homeAway, Number(x.score)])
  );
  if (
    !game.competitions[0].competitors.every(
      (x) => Number(x.score) === scores[x.homeAway]
    )
  )
    return null;
  if (
    !Number.isInteger(p.homeScore) ||
    !Number.isInteger(p.awayScore) ||
    scores.home !== p.homeScore ||
    scores.away !== p.awayScore ||
    Math.abs(scores.home - scores.away) !== 5
  )
    return null;
  const leader = t[scores.home > scores.away ? 'home' : 'away'];
  return {
    ticker: eventTicker(game) + '-' + leader,
    opponent: eventTicker(game) + '-' + t[scores.home > scores.away ? 'away' : 'home'],
    stamp: p.wallclock,
    seconds,
    home: scores.home,
    away: scores.away
  };
}
export function nbaOffer(book, side = 'yes') {
  const bids = book?.orderbook_fp?.[side === 'yes' ? 'no_dollars' : 'yes_dollars'];
  if (!Array.isArray(bids)) return null;
  const valid = bids
    .map(([p, q]) => [Number(p), Number(q)])
    .filter(([p, q]) => p > 0 && p < 1 && q > 0 && Number.isFinite(q));
  const best = Math.max(...valid.map(([p]) => p)),
    depth = valid
      .filter(([p]) => p === best)
      .reduce((sum, [, q]) => sum + q, 0);
  const price = Math.round((1 - best) * 10000) / 10000;
  return depth >= 1 && price > 0 && price <= 0.99 ? { price, depth } : null;
}

function gameRule(m, ticker, event) {
  if (m?.ticker !== ticker || m.event_ticker !== event || m.market_type !== 'binary' ||
      m.notional_value_dollars !== '1.0000' || m.status !== 'active' || !m.yes_sub_title) return null;
  const prefix = 'If ' + m.yes_sub_title;
  return m.rules_primary?.startsWith(prefix + ' wins the ') && m.rules_primary.endsWith('then the market resolves to Yes.')
    ? m.rules_primary.slice(prefix.length) : null;
}

export function nbaRoutes(body, signal, eventTicker) {
  const event = body.event;
  if (event?.event_ticker !== eventTicker || event.series_ticker !== 'KXNBAGAME') return [];
  const markets = body.markets?.length ? body.markets : event.markets ?? [];
  const leader = markets.find(m => m.ticker === signal.ticker);
  const opponent = markets.find(m => m.ticker === signal.opponent);
  const rule = gameRule(leader,signal.ticker,eventTicker);
  if (!rule) return [];
  const routes = [{market:leader,side:'yes'}];
  if (event.mutually_exclusive === true && markets.length === 2 && leader.ticker !== opponent?.ticker &&
      gameRule(opponent,signal.opponent,eventTicker) === rule &&
      typeof leader.rules_secondary === 'string' && opponent.rules_secondary === leader.rules_secondary &&
      leader.close_time === opponent.close_time)
    routes.push({market:opponent,side:'no'});
  return routes;
}
export function repeatedNbaOffers(routes, first, second, at) {
  function ask(books,r) {
    return nbaOffer(books.find(b => b.ticker === r.market.ticker), r.side);
  }
  return routes.flatMap(r => {
    const a = ask(first,r), b = ask(second,r);
    if (!a || !b || b.price > a.price || !(at < Date.parse(r.market.close_time))) return [];
    return [{ticker:r.market.ticker,side:r.side,price:b.price,depth:Math.min(a.depth,b.depth),closeAt:Date.parse(r.market.close_time)}];
  }).sort((a,b) => a.price-b.price || Number(a.side==='no')-Number(b.side==='no'));
}
export async function observeNBA({ db, config, stop, status }) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS nba_observations(game TEXT PRIMARY KEY, ticker TEXT, signal TEXT, decision TEXT, observed TEXT)'
  );
  db.exec(`CREATE TABLE IF NOT EXISTS nba_feed_arrivals(game TEXT, play TEXT, observed INTEGER,lag INTEGER,accepted INTEGER,
    PRIMARY KEY(game,play)); CREATE TABLE IF NOT EXISTS nba_route_books(game TEXT,read INTEGER,at INTEGER,detail TEXT,PRIMARY KEY(game,read))`);
  const io = new Transport({
    ...config,
    maxHttpAgeSeconds: 1,
    requestTimeoutMs: 3000
  });
  let events = new Map(),
    refresh = 0,
    multiplier = null;

  async function check(game) {
    const url = 'summary?event=' + game.id;
    const summary = await espn(url), received = Date.now();
    const first = liveSignal(summary, game, received);
    const p = summary.plays?.at(-1), seconds = clock(p?.clock?.displayValue);
    if (String(summary.header?.id) === game.id && p?.period?.number === 4 && seconds >= 35 && seconds <= 50 &&
        Math.abs(p.homeScore-p.awayScore) === 5 && Number.isFinite(Date.parse(p.wallclock))) {
      db.prepare('INSERT OR IGNORE INTO nba_feed_arrivals VALUES(?,?,?,?,?)')
        .run(game.id,String(p.id ?? p.wallclock),received,received-Date.parse(p.wallclock),Number(!!first));
    }
    if (!first || stop()) return;
    const now = new Date().toISOString();
    const inserted = db
      .prepare('INSERT OR IGNORE INTO nba_observations VALUES(?,?,?,?,?)')
      .run(game.id, first.ticker, JSON.stringify(first), 'Checking', now);
    if (!inserted.changes) return;
    const finish = (decision) =>
      db
        .prepare('UPDATE nba_observations SET decision=? WHERE game=?')
        .run(decision, game.id);
    try {
      const event = eventTicker(game);
      const query = new URLSearchParams([['tickers',first.ticker],['tickers',first.opponent],['depth','5']]);
      const book = '/markets/orderbooks?' + query;
      const [m, a] = await Promise.all([io.get('/events/'+event+'?with_nested_markets=true'), io.get(book)]);
      const routes = nbaRoutes(m.body,first,event);
      if (!routes.length) return finish('Market unavailable or rules mismatch');
      const store = (n,r) => db.prepare('INSERT OR IGNORE INTO nba_route_books VALUES(?,?,?,?)')
        .run(game.id,n,r.receivedAt,JSON.stringify({requestedAt:r.requestedAt,books:r.body.orderbooks}));
      store(1,a);
      if (!routes.some(r => nbaOffer(a.body.orderbooks.find(b=>b.ticker===r.market.ticker),r.side)))
        return finish('No qualifying ask on either route');
      await sleep(1000);
      const [b, summary, scoreboard] = await Promise.all([
        io.get(book),
        espn(url),
        espn('scoreboard?dates=' + dates(game.date).board)
      ]);
      const updated = scoreboard.events?.find((g) => g.id === game.id);
      store(2,b);
      const completed = Date.now(),
        latest = updated && liveSignal(summary, updated, completed);
      if (
        stop() ||
        !latest ||
        latest.ticker !== first.ticker ||
        latest.stamp !== first.stamp ||
        latest.seconds !== first.seconds ||
        latest.home !== first.home ||
        latest.away !== first.away
      )
        return finish('Score changed or expired');
      const offers = repeatedNbaOffers(routes,a.body.orderbooks,b.body.orderbooks,completed);
      if (!offers.length)
        return finish('Offer disappeared or increased');
      db.exec('BEGIN');
      try {
        for (const [strategy,quote] of [['nba_five',offers.find(o=>o.side==='yes')],['nba_best_route',offers[0]]]) {
          if (!quote) continue;
          const fees = Math.ceil(0.07 * multiplier * quote.price * (1 - quote.price) * 10000 - 1e-9) / 10000;
          addPaper(db, {id:strategy+'/'+game.id,strategy,...quote,at:new Date(completed).toISOString(),quantity:1,fees});
        }
        finish('Paper entry');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      finish('Quote check failed: ' + e.message);
    }
  }
  while (!stop()) {
    let delay = 30000;
    try {
      const now = Date.now();
      if (now >= refresh) {
        const [listing, fees] = await Promise.all([
          io.get('/events?series_ticker=KXNBAGAME&status=open&limit=200'),
          io.get('/series/KXNBAGAME')
        ]);
        const s = fees.body.series;
        if (
          s.ticker !== 'KXNBAGAME' ||
          !['quadratic', 'quadratic_with_maker_fees'].includes(s.fee_type) ||
          !Number.isFinite(s.fee_multiplier) ||
          s.fee_multiplier < 0
        )
          throw Error('Unknown NBA fee schedule');
        const listed = [...listing.body.events];
        let cursor = listing.body.cursor;
        const seen = new Set();
        while (cursor) {
          if (seen.has(cursor)) throw Error('Repeated events cursor');
          seen.add(cursor);
          const next = (
            await io.get(
              '/events?series_ticker=KXNBAGAME&status=open&limit=200&cursor=' +
                encodeURIComponent(cursor)
            )
          ).body;
          listed.push(...next.events);
          cursor = next.cursor;
        }
        events = new Map(listed.map((e) => [e.event_ticker, e]));
        multiplier = s.fee_multiplier;
        refresh = now + 300000;
      }
      const today = dates(now).board,
        yesterday = dates(now - 86400000).board;
      const boardDates =
        dates(now - 6 * 3600000).board === today ? [today] : [yesterday, today];
      const boards = await Promise.all(
        boardDates.map((day) => espn('scoreboard?dates=' + day))
      );
      if (!boards.every((b) => Array.isArray(b.events)))
        throw Error('ESPN schedule missing');
      const games = boards
        .flatMap((b) => b.events)
        .filter((g) => events.has(eventTicker(g)));
      status.scheduled = games.filter(
        (g) => g.status?.type?.state === 'pre'
      ).length;
      status.live = games.filter((g) => g.status?.type?.state === 'in').length;
      status.next =
        games
          .filter((g) => g.status?.type?.state === 'pre')
          .map((g) => g.date)
          .sort()[0] ?? null;
      const near = games.filter(
        (g) =>
          g.status?.type?.state === 'in' &&
          g.status.period === 4 &&
          clock(g.status.displayClock) <= 180
      );
      const targets = near.filter(
        (g) =>
          !db.prepare('SELECT 1 FROM nba_observations WHERE game=?').get(g.id)
      );
      const checks = await Promise.allSettled(targets.map(check));
      const failed = checks.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
      delay = near.length ? 2500 : status.live ? 12000 : 60000;
      status.error = null;
    } catch (e) {
      status.error = e.message;
      delay = 10000;
    }
    status.at = new Date().toISOString();
    status.observations = db
      .prepare('SELECT COUNT(*) AS n FROM nba_observations')
      .get().n;
    status.arrivals = db.prepare(`SELECT COUNT(*) AS plays,COUNT(DISTINCT game) AS games,
      COUNT(CASE WHEN lag>=0 AND lag<=5000 THEN 1 END) AS withinFive,
      COUNT(CASE WHEN lag>=0 AND lag<=15000 THEN 1 END) AS withinFifteen,
      COUNT(CASE WHEN accepted=1 THEN 1 END) AS matched FROM nba_feed_arrivals`).get();
    await sleep(delay);
  }
}
