import {
  stationMessages,
  stationEvidence,
  stationSupports
} from './weather-station.mjs';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { askLevels, checkMarketActive, quoteBook, MICRO } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';
import { threeOClock, threeSignals } from './weather-three.mjs';
import {
  stations,
  westernStations,
  afternoonForecast,
  listings,
  product,
  parseReport,
  eventMarkets,
  crossed,
  localParts,
  officialPayout
} from './weather-high.mjs';
const monitoredStations = [...stations,...westernStations];

function latest(products) {
  return [...products].sort(
    (a, b) =>
      Date.parse(b.issuanceTime) - Date.parse(a.issuanceTime) ||
      b.id.localeCompare(a.id)
  )[0];
}
export function repeatedWeatherAsk(a, b, side) {
  const first = askLevels(a, side.toUpperCase(), 99).find(
    (l) => l.quantity >= 1e6
  );
  const second = askLevels(b, side.toUpperCase(), 99).find(
    (l) => l.quantity >= 1e6
  );
  if (!first || !second || second.price > first.price) return null;
  return {
    price: second.price / 1e6,
    depth: Math.min(first.quantity, second.quantity) / 1e6
  };
}
async function snapshot(io, eligible) {
  const q = new URLSearchParams(eligible.map(({ m }) => ['tickers', m.ticker]));
  q.set('depth', '100');
  const read = await io.get('/markets/orderbooks?' + q);
  if (read.receivedAt - read.requestedAt > 2000)
    throw Error('Slow weather order book');
  const books = new Map(read.body.orderbooks.map((b) => [b.ticker, b]));
  if (eligible.some(({ m }) => !books.has(m.ticker)))
    throw Error('Missing weather book');
  return { books, at: read.receivedAt, asOf:Date.parse(read.httpDate)-1000*Number(read.cacheAge??0) };
}

export function forecastOffer(a,b,ticker) {
  if (!(b.asOf>a.asOf) || ![a,b].every(r=>r.at-r.asOf>=-500 && r.at-r.asOf<=3500)) return null;
  const quotes=[a,b].map(r=>quoteBook(r.books.get(ticker),'YES',5,95));
  if (quotes.some(q=>!q) || quotes[1].levels.at(-1).price>quotes[0].levels.at(-1).price) return null;
  const costs=quotes.map(q=>q.levels.reduce((n,l)=>n+l.price*l.quantity/(MICRO*MICRO),0));
  if (costs[1]>costs[0]+1e-9) return null;
  const fees=quotes[1].levels.reduce((n,l)=>{
    const p=l.price/MICRO;
    return n+Math.ceil(7*l.quantity/MICRO*p*(1-p)-1e-9)/100;
  },0);
  return {quantity:5,price:costs[1]/5,fees,depth:5};
}
async function weatherExchange(io, station) {
  const [series, exchange] = await Promise.all([
    io.get('/series/' + station.series), io.get('/exchange/status')
  ]);
  const s = series.body.series;
  if (s.ticker !== station.series || !['quadratic','quadratic_with_maker_fees'].includes(s.fee_type) || s.fee_multiplier !== 1)
    throw Error('Weather fee schedule changed');
  return exchange.body.trading_active && exchange.body.exchange_active;
}
function recordWeatherEntry(db, strategy, market, side, offer, at) {
  addPaper(db, {id:strategy + '/' + market.ticker, strategy, ticker:market.ticker, side,
    at:new Date(at).toISOString(), quantity:1, price:offer.price, depth:offer.depth,
    fees:Math.ceil(0.07 * offer.price * (1 - offer.price) * 10000 - 1e-9) / 10000,
    closeAt:Date.parse(market.close_time)});
}
export async function observeWeather({ db, config, status, stop }) {
  const io = new Transport({
    ...config,
    maxHttpAgeSeconds: 2,
    requestTimeoutMs: 4000
  });
  db.exec(
    'CREATE TABLE IF NOT EXISTS weather_report_reads(id TEXT PRIMARY KEY, event TEXT, at INTEGER, detail TEXT);CREATE TABLE IF NOT EXISTS weather_quote_checks(id TEXT, at INTEGER, ticker TEXT, detail TEXT,PRIMARY KEY(id,at,ticker))'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS weather_station_checks(id TEXT PRIMARY KEY, at INTEGER, detail TEXT); CREATE TABLE IF NOT EXISTS weather_station_entries(id TEXT PRIMARY KEY, report TEXT, label TEXT)'
  );
  const cached = new Map();
  db.exec('CREATE TABLE IF NOT EXISTS weather_three_checks(event TEXT,at INTEGER,detail TEXT, PRIMARY KEY(event,at))');
  status.three = {};
  async function checkThree(station, list, now) {
    const window = threeOClock(station, now);
    if (now < window.start + 60000 || now >= window.end) return {state:'Outside 3–4 p.m. standard time'};
    const published = products => products.some(p => {
      const issued = Date.parse(p.issuanceTime);
      return issued >= window.dayStart + 12 * 3600000 && issued <= Date.now();
    });
    if (published(list)) return {state:'Afternoon climate product published'};
    const [raw, markets] = await Promise.all([stationMessages(station, now), eventMarkets(station, window)]);
    const checked = threeSignals(station, window, raw.rows, markets, Date.now());
    const eligible = checked.signals.filter(({m}) => checkMarketActive(m, Date.now()));
    const info = {state:checked.state, at:new Date().toISOString(), event:window.event,
      maximum:checked.evidence?.maximum ?? null, thresholds:eligible.length, offers:0};
    const details = {source:raw.url, cutoff:window.start, evidence:checked.evidence, books:[]};
    if (eligible.length) {
      if (!await weatherExchange(io, station)) return {...info,state:'Exchange unavailable'};
      const a = await snapshot(io,eligible);
      await sleep(1000);
      const [b, fresh, revisions] = await Promise.all([snapshot(io,eligible),listings(station),stationMessages(station,Date.now())]);
      const end = Date.now();
      const verified = threeSignals(station,window,revisions.rows,markets,end);
      if (stop() || published(fresh) || end - a.at > 5000 || end >= window.end ||
          verified.evidence?.maximum !== info.maximum)
        return {...info,state:'Source or quote changed'};
      for (const {m,side} of eligible) {
        if (!checkMarketActive(m,end)) continue;
        const first = a.books.get(m.ticker), second = b.books.get(m.ticker);
        const offer = repeatedWeatherAsk(first,second,side);
        details.books.push({ticker:m.ticker,side,firstAt:a.at,secondAt:b.at,first,second,offer});
        if (offer) info.offers++;
      }
      if (info.offers) {
        details.stationRows = raw.rows;
        details.confirmingRows = revisions.rows;
      }
    }
    const at = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO weather_three_checks VALUES(?,?,?)').run(window.event,at,JSON.stringify({...details,...info}));
      for (const b of details.books.filter(b => b.offer)) {
        const market = eligible.find(({m}) => m.ticker===b.ticker).m;
        recordWeatherEntry(db,'weather_three',market,b.side,b.offer,b.secondAt);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return info;
  }
  function startStationCheck(station, r) {
    const cache = cached.get(station.cli);
    if (cache.loading || cache.proof || stop()) return;
    const previous = db
      .prepare('SELECT detail FROM weather_station_checks WHERE id=?')
      .get(r.id);
    if (previous) {
      cache.proof = JSON.parse(previous.detail).evidence;
      return;
    }
    cache.loading = true;
    stationMessages(station, r.ts)
      .then(({ url, rows }) => {
        if (stop()) return;
        const evidence = stationEvidence(station, r, rows);
        if (!evidence.observations && !evidence.intervals)
          throw Error('No eligible station messages');
        db.prepare(
          'INSERT OR IGNORE INTO weather_station_checks VALUES(?,?,?)'
        ).run(r.id, Date.now(), JSON.stringify({ url, rows, evidence }));
        cache.proof = evidence;
        cache.stationError = null;
      })
      .catch((e) => {
        cache.stationError = e.message;
      })
      .finally(() => {
        cache.loading = false;
      });
  }

  async function check(station) {
    const now = Date.now(),
      local = localParts(station, now);
    if (+local.hour < 12 || +local.hour >= 22)
      return { state: 'Outside afternoon report window' };
    const list = await listings(station),
      newest = latest(list);
    try {
      status.three[station.city] = await checkThree(station,list,now);
    } catch (e) {
      status.three[station.city] = {state:'Data error', error:e.message};
    }
    if (!newest) throw Error('NWS list empty');
    const age = now - Date.parse(newest.issuanceTime);
    if (age < 0 || age >= 3600000)
      return { state: 'Waiting for an afternoon report' };
    if (cached.get(station.cli)?.id !== newest.id) {
      const doc = await product(newest.id);
      if (
        doc.id !== newest.id ||
        Date.parse(doc.issuanceTime) !== Date.parse(newest.issuanceTime)
      )
        throw Error('NWS listing and product differ');
      cached.set(station.cli, {
        id: newest.id,
        report: parseReport(station, doc),
        corrected: /\b(?:CORRECTED|CORRECTION)\b/i.test(doc.productText)
      });
    }
    const r = cached.get(station.cli).report;
    if (!r) return { state: 'Waiting for a same-day afternoon high' };
    const first = db
      .prepare(
        'SELECT id FROM weather_report_reads WHERE event=? ORDER BY at LIMIT 1'
      )
      .get(r.event);
    const earlierIssued = list.some((p) => {
      const t = Date.parse(p.issuanceTime),
        day = localParts(station, t);
      return (
        t < r.ts &&
        day.year === local.year &&
        day.month === local.month &&
        day.day === local.day &&
        +day.hour >= 12
      );
    });
    if (
      (first && first.id !== r.id) ||
      cached.get(station.cli).corrected ||
      earlierIssued
    )
      return { state: 'Updated weather report', event: r.event };
    db.prepare(
      'INSERT OR IGNORE INTO weather_report_reads VALUES(?,?,?,?)'
    ).run(r.id, r.event, Date.now(), JSON.stringify(r));
    const info = {
      event: r.event,
      high: r.high,
      issuedAt: r.issuedAt,
      report: r.id
    };
    startStationCheck(station, r);
    if (age < 60000)
      return { ...info, state: 'Waiting for one-minute entry delay' };
    const markets = await eventMarkets(station, r);
    const eligible = markets
      .map((m) => ({ m, side: crossed(station, r, m) }))
      .filter(({ m, side }) => side && checkMarketActive(m, Date.now()));
    const forecast=afternoonForecast(station,r,markets);
    const activeForecast=forecast && checkMarketActive(forecast,Date.now()) ? forecast : null;
    if (activeForecast)
      db.prepare('INSERT OR IGNORE INTO weather_forecasts(event,ticker,report,high,at,closeAt) VALUES(?,?,?,?,?,?)')
        .run(r.event,forecast.ticker,r.id,r.high,Date.now(),Date.parse(forecast.close_time));
    const books=activeForecast && !eligible.some(x=>x.m.ticker===forecast.ticker) ? [...eligible,{m:forecast,side:'yes'}] : eligible;
    if (!books.length)
      return { ...info, state: 'No open crossed thresholds', thresholds: 0 };
    if (!await weatherExchange(io, station))
      return { ...info, state: 'Exchange unavailable' };
    // Freeze what this worker actually had in hand before the first book request.
    const proof = cached.get(station.cli).proof;
    const a = await snapshot(io, books);
    await sleep(1000);
    const [again, b] = await Promise.all([
      listings(station),
      snapshot(io, books)
    ]);
    if (
      stop() ||
      latest(again)?.id !== r.id ||
      Date.now() - r.ts >= 3600000 ||
      Date.now() - a.at > 5000
    )
      return { ...info, state: 'Signal or quote expired' };
    let offers = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (activeForecast && checkMarketActive(forecast,Date.now())) {
        const offer=forecastOffer(a,b,forecast.ticker);
        db.prepare('UPDATE weather_forecasts SET checks=checks+1 WHERE event=?').run(r.event);
        if (offer) {
          addPaper(db,{...offer,id:'weather_bracket/'+forecast.ticker,strategy:'weather_bracket',
            ticker:forecast.ticker,side:'yes',at:new Date(b.at).toISOString(),closeAt:Date.parse(forecast.close_time)});
          const proof=[a,b].map(s=>({at:s.at,asOf:s.asOf,book:s.books.get(forecast.ticker)}));
          db.prepare('UPDATE weather_forecasts SET proof=COALESCE(proof,?) WHERE event=?').run(JSON.stringify(proof),r.event);
        }
      }
      for (const { m, side } of eligible) {
        if (!checkMarketActive(m, Date.now())) continue;
        const offer = repeatedWeatherAsk(
          a.books.get(m.ticker),
          b.books.get(m.ticker),
          side
        );
        db.prepare(
          'INSERT OR IGNORE INTO weather_quote_checks VALUES(?,?,?,?)'
        ).run(
          r.id,
          b.at,
          m.ticker,
          JSON.stringify({
            side,
            firstAt: a.at,
            first: a.books.get(m.ticker),
            second: b.books.get(m.ticker),
            offer
          })
        );
        if (!offer) continue;
        offers++;
        recordWeatherEntry(db,'weather_high',m,side,offer,b.at);
        const label = !proof
          ? 'Unavailable'
          : proof.contradicted
            ? 'Conflicting report'
            : proof.maximum === null
              ? 'Unavailable'
              : stationSupports(proof, m, side)
                ? 'Supported'
                : 'Unconfirmed';
        db.prepare(
          'INSERT OR IGNORE INTO weather_station_entries SELECT id,?,? FROM paper WHERE id=? AND at=?'
        ).run(
          r.id,
          label,
          'weather_high/' + m.ticker,
          new Date(b.at).toISOString()
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return {
      ...info,
      state: 'Checking published high',
      stationMaximum: proof?.maximum ?? null,
      stationError: cached.get(station.cli).stationError ?? null,
      thresholds: eligible.length,
      offers
    };
  }
  let nextReview = 0;
  async function reviewHistorical() {
    const file = new URL('./runtime/weather-high-replay.json', import.meta.url);
    let report;
    try {
      report = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const tracked = report.days.flatMap((day) =>
      day.rows.filter((r) => r.trade && r.outcome === null)
    );
    const updates = [];
    for (const row of tracked) {
      const m = (await io.get('/markets/' + encodeURIComponent(row.ticker)))
        .body.market;
      if (m.ticker !== row.ticker)
        throw Error('Unexpected historical weather ticker');
      const payout = officialPayout(m, row.side);
      updates.push({
        ticker: m.ticker,
        side: row.side,
        status: m.status,
        net: payout === null ? null : payout - row.trade.price - row.trade.fee
      });
    }
    status.historical = updates;
  }
  while (!stop()) {
    const checks = await Promise.allSettled(monitoredStations.map(async (station,i)=>{
      if (i>=stations.length) await sleep((i-stations.length+1)*1500);
      return check(station);
    }));
    if (Date.now() >= nextReview) {
      try {
        await reviewHistorical();
        status.reviewError = null;
        nextReview = Date.now() + 3600000;
      } catch (e) {
        status.reviewError = e.message;
        nextReview = Date.now() + 60000;
      }
    }
    status.stationGroups = db
      .prepare(
        `SELECT COALESCE(e.label,'Unavailable') AS label, COUNT(*) AS entries,COUNT(p.payout) AS settled,SUM(p.payout-p.price*p.quantity-p.fees) AS net FROM paper p LEFT JOIN weather_station_entries e ON p.id=e.id WHERE p.strategy='weather_high' GROUP BY 1`
      )
      .all();
    status.cities = Object.fromEntries(
      checks.map((x, i) => [
        monitoredStations[i].city,
        x.status === 'fulfilled'
          ? x.value
          : { state: 'Data error', error: x.reason.message }
      ])
    );
    status.threeTotals = db.prepare(`SELECT COUNT(*) AS scans, COUNT(DISTINCT event) AS stationDays,
      COUNT(CASE WHEN json_extract(detail,'$.offers')>0 THEN 1 END) AS scansWithOffers
      FROM weather_three_checks`).get();
    status.at = new Date().toISOString();
    await sleep(60000);
  }
}
