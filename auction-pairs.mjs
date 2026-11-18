import { setTimeout as sleep } from 'node:timers/promises';
import { askLevels } from './core.mjs';
import { Transport } from './transport.mjs';
import { addPaper } from './strategy-monitor.mjs';

export const pairSeries = {
  KXART: 'Auction',
  KXBTCD: 'Bitcoin price',
  KXETHD: 'Ethereum price'
};

// With the same lot, source, time and settlement terms, lower YES and higher
// NO pay at least one dollar together under ordinary binary settlement.
function rulesKey(m, now) {
  if (
    m.status !== 'active' ||
    m.result ||
    Date.parse(m.close_time) <= now ||
    !Object.hasOwn(pairSeries, m.event_ticker?.split('-')[0]) ||
    m.market_type !== 'binary' ||
    Number(m.notional_value_dollars) !== 1 ||
    m.strike_type !== 'greater' ||
    !m.rules_secondary
  )
    return null;
  const text = m.rules_primary ?? '';
  const matches = [
    ...text.matchAll(/\babove \$?([\d,]+(?:\.\d+)?)([KMB]?)\b/gi)
  ];
  if (matches.length !== 1) return null;
  const [label, number, scale] = matches[0];
  const threshold =
    Number(number.replaceAll(',', '')) *
    { '': 1, K: 1e3, M: 1e6, B: 1e9 }[scale.toUpperCase()];
  if (
    threshold !== m.floor_strike ||
    !Number.isFinite(Date.parse(m.close_time))
  )
    return null;
  return JSON.stringify([
    m.event_ticker,
    m.close_time,
    text.replace(label, 'above [threshold]'),
    m.rules_secondary
  ]);
}

export function ladderCandidates(markets, now) {
  const groups = new Map();
  for (const m of markets) {
    const key = rulesKey(m, now);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  let comparisons = 0;
  const pairs = [];
  for (const group of groups.values()) {
    for (const low of group)
      for (const high of group) {
        if (low.floor_strike >= high.floor_strike) continue;
        comparisons++;
        const yes = Number(low.yes_ask_dollars),
          no = Number(high.no_ask_dollars);
        if (yes > 0 && no > 0 && yes + no < 1)
          pairs.push({ low, high, cost: yes + no });
      }
  }
  return { comparisons, pairs: pairs.sort((a, b) => a.cost - b.cost) };
}

function fee(p) {
  return Math.ceil(0.07 * p * (1 - p) * 10000 - 1e-9) / 10000;
}
export function costedPair(books) {
  const legs = books.map((b, i) => {
    const side = i === 0 ? 'YES' : 'NO';
    const top = askLevels(b.body, side, 100)[0];
    if (!top || top.quantity < 1000000) return null;
    const price = top.price / 1000000;
    return {
      side: side.toLowerCase(),
      price,
      fees: fee(price),
      depth: top.quantity / 1000000
    };
  });
  if (legs.some((l) => !l)) return null;
  return legs.reduce(
    (n, l) => n + Math.round((l.price + l.fees) * 1000000),
    0
  ) < 1000000
    ? legs
    : null;
}

export async function observePairs({ db, config, stop, status, series }) {
  if (!Object.hasOwn(pairSeries, series))
    throw Error('Unknown threshold series');
  const io = new Transport({ ...config, maxHttpAgeSeconds: 2 });
  while (!stop()) {
    try {
      let markets = [],
        cursor = '',
        seen = new Set();
      do {
        const data = (
          await io.get(
            '/markets?series_ticker=' +
              series +
              '&status=open&limit=1000' +
              (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
          )
        ).body;
        markets.push(
          ...data.markets.filter((m) =>
            m.event_ticker?.startsWith(series + '-')
          )
        );
        cursor = data.cursor;
        if (cursor && seen.has(cursor)) throw Error('Repeated market cursor');
        seen.add(cursor);
      } while (cursor);
      const { comparisons, pairs } = ladderCandidates(markets, Date.now());
      Object.assign(status, {
        markets: markets.length,
        comparisons,
        candidates: pairs.length,
        error: null
      });
      if (pairs.length) {
        const schedule = (await io.get('/series/' + series)).body.series;
        if (
          schedule?.ticker !== series ||
          schedule.fee_type !== 'quadratic' ||
          schedule.fee_multiplier !== 1
        )
          throw Error('Fee schedule requires review');
        const exchange = (await io.get('/exchange/status')).body;
        if (!exchange.exchange_active || !exchange.trading_active)
          throw Error('Exchange paused');
      }
      for (const { low, high } of pairs) {
        if (stop()) return;
        const id =
          (series === 'KXART' ? 'auction-pair/' : 'crypto-pair/') +
          low.event_ticker +
          '/';
        if (db.prepare('SELECT 1 FROM paper WHERE id=?').get(id + 'yes'))
          continue;
        const tickers = [low.ticker, high.ticker];
        const books = () =>
          Promise.all(
            tickers.map((t) =>
              io.get(
                '/markets/' + encodeURIComponent(t) + '/orderbook?depth=100'
              )
            )
          );
        const first = await books();
        const firstLegs = costedPair(first);
        if (!firstLegs) continue;
        await sleep(1000);
        const listed = await Promise.all(
          tickers.map((t) => io.get('/markets/' + encodeURIComponent(t)))
        );
        if (
          listed.some(
            (r, i) =>
              r.body.market.ticker !== tickers[i] ||
              rulesKey(r.body.market, Date.now()) !==
                rulesKey(i === 0 ? low : high, Date.now()) ||
              !rulesKey(r.body.market, Date.now())
          )
        )
          continue;
        const second = await books();
        const legs = costedPair(second);
        if (
          !legs ||
          legs.some((l, i) => l.price > firstLegs[i].price) ||
          stop()
        )
          continue;
        const now = Date.now(),
          close = Date.parse(low.close_time);
        if (
          now >= close ||
          now - Math.min(...second.map((b) => b.requestedAt)) > 2000 ||
          Math.max(...first.map((b) => b.receivedAt)) -
            Math.min(...first.map((b) => b.requestedAt)) >
            2000
        )
          continue;
        db.exec('BEGIN IMMEDIATE');
        try {
          legs.forEach((leg, i) =>
            addPaper(db, {
              id: id + leg.side,
              strategy: series === 'KXART' ? 'auction_pair' : 'crypto_pair',
              ticker: tickers[i],
              at: new Date(now).toISOString(),
              quantity: 1,
              closeAt: close,
              ...leg
            })
          );
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
    } catch (e) {
      status.error = e.message;
    }
    status.at = new Date().toISOString();
    await sleep(30000);
  }
}
