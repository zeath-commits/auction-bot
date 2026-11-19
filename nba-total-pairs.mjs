import { setTimeout as sleep } from 'node:timers/promises';
import { askLevels, checkMarketActive, overlappingAskLevels } from './core.mjs';
import { totalMarkets } from './nba-total-queue.mjs';
import { Transport } from './transport.mjs';
import { addPaper } from './strategy-monitor.mjs';

const strategy = 'nba_total_pair';
const stamp = r => Date.parse(r.httpDate) - Number(r.cacheAge ?? 0) * 1000;
const fee = (p, n) => Math.ceil(.07 * n * p * (1 - p) * 10000 - 1e-9) / 10000;

function eventMarkets(event, now) {
  const code = /^KXNBATOTAL-(\d{2})([A-Z]{3})(\d{2})[A-Z]+$/.exec(event.event_ticker);
  if (!code) throw Error('Unknown NBA game date');
  const day = new Date(code[3] + ' ' + code[2] + ' 20' + code[1] + ' 12:00 GMT').toISOString().slice(0, 10);
  return totalMarkets(event, event.event_ticker, day).filter(m => checkMarketActive(m, now) && m.rules_secondary);
}

function compatible(low, high) {
  return low.event_ticker === high.event_ticker && low.floor_strike < high.floor_strike &&
    low.close_time === high.close_time && low.rules_secondary === high.rules_secondary &&
    low.rules_primary.replace('over ' + low.floor_strike + ' total', 'over # total') ===
    high.rules_primary.replace('over ' + high.floor_strike + ' total', 'over # total');
}

function booksByTicker(read, markets) {
  const books = new Map(read.body.orderbooks.map(b => [b.ticker, b]));
  if (books.size !== markets.length || read.body.orderbooks.length !== books.size || markets.some(m => !books.has(m.ticker)))
    throw Error('Incomplete NBA pair books');
  return books;
}

export function findTotalPair(markets, books) {
  const tops = markets.map(m => {
    const levels = side => askLevels(books.get(m.ticker), side, 100).find(l => l.quantity >= 1000000)?.price;
    return { m, yes: levels('YES'), no: levels('NO') };
  });
  let comparisons = 0, priced = 0, cheapest = Infinity, chosen = null;
  for (const low of tops) for (const high of tops) {
    if (!compatible(low.m, high.m)) continue;
    comparisons++;
    if (!low.yes || !high.no) continue;
    priced++;
    const cost = (low.yes + high.no) / 1000000;
    cheapest = Math.min(cheapest, cost);
    if (cost + .07 * (low.yes / 1e6 * (1 - low.yes / 1e6) + high.no / 1e6 * (1 - high.no / 1e6)) >= 1) continue;
    if (!chosen || cost < chosen.cost) chosen = { low: low.m, high: high.m, cost };
  }
  return { comparisons, priced, cheapest: Number.isFinite(cheapest) ? cheapest : null, chosen };
}

// Match equal quantities at price levels visible on both reads. Reserve both legs and
// fees together. Public book observations cannot establish atomic two-leg execution.
export function sizeTotalPair(first, second, pair, cash) {
  const tickers = [pair.low.ticker, pair.high.ticker];
  const levels = tickers.map((t, i) => overlappingAskLevels(first.get(t), second.get(t), i ? 'NO' : 'YES', 100).filter(l => l.quantity));
  const legs = tickers.map((ticker, i) => ({ ticker, side: i ? 'no' : 'yes', principal: 0, fees: 0 }));
  let quantity = 0, available = cash;
  for (let i = 0, j = 0; i < levels[0].length && j < levels[1].length;) {
    const a = levels[0][i], b = levels[1][j], unit = a.price + b.price;
    const afterFees = unit + .07 * (a.price * (1 - a.price) + b.price * (1 - b.price));
    if (afterFees >= 1) break;
    let n = Math.min(a.quantity, b.quantity, Math.floor((available + 1e-9) / afterFees));
    const cost = n => n * unit + fee(a.price, n) + fee(b.price, n);
    if (n > 0 && cost(n) > available + 1e-9) n--;
    if (n <= 0) break;
    if (cost(n) + 1e-9 < n) {
      quantity += n;
      for (const [k, l] of [a, b].entries()) {
        legs[k].principal += n * l.price;
        legs[k].fees += fee(l.price, n);
      }
      available -= cost(n);
    }
    a.quantity -= n; b.quantity -= n;
    if (!a.quantity) i++;
    if (!b.quantity) j++;
  }
  return { quantity, legs };
}

export async function observeTotalPairs({ db, config, status, stop }) {
  const io = new Transport({ ...config, maxHttpAgeSeconds: 2 });
  db.exec('CREATE TABLE IF NOT EXISTS nba_pair_scans(event TEXT PRIMARY KEY,scans INTEGER,priced INTEGER,signals INTEGER,confirmed INTEGER,lastAt INTEGER,minCost REAL,proof TEXT)');
  const save = db.prepare(`INSERT INTO nba_pair_scans VALUES(?,1,?,?,?, ?,?,?)
    ON CONFLICT(event) DO UPDATE SET scans=scans+1,priced=priced+excluded.priced,signals=signals+excluded.signals,
    confirmed=confirmed+excluded.confirmed,lastAt=excluded.lastAt,proof=COALESCE(excluded.proof,proof),
    minCost=CASE WHEN minCost IS NULL THEN excluded.minCost WHEN excluded.minCost IS NULL THEN minCost ELSE min(minCost,excluded.minCost) END`);
  const cash = db.prepare('SELECT 1000+COALESCE(SUM(COALESCE(payout,0)-price*quantity-fees),0) AS balance FROM paper WHERE strategy=?');
  const seen = db.prepare('SELECT 1 FROM paper WHERE id=?');
  const book = async markets => {
    const query = new URLSearchParams(markets.map(m => ['tickers', m.ticker]));
    query.set('depth', '100');
    const read = await io.get('/markets/orderbooks?' + query);
    if (!(stamp(read) >= read.receivedAt - 2500 && stamp(read) <= read.receivedAt + 1000 && read.receivedAt - read.requestedAt < 2500))
      throw Error('NBA pair book stale');
    return { read, books: booksByTicker(read, markets) };
  };
  while (!stop()) {
    let marketsSeen = 0, comparisons = 0, candidates = 0;
    const errors = [];
    try {
      let cursor = '';
      const cursors = new Set();
      do {
        const listing = await io.get('/events?series_ticker=KXNBATOTAL&status=open&with_nested_markets=true&limit=100' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        cursor = listing.body.cursor;
        if (cursor && cursors.has(cursor)) throw Error('Repeated NBA event cursor');
        cursors.add(cursor);
        for (const e of listing.body.events) {
          if (stop()) return;
          try {
            const ms = eventMarkets(e, Date.now());
            if (ms.length < 2) continue;
            const a = await book(ms);
            const { comparisons: count, priced, cheapest, chosen } = findTotalPair(ms, a.books);
            marketsSeen += ms.length; comparisons += count; candidates += Number(!!chosen);
            const prefix = 'nba-total-pair/' + e.event_ticker + '/';
            let modeled = null, proof = null;
            if (chosen && !seen.get(prefix + 'yes')) {
              const schedule = (await io.get('/series/KXNBATOTAL')).body.series;
              if (schedule?.ticker !== 'KXNBATOTAL' || !['quadratic', 'quadratic_with_maker_fees'].includes(schedule.fee_type) || schedule.fee_multiplier !== 1)
                throw Error('NBA pair fees changed');
              const exchange = (await io.get('/exchange/status')).body;
              if (exchange.exchange_active && exchange.trading_active) {
                await sleep(1200);
                const current = eventMarkets((await io.get('/events/' + e.event_ticker + '?with_nested_markets=true')).body.event, Date.now());
                const legs = [chosen.low, chosen.high];
                if (legs.every(m => current.some(c => c.ticker === m.ticker && c.rules_primary === m.rules_primary &&
                    c.rules_secondary === m.rules_secondary && c.close_time === m.close_time))) {
                  const b = await book(legs);
                  if (stamp(b.read) > stamp(a.read) && b.read.receivedAt - a.read.receivedAt <= 6000 &&
                      legs.every(m => checkMarketActive(m, b.read.receivedAt))) {
                    modeled = sizeTotalPair(a.books, b.books, chosen, cash.get(strategy).balance);
                    if (modeled.quantity) proof = JSON.stringify({ markets: legs.map(m => m.ticker),
                      books: [a, b].map(x => ({ at: x.read.receivedAt, server: stamp(x.read), legs: legs.map(m => x.books.get(m.ticker)) })) });
                  }
                }
              }
            }
            if (stop()) return;
            db.exec('BEGIN IMMEDIATE');
            try {
              if (modeled?.quantity && !seen.get(prefix + 'yes')) for (const leg of modeled.legs) addPaper(db, {
                id: prefix + leg.side, strategy, ticker: leg.ticker, side: leg.side, price: leg.principal / modeled.quantity,
                quantity: modeled.quantity, fees: leg.fees, depth: modeled.quantity, closeAt: Date.parse(chosen.low.close_time), at: new Date().toISOString()
              });
              save.run(e.event_ticker, priced, Number(!!chosen), Number(!!proof), Date.now(), cheapest, proof);
              db.exec('COMMIT');
            } catch (err) { db.exec('ROLLBACK'); throw err; }
          } catch (err) { errors.push(e.event_ticker + ' ' + err.message); }
          await sleep(200);
        }
      } while (cursor && !stop());
    } catch (err) { errors.push(err.message); }
    Object.assign(status, { markets: marketsSeen, comparisons, candidates, error: errors.length ? errors.slice(0, 2).join(', ') : null,
      at: new Date().toISOString(), coverage: db.prepare('SELECT COUNT(*) games,SUM(scans) scans,SUM(priced) priced,SUM(signals) signals,SUM(confirmed) confirmed,MIN(minCost) lowestBeforeFees FROM nba_pair_scans').get() });
    await sleep(30000);
  }
}
