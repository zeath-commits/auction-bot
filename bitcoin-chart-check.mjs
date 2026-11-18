import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { API } from './transport.mjs';
import { chartProjection, referencePrices } from './bitcoin-reference.mjs';

async function replay() {
  const root = fileURLToPath(new URL('./runtime/', import.meta.url));
  const source = path.join(root, 'holdout-ten');
  const output = path.join(root, 'chart-check');
  await fs.mkdir(output, { recursive: true });
  const dates = (await fs.readdir(source)).filter(f =>
    /^2026-\d\d-\d\d\.json$/.test(f) && f >= '2026-10-07' && f < '2026-11-11').sort();
  if (dates.length !== 35) throw Error('Expected October 7 through November 10 archives');
  const rows = [];
  const markets = new Map();
  let windows = 0;
  const candidates = [];
  for (const day of dates) {
    const archive = JSON.parse(await fs.readFile(path.join(source, day), 'utf8'));
    windows += archive.rows.length;
    for (const row of archive.rows)
      if (row.finalTen && row.finalTen.side === row.finalTen.taker && Number(row.finalTen.count) >= 1)
        candidates.push({...row, day: day.slice(0, 10)});
  }
  const saved = new Set(await fs.readdir(output));
  const missing = candidates.filter(r => !saved.has(r.ticker + '.json'));
  for (let i = 0; i < missing.length; i += 50) {
    const query = new URLSearchParams({tickers: missing.slice(i,i+50).map(r => r.ticker).join(','), limit: '1000'});
    const response = await fetch(API + '/markets?' + query, {signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw Error('Kalshi status ' + response.status);
    const page = await response.json();
    if (page.cursor) throw Error('Incomplete market response');
    for (const m of page.markets) markets.set(m.ticker, m);
  }
  for (const row of candidates) {
    const trade = row.finalTen;
    const file = path.join(output, row.ticker + '.json');
    let record;
    try {
      record = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const market = markets.get(row.ticker);
      if (!market) throw Error('Missing market ' + row.ticker);
      const close = Date.parse(market.close_time) / 1000;
      const at = Date.parse(trade.at) / 1000;
      if (market.ticker !== row.ticker || market.result !== row.result ||
          market.status !== 'finalized' || market.strike_type !== 'greater_or_equal' ||
          !(market.floor_strike > 0) || !market.rules_primary.includes('BRTI') ||
          !(at >= close - 10 && at < close)) throw Error('Market or trade identity mismatch');
      const ticks = await referencePrices(close - 60, close - 15);
      record = {ticker: row.ticker, close, strike: market.floor_strike, ticks: [...ticks], fetchedAt: new Date().toISOString()};
      const temp = file + '.' + process.pid + '.tmp';
      await fs.writeFile(temp, JSON.stringify(record));
      await fs.rename(temp, file);
      await sleep(180);
    }
    const forecast = chartProjection(new Map(record.ticks), record.close, record.strike);
    const fee = Math.ceil(0.07 * trade.price * (1 - trade.price) * 10000 - 1e-9) / 10000;
    rows.push({day: row.day, ticker: row.ticker, trade, result: row.result,
      forecast, passes: forecast !== null && forecast.side === trade.side && Math.abs(forecast.gapBps) >= 5,
      net: Number(trade.side === row.result) - trade.price - fee});
  }
  const summarize = a => ({entries: a.length, wins: a.filter(r => r.trade.side === r.result).length,
    net: Number(a.reduce((sum,r) => sum + r.net, 0).toFixed(4))});
  const summary = {windows, available: rows.filter(r => r.forecast).length,
    correctDirections: rows.filter(r => r.forecast?.side === r.result).length,
    all: summarize(rows), selected: summarize(rows.filter(r => r.passes)),
    other: summarize(rows.filter(r => !r.passes))};
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({summary, rows}, null, 2));
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await replay();
