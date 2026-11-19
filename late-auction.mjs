import { setTimeout as sleep } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import {
  askLevels, overlappingAskLevels,
  checkEvent,
  checkFees,
  checkMarketActive
} from './core.mjs';
import { catalogue, evidence, offerSide } from './watch-offers.mjs';
import { verifyTerms } from './paper-unsold.mjs';
import { addPaper } from './strategy-monitor.mjs';
import { initRestingStudy, observeRestingBid } from './auction-resting.mjs';

const scale = 1000000;
import {auctionPortfolio} from './auction-portfolio.mjs';
const afterSale = 'late_auction',
  duringSale = 'sale_depth';
export function auctionPhase(auction, now, tailHours) {
  if (now < Date.parse(auction.startAt)) return null;
  return now < Date.parse(auction.deadline) + tailHours * 3600000
    ? duringSale
    : afterSale;
}
export async function auditArtCoverage(io, auctions) {
  const known = new Map(
    auctions.flatMap((a) => a.targets).map((t) => [t.event, t])
  );
  const summary = {
    open: 0,
    artnet: 0,
    mapped: 0,
    other: 0,
    unclassified: 0,
    review: []
  };
  let cursor = '';
  const seen = new Set();
  do {
    const { body } = await io.get(
      '/events?series_ticker=KXART&status=open&limit=200&with_nested_markets=true' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    );
    for (const e of body.events) {
      if (
        !/^KXART-[A-Z0-9]+$/.test(e.event_ticker) ||
        !Array.isArray(e.markets)
      )
        throw Error('Unexpected auction event');
      const active = e.markets.filter((m) => m.status === 'active');
      summary.open += active.length;
      const sources = e.settlement_sources;
      if (!sources?.length) {
        summary.unclassified += active.length;
        continue;
      }
      if (
        !sources.every(
          (s) =>
            /^artnet$/i.test(s.name) &&
            /(^|\.)artnet\.com$/i.test(new URL(s.url).hostname)
        )
      ) {
        summary.other += active.length;
        continue;
      }
      summary.artnet += active.length;
      const target = known.get(e.event_ticker);
      let matched = [];
      if (target) {
        try {
          matched = checkEvent({ event: e, markets: active }, target).filter(
            (m) => m.status === 'active'
          );
        } catch {
          /* Changed rules require review. */
        }
      }
      const tickers = new Set(matched.map((m) => m.ticker));
      summary.mapped += tickers.size;
      const missing = active
        .filter((m) => !tickers.has(m.ticker))
        .map((m) => m.ticker);
      if (missing.length)
        summary.review.push({
          event: e.event_ticker,
          title: e.title,
          tickers: missing
        });
    }
    cursor = body.cursor;
    if (cursor && seen.has(cursor))
      throw Error('Repeated auction event cursor');
    seen.add(cursor);
  } while (cursor);
  return summary;
}
export function auctionDepthCash(db) {
  return auctionPortfolio(db).cash;
}
function charge(price, quantity) {
  return (
    Math.ceil(0.07 * quantity * price * (1 - price) * 10000 - 1e-9) / 10000
  );
}

export function affordableLevel(price, quantity, cash) {
  const unit = price + 0.07 * price * (1 - price);
  let count = Math.min(quantity, Math.floor((cash + 1e-10) / unit));
  if (count > 0 && count * price + charge(price, count) > cash + 1e-9) count--;
  if (count <= 0) return null;
  const fee = charge(price, count);
  return count * (1 - price) > fee ? { price, quantity: count, fee } : null;
}

// Use whole contracts and take only volume visible at the same price on
// both reads. The exchange does not disclose queue identities in this feed.
export function persistentOffer(
  first,
  second,
  side,
  cash,
  previouslyBought = 0,
  maxCents = 99
) {
  if (!Number.isSafeInteger(previouslyBought) || previouslyBought < 0)
    throw Error('Invalid previous paper quantity');
  let quantity = 0,
    principal = 0,
    fees = 0,
    displayed = 0;
  const levels = [];
  let reserved = previouslyBought;
  for (const {price,quantity:depth} of overlappingAskLevels(first, second, side, maxCents)) {
    displayed += depth;
    // The book has no order identities. Reserve the earlier paper units at the
    // cheapest visible prices, even if quotes were cancelled or repriced.
    const overlap = Math.min(reserved, depth);
    reserved -= overlap;
    const fill = affordableLevel(
      price,
      depth - overlap,
      cash - principal - fees
    );
    if (!fill) continue;
    levels.push(fill);
    quantity += fill.quantity;
    principal += fill.quantity * price;
    fees += fill.fee;
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

export async function scanAuctionDepth(
  { db, io, auctions, config, stop, status },
  strategy
) {
  if (strategy === duringSale) {
    initRestingStudy(db);
    db.exec('CREATE TABLE IF NOT EXISTS auction_first_sale_books(signal TEXT,ticker TEXT,requested INTEGER,received INTEGER,httpDate TEXT,cacheAge TEXT,book TEXT,PRIMARY KEY(signal,ticker))');
  }
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
    unconfirmed: [],
    sourceErrors: 0,
    newEntries: 0,
    priorBooks: 0,
    expandedBooks: 0,
    addedContracts: 0
  };
  const holdings =
    db.prepare(`SELECT p.side,p.quantity,p.payout,e.detail FROM paper p LEFT JOIN late_evidence e ON e.id=p.id
    WHERE p.ticker=? AND p.strategy IN (?,?)`);
  function inventory(ticker, side, signal) {
    const rows = holdings.all(ticker, duringSale, afterSale);
    let quantity = 0;
    for (const row of rows) {
      const evidence = row.detail && JSON.parse(row.detail);
      if (
        row.payout !== null ||
        row.side !== side.toLowerCase() ||
        evidence?.kind !== signal.kind ||
        evidence.amount !== signal.amount
      )
        return null;
      quantity += row.quantity;
    }
    return { quantity, entries: rows.length };
  }
  for (const auction of auctions) {
    if (auctionPhase(auction, Date.now(), config.offerTailHours) !== strategy)
      continue;
    const targets = auction.targets.filter((t) =>
      t.markets.some((m) => open.has(m.ticker))
    );
    if (!targets.length) continue;
    let src;
    try {
      src = await catalogue(io, auction);
    } catch (e) {
      totals.sourceErrors++;
      totals.lastSourceError = e.message;
      continue;
    }
    for (const target of targets) {
      if (stop()) return;
      let sig;
      try {
        sig = await evidence(io, auction, target, src);
      } catch {
        totals.sourceErrors++;
        continue;
      }
      if (!['published_sale', 'unsold'].includes(sig?.kind)) {
        totals.unconfirmed.push({
          event: target.event,
          lot: target.lot,
          title: target.title,
          thresholds: target.markets.filter((m) => open.has(m.ticker)).length
        });
        continue;
      }
      if (strategy === duringSale)
        db.prepare(
          'INSERT OR IGNORE INTO auction_source_signals(id,event,kind,amount,source,seenAt) VALUES(?,?,?,?,?,?)'
        ).run(
          [target.event, sig.kind, sig.amount].join('/'),
          target.event,
          sig.kind,
          sig.amount,
          sig.url,
          new Date().toISOString()
        );
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
      // Preserve the first batch even when no one is offering the result side.
      // The sale evidence and market rules are already matched above. Raw headers
      // let the replay exclude books that might have been cached before publication.
      if (strategy === duringSale && sig.kind === 'published_sale') {
        const signal = [target.event, sig.kind, sig.amount].join('/');
        const insert = db.prepare('INSERT OR IGNORE INTO auction_first_sale_books VALUES(?,?,?,?,?,?,?)');
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const [ticker, read] of first)
            insert.run(signal,ticker,read.requestedAt,read.receivedAt,read.httpDate??null,read.cacheAge??null,JSON.stringify(read.body));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      const offers = markets.filter((m) => {
        const side = offerSide(sig, m.floor_strike),
          b = first.get(m.ticker).body;
        return side && askLevels(b, side, 99).some((l) => l.quantity >= scale);
      });
      totals.quoted += offers.length;
      const pending = offers.filter((m) => {
        const side = offerSide(sig, m.floor_strike),
          prior = inventory(m.ticker, side, sig);
        if (!prior) return false;
        const depth = askLevels(first.get(m.ticker).body, side, 99).reduce(
          (n, l) => n + Math.floor(l.quantity / scale),
          0
        );
        if (prior.entries) {
          totals.priorBooks++;
          if (depth > prior.quantity) totals.expandedBooks++;
        }
        return depth > prior.quantity;
      });
      const pendingBuys=new Set(pending.map(m=>m.ticker));
      const resting=new Set();
      let publishedAt;
      if(strategy===duringSale && sig.kind==='published_sale'){
        const history=db.prepare('SELECT kind,amount,seenAt FROM auction_source_signals WHERE event=?').all(target.event);
        if(history.length===1 && history[0].kind===sig.kind && history[0].amount===sig.amount)publishedAt=Date.parse(history[0].seenAt);
        const recorded=db.prepare('SELECT 1 FROM auction_resting_trials WHERE ticker=?');
        for(const m of markets){
          const side=offerSide(sig,m.floor_strike);
          if(Number.isFinite(publishedAt) && side && !recorded.get(m.ticker) && !askLevels(first.get(m.ticker).body,side,95).length)resting.add(m.ticker);
        }
      }
      if (!pendingBuys.size && !resting.size) continue;
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
      const recheck=markets.filter(m=>active.has(m.ticker)&&(pendingBuys.has(m.ticker)||resting.has(m.ticker)));
      const second = await books(io,recheck);
      for (const m of recheck) {
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
        const side = offerSide(confirmed, m.floor_strike);
        if(resting.has(m.ticker) && confirmed.url===sig.url){
          const earlier=first.get(m.ticker);
          const asOf=r=>Date.parse(r.httpDate)-1000*Number(r.cacheAge??0);
          const fresh=(r,source)=>r.requestedAt>=source.requestedAt && asOf(r)>=publishedAt &&
            asOf(r)>=r.receivedAt-2500 && asOf(r)<=r.receivedAt+500;
          if(fresh(earlier,sig)&&fresh(read,confirmed)&&asOf(read)>asOf(earlier))
            observeRestingBid(db,
              {book:earlier.body,bookAsOf:asOf(earlier),at:earlier.receivedAt,sourceAt:sig.requestedAt,url:sig.url,amount:sig.amount},
              {ticker:m.ticker,side,at:read.receivedAt,book:read.body,bookAsOf:asOf(read),sourceAt:confirmed.requestedAt,
                saleSlots:auction.targets.reduce((n,target)=>n+target.markets.length,0),
                closeAt:Date.parse(m.close_time),url:confirmed.url,amount:confirmed.amount});
        }
        if(!pendingBuys.has(m.ticker))continue;
        db.exec('BEGIN IMMEDIATE');
        try {
          const prior = inventory(m.ticker, side, confirmed);
          if (!prior) {
            db.exec('COMMIT');
            continue;
          }
          const id =
            afterSale +
            '/' +
            m.ticker +
            (prior.entries ? '/' + (prior.entries + 1) : '');
          const q = persistentOffer(
            first.get(m.ticker).body,
            read.body,
            side,
            auctionDepthCash(db),
            prior.quantity
          );
          if (q) {
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
              previouslyBought: prior.quantity,
              confirmedDepth: q.displayed,
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
            if (prior.entries) totals.addedContracts += q.quantity;
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
  opts.db.exec(
    'CREATE TABLE IF NOT EXISTS auction_source_signals(id TEXT PRIMARY KEY,event TEXT,kind TEXT,amount REAL,source TEXT,seenAt TEXT)'
  );
  const io = new Transport(opts.config);
  await Promise.all([watchDuringSales(opts, io), watchAfterSales(opts, io)]);
}

async function watchDuringSales(opts, io) {
  while (!opts.stop()) {
    const now = Date.now();
    const active = opts.auctions.filter(
      (a) => auctionPhase(a, now, opts.config.offerTailHours) === duringSale
    );
    const cycle = { active: active.length, error: null };
    if (active.length) {
      try {
        await scanAuctionDepth(
          { ...opts, auctions: active, io, status: cycle },
          duringSale
        );
      } catch (e) {
        cycle.error = e.message;
      }
    }
    opts.status.saleDepth = { ...cycle, at: new Date().toISOString() };
    const next = Math.min(
      ...opts.auctions
        .map((a) => Date.parse(a.startAt) - now)
        .filter((ms) => ms > 0)
    );
    await sleep(
      active.length
        ? cycle.error
          ? 30000
          : opts.config.pollIntervalMs
        : Math.min(60000, next)
    );
  }
}

async function watchAfterSales(opts, io) {
  let coverageDue = 0;
  while (!opts.stop()) {
    const cycle = {};
    if (Date.now() >= coverageDue) {
      try {
        opts.status.coverage = {
          ...(await auditArtCoverage(io, opts.auctions)),
          at: new Date().toISOString()
        };
        opts.status.coverageError = null;
        coverageDue = Date.now() + 600000;
      } catch (e) {
        opts.status.coverageError = e.message;
        coverageDue = Date.now() + 60000;
      }
    }
    try {
      await scanAuctionDepth({ ...opts, io, status: cycle }, afterSale);
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
