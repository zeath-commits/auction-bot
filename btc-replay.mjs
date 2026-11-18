import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { API } from './transport.mjs';

const args = process.argv.slice(2);
const tenOnly = args[2] === '--final-ten';
const cheapTaker = args[2] === '--cheap-taker';
if (args.length !== (tenOnly || cheapTaker ? 3 : 2))
  throw Error('Supply two UTC boundaries and optionally --final-ten or --cheap-taker');

// Reproduce the original test: first 98c/99c print on either side in the
// final minute, irrespective of aggressor. A print is never a simulated fill.
async function get(route) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(API + route, {
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500)
      throw Error('HTTP ' + response.status);
    await sleep(1200 * (attempt + 1));
  }
  throw Error('Unable to read complete trade history');
}

async function replay(market) {
  const end = Date.parse(market.close_time) / 1000;
  const route =
    '/markets/trades?ticker=' +
    market.ticker +
    '&limit=1000&min_ts=' +
    (end - (tenOnly ? 10 : 60)) +
    '&max_ts=' +
    end;
  let cursor = '',
    first,
    finalTen;
  const seen = new Set();
  do {
    const data = await get(
      route + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    );
    for (const trade of data.trades) {
      const at = Date.parse(trade.created_time);
      if (trade.is_block_trade || at < 1000 * (end - 60) || at >= 1000 * end)
        continue;
      const prices = cheapTaker ? [0.01, 0.02] : [0.98, 0.99];
      const side = ['yes', 'no'].find(k => prices.includes(Number(trade[k + '_price_dollars'])));
      if (!side) continue;
      if (cheapTaker && (trade.ticker !== market.ticker ||
          (trade.taker_outcome_side ?? trade.taker_side) !== side || !(Number(trade.count_fp) >= 1))) continue;
      const print = {
        at: trade.created_time,
        side,
        price: Number(trade[side + '_price_dollars'])
      };
      if (tenOnly || cheapTaker) {
        print.count = trade.count_fp;
        print.taker = trade.taker_outcome_side ?? trade.taker_side;
        print.id = trade.trade_id;
      }
      if (!first || print.at < first.at) first = print;
      if (at >= 1000 * (end - 10) && (!finalTen || print.at < finalTen.at))
        finalTen = print;
    }
    cursor = data.cursor;
    if (cursor && seen.has(cursor)) throw Error('Repeated trade cursor');
    seen.add(cursor);
  } while (cursor);
  return {
    ticker: market.ticker,
    result: market.result,
    first: first ?? null,
    finalTen: finalTen ?? null
  };
}

const [from, until] = args.slice(0, 2).map(Date.parse);
const dstDay = [23, 25].includes((until - from) / 3600000);
if (
  !(until > from && until <= Date.now()) ||
  (!dstDay && (until - from) % 86400000)
)
  throw Error('Supply past UTC day boundaries');
const dir = new URL(
  cheapTaker ? './runtime/cheap-taker/' : tenOnly ? './runtime/holdout-ten/' : './runtime/replay/',
  import.meta.url
);
await fs.mkdir(dir, { recursive: true });
for (
  let start = from;
  start < until;
  start += dstDay ? until - from : 86400000
) {
  const end = dstDay ? until : start + 86400000;
  const route =
    '/markets?series_ticker=KXBTC15M&limit=200&min_close_ts=' +
    (start / 1000 + 1) +
    '&max_close_ts=' +
    end / 1000;
  const { markets, cursor } = await get(route);
  if (
    cursor ||
    !markets.length ||
    markets.some((m) => m.status !== 'finalized')
  )
    throw Error('Incomplete market results');
  const binary = markets.filter((m) => ['yes', 'no'].includes(m.result));
  const rows = [];
  for (let i = 0; i < binary.length; i += 5) {
    rows.push(...(await Promise.all(binary.slice(i, i + 5).map(replay))));
    await sleep(230);
  }
  const count = rows.filter((r) => r.first).length;
  const losses = rows.filter(
    (r) => r.first && r.first.side !== r.result
  ).length;
  const date = new Date(start).toISOString().slice(0, 10);
  const file = new URL(date + '.json', dir);
  const temp = new URL(date + '.' + process.pid + '.tmp', dir);
  await fs.writeFile(
    temp,
    JSON.stringify({
      start,
      end,
      listed: markets.length,
      possible: (end - start) / 900000,
      rows
    })
  );
  await fs.rename(temp, file);
  console.log(
    date,
    markets.length,
    'windows',
    count,
    'qualifying',
    losses,
    'losses'
  );
}
