import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { API } from './transport.mjs';

async function get(route) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(400);
    const r = await fetch(API + route, { signal: AbortSignal.timeout(10000) });
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status !== 503)
      throw Error('Market data HTTP ' + r.status);
    const retry = r.headers.get('retry-after'),
      ms =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now();
    await sleep(Math.max(2000 * 2 ** attempt, Number.isFinite(ms) ? ms : 0));
  }
  throw Error('Public trade history unavailable');
}

export function bidWindows(rows, strike, confirmed) {
  return rows
    .filter((r, i) => {
      if (!(r.bid > strike)) return false;
      const prev = rows[i - 1],
        age = prev ? Date.parse(r.at) - Date.parse(prev.at) : 0;
      return (
        !confirmed ||
        (prev &&
          prev.tick + 1 === r.tick &&
          age >= 1000 &&
          age <= 45000 &&
          prev.bid > strike &&
          r.bid >= prev.bid &&
          r.count >= prev.count)
      );
    })
    .map((r) => [Date.parse(r.at) + 1000, r.until]);
}

async function main() {
  const { lots } = JSON.parse(
    await fs.readFile(new URL('./live-bid-replay-input.json', import.meta.url))
  );
  const series = (await get('/series/KXART')).series;
  if (series.fee_type !== 'quadratic' || series.fee_multiplier !== 1)
    throw Error('Auction fees changed');
  const results = [];
  for (const lot of lots) {
    const d = await get('/events/' + lot.event + '?with_nested_markets=true'),
      e = d.event;
    if (
      e.event_ticker !== lot.event ||
      !e.settlement_sources?.length ||
      !e.settlement_sources.every(
        (s) =>
          s.name === 'Artnet' && new URL(s.url).hostname === 'www.artnet.com'
      )
    )
      throw Error('Unexpected settlement source');
    const markets = d.markets?.length ? d.markets : e.markets;
    for (const m of markets) {
      if (
        m.event_ticker !== lot.event ||
        m.status !== 'finalized' ||
        !['yes', 'no'].includes(m.result) ||
        m.strike_type !== 'greater' ||
        Number(m.notional_value_dollars) !== 1 ||
        !m.rules_primary.includes(lot.sale) ||
        !m.rules_primary.includes('lot ' + lot.lot + ')') ||
        !m.rules_primary.includes('on Artnet is above')
      )
        throw Error('Review ' + m.ticker);
      const windows = bidWindows(lot.observations, m.floor_strike, false),
        two = bidWindows(lot.observations, m.floor_strike, true);
      const row = {
        event: lot.event,
        ticker: m.ticker,
        bidCrossed: !!windows.length,
        confirmed: !!two.length,
        result: m.result,
        publicTrades: 0,
        yesExecutions: [],
        buys: []
      };
      results.push(row);
      if (!windows.length) continue;
      const p = new URLSearchParams({
        ticker: m.ticker,
        min_ts: String(Math.floor(windows[0][0] / 1000)),
        max_ts: String(Math.ceil(windows.at(-1)[1] / 1000)),
        limit: '1000',
        is_block_trade: 'false'
      });
      const cursors = new Set(),
        ids = new Set();
      do {
        const page = await get('/markets/trades?' + p);
        for (const t of page.trades) {
          if (t.ticker !== m.ticker || !t.trade_id || ids.has(t.trade_id))
            throw Error('Unexpected trade identity');
          ids.add(t.trade_id);
          const at = Date.parse(t.created_time),
            price = Number(t.yes_price_dollars),
            qty = Number(t.count_fp);
          if (
            t.is_block_trade !== false ||
            !windows.some(([a, b]) => at >= a && at < b)
          )
            continue;
          row.publicTrades++;
          if (t.taker_outcome_side !== 'yes' || t.taker_book_side !== 'bid')
            continue;
          const fill = {
            at: t.created_time,
            price,
            qty,
            confirmed: two.some(([a, b]) => at >= a && at < b)
          };
          row.yesExecutions.push(fill);
          if (qty >= 1 && price > 0 && price <= 0.95) row.buys.push(fill);
        }
        if (!page.cursor) break;
        if (cursors.has(page.cursor)) throw Error('Repeated trade cursor');
        cursors.add(page.cursor);
        p.set('cursor', page.cursor);
      } while (true);
      row.buys.sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || b.price - a.price
      );
    }
  }
  const file = new URL('./runtime/live-bid-replay.json', import.meta.url);
  await fs.mkdir(new URL('./runtime/', import.meta.url), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ at: new Date().toISOString(), results })
  );
  for (const confirmed of [false, true]) {
    const crossed = results.filter((r) =>
      confirmed ? r.confirmed : r.bidCrossed
    );
    const entries = crossed
      .map((r) => ({ r, t: r.buys.find((t) => !confirmed || t.confirmed) }))
      .filter((x) => x.t);
    let net = 0,
      cost = 0,
      size = 0;
    for (const { r, t } of entries) {
      const n = Math.min(5, Math.floor(t.qty)),
        debit =
          Math.ceil(100 * n * t.price - 1e-9) +
          Math.ceil(7 * n * t.price * (1 - t.price) - 1e-9);
      cost += debit;
      net += (r.result === 'yes' ? 100 * n : 0) - debit;
      size += n;
    }
    console.log({
      confirmed,
      crossed: crossed.length,
      lots: new Set(crossed.map((r) => r.event)).size,
      yes: crossed.filter((r) => r.result === 'yes').length,
      entries: entries.length,
      size,
      cost: cost / 100,
      net: net / 100
    });
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main();
