import { crossed, stationDay } from './weather-high.mjs';
import { stationEvidence } from './weather-station.mjs';

const hour = 3600000;

export function threeOClock(station, at) {
  const day = stationDay(station, at);
  const start = day.dayStart + 15 * hour;
  return { ...day, start, end: start + hour };
}

export function threeSignals(station, window, rows, markets, checkedAt) {
  if (checkedAt < window.start || checkedAt >= window.end)
    return {state: 'Outside observation window', signals: []};
  const corrected = rows.some(r => r.icaoId === 'K' + station.cli &&
    r.obsTime * 1000 >= window.dayStart && r.obsTime * 1000 <= window.start &&
    Date.parse(r.receiptTime) <= checkedAt && /\bCOR\b/.test(r.rawOb ?? ''));
  if (corrected) return {state: 'Corrected station observation', signals: []};
  // A six-hour group labelled for a future nominal hour is excluded at the cutoff.
  const known = rows.filter(r => Date.parse(r.reportTime) <= window.start);
  const evidence = stationEvidence(station, {ts: window.start, dayStart: window.dayStart, peakAt: null}, known);
  if (evidence.maximum === null) return {state: 'Insufficient station evidence', evidence, signals: []};
  const report = {...window, high: evidence.maximum};
  const signals = markets.map(m => ({m, side: crossed(station, report, m)})).filter(x => x.side);
  return {state: 'Checked station readings', evidence, signals};
}

// Re-evaluate only when a new observation can first be used. Both the receipt
// and nominal time must be in the past. Keep the first crossing per contract.
export function beforeThreeCrossings(station, day, rows, markets) {
  const receipts = rows.map(r => Math.max(Date.parse(r.receiptTime), Date.parse(r.reportTime)))
    .filter(t => t >= day.dayStart && t < day.start);
  const found = new Map();
  for (const start of [...new Set(receipts)].sort((a,b) => a-b)) {
    const window = {...day, start, end:Math.min(day.start, start + hour)};
    const {signals} = threeSignals(station,window,rows,markets,start);
    for (const {m, side} of signals) {
      if (!found.has(m.ticker)) found.set(m.ticker,{m,side,window});
    }
  }
  return [...found.values()];
}
