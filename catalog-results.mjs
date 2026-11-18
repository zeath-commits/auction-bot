import { checkEvent } from './core.mjs';

// Frozen public catalog observations. Kalshi names the Artnet Price Database
// in its rules. Only the exchange can confirm the individual contract payouts.
export const catalogObservations = [
  { event: 'KXART-PHI17NOV26', label: 'Withdrawn' },
  { event: 'KXART-PHI18NOV26', label: 'Bought In' }
];
export const catalogSource = 'https://www.artnet.com/auction-houses/phillips-newyork/modern-contemporary-art-evening-sale-6/2';
export const catalogObservedAt = '2026-11-18T19:41:00Z';

export function summarizeSettlement(target, body) {
  const markets = checkEvent(body, target);
  if (markets.length !== target.markets.length ||
      new Set(markets.map(m => m.ticker)).size !== target.markets.length)
    throw Error('Incomplete or duplicate auction thresholds');
  const counts = { total: markets.length, yes: 0, no: 0, other: 0, pending: 0 };
  for (const m of markets) {
    if (m.status !== 'finalized' && m.status !== 'settled') {
      counts.pending++;
    } else if (m.result === 'yes' && /^1(?:\.0+)?$/.test(m.settlement_value_dollars)) {
      counts.yes++;
    } else if (m.result === 'no' && /^0(?:\.0+)?$/.test(m.settlement_value_dollars)) {
      counts.no++;
    } else {
      counts.other++;
    }
  }
  return counts;
}
