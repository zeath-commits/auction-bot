import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanAuctionDepth } from '../late-auction.mjs';
import { addPaper, openLedger } from '../strategy-monitor.mjs';

test('sale and post-sale depth scans share cash, verify both books, and record the source without duplicating entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-depth-')),
    db = openLedger(dir);
  const now = Date.now(),
    event = 'KXART-TEST',
    ticker = event + '-10';
  const market = {
    ticker,
    event_ticker: event,
    market_type: 'binary',
    status: 'active',
    strike_type: 'greater',
    floor_strike: 10,
    notional_value_dollars: '1.0000',
    rules_primary: 'test',
    rules_secondary: 'premium',
    close_time: new Date(now + 3600000).toISOString()
  };
  const frozen = {
    ticker,
    strikeType: 'greater',
    threshold: 10,
    primary: 'test',
    secondary: 'premium'
  };
  const target = {
    event,
    id: '1',
    lot: '1',
    artist: 'Artist',
    title: 'Painting',
    markets: [frozen]
  };
  const auction = {
    house: 'christies',
    sale: '42',
    targets: [target],
    sourceUrl: 'test',
    startAt: new Date(now - 60000).toISOString(),
    deadline: new Date(now + 60000).toISOString()
  };
  const raw = {
    object_id: '1',
    lot_id_txt: '1',
    analytics_id: '42.1',
    title_primary_txt: 'Artist',
    title_secondary_txt: 'Painting',
    price_realised: 15,
    price_realised_txt: 'USD 15',
    lot_withdrawn: false,
    is_in_progress: false,
    is_auction_over: true
  };
  let html =
    '<script>window.chrComponents.lots = ' +
    JSON.stringify({
      data: { lots: [raw], total_hits_filtered: 1 },
      labels: { currency_txt: 'USD' }
    }) +
    ';</script>';
  let books = 0,
    quantity = '10.00',
    bid = '0.1000';
  const io = {
    request: async () => ({ text: html, requestedAt: Date.now() }),
    get: async (p) => {
      let body;
      if (p.startsWith('/markets?')) body = { markets: [market], cursor: '' };
      else if (p.startsWith('/events/'))
        body = {
          event: {
            event_ticker: event,
            settlement_sources: [
              { name: 'Artnet', url: 'https://www.artnet.com/' }
            ]
          },
          markets: [market]
        };
      else if (p.startsWith('/markets/orderbooks?'))
        body = {
          orderbooks: [
            {
              ticker,
              orderbook_fp: {
                yes_dollars: [['0.9500','18.75']],
                no_dollars: bid===null ? [] : [[bid, ++books === 1 ? '12.00' : quantity]]
              }
            }
          ]
        };
      else if (p === '/series/KXART')
        body = {
          series: { ticker: 'KXART', fee_type: 'quadratic', fee_multiplier: 1 }
        };
      else if (p === '/exchange/status')
        body = { trading_active: true, exchange_active: true };
      else throw Error(p);
      const at=Date.now();
      return { body, requestedAt: at, receivedAt: at, httpDate:new Date(at).toUTCString() };
    }
  };
  try {
    db.exec(
      'CREATE TABLE late_evidence(id TEXT PRIMARY KEY,detail TEXT);CREATE TABLE auction_source_signals(id TEXT PRIMARY KEY,event TEXT,kind TEXT,amount REAL,source TEXT,seenAt TEXT)'
    );
    addPaper(db, {
      id: 'prior',
      strategy: 'late_auction',
      ticker: 'PRIOR',
      side: 'yes',
      at: '2026-11-01',
      quantity: 1000,
      price: 0.996,
      fees: 0
    });
    const opts = {
      db,
      io,
      auctions: [auction],
      stop: () => false,
      status: {},
      config: { offerTailHours: 0, maxSourceAgeMs: 15000, maxQuoteAgeMs: 2000 }
    };
    await scanAuctionDepth(opts, 'sale_depth');
    assert.equal(books, 2);
    assert.equal(
      db.prepare('SELECT quantity FROM paper WHERE ticker=?').get(ticker)
        .quantity,
      4
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM auction_source_signals').get().n,
      1
    );
    auction.deadline = new Date(now - 1).toISOString();
    await scanAuctionDepth(opts, 'late_auction');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM paper WHERE ticker=?').get(ticker)
        .n,
      1
    );
    db.prepare("UPDATE paper SET payout=1000 WHERE id='prior'").run();
    await scanAuctionDepth(opts, 'late_auction');
    const owned = () =>
      db
        .prepare('SELECT SUM(quantity) AS n FROM paper WHERE ticker=?')
        .get(ticker).n;
    assert.equal(owned(), 10);
    bid = '0.1700';
    await scanAuctionDepth(opts, 'late_auction');
    assert.equal(owned(), 10);
    quantity = '13.00';
    await scanAuctionDepth(opts, 'late_auction');
    assert.equal(owned(), 13);
    assert.equal(opts.status.addedContracts, 3);
    await scanAuctionDepth(opts, 'late_auction');
    assert.equal(owned(), 13);
    const firstBooks = db.prepare('SELECT signal,book FROM auction_first_sale_books ORDER BY signal');
    const original = firstBooks.all();
    assert.equal(original.length,1);
    assert.equal(JSON.parse(original[0].book).orderbook_fp.no_dollars[0][1],'12.00');
    auction.deadline = new Date(Date.now()+60000).toISOString();
    bid=null;
    await scanAuctionDepth(opts,'sale_depth');
    const trial=db.prepare('SELECT * FROM auction_resting_trials WHERE ticker=?').get(ticker);
    assert.equal(trial.side,'YES');assert.equal(trial.ahead,18.75);assert.equal(trial.amount,15);
    const funded=db.prepare('SELECT slots,shares,proof FROM auction_resting_plans JOIN auction_resting_allocations USING(ticker) WHERE ticker=?').get(ticker);
    assert.equal(funded.slots,1);
    assert.equal(funded.shares,1052);
    const {first,second}=JSON.parse(funded.proof);
    assert.ok(second.bookAsOf>first.bookAsOf);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM auction_resting_allocations WHERE policy='empty'").get().n,0);
    assert.equal(owned(),13);
    html = html.replace('"price_realised":15','"price_realised":16').replace('USD 15','USD 16');
    bid = null;
    await scanAuctionDepth(opts,'sale_depth');
    assert.equal(opts.status.quoted,0);
    const after = firstBooks.all();
    assert.deepEqual(after[0],original[0]);
    assert.equal(after.length,2);
    assert.deepEqual(JSON.parse(after[1].book).orderbook_fp.no_dollars,[]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
