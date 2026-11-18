import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { checkFees, checkMarketActive, decimal, MICRO } from './core.mjs';

const strategies = ['late_auction', 'sale_depth', 'sothebys_sold'];
const startingCash = 1000;

export function auctionPortfolio(db) {
  const s = db
    .prepare(
      `SELECT
    COALESCE(SUM(price*quantity+fees) FILTER(WHERE payout IS NULL),0) AS openCost,
    COALESCE(SUM(payout-price*quantity-fees) FILTER(WHERE payout IS NOT NULL),0) AS settledNet,
    COALESCE(SUM(quantity) FILTER(WHERE payout IS NULL),0) AS openQuantity,
    COALESCE(SUM(quantity) FILTER(WHERE payout IS NOT NULL),0) AS settledQuantity
    FROM paper WHERE strategy IN (?,?,?)`
    )
    .get(...strategies);
  return { startingCash, ...s, cash: startingCash + s.settledNet - s.openCost };
}
export function auctionHoldings(db) {
  return db
    .prepare(
      `SELECT ticker,side,SUM(quantity) AS quantity,SUM(price*quantity+fees) AS cost
    FROM paper WHERE payout IS NULL AND strategy IN (?,?,?) GROUP BY ticker,side ORDER BY ticker,side`
    )
    .all(...strategies);
}
function bids(book, side) {
  const list = book?.orderbook_fp?.[side + '_dollars'];
  if (!Array.isArray(list)) throw Error('Missing bids for held side');
  const levels = new Map();
  for (const [p, q] of list) {
    const price = decimal(p),
      quantity = decimal(q);
    if (price <= 0 || price >= MICRO || levels.has(price))
      throw Error('Invalid or duplicate exit price');
    levels.set(price, quantity);
  }
  return levels;
}
export function exitQuote(position, first, second) {
  const a = bids(first, position.side),
    b = bids(second, position.side);
  let quantity = 0,
    gross = 0,
    fees = 0;
  const levels = [];
  for (const [p, q] of [...b].sort(([x], [y]) => y - x)) {
    const n = Math.min(
      position.quantity - quantity,
      Math.floor(Math.min(a.get(p) ?? 0, q) / MICRO)
    );
    if (n <= 0) continue;
    const price = p / MICRO;
    const fee =
      Math.ceil(0.07 * n * price * (1 - price) * 10000 - 1e-9) / 10000;
    if (n * price <= fee) continue;
    levels.push({ price, quantity: n, fee });
    quantity += n;
    gross += n * price;
    fees += fee;
    if (quantity === position.quantity) break;
  }
  return {
    quantity,
    unpriced: position.quantity - quantity,
    proceeds: gross - fees,
    fees,
    levels,
    netIfFullySold:
      quantity === position.quantity ? gross - fees - position.cost : null
  };
}
export async function observeAuctionExits({ db, config, status, stop }) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS auction_exit_marks(ticker TEXT,side TEXT,at INTEGER,quantity INTEGER,cost REAL,detail TEXT,PRIMARY KEY(ticker,side,at))'
  );
  const io = new Transport({
    ...config,
    maxHttpAgeSeconds: 2,
    requestTimeoutMs: 4000
  });
  while (!stop()) {
    const positions = auctionHoldings(db),
      rows = [];
    try {
      if (positions.length) {
        const [fee, exchange] = await Promise.all([
          io.get('/series/KXART'),
          io.get('/exchange/status')
        ]);
        checkFees(fee.body);
        if (!exchange.body.trading_active || !exchange.body.exchange_active)
          throw Error('Exchange unavailable');
        const instruments = [...new Set(positions.map((p) => p.ticker))];
        for (let i = 0; i < instruments.length; i += 40) {
          const tickers = instruments.slice(i, i + 40);
          const listing = (
            await io.get(
              '/markets?limit=1000&tickers=' +
                encodeURIComponent(tickers.join(','))
            )
          ).body.markets;
          const listed = new Map(listing.map((m) => [m.ticker, m]));
          if (tickers.some((t) => !listed.has(t)))
            throw Error('Incomplete auction market status');
          const active = tickers.filter((t) =>
            checkMarketActive(listed.get(t), Date.now())
          );
          if (!active.length) continue;
          const q = new URLSearchParams(active.map((t) => ['tickers', t]));
          q.set('depth', '100');
          const route = '/markets/orderbooks?' + q;
          const a = await io.get(route);
          await sleep(1000);
          const b = await io.get(route);
          if (stop()) return;
          if (
            b.receivedAt - a.requestedAt > 5500 ||
            a.receivedAt - a.requestedAt > 2000 ||
            b.receivedAt - b.requestedAt > 2000
          )
            throw Error('Quote check exceeded time window');
          const first = new Map(a.body.orderbooks.map((x) => [x.ticker, x])),
            second = new Map(b.body.orderbooks.map((x) => [x.ticker, x]));
          for (const p of positions.filter((p) => active.includes(p.ticker))) {
            if (!checkMarketActive(listed.get(p.ticker), b.receivedAt))
              continue;
            const exit = exitQuote(
              p,
              first.get(p.ticker),
              second.get(p.ticker)
            );
            rows.push({ ...p, firstAt: a.receivedAt, at: b.receivedAt, exit });
          }
        }
      }
      const current = auctionHoldings(db);
      const valid = rows.filter((r) =>
        current.some(
          (p) =>
            p.ticker === r.ticker &&
            p.side === r.side &&
            p.quantity === r.quantity &&
            p.cost === r.cost
        )
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of valid)
          db.prepare(
            'INSERT OR IGNORE INTO auction_exit_marks VALUES(?,?,?,?,?,?)'
          ).run(r.ticker, r.side, r.at, r.quantity, r.cost, JSON.stringify(r));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      Object.assign(status, { at: Date.now(), rows: valid, error: null });
    } catch (e) {
      Object.assign(status, { at: Date.now(), rows: [], error: e.message });
    }
    await sleep(60000);
  }
}
