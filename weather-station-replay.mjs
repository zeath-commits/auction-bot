import fs from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { stations, product, parseReport } from './weather-high.mjs';
import {
  stationMessages,
  stationEvidence,
  stationSupports
} from './weather-station.mjs';
const runtime = new URL('./runtime/', import.meta.url),
  data = JSON.parse(
    await fs.readFile(new URL('weather-high-replay.json', runtime))
  );
if (data.errors?.length) throw Error('Incomplete underlying weather replay');
const results = [];
const cache = new URL('weather-observations/', runtime);
await fs.mkdir(cache, { recursive: true });
async function cached(day, s) {
  const file = new URL(day.id + '.json.gz', cache);
  try {
    return JSON.parse(gunzipSync(await fs.readFile(file)));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (let i = 0; ; i++) {
    try {
      const doc = await product(day.id),
        x = await stationMessages(s, day.ts);
      if (!x.rows.length)
        throw Error('No archived observations for ' + day.event);
      const out = { doc, ...x },
        tmp = new URL(day.id + '.' + process.pid + '.tmp', cache);
      await fs.writeFile(tmp, gzipSync(JSON.stringify(out)));
      await fs.rename(tmp, file);
      return out;
    } catch (e) {
      if (i >= 3) throw Error(day.event + ': ' + e.message);
      await sleep(1500 * 2 ** i);
    }
  }
}

for (const day of data.days) {
  const s = stations.find((s) => s.cli === day.cli),
    { doc, url, rows } = await cached(day, s),
    r = parseReport(s, doc);
  if (!r || r.event !== day.event || r.high !== day.high)
    throw Error('Archived afternoon report changed');
  const evidence = stationEvidence(s, r, rows);
  const checks = day.rows.map((row) => ({
    ticker: row.ticker,
    outcome: row.outcome,
    sourceSupportsSide: row.sourceSupportsSide,
    printed: !!row.trade,
    supported: stationSupports(
      evidence,
      { strike_type: row.strike, floor_strike: row.floor, cap_strike: row.cap },
      row.side
    )
  }));
  results.push({
    event: r.event,
    cli: s.cli,
    issuedAt: r.issuedAt,
    peakAt: r.peakAt === null ? null : new Date(r.peakAt).toISOString(),
    reported: r.high,
    officialHigh: day.officialHigh,
    source: url,
    evidence,
    checks
  });
  await sleep(200);
}
const all = results.flatMap((r) => r.checks),
  support = all.filter((x) => x.supported);
const summary = {
  days: results.length,
  withMessages: results.filter((r) => r.evidence.observations > 0).length,
  peakTimesCovered: results.filter((r) => r.evidence.peakWindow !== null)
    .length,
  contradictions: results.filter((r) => r.evidence.contradicted).length,
  crossings: all.length,
  supported: support.length,
  finalized: support.filter((t) => t.outcome !== null).length,
  settlementDisagreements: support.filter((t) => t.outcome === false).length,
  qualifyingTradesOnSupportedThresholds: support.filter((x) => x.printed).length
};
await fs.writeFile(
  new URL('weather-station-replay.json', runtime),
  JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2)
);
console.log(
  JSON.stringify(summary),
  JSON.stringify(results.find((r) => r.event === 'KXHIGHNY-26NOV13'))
);
