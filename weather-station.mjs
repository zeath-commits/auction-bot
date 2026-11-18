import { publicJson } from './weather-high.mjs';
const hour = 3600000,
  minute = 60000;
export async function stationMessages(station, cutoff) {
  // Query through the next UTC hour to include observations labelled at the nominal hour.
  // Receipt time controls which messages were public by the report issuance.
  const end = new Date(Math.ceil(cutoff / hour) * hour);
  const date =
    end.toISOString().slice(0, 10).replaceAll('-', '') +
    '_' +
    end.toISOString().slice(11, 13) +
    '00';
  const query = new URLSearchParams({
    ids: 'K' + station.cli,
    format: 'json',
    hours: '30'
  });
  if (end.getTime() <= Date.now()) query.set('date', date);
  const url = 'https://aviationweather.gov/api/data/metar?' + query;
  const rows = await publicJson(url);
  if (!Array.isArray(rows) || rows.length >= 400)
    throw Error('Incomplete aviation observation set');
  return { url, rows };
}
const fahrenheit = (sign, digits) =>
  Math.round((Number(digits) / 10) * (sign === '1' ? -1 : 1) * 1.8 + 32);
export function stationEvidence(station, report, rows) {
  const hourly = [],
    maxima = [];
  for (const x of rows) {
    const at = x.obsTime * 1000,
      receipt = Date.parse(x.receiptTime),
      raw = x.rawOb ?? '';
    if (
      x.icaoId !== 'K' + station.cli ||
      !['METAR', 'SPECI'].includes(x.metarType) ||
      !Number.isFinite(at) ||
      !(receipt >= at && receipt <= report.ts) ||
      at > report.ts ||
      !new RegExp('\\bK' + station.cli + '\\b').test(raw) ||
      /\b(?:COR|TEST)\b/.test(raw)
    )
      continue;
    const remarks = raw.split(/\bRMK\b/)[1] ?? '';
    const t = remarks.match(/\bT([01])(\d{3})(?:[01]\d{3})?\b/);
    if (t && at >= report.dayStart + 5 * minute)
      hourly.push({ at, receipt, temp: fahrenheit(t[1], t[2]) });
    const high = remarks.match(/\b1([01])(\d{3})\b/),
      end = Date.parse(x.reportTime);
    if (
      !high ||
      !Number.isFinite(end) ||
      end % (6 * hour) !== 0 ||
      Math.abs(end - at) > 15 * minute
    )
      continue;
    maxima.push({ end, receipt, temp: fahrenheit(high[1], high[2]), raw });
  }
  // Use two temperature readings at least ten minutes apart. Each six-hour maximum
  // must fit in the standard-time climate day even allowing a 15-minute boundary margin.
  hourly.sort((a, b) => a.at - b.at);
  let paired = null,
    priorPeak = -Infinity,
    idx = 0;
  for (const x of hourly) {
    while (idx < hourly.length && hourly[idx].at <= x.at - 10 * minute)
      priorPeak = Math.max(priorPeak, hourly[idx++].temp);
    if (Number.isFinite(priorPeak))
      paired = Math.max(paired ?? -Infinity, Math.min(priorPeak, x.temp));
  }
  const internal = maxima.filter(
    (x) => x.end - 6 * hour - 15 * minute >= report.dayStart
  );
  const bound = Math.max(paired ?? -Infinity, ...internal.map((x) => x.temp));
  const atPeak = maxima.filter(
    (x) =>
      report.peakAt !== null &&
      report.peakAt > x.end - 6 * hour + 15 * minute &&
      report.peakAt < x.end - 15 * minute
  );
  return {
    observations: hourly.length,
    paired,
    intervals: internal.length,
    maximum: Number.isFinite(bound) ? bound : null,
    peakWindow: atPeak[0] ?? null,
    contradicted: atPeak.some((x) => x.temp + 1 < report.high)
  };
}
export function stationSupports(e, m, side) {
  if (e.maximum === null || e.contradicted) return false;
  const low = e.maximum - 1;
  return side === 'yes'
    ? m.strike_type === 'greater' && low > m.floor_strike
    : (m.strike_type === 'less' && low >= m.cap_strike) ||
        (m.strike_type === 'between' && low > m.cap_strike);
}
