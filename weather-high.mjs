import { setTimeout as sleep } from 'node:timers/promises';
import { API } from './transport.mjs';

export const stations = [
  {
    cli: 'PHL',
    series: 'KXHIGHPHIL',
    city: 'Philadelphia',
    heading: 'PHILADELPHIA PA',
    office: 'KPHI',
    zone: 'America/New_York'
  },
  {
    cli: 'NYC',
    series: 'KXHIGHNY',
    city: 'New York City',
    heading: 'CENTRAL PARK NY',
    office: 'KOKX',
    zone: 'America/New_York'
  },
  {
    cli: 'MIA',
    series: 'KXHIGHMIA',
    city: 'Miami',
    heading: 'MIAMI',
    office: 'KMFL',
    zone: 'America/New_York'
  },
  {
    cli: 'MDW',
    series: 'KXHIGHCHI',
    city: 'Chicago',
    heading: 'CHICAGO-MIDWAY',
    office: 'KLOT',
    zone: 'America/Chicago'
  }
];
export const westernStations = [
  {cli:'DEN',series:'KXHIGHDEN',city:'Denver',heading:'DENVER CO',office:'KBOU',zone:'America/Denver'},
  {cli:'LAX',series:'KXHIGHLAX',city:'Los Angeles',heading:'LOS ANGELES INTL AIRPORT CA',office:'KLOX',zone:'America/Los_Angeles'},
  {cli:'SEA',series:'KXHIGHTSEA',city:'Seattle',heading:'SEATTLE-TACOMA WA AIRPORT',office:'KSEW',zone:'America/Los_Angeles'},
  {cli:'SFO',series:'KXHIGHTSFO',city:'San Francisco',heading:'SAN FRANCISCO AIRPORT',office:'KMTR',zone:'America/Los_Angeles'}
];
const standardOffsets = {'America/New_York':5,'America/Chicago':6,'America/Denver':7,'America/Los_Angeles':8};
export async function publicJson(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WeatherPaperResearch/1.0',
        'Cache-Control': 'no-cache'
      },
      signal: AbortSignal.timeout(7000)
    });
    if ([429, 502, 503, 504].includes(r.status) && attempt < 4) {
      const hint = r.headers.get('retry-after');
      const ms =
        hint && /^\d+$/.test(hint)
          ? Number(hint) * 1000
          : Date.parse(hint) - Date.now();
      await r.body?.cancel();
      await sleep(Math.max(2000 * 2 ** attempt, Number.isFinite(ms) ? ms : 0));
      continue;
    }
    if (!r.ok) throw Error(new URL(url).hostname + ' HTTP ' + r.status);
    return r.json();
  }
}
export async function listings(station) {
  const d = await publicJson(
    'https://api.weather.gov/products/types/CLI/locations/' + station.cli
  );
  if (!Array.isArray(d['@graph'])) throw Error('NWS product list missing');
  return d['@graph'].filter(
    (p) => p.issuingOffice === station.office && p.productCode === 'CLI'
  );
}
export async function product(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid NWS product ID');
  return publicJson('https://api.weather.gov/products/' + id);
}
export function localParts(station, t) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: station.zone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(t));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
export function stationDay(station, at) {
  const offsetHours = standardOffsets[station.zone];
  const date = new Date(at - offsetHours * 3600000);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), offsetHours);
  const month = date.toLocaleString('en-US', {timeZone: 'UTC', month: 'short'});
  const suffix = String(date.getUTCFullYear()).slice(-2) + month.toUpperCase() + String(date.getUTCDate()).padStart(2, '0');
  return {dayStart, date: month + ' ' + date.getUTCDate() + ', ' + date.getUTCFullYear(), event: station.series + '-' + suffix};
}
export function parseReport(station, p) {
  const t = Date.parse(p.issuanceTime),
    s = p.productText?.replaceAll('\r', '') ?? '';
  if (
    !Number.isFinite(t) ||
    p.issuingOffice !== station.office ||
    p.productCode !== 'CLI' ||
    !s.split('\n').some((l) => l.trim() === 'CLI' + station.cli)
  )
    return null;
  const heading = s.match(
    /\.\.\.THE ([^\n]+?) CLIMATE SUMMARY FOR ([A-Z]+) (\d{1,2}) (\d{4})\.\.\./
  );
  const temp = s.match(
    /TEMPERATURE \(F\)[ \t]*\n[ \t]*TODAY[ \t]*\n[ \t]*MAXIMUM[ \t]+(-?\d+)\s/
  );
  if (
    heading?.[1] !== station.heading ||
    !temp ||
    !/^VALID TODAY AS OF [0-9]{4} PM LOCAL TIME\./m.test(s)
  )
    return null;
  const d = localParts(station, t);
  if (
    d.month.toUpperCase() !== heading[2].slice(0, 3) ||
    Number(d.day) !== Number(heading[3]) ||
    d.year !== heading[4] ||
    Number(d.hour) < 12
  )
    return null;
  const monthIndex = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'
    .split(' ')
    .indexOf(heading[2].slice(0, 3));
  const dayStart = Date.UTC(
    Number(d.year),
    monthIndex,
    Number(d.day),
    standardOffsets[station.zone]
  );
  const peak = s
    .slice(temp.index + temp[0].length)
    .match(/^[ \t]*(\d{1,2}):?(\d{2})[ \t]+(AM|PM)\b/);
  const validPeak = peak && +peak[1] >= 1 && +peak[1] <= 12 && +peak[2] < 60;
  const peakAt = validPeak
    ? dayStart +
      (((+peak[1] % 12) + (peak[3] === 'PM' ? 12 : 0)) * 60 + Number(peak[2])) *
        60000
    : null;
  const suffix =
    d.year.slice(-2) + d.month.toUpperCase() + d.day.padStart(2, '0');
  return {
    id: p.id,
    ts: t,
    issuedAt: p.issuanceTime,
    high: Number(temp[1]),
    dayStart,
    peakAt,
    date: d.month + ' ' + d.day + ', ' + d.year,
    event: station.series + '-' + suffix
  };
}
export async function eventMarkets(station, report) {
  const { event } = await publicJson(
    API + '/events/' + report.event + '?with_nested_markets=true'
  );
  if (
    event?.series_ticker !== station.series ||
    event.event_ticker !== report.event ||
    event.settlement_sources?.length !== 1 ||
    event.settlement_sources[0].name !== 'The Weather Company' ||
    !Array.isArray(event.markets)
  )
    throw Error('Weather event source mismatch');
  return event.markets;
}
function temperatureBracket(station, r, m) {
  if (
    m.event_ticker !== r.event ||
    m.market_type !== 'binary' ||
    m.notional_value_dollars !== '1.0000'
  )
    return null;
  const f = m.floor_strike,
    c = m.cap_strike;
  let words, low=-Infinity, high=Infinity;
  if (m.strike_type === 'less' && Number.isInteger(c)) {
    words = 'less than ' + c;
    high=c-1;
  } else if (m.strike_type === 'greater' && Number.isInteger(f)) {
    words = 'greater than ' + f;
    low=f+1;
  } else if (
    m.strike_type === 'between' &&
    Number.isInteger(c) &&
    Number.isInteger(f) &&
    f <= c
  ) {
    words = 'between ' + f + '-' + c;
    low=f;
    high=c;
  } else return null;
  const rule =
    'If the maximum temperature recorded at ' +
    station.city +
    ' (CLI' +
    station.cli +
    ') for ' +
    r.date +
    ', is ' +
    words +
    '° fahrenheit according to The Weather Company, then the market resolves to Yes.';
  return m.rules_primary === rule ? {low,high} : null;
}

export function crossed(station, r, m) {
  const bounds=temperatureBracket(station,r,m);
  if (!bounds) return null;
  const lower=r.high-1;
  if (lower>bounds.high) return 'no';
  return bounds.high===Infinity && lower>=bounds.low ? 'yes' : null;
}

export function afternoonForecast(station, r, markets) {
  const hits=markets.filter(m=>{
    const bounds=temperatureBracket(station,r,m);
    return bounds && r.high>=bounds.low && r.high<=bounds.high;
  });
  return hits.length===1 ? hits[0] : null;
}

export function officialPayout(m, side) {
  if (
    m.status !== 'finalized' ||
    !['yes', 'no'].includes(m.result) ||
    typeof m.settlement_value_dollars !== 'string' ||
    !/^(?:0|1)(?:\.0+)?$/.test(m.settlement_value_dollars)
  )
    return null;
  if (Number(m.settlement_value_dollars) !== Number(m.result === 'yes'))
    return null;
  return Number(m.result === side);
}

export async function weatherBuys(ticker, side, from, to) {
  let cursor = '',
    seen = new Set(),
    hits = [];
  do {
    const u = new URLSearchParams({
      ticker,
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
        t.ticker === ticker &&
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
  return hits;
}
