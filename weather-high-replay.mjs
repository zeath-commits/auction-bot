import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { API } from './transport.mjs';
import {
  stations,
  listings,
  product,
  parseReport,
  eventMarkets,
  crossed,
  officialPayout,
  publicJson
} from './weather-high.mjs';

const report = {
  at: new Date().toISOString(),
  protocol:
    'First same-day afternoon NWS CLI per station and day. Subtract 1°F from the reported maximum, then screen contracts already crossed. Examine first qualifying same-side non-block buyer through 99¢, 60 seconds through 60 minutes after issuance, ending earlier on an updated report or market close. Model one share per contract and standard taker fees. Issuance is a proxy for public receipt. A trade by another buyer does not demonstrate an available fill.',
  stations: [],
  days: [],
  errors: []
};
for (const station of stations) {
  const list = await listings(station),
    byEvent = new Map();
  for (const row of list) {
    const doc = await product(row.id),
      r = parseReport(station, doc);
    if (r) {
      if (!byEvent.has(r.event)) byEvent.set(r.event, []);
      byEvent.get(r.event).push(r);
    }
    await sleep(85);
  }
  const series = (await publicJson(API + '/series/' + station.series)).series;
  if (
    series.ticker !== station.series ||
    !['quadratic', 'quadratic_with_maker_fees'].includes(series.fee_type) ||
    !Number.isFinite(series.fee_multiplier)
  )
    throw Error('Unexpected series fees');
  report.stations.push({
    cli: station.cli,
    products: list.length,
    afternoonDays: byEvent.size,
    multiplier: series.fee_multiplier
  });
  for (const day of byEvent.values()) {
    day.sort((a, b) => a.ts - b.ts);
    const r = day[0],
      rows = [];
    const record = { cli: station.cli, ...r, rows };
    report.days.push(record);
    try {
      const markets = await eventMarkets(station, r);
      for (const m of markets) {
        const side = crossed(station, r, m);
        if (!side) continue;
        const from = r.ts + 60000,
          to = Math.min(
            r.ts + 3600000,
            day[1]?.ts ?? Infinity,
            Date.parse(m.close_time)
          );
        const payout = officialPayout(m, side);
        const outcome = payout === null ? null : Boolean(payout);
        const result = {
          ticker: m.ticker,
          side,
          outcome,
          strike: m.strike_type,
          floor: m.floor_strike,
          cap: m.cap_strike,
          trade: null
        };
        rows.push(result);
        if (to <= from) continue;
        let cursor = '',
          seen = new Set(),
          hits = [];
        do {
          const u = new URLSearchParams({
            ticker: m.ticker,
            min_ts: Math.floor(from / 1000),
            max_ts: Math.ceil(to / 1000),
            limit: 1000,
            is_block_trade: 'false'
          });
          if (cursor) u.set('cursor', cursor);
          const page = await publicJson(API + '/markets/trades?' + u);
          for (const t of page.trades) {
            const p = Number(t[side + '_price_dollars']),
              at = Date.parse(t.created_time);
            if (
              t.ticker === m.ticker &&
              t.is_block_trade === false &&
              t.taker_outcome_side === side &&
              t.taker_book_side === (side === 'yes' ? 'bid' : 'ask') &&
              at >= from &&
              at < to &&
              p > 0 &&
              p <= 0.99 &&
              Number(t.count_fp) >= 1
            )
              hits.push({
                id: t.trade_id,
                at: t.created_time,
                price: p,
                size: Number(t.count_fp)
              });
          }
          cursor = page.cursor;
          if (cursor && seen.has(cursor)) throw Error('Repeated trades cursor');
          seen.add(cursor);
          await sleep(350);
        } while (cursor);
        hits.sort((a, b) => a.at.localeCompare(b.at) || b.price - a.price);
        result.qualifyingExecutions = hits.length;
        result.qualifyingQuantity = Number(
          hits.reduce((n, t) => n + t.size, 0).toFixed(2)
        );
        if (hits.length) {
          const t = hits[0];
          const fee =
            Math.ceil(
              0.07 * series.fee_multiplier * t.price * (1 - t.price) * 10000 -
                1e-9
            ) / 10000;
          result.trade = {
            ...t,
            fee,
            modeledNet:
              outcome === null ? null : Number(outcome) - t.price - fee
          };
        }
      }
    } catch (e) {
      record.error = e.message;
      report.errors.push({ event: r.event, error: e.message });
    }
  }
}
// Current official values diagnose revisions. They are never entry inputs.
const officialByDate = new Map();
for (const d of report.days) {
  const station = stations.find((s) => s.cli === d.cli);
  const date = new Date(d.ts).toISOString().slice(0, 10);
  if (!officialByDate.has(date))
    officialByDate.set(
      date,
      await publicJson(
        'https://weather.com/kalshi/api/climate/primary?date=' + date
      )
    );
  const doc = officialByDate.get(date);
  const item = doc.results?.find(
    (x) =>
      x.station?.cliId === d.cli &&
      x.data?.stationId === d.cli &&
      x.data?.reportDate === date &&
      x.data?.isOfficial === true &&
      ['official', 'revised'].includes(x.status)
  );
  d.officialHigh = Number.isInteger(item?.data.maxTemp)
    ? item.data.maxTemp
    : null;
  if (d.officialHigh === null) continue;
  for (const row of d.rows) {
    const { strike, floor, cap } = row;
    const yes =
      strike === 'greater'
        ? d.officialHigh > floor
        : strike === 'less'
          ? d.officialHigh < cap
          : d.officialHigh >= floor && d.officialHigh <= cap;
    row.sourceSupportsSide = yes === (row.side === 'yes');
    if (row.trade)
      row.trade.netIfSettledFromCurrentSource =
        Number(row.sourceSupportsSide) - row.trade.price - row.trade.fee;
  }
}
const rows = report.days.flatMap((d) => d.rows),
  hits = rows.filter((x) => x.trade),
  settled = hits.filter((x) => x.outcome !== null);
report.summary = {
  days: report.days.length,
  crossings: rows.length,
  settled: rows.filter((x) => x.outcome !== null).length,
  wrong: rows.filter((x) => x.outcome === false).length,
  tapeMatches: hits.length,
  matchedDays: report.days.filter((d) => d.rows.some((x) => x.trade)).length,
  matchedSettled: settled.length,
  modeledNet: settled.length
    ? +settled.reduce((s, x) => s + x.trade.modeledNet, 0).toFixed(4)
    : null
};
report.summary.sourceDays = report.days.filter(
  (d) => d.officialHigh !== null
).length;
report.summary.sourceContradictions = rows.filter(
  (r) => r.sourceSupportsSide === false
).length;
const runtime = new URL('./runtime/', import.meta.url);
await fs.mkdir(runtime, { recursive: true });
const tmp = new URL('weather-high-replay.' + process.pid + '.tmp', runtime);
await fs.writeFile(tmp, JSON.stringify(report, null, 2));
await fs.rename(
  tmp,
  new URL(
    report.errors.length
      ? 'weather-high-replay.partial.json'
      : 'weather-high-replay.json',
    runtime
  )
);
if (report.errors.length) process.exitCode = 1;
console.log(
  JSON.stringify({
    stations: report.stations,
    summary: report.summary,
    errors: report.errors
  })
);
