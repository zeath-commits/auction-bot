import {setTimeout as sleep} from 'node:timers/promises';
import {captureAuctionQuotes} from './auction-quote-timing.mjs';

// Offsets are measured from our first receipt of the house's published result.
// Keep empty books and missed samples in the denominator.
const offsets = [0, 1200, 2100, 4000, 6500, 11000, 15000];
export function saleSampler({db, io, stop, status, now = Date.now, wait = sleep}) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_sale_samples(event TEXT, release INTEGER, offset INTEGER,
    amount REAL NOT NULL, state TEXT NOT NULL, sample TEXT, PRIMARY KEY(event,release,offset))`);
  const insert = db.prepare("INSERT OR IGNORE INTO auction_sale_samples VALUES(?,?,?,?,'pending',NULL)");
  const pending = db.prepare("SELECT offset FROM auction_sale_samples WHERE event=? AND release=? AND state='pending' ORDER BY offset");
  const save = db.prepare("UPDATE auction_sale_samples SET state=?,sample=? WHERE event=? AND release=? AND offset=? AND state='pending'");
  db.prepare("UPDATE auction_sale_samples SET state='Interrupted before capture' WHERE state='pending' AND release<?").run(now()-18000);
  const active = new Map();
  const summary = db.prepare('SELECT state,COUNT(*) AS n FROM auction_sale_samples GROUP BY state');
  const conflict = db.prepare("SELECT 1 FROM auction_source_signals WHERE event=? AND (kind!='published_sale' OR amount IS NOT ?) LIMIT 1");
  function refresh() {
    status.releaseSampling = {offsetsMs: offsets, observations: Object.fromEntries(summary.all().map(r=>[r.state,r.n]))};
  }
  refresh();
  async function capture(target, release, amount, offset, marketsPromise) {
    const due = release + offset;
    let state, sample;
    try {
      if (now()<due) await wait(due-now());
      const markets = await marketsPromise;
      if (stop()) state = 'Stopped before capture';
      else if (now()>due+750) state = 'Sampling window missed';
      else if (markets.length!==target.markets.length) state = 'Incomplete active markets';
      else {
        const frame = await captureAuctionQuotes(io, markets);
        if (!frame || frame.rows.length!==target.markets.length) state = 'Incomplete active books';
        else {
          sample = JSON.stringify(frame);
          if (conflict.get(target.event,amount)) state = 'Conflicting house results';
          else state = frame.asOf>=release ? 'Observed' : 'Book timestamp overlaps release';
        }
      }
    } catch (e) {state = 'Read failed: '+e.message;}
    save.run(state,sample??null,target.event,release,offset);
    refresh();
  }
  function start(target, release, amount, marketsPromise) {
    const key = target.event+'/'+release;
    if (stop() || now()-release>18000 || active.has(key)) return;
    for (const offset of offsets) insert.run(target.event,release,offset,amount);
    const tasks = pending.all(target.event,release);
    if (!tasks.length) return;
    const job = Promise.allSettled(tasks.map(r=>capture(target,release,amount,r.offset,marketsPromise)))
      .then(results=>{
        const failed=results.find(r=>r.status==='rejected');
        if(failed)status.releaseSamplingError=String(failed.reason);
      }).finally(()=>active.delete(key));
    active.set(key,job);
  }
  return {start, drain:()=>Promise.all(active.values())};
}
