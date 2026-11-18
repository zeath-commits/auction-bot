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
    station.cli === 'MDW' ? 6 : 5
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
export function crossed(station, r, m) {
  if (
    m.event_ticker !== r.event ||
    m.market_type !== 'binary' ||
    m.notional_value_dollars !== '1.0000'
  )
    return null;
  const lower = r.high - 1,
    f = m.floor_strike,
    c = m.cap_strike;
  let words, side;
  if (m.strike_type === 'less' && Number.isInteger(c)) {
    words = 'less than ' + c;
    side = lower >= c ? 'no' : null;
  } else if (m.strike_type === 'greater' && Number.isInteger(f)) {
    words = 'greater than ' + f;
    side = lower > f ? 'yes' : null;
  } else if (
    m.strike_type === 'between' &&
    Number.isInteger(c) &&
    Number.isInteger(f) &&
    f <= c
  ) {
    words = 'between ' + f + '-' + c;
    side = lower > c ? 'no' : null;
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
  return m.rules_primary === rule ? side : null;
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
