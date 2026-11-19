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
export function auctionStudyHoldings(db) {
  return db.prepare(`SELECT strategy,ticker,side,SUM(quantity) AS quantity,SUM(price*quantity+fees) AS cost
    FROM paper WHERE payout IS NULL AND strategy IN ('art_record_pair','art_range_bids','art_withdrawn')
    GROUP BY strategy,ticker,side ORDER BY strategy,ticker,side`).all();
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
    const precision = ['art_record_pair','art_range_bids','art_withdrawn'].includes(position.strategy) ? 100 : 10000;
    const fee = Math.ceil(0.07 * n * price * (1 - price) * precision - 1e-9) / precision;
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

export function registerExitTrials(db, holdings, now) {
  const save=db.prepare('INSERT OR IGNORE INTO auction_exit_trials(id,strategy,registered,holdings) VALUES(?,?,?,?)');
  for (const p of holdings.filter(p=>p.strategy==='art_range_bids'))
    save.run(p.ticker,p.strategy,now,JSON.stringify([p]));
  for (const p of holdings.filter(p=>p.strategy==='art_withdrawn'))
    save.run(p.strategy+'/'+p.ticker,p.strategy,now,JSON.stringify([p]));
  const paired=holdings.filter(p=>p.strategy==='art_record_pair');
  const annual=paired.filter(p=>p.side==='yes');
  const lots=paired.filter(p=>p.side==='no');
  if (annual.length===1 && lots.length && annual[0].quantity===lots.reduce((n,p)=>n+p.quantity,0))
    save.run(annual[0].ticker,'art_record_pair',now,JSON.stringify(paired));
}

export function checkExitTrials(db, positions, first, second, tickers) {
  const asOf = r => Date.parse(r.httpDate)-1000*Number(r.cacheAge??0);
  if (!(asOf(second)>asOf(first)) || ![first,second].every(r=>
    asOf(r)>=r.receivedAt-3500 && asOf(r)<=r.receivedAt+1000)) return;
  for (const trial of db.prepare('SELECT * FROM auction_exit_trials WHERE soldAt IS NULL AND registered<=?').all(first.requestedAt)) {
    const held=JSON.parse(trial.holdings);
    // A single paired book request must cover all frozen legs while they are still open.
    if (!held.every(h=>tickers.includes(h.ticker) && positions.some(p=>p.strategy===h.strategy &&
      p.ticker===h.ticker && p.side===h.side && p.quantity>=h.quantity))) continue;
    const legs=held.map(h=>exitQuote(h,first.body.orderbooks.find(b=>b.ticker===h.ticker),
      second.body.orderbooks.find(b=>b.ticker===h.ticker)));
    if (!legs.every(l=>l.unpriced===0)) continue;
    const proceeds=legs.reduce((n,l)=>n+l.proceeds,0);
    const cost=held.reduce((n,h)=>n+h.cost,0);
    if (Math.round((proceeds-cost)*1e6)<=0) continue;
    db.prepare('UPDATE auction_exit_trials SET soldAt=?,proceeds=?,evidence=? WHERE id=? AND soldAt IS NULL')
      .run(second.receivedAt,proceeds,JSON.stringify({first:first.receivedAt,second:second.receivedAt,legs}),trial.id);
  }
}

export function exitTrialResults(db) {
  const settled=db.prepare('SELECT payout/quantity AS value FROM paper WHERE ticker=? AND side=? AND strategy=? AND payout IS NOT NULL AND quantity>0 LIMIT 1');
  return db.prepare('SELECT * FROM auction_exit_trials ORDER BY registered,id').all().map(trial=>{
    const held=JSON.parse(trial.holdings),cost=held.reduce((n,h)=>n+h.cost,0);
    const payouts=held.map(h=>settled.get(h.ticker,h.side,h.strategy)?.value);
    const heldNet=payouts.every(p=>p!=null) ? held.reduce((n,h,i)=>n+h.quantity*payouts[i],-cost) : null;
    return {id:trial.id,strategy:trial.strategy,registered:trial.registered,cost,soldAt:trial.soldAt,
      exitNet:trial.proceeds==null?null:trial.proceeds-cost,heldNet};
  });
}

export async function observeAuctionExits({ db, config, status, stop }) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS auction_exit_marks(ticker TEXT,side TEXT,at INTEGER,quantity INTEGER,cost REAL,detail TEXT,PRIMARY KEY(ticker,side,at))'
  );
  db.exec('CREATE TABLE IF NOT EXISTS auction_study_exits(strategy TEXT,ticker TEXT,side TEXT,at INTEGER,detail TEXT NOT NULL,PRIMARY KEY(strategy,ticker,side,at))');
  const holdings = () => [...auctionHoldings(db), ...auctionStudyHoldings(db)];
  const io = new Transport({
    ...config,
    maxHttpAgeSeconds: 2,
    requestTimeoutMs: 4000
  });
  while (!stop()) {
    const positions = holdings(),
      rows = [];
    registerExitTrials(db,positions,Date.now());
    try {
      if (positions.length) {
        const [fee, exchange] = await Promise.all([
          io.get('/series/KXART'),
          io.get('/exchange/status')
        ]);
        checkFees(fee.body);
        if (positions.some(p => p.ticker.startsWith('KXAUCTIONRECORD-'))) {
          const {series} = (await io.get('/series/KXAUCTIONRECORD')).body;
          if (series?.ticker !== 'KXAUCTIONRECORD' || series.fee_type !== 'quadratic' || series.fee_multiplier !== 1)
            throw Error('Artist-record exit fee needs review');
        }
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
          const stillOpen=active.filter(t=>checkMarketActive(listed.get(t),b.receivedAt));
          for (const p of positions.filter((p) => stillOpen.includes(p.ticker))) {
            const exit = exitQuote(
              p,
              first.get(p.ticker),
              second.get(p.ticker)
            );
            rows.push({ ...p, firstAt: a.receivedAt, at: b.receivedAt, exit });
          }
          checkExitTrials(db,holdings(),a,b,stillOpen);
        }
      }
      const current = holdings();
      const valid = rows.filter((r) =>
        current.some(
          (p) =>
            p.strategy === r.strategy && p.ticker === r.ticker &&
            p.side === r.side &&
            p.quantity === r.quantity &&
            p.cost === r.cost
        )
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of valid) {
          if (r.strategy) db.prepare('INSERT OR IGNORE INTO auction_study_exits VALUES(?,?,?,?,?)')
            .run(r.strategy,r.ticker,r.side,r.at,JSON.stringify(r));
          else db.prepare(
            'INSERT OR IGNORE INTO auction_exit_marks VALUES(?,?,?,?,?,?)'
          ).run(r.ticker, r.side, r.at, r.quantity, r.cost, JSON.stringify(r));
        }
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
