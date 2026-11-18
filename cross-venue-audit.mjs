import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { API } from './transport.mjs';
import {
  usSlug,
  openingTerms,
  usPublic,
  referencePrices,
  averageAt
} from './bitcoin-reference.mjs';

const [start, end] = process.argv.slice(2).map((v) => Date.parse(v) / 1000);
if (
  !(end > start && end * 1000 <= Date.now()) ||
  start % 900 ||
  (end - start) % 86400
)
  throw Error('Supply completed UTC days');
const rows = [];
for (let t = start; t < end; t += 86400) {
  const p = new URLSearchParams({
    series_ticker: 'KXBTC15M',
    min_close_ts: t + 1,
    max_close_ts: t + 86400,
    limit: 200
  });
  const r = await fetch(API + '/markets?' + p);
  if (!r.ok) throw Error('Kalshi HTTP ' + r.status);
  const page = await r.json();
  if (page.cursor || !page.markets.length)
    throw Error('Incomplete Kalshi page');
  const markets = page.markets;
  for (let i = 0; i < markets.length; i += 6) {
    rows.push(
      ...(await Promise.all(
        markets.slice(i, i + 6).map(async (k) => {
          const close = Date.parse(k.close_time) / 1000,
            start5 = close - 300,
            slug = usSlug(start5);
          if (
            close % 900 ||
            k.status !== 'finalized' ||
            !['yes', 'no'].includes(k.result) ||
            !k.rules_primary.includes('BRTI')
          )
            return { close, excluded: 'Kalshi terms or result' };
          let m;
          try {
            m = (await usPublic('/v1/market/slug/' + slug)).market;
          } catch (e) {
            if (e.message.endsWith('404'))
              return { close, excluded: 'US listing unavailable' };
            throw e;
          }
          const terms = openingTerms(m, start5);
          if (
            !terms ||
            m.status !== 'MARKET_STATUS_RESOLVED' ||
            !terms.settlementPrice?.value ||
            !k.expiration_value
          )
            return { close, excluded: 'US terms or settlement missing' };
          const pmFinal = Number(terms.settlementPrice.value),
            kFinal = Number(k.expiration_value);
          if (![pmFinal, kFinal].every((x) => Number.isFinite(x) && x > 0))
            throw Error('Invalid settlement value');
          const pmStrike = Number(terms.priceToBeat.value),
            kStrike = k.floor_strike;
          const prices = JSON.parse(m.outcomePrices).map(Number),
            outcomes = JSON.parse(m.outcomes);
          if (
            k.strike_type !== 'greater_or_equal' ||
            !(kStrike > 0) ||
            !prices.includes(0) ||
            !prices.includes(1) ||
            prices.length !== 2 ||
            outcomes[prices.indexOf(1)]?.toLowerCase() !==
              (pmFinal >= pmStrike ? 'yes' : 'no') ||
            k.result !== (kFinal >= kStrike ? 'yes' : 'no')
          )
            return {
              close,
              excluded: 'Binary payout does not match published terms'
            };
          return {
            close,
            slug,
            ticker: k.ticker,
            pmFinal,
            kFinal,
            pmStrike,
            kStrike,
            pmWonUp: pmFinal >= pmStrike,
            kWonUp: k.result === 'yes'
          };
        })
      ))
    );
    await sleep(160);
  }
}
const out = new URL(
  './runtime/cross-venue-audit-' + start + '-' + end + '.json',
  import.meta.url
);
await fs.writeFile(out, JSON.stringify(rows));
const valid = rows.filter((r) => !r.excluded);
if (new Set(rows.map((r) => r.close)).size !== rows.length)
  throw Error('Duplicate closing window');
console.log(
  rows.length,
  valid.length,
  'comparable',
  valid.filter((r) => r.pmFinal === r.kFinal).length,
  'identical',
  valid.filter((r) => r.pmStrike !== r.kStrike).length,
  'different strikes'
);
for (let from = start; from < end; from += 7 * 86400) {
  const wide = valid.filter(
    (r) =>
      r.close > from &&
      r.close <= from + 7 * 86400 &&
      (10000 * Math.abs(r.pmStrike - r.kStrike)) / r.kStrike >= 20
  );
  const payouts = wide.map((r) =>
    r.pmStrike < r.kStrike
      ? Number(r.pmWonUp) + Number(!r.kWonUp)
      : Number(!r.pmWonUp) + Number(r.kWonUp)
  );
  console.log(
    new Date(from * 1000).toISOString(),
    '20+ basis point windows',
    wide.length,
    'zero, one and two winning legs',
    [0, 1, 2].map((n) => payouts.filter((p) => p === n).length)
  );
}
if (process.argv.includes('--chart-check')) {
  let tested = 0,
    matched = 0;
  for (const row of valid) {
    const ticks = await referencePrices(row.close - 60, row.close - 1);
    const mean = averageAt(ticks, row.close);
    if (mean !== null) {
      tested++;
      if (mean === row.pmFinal) matched++;
    }
  }
  console.log('One-second chart checks', tested, 'matched finals', matched);
}
