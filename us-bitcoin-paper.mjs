import { setTimeout as sleep } from 'node:timers/promises';
import { usSlug, usPublic, openingTerms, readClosingMargin, marginAllows } from './bitcoin-reference.mjs';
import { Transport } from './transport.mjs';
import { askLevels } from './core.mjs';
import { addPaper } from './strategy-monitor.mjs';

const single = 'us_btc10',
  paired = 'cross_us_btc',
  middle = 'cross_us_middle',
  units = 10;
function nearestCent(x) {
  const cents = x * 100,
    floor = Math.floor(cents);
  if (Math.abs(cents - floor - 0.5) < 1e-9) return (floor + (floor % 2)) / 100;
  return Math.round(cents) / 100;
}

export function usAsks(book, slug) {
  if (book?.marketSlug !== slug || book.state !== 'MARKET_STATE_OPEN')
    return null;
  const result = {};
  for (const [side, levels] of [
    ['yes', book.offers],
    ['no', book.bids]
  ]) {
    if (!Array.isArray(levels)) return null;
    const valid = levels
      .filter(
        (l) =>
          l.px?.currency === 'USD' &&
          Number(l.qty) > 0 &&
          Number(l.px.value) > 0 &&
          Number(l.px.value) < 1
      )
      .map((l) => ({
        price:
          side === 'yes'
            ? Number(l.px.value)
            : Math.round((1 - Number(l.px.value)) * 10000) / 10000,
        size: Number(l.qty)
      }))
      .sort((a, b) => a.price - b.price);
    result[side] = valid[0];
  }
  return result;
}
function kAsks(book) {
  const result = {};
  for (const side of ['yes', 'no']) {
    const best = askLevels(book, side.toUpperCase(), 100)[0];
    if (best)
      result[side] = { price: best.price / 1e6, size: best.quantity / 1e6 };
  }
  return result;
}
function usLeg(side, q, quantity, rate, ticker) {
  return {
    side,
    price: q.price,
    depth: q.size,
    quantity,
    fees: nearestCent(rate * quantity * q.price * (1 - q.price)),
    ticker
  };
}
export function boundedPair(us, k, usStrike, kStrike, rate, slug, ticker) {
  if (
    !us ||
    !k ||
    ![usStrike, kStrike].every((n) => Number.isFinite(n) && n > 0) ||
    Math.abs(usStrike - kStrike) < 0.019999 ||
    !Number.isFinite(rate) ||
    rate < 0
  )
    return null;
  const side = usStrike < kStrike ? 'yes' : 'no',
    other = side === 'yes' ? 'no' : 'yes';
  const a = us[side],
    b = k[other];
  if (!a || !b || a.size < units || b.size < units) return null;
  const pm = usLeg(side, a, units, rate, slug);
  const ks = {
    ticker,
    side: other,
    price: b.price,
    depth: b.size,
    quantity: units,
    fees:
      Math.ceil(0.07 * units * b.price * (1 - b.price) * 10000 - 1e-9) / 10000
  };
  return {
    legs: [pm, ks],
    cost: units * (pm.price + ks.price) + pm.fees + ks.fees
  };
}
function eligibleSingle(book, rate, slug) {
  if (!book) return null;
  const sides = ['yes', 'no'].filter(
    (s) => book[s]?.size >= 1 && [0.98, 0.99].includes(book[s].price)
  );
  return sides.length === 1
    ? usLeg(sides[0], book[sides[0]], 1, rate, slug)
    : null;
}
export function pairStrategy(snapshot, start, gapBps) {
  const cost = snapshot?.pair?.cost;
  if (!(cost > 0)) return null;
  if (cost < units) return paired;
  if (
    gapBps >= 20 &&
    snapshot.begin >= start * 1000 &&
    snapshot.finish < start * 1000 + 30000 &&
    cost <= 1.3 * units
  )
    return middle;
  return null;
}
async function settleUS(db) {
  const pending = db
    .prepare(
      "SELECT DISTINCT ticker,closeAt FROM paper WHERE ticker LIKE 'cpc-btc-updown-5m-%' AND payout IS NULL AND closeAt<=? ORDER BY closeAt LIMIT 20"
    )
    .all(Date.now());
  for (const row of pending) {
    const m = (await usPublic('/v1/market/slug/' + row.ticker)).market;
    const terms = openingTerms(m, row.closeAt / 1000 - 300);
    if (
      !terms ||
      m.status !== 'MARKET_STATUS_RESOLVED' ||
      terms.settlementPrice?.currency !== 'USD'
    )
      continue;
    const value = Number(terms.settlementPrice.value);
    if (!(value > 0)) continue;
    const win = value >= Number(terms.priceToBeat.value) ? 'yes' : 'no';
    const outcomes = JSON.parse(m.outcomes),
      prices = JSON.parse(m.outcomePrices).map(Number);
    if (
      prices.length !== 2 ||
      prices.filter((p) => p === 1).length !== 1 ||
      !prices.includes(0) ||
      outcomes[prices.indexOf(1)]?.toLowerCase() !== win
    )
      continue;
    db.prepare(
      'UPDATE paper SET payout=CASE WHEN side=? THEN quantity ELSE 0 END,result=? WHERE ticker=? AND payout IS NULL'
    ).run(win, win, row.ticker);
  }
}
async function pairMarket(io, end) {
  const [markets, fee] = await Promise.all([
    io.get('/markets?series_ticker=KXBTC15M&status=open&limit=50'),
    io.get('/series/KXBTC15M')
  ]);
  const s = fee.body.series;
  if (
    s.ticker !== 'KXBTC15M' ||
    s.fee_type !== 'quadratic' ||
    s.fee_multiplier !== 1
  )
    return null;
  return (
    markets.body.markets.find(
      (m) =>
        m.ticker.startsWith('KXBTC15M-') &&
        m.status === 'active' &&
        m.strike_type === 'greater_or_equal' &&
        Date.parse(m.close_time) === end * 1000 &&
        Date.parse(m.open_time) === (end - 900) * 1000 &&
        m.rules_primary.includes('BRTI') &&
        m.rules_primary.includes('simple average of the sixty seconds') &&
        m.rules_primary.includes('at least')
    ) ?? null
  );
}
export async function observeUS({ db, config, stop, status }) {
  status.stale = 0;
  db.exec(
    'CREATE TABLE IF NOT EXISTS us_samples(slug TEXT PRIMARY KEY, closeAt INTEGER, checks INTEGER DEFAULT 0, last10 INTEGER DEFAULT 0, pairChecks INTEGER DEFAULT 0, minCost REAL)'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS us_middle_windows(slug TEXT PRIMARY KEY, gapBps REAL NOT NULL, priced INTEGER DEFAULT 0, bestCost REAL)'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS us_closing_windows(slug TEXT PRIMARY KEY, closeAt INTEGER NOT NULL, attempts INTEGER DEFAULT 0, usable INTEGER DEFAULT 0)'
  );
  const watchClose = db.prepare(
      'INSERT OR IGNORE INTO us_closing_windows(slug,closeAt) VALUES(?,?)'
    ),
    tryClose = db.prepare(
      'UPDATE us_closing_windows SET attempts=attempts+1 WHERE slug=?'
    ),
    sawClose = db.prepare(
      'UPDATE us_closing_windows SET usable=usable+1 WHERE slug=?'
    );
  const log =
    db.prepare(`INSERT INTO us_samples VALUES(?,?,1,?,?,?) ON CONFLICT(slug) DO UPDATE SET
    checks=checks+1,last10=last10+excluded.last10,pairChecks=pairChecks+excluded.pairChecks,
    minCost=CASE WHEN excluded.minCost IS NULL THEN minCost WHEN minCost IS NULL THEN excluded.minCost ELSE min(minCost,excluded.minCost) END`);
  const io = new Transport({ ...config, maxHttpAgeSeconds: 2 });
  let cached = null,
    limitBackoff = 0,
    lastSettlement = 0;
  while (!stop()) {
    let delay = 2000;
    try {
      const now = Date.now(),
        start = Math.floor(now / 300000) * 300,
        end = start + 300,
        slug = usSlug(start);
      const aligned = end % 900 === 0;
      if (!cached || cached.start !== start) {
        watchClose.run(slug, end * 1000);
        const m = (await usPublic('/v1/market/slug/' + slug)).market,
          terms = openingTerms(m, start);
        if (
          !terms ||
          m.status !== 'MARKET_STATUS_OPEN' ||
          m.feeCoefficient !== 0.095
        )
          throw Error('US listing, rules or fee awaiting verification');
        cached = {
          start,
          slug,
          rate: m.feeCoefficient,
          strike: Number(terms.priceToBeat.value),
          k: null,
          nextKalshi: 0
        };
        status.kalshiError = null;
      }
      if (
        aligned &&
        !cached.k &&
        now >= cached.nextKalshi &&
        end * 1000 - now > 14000
      ) {
        cached.nextKalshi = now + 10000;
        const k = await pairMarket(io, end).catch((e) => {
          status.kalshiError = e.message;
          return null;
        });
        if (k) {
          cached.k = k;
          status.kalshiError = null;
          cached.gapBps =
            (10000 * Math.abs(cached.strike - k.floor_strike)) / k.floor_strike;
          if (
            Number.isFinite(cached.gapBps) &&
            k.floor_strike > 0 &&
            Date.now() < start * 1000 + 30000
          )
            db.prepare(
              'INSERT OR IGNORE INTO us_middle_windows(slug,gapBps) VALUES(?,?)'
            ).run(slug, cached.gapBps);
        }
      }
      const left = end * 1000 - Date.now(),
        { k, rate, strike } = cached;
      Object.assign(status, {
        slug,
        close: new Date(end * 1000).toISOString(),
        aligned,
        error: null
      });
      if (left > 14000 && Date.now() - lastSettlement > 60000) {
        await settleUS(db);
        lastSettlement = Date.now();
      }
      if (!aligned && left > 10000) {
        delay = Math.min(12000, Math.max(250, left - 10000));
        status.state = 'Waiting for final ten seconds';
      } else {
        const snapshot = async () => {
          const begin = Date.now();
          const inClosingWindow =
            begin >= end * 1000 - 10000 && begin < end * 1000;
          if (inClosingWindow) tryClose.run(slug);
          const [pb, kb] = await Promise.all([
            usPublic('/v1/markets/' + slug + '/book'),
            k
              ? io.get('/markets/' + k.ticker + '/orderbook?depth=100').then(
                  (r) => {
                    status.kalshiError = null;
                    return r;
                  },
                  (e) => {
                    status.kalshiError = e.message;
                    return null;
                  }
                )
              : null
          ]);
          const finish = Date.now();
          const bookTime = Date.parse(pb.marketData?.transactTime);
          if (
            finish >= end * 1000 ||
            finish - begin > 1500 ||
            !Number.isFinite(bookTime) ||
            finish - bookTime > 3000 ||
            bookTime > finish + 500
          ) {
            status.stale++;
            return null;
          }
          const us = usAsks(pb.marketData, slug);
          if (!us) return null;
          if (inClosingWindow) sawClose.run(slug);
          return {
            begin,
            finish,
            bookTime,
            one:
              begin >= end * 1000 - 10000
                ? eligibleSingle(us, rate, slug)
                : null,
            pair: kb
              ? boundedPair(
                  us,
                  kAsks(kb.body),
                  strike,
                  k.floor_strike,
                  rate,
                  slug,
                  k.ticker
                )
              : null
          };
        };
        const a = await snapshot();
        limitBackoff = 0;
        if (a) {
          const inside = a.begin >= end * 1000 - 10000;
          log.run(
            slug,
            end * 1000,
            Number(inside),
            Number(Boolean(a.pair)),
            a.pair?.cost ?? null
          );
          if (a.pair && cached.gapBps >= 20 && a.finish < start * 1000 + 30000)
            db.prepare(
              'UPDATE us_middle_windows SET priced=priced+1, bestCost=min(COALESCE(bestCost,?),?) WHERE slug=?'
            ).run(a.pair.cost, a.pair.cost, slug);
          const firstStrategy = pairStrategy(a, start, cached.gapBps);
          if (a.one || firstStrategy) {
            const [margin]=await Promise.all([a.one ? readClosingMargin(end*1000,strike).catch(()=>null) : null,sleep(1000)]);
            const b = await snapshot();
            if (b && b.bookTime > a.bookTime && !stop()) {
              const at = new Date(b.finish).toISOString(),
                closeAt = end * 1000;
              if (
                a.one &&
                b.one?.side === a.one.side &&
                b.one.price <= a.one.price &&
                marginAllows(margin,b.one.side,closeAt,strike,b.begin,b.finish)
              )
                addPaper(db, {
                  id: single + '/' + slug,
                  strategy: single,
                  at,
                  closeAt,
                  ...b.one,
                  depth: Math.min(a.one.depth, b.one.depth)
                });
              if (
                firstStrategy &&
                firstStrategy === pairStrategy(b, start, cached.gapBps) &&
                b.pair.legs.every(
                  (l, i) =>
                    l.side === a.pair.legs[i].side &&
                    l.price <= a.pair.legs[i].price
                )
              ) {
                db.exec('BEGIN IMMEDIATE');
                try {
                  b.pair.legs.forEach((leg, i) =>
                    addPaper(db, {
                      id:
                        (firstStrategy === paired
                          ? 'cross-us/'
                          : 'cross-middle/') +
                        slug +
                        '/' +
                        leg.side,
                      strategy: firstStrategy,
                      at,
                      closeAt,
                      ...leg,
                      depth: Math.min(a.pair.legs[i].depth, leg.depth)
                    })
                  );
                  db.exec('COMMIT');
                } catch (e) {
                  db.exec('ROLLBACK');
                  throw e;
                }
              }
            }
          }
        }
        status.state = aligned
          ? 'Checking both venues'
          : 'Checking US closing book';
        delay = left <= 12000 ? 250 : 3000;
      }
    } catch (e) {
      if (
        [
          'Cached US book exceeded one second',
          'Cached response too old'
        ].includes(e.message)
      )
        status.stale++;
      status.state = 'Retrying public data';
      status.error = e.message;
      delay = 2000;
      if (e.status === 429) {
        limitBackoff = Math.min(120000, Math.max(10000, limitBackoff * 2));
        delay = Math.max(limitBackoff, e.retryAfterMs || 0);
        status.error += ' · retry after ' + Math.ceil(delay / 1000) + 's';
      }
    }
    status.at = new Date().toISOString();
    await sleep(delay);
  }
}
