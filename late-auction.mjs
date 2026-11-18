import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import {
  askLevels,
  checkEvent,
  checkFees,
  checkMarketActive
} from './core.mjs';
import { catalogue, evidence, offerSide } from './watch-offers.mjs';
import { verifyTerms } from './paper-unsold.mjs';
import { addPaper } from './strategy-monitor.mjs';

const scale = 1000000;
const portfolio = 1000;
const strategy = 'late_auction';
function charge(price, quantity) {
  return (
    Math.ceil(0.07 * quantity * price * (1 - price) * 10000 - 1e-9) / 10000
  );
}

// Use whole contracts and take only volume visible at the same price on
// both reads. The exchange does not disclose queue identities in this feed.
export function persistentOffer(first, second, side, cash) {
  const original = new Map(
    askLevels(first, side, 99).map((l) => [l.price, l.quantity])
  );
  let quantity = 0,
    principal = 0,
    fees = 0,
    displayed = 0;
  const levels = [];
  for (const level of askLevels(second, side, 99)) {
    const price = level.price / scale;
    const depth = Math.floor(
      Math.min(original.get(level.price) ?? 0, level.quantity) / scale
    );
    displayed += depth;
    const available = cash - principal - fees;
    const unit = price + 0.07 * price * (1 - price);
    let count = Math.min(depth, Math.floor((available + 1e-10) / unit));
    if (count > 0 && count * price + charge(price, count) > available + 1e-9)
      count--;
    if (count <= 0) continue;
    const fee = charge(price, count);
    if (count * (1 - price) <= fee) continue;
    levels.push({ price, quantity: count, fee });
    quantity += count;
    principal += count * price;
    fees += fee;
  }
  return quantity
    ? { quantity, price: principal / quantity, fees, levels, displayed }
    : null;
}

async function books(io, markets) {
  const result = new Map();
  for (let i = 0; i < markets.length; i += 50) {
    const group = markets.slice(i, i + 50);
    const query = new URLSearchParams(group.map((m) => ['tickers', m.ticker]));
    query.set('depth', '100');
    const read = await io.get('/markets/orderbooks?' + query);
    const returned = new Map(read.body.orderbooks.map((b) => [b.ticker, b]));
    for (const m of group) {
      if (!returned.has(m.ticker))
        throw Error('Missing book in batch response');
      result.set(m.ticker, { ...read, body: returned.get(m.ticker) });
    }
  }
  return result;
}

async function scan({ db, io, auctions, config, stop, status }) {
  const open = new Set();
  let cursor = '';
  const seen = new Set();
  do {
    const page = (
      await io.get(
        '/markets?status=open&series_ticker=KXART&limit=1000' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      )
    ).body;
    for (const m of page.markets) open.add(m.ticker);
    cursor = page.cursor;
    if (cursor && seen.has(cursor)) throw Error('Repeated market cursor');
    seen.add(cursor);
  } while (cursor);
  const totals = {
    matched: 0,
    books: 0,
    quoted: 0,
    sourceErrors: 0,
    newEntries: 0
  };
  const already = db.prepare('SELECT 1 FROM paper WHERE id=?');
  for (const auction of auctions) {
    if (
      Date.now() <
      Date.parse(auction.deadline) + config.offerTailHours * 3600000
    )
      continue;
    const targets = auction.targets.filter((t) =>
      t.markets.some((m) => open.has(m.ticker))
    );
    if (!targets.length) continue;
    const src = await catalogue(io, auction);
    for (const target of targets) {
      if (stop()) return;
      let sig;
      try {
        sig = await evidence(io, auction, target, src);
      } catch {
        totals.sourceErrors++;
        continue;
      }
      if (!['published_sale', 'unsold'].includes(sig?.kind)) continue;
      const current = async () =>
        checkEvent(
          (
            await io.get(
              '/events/' + target.event + '?with_nested_markets=true'
            )
          ).body,
          target
        ).filter((m) => checkMarketActive(m, Date.now()));
      const markets = await current();
      totals.matched += markets.length;
      if (!markets.length) continue;
      const first = await books(io, markets);
      totals.books += first.size;
      const offers = markets.filter((m) => {
        const side = offerSide(sig, m.floor_strike),
          b = first.get(m.ticker).body;
        return side && askLevels(b, side, 99).some((l) => l.quantity >= scale);
      });
      totals.quoted += offers.length;
      const pending = offers.filter(
        (m) => !already.get(strategy + '/' + m.ticker)
      );
      if (!pending.length) continue;
      // Trade-date status and rule verification apply to the entire batch.
      if (sig.kind === 'unsold') await verifyTerms(io);
      else checkFees((await io.get('/series/KXART')).body);
      const ex = (await io.get('/exchange/status')).body;
      if (!ex.trading_active || !ex.exchange_active) continue;
      await sleep(1000);
      const confirmed = await evidence(
        io,
        auction,
        target,
        await catalogue(io, auction)
      );
      if (confirmed?.kind !== sig.kind || confirmed.amount !== sig.amount)
        continue;
      const active = new Set((await current()).map((m) => m.ticker));
      const second = await books(
        io,
        pending.filter((m) => active.has(m.ticker))
      );
      for (const m of pending) {
        const read = second.get(m.ticker);
        if (
          !read ||
          stop() ||
          !checkMarketActive(m, Date.now()) ||
          Date.now() - confirmed.requestedAt > config.maxSourceAgeMs ||
          Date.now() - read.requestedAt > config.maxQuoteAgeMs ||
          first.get(m.ticker).receivedAt - first.get(m.ticker).requestedAt >
            config.maxQuoteAgeMs ||
          read.requestedAt - first.get(m.ticker).receivedAt >
            config.maxSourceAgeMs
        )
          continue;
        const id = strategy + '/' + m.ticker,
          side = offerSide(confirmed, m.floor_strike);
        db.exec('BEGIN IMMEDIATE');
        try {
          const { spent } = db
            .prepare(
              'SELECT COALESCE(SUM(price*quantity+fees-COALESCE(payout,0)),0) AS spent FROM paper WHERE strategy=?'
            )
            .get(strategy);
          const q = persistentOffer(
            first.get(m.ticker).body,
            read.body,
            side,
            portfolio - spent
          );
          if (q && !already.get(id)) {
            addPaper(db, {
              id,
              strategy,
              ticker: m.ticker,
              side: side.toLowerCase(),
              at: new Date(read.receivedAt).toISOString(),
              quantity: q.quantity,
              price: q.price,
              fees: q.fees,
              depth: q.displayed,
              closeAt: Date.parse(m.close_time)
            });
            const detail = {
              source: confirmed.url,
              kind: sig.kind,
              amount: sig.amount,
              sourceCheckedAt: confirmed.requestedAt,
              firstBookAt: first.get(m.ticker).receivedAt,
              secondBookAt: read.receivedAt,
              levels: q.levels
            };
            db.prepare('INSERT INTO late_evidence VALUES(?,?)').run(
              id,
              JSON.stringify(detail)
            );
            totals.newEntries++;
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
    }
  }
  Object.assign(status, totals);
}

export async function observeLateAuctions(opts) {
  opts.db.exec(
    'CREATE TABLE IF NOT EXISTS late_evidence(id TEXT PRIMARY KEY, detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS late_scans(at TEXT PRIMARY KEY, books INTEGER, quoted INTEGER, source_errors INTEGER, error TEXT)'
  );
  const io = new Transport(opts.config);
  while (!opts.stop()) {
    const cycle = {};
    try {
      await scan({ ...opts, io, status: cycle });
      cycle.error = null;
    } catch (e) {
      cycle.error = e.message;
    }
    if (opts.stop()) return;
    cycle.at = new Date().toISOString();
    opts.db
      .prepare('INSERT INTO late_scans VALUES(?,?,?,?,?)')
      .run(
        cycle.at,
        cycle.books ?? null,
        cycle.quoted ?? null,
        cycle.sourceErrors ?? null,
        cycle.error
      );
    Object.assign(opts.status, cycle);
    await sleep(60000);
  }
}
