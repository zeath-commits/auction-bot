import fs from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {stations, eventMarkets, officialPayout, weatherBuys} from './weather-high.mjs';
import {threeOClock, threeSignals, beforeThreeCrossings} from './weather-three.mjs';

const root = new URL('./runtime/', import.meta.url);
const history = JSON.parse(await fs.readFile(new URL('weather-high-replay.json', root)));
if (history.errors.length || history.days.length !== 28) throw Error('Incomplete seven-day climate archive');
const early = process.argv.includes('--first-crossing');
const folder = new URL(early ? 'weather-first-crossing/' : 'weather-three-replay/', root);
await fs.mkdir(folder, {recursive:true});
const days = [];
for (const day of history.days) {
  const station = stations.find(s => s.cli === day.cli);
  const window = threeOClock(station, day.ts);
  if (window.event !== day.event) throw Error('Climate day mismatch');
  const file = new URL(day.event + '.json', folder);
  let result;
  try {
    result = JSON.parse(await fs.readFile(file));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const archive = new URL('weather-observations/' + day.id + '.json.gz', root);
    const {rows} = JSON.parse(gunzipSync(await fs.readFile(archive)));
    const markets = await eventMarkets(station, window);
    const checked = threeSignals(station, window, rows, markets, window.start + 60000);
    const candidates = early ? beforeThreeCrossings(station,window,rows,markets)
      : checked.signals.map(signal => ({...signal,window}));
    result = {event: day.event, cli: station.cli, entries: []};
    for (const {m,side,window:sourceWindow} of candidates) {
        const from = Math.max(sourceWindow.start + 60000, Date.parse(m.open_time));
        const stop = Math.min(day.ts, sourceWindow.end);
        if (from >= stop) continue;
        const tape = await weatherBuys(m.ticker, side, from, Math.min(stop, Date.parse(m.close_time)));
        const first = tape.find(t => threeSignals(station,sourceWindow,rows,[m],Date.parse(t.at)).signals.length);
        const payout = officialPayout(m, side);
        const fee = first ? Math.ceil(0.07 * first.price * (1-first.price) * 10000 - 1e-9) / 10000 : null;
        result.entries.push({ticker:m.ticker, side, from, stop, payout, first: first ?? null, fee,
          net: first && payout !== null ? payout - first.price - fee : null});
    }
    const tmp = new URL(day.event + '.' + process.pid + '.tmp', folder);
    await fs.writeFile(tmp, JSON.stringify(result));
    await fs.rename(tmp, file);
  }
  days.push(result);
}
const entries = days.flatMap(d => d.entries);
const buys = entries.filter(r => r.first);
console.log(JSON.stringify({days:days.length, thresholds:entries.length, finalized:entries.filter(r => r.payout!==null).length,
  wrong:entries.filter(r => r.payout===0).length, printed:buys.length, printedEvents:days.filter(d => d.entries.some(r => r.first)).length,
  settledBuys:buys.filter(r => r.net!==null).length, net:buys.reduce((s,r) => s+(r.net??0),0)}));
