import {
  stationMessages,
  stationEvidence,
  stationSupports
} from './weather-station.mjs';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { askLevels, checkMarketActive } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';
import {
  stations,
  listings,
  product,
  parseReport,
  eventMarkets,
  crossed,
  localParts,
  officialPayout
} from './weather-high.mjs';

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
  return { books, at: read.receivedAt };
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
    if (!eligible.length)
      return { ...info, state: 'No open crossed thresholds', thresholds: 0 };
    const [series, exchange] = await Promise.all([
      io.get('/series/' + station.series),
      io.get('/exchange/status')
    ]);
    const s = series.body.series;
    if (
      s.ticker !== station.series ||
      !['quadratic', 'quadratic_with_maker_fees'].includes(s.fee_type) ||
      s.fee_multiplier !== 1
    )
      throw Error('Weather fee schedule changed');
    if (!exchange.body.trading_active || !exchange.body.exchange_active)
      return { ...info, state: 'Exchange unavailable' };
    // Freeze what this worker actually had in hand before the first book request.
    const proof = cached.get(station.cli).proof;
    const a = await snapshot(io, eligible);
    await sleep(1000);
    const [again, b] = await Promise.all([
      listings(station),
      snapshot(io, eligible)
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
        addPaper(db, {
          id: 'weather_high/' + m.ticker,
          strategy: 'weather_high',
          ticker: m.ticker,
          side,
          at: new Date(b.at).toISOString(),
          quantity: 1,
          price: offer.price,
          depth: offer.depth,
          fees:
            Math.ceil(0.07 * offer.price * (1 - offer.price) * 10000 - 1e-9) /
            10000,
          closeAt: Date.parse(m.close_time)
        });
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
    const checks = await Promise.allSettled(stations.map(check));
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
        stations[i].city,
        x.status === 'fulfilled'
          ? x.value
          : { state: 'Data error', error: x.reason.message }
      ])
    );
    status.at = new Date().toISOString();
    await sleep(60000);
  }
}
