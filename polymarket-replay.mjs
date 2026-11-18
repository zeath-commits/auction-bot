import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const gamma = 'https://gamma-api.polymarket.com';
const data = 'https://data-api.polymarket.com';
const source = 'https://data.chain.link/streams/btc-usd-twap-60s-streams';

async function read(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status === 404 && url.startsWith(gamma + '/')) return null;
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500)
        throw Object.assign(Error('HTTP ' + r.status), { terminal: true });
    } catch (e) {
      if (e.terminal || attempt === 4) throw e;
    }
    await sleep(500 * 2 ** attempt);
  }
  throw Error('Public data temporarily unavailable');
}

export function scoreWindow(m, trades, start) {
  const end = start + 300;
  if (
    m?.eventStartTime == null ||
    Date.parse(m.eventStartTime) !== start * 1000 ||
    Date.parse(m.endDate) !== end * 1000 ||
    m.slug !== 'btc-updown-5m-' + start ||
    m.closed !== true ||
    m.umaResolutionStatus !== 'resolved' ||
    m.resolutionSource !== source ||
    m.feesEnabled !== true ||
    m.feeSchedule?.exponent !== 1 ||
    m.feeSchedule.rate !== 0.07
  )
    return {
      start,
      excluded: 'Listing, settlement source, or fee schedule unmatched'
    };
  const outcomes = JSON.parse(m.outcomes),
    prices = JSON.parse(m.outcomePrices).map(Number);
  if (
    outcomes.length !== 2 ||
    !outcomes.includes('Up') ||
    !outcomes.includes('Down') ||
    prices.length !== 2 ||
    !prices.includes(1) ||
    !prices.includes(0)
  )
    return { start, excluded: 'Non-binary settlement' };
  const winner = outcomes[prices.indexOf(1)];
  let first = null,
    sizeAtLeast1000 = false;
  for (const t of trades) {
    if (t.condition_id !== m.conditionId || t.slug !== m.slug)
      throw Error('Trade identity mismatch');
    if (
      t.side !== 'BUY' ||
      t.timestamp < end - 10 ||
      t.timestamp >= end ||
      t.size < 1 ||
      !outcomes.includes(t.outcome) ||
      ![0.98, 0.99].includes(t.price)
    )
      continue;
    if (t.size >= 1000) sizeAtLeast1000 = true;
    if (!first)
      first = {
        timestamp: t.timestamp,
        price: t.price,
        size: t.size,
        outcome: t.outcome
      };
  }
  const net = first
    ? Number(first.outcome === winner) -
      first.price -
      Math.round(1e5 * 0.07 * first.price * (1 - first.price)) / 1e5
    : null;
  return { start, winner, first, net, sizeAtLeast1000 };
}

async function windowAt(start) {
  const m = await read(gamma + '/markets/slug/btc-updown-5m-' + start);
  if (!m) return { start, excluded: 'Market listing unavailable' };
  if (!m.conditionId) throw Error('Missing market identifier');
  const rows = [],
    seen = new Set();
  let cursor = '',
    oldest = Infinity;
  // The condition feed ignores time bounds. Page in descending block order
  // until the complete lower boundary (including all ties) has been read.
  do {
    const q = new URLSearchParams({
      condition: m.conditionId,
      limit: '500',
      taker_only: 'true',
      side: 'BUY'
    });
    if (cursor) q.set('cursor', cursor);
    const page = await read(data + '/v2/trades?' + q);
    if (!Array.isArray(page.data) || !page.pagination)
      throw Error('Incomplete trades response');
    for (const t of page.data) {
      if (
        !Number.isInteger(t.timestamp) ||
        t.timestamp > oldest ||
        t.condition_id !== m.conditionId ||
        t.side !== 'BUY'
      )
        throw Error('Trade ordering or filter changed');
      oldest = t.timestamp;
      if (t.timestamp >= start + 290 && t.timestamp < start + 300) rows.push(t);
    }
    cursor = page.pagination.next_cursor;
    if (
      Boolean(cursor) !== page.pagination.has_more ||
      (cursor && seen.has(cursor))
    )
      throw Error('Invalid trades cursor');
    seen.add(cursor);
  } while (cursor && oldest >= start + 290);
  return scoreWindow(m, rows.reverse(), start);
}

async function main() {
  const [from, until] = process.argv.slice(2).map((v) => Date.parse(v) / 1000);
  if (
    !Number.isInteger(from) ||
    from % 300 ||
    !(until > from && until * 1000 <= Date.now()) ||
    until % 300
  )
    throw Error('Supply past UTC boundaries aligned to five minutes');
  const dir = new URL('./runtime/polymarket-replay/', import.meta.url);
  await fs.mkdir(dir, { recursive: true });
  for (let day = from; day < until; day += 86400) {
    const rows = [];
    for (let t = day; t < Math.min(day + 86400, until); t += 1200) {
      const starts = [t, t + 300, t + 600, t + 900].filter(
        (v) => v < Math.min(day + 86400, until)
      );
      rows.push(...(await Promise.all(starts.map(windowAt))));
      await sleep(110);
    }
    const file = day + '-' + Math.min(day + 86400, until);
    const tmp = new URL(file + '.' + process.pid + '.tmp', dir);
    await fs.writeFile(tmp, JSON.stringify(rows));
    await fs.rename(tmp, new URL(file + '.json', dir));
    const hits = rows.filter((r) => r.first);
    console.log(
      file,
      rows.length,
      'windows',
      rows.filter((r) => r.excluded).length,
      'excluded',
      hits.length,
      'entries',
      hits.filter((r) => r.net < 0).length,
      'losses'
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
