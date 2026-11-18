import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPaper,
  openLedger,
  paperRows,
  recordBtc,
  settle
} from '../strategy-monitor.mjs';

for (const strategy of ['auction_pair', 'cross_us_btc', 'cross_us_middle'])
  test(strategy + ' return waits for both settlements', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-pair-'));
    const db = openLedger(dir);
    try {
      for (const side of ['yes', 'no'])
        addPaper(db, {
          id: strategy + '/TEST/' + side,
          strategy,
          ticker: side,
          side,
          at: '2026-01-01',
          quantity: 1,
          price: 0.44,
          fees: 0.0173
        });
      db.prepare("UPDATE paper SET payout=1 WHERE side='yes'").run();
      assert.ok(paperRows(db).every((r) => r.net === null));
      db.prepare("UPDATE paper SET payout=0 WHERE side='no'").run();
      assert.ok(
        Math.abs(paperRows(db).reduce((n, r) => n + r.net, 0) - 0.0854) < 1e-8
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('BTC strategies require repeatable size and settle each paper variant only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-paper-')),
    db = openLedger(dir);
  try {
    const close = Date.now() - 1500;
    const market = {
      ticker: 'KXBTC15M-TEST',
      status: 'active',
      close_time: new Date(close).toISOString()
    };
    const book = (ms, price = '0.0200', size = '10.00') => ({
      requestedAt: ms,
      receivedAt: ms + 30,
      body: {
        orderbook_fp: {
          yes_dollars: [['0.9700', '3.00']],
          no_dollars: [[price, size]]
        }
      }
    });
    const enter = (a, b) => recordBtc(db, market, a, b, 1);
    const rows = () =>
      db.prepare('SELECT * FROM paper ORDER BY strategy').all();
    enter(book(close - 12000), book(close - 10900, '0.0100')); // offer worsened
    enter(book(close - 7000), book(close - 5800, '0.0200', '0.5')); // too small
    enter(book(close - 1200), book(close)); // close during confirmation
    assert.equal(rows().length, 0);
    enter(book(close - 12000), book(close - 10900));
    assert.deepEqual(
      rows().map((r) => r.strategy),
      ['btc60']
    );
    enter(book(close - 9000), book(close - 7800));
    enter(book(close - 5000), book(close - 3800));
    assert.deepEqual(
      rows().map((r) => r.strategy),
      ['btc10', 'btc60']
    );
    assert.equal(rows()[0].fees, 0.0014);
    enter(
      book(close - 3000, '0.0200', '1000'),
      book(close - 1800, '0.0200', '999.99')
    );
    assert.equal(rows().length, 2);
    enter(
      book(close - 2800, '0.0200', '1200'),
      book(close - 1600, '0.0200', '1000')
    );
    assert.equal(rows()[2].strategy, 'btcDepth');
    assert.equal(rows()[2].depth, 1000);
    const io = {
      get: async () => ({
        body: { market: { ...market, status: 'finalized', result: 'no' } }
      })
    };
    await settle(db, io);
    await settle(db, io);
    assert.deepEqual(
      rows().map((r) => r.payout),
      [0, 0, 0]
    );
    const cheap = (ms, bid, size = '1.00') => {
      const snapshot = book(ms, '0.0500');
      snapshot.body.orderbook_fp.yes_dollars = [[bid, size]];
      return snapshot;
    };
    const candidate = { ...market, ticker: 'KXBTC15M-UNDERDOG' };
    const recordCheap = (a,b) => recordBtc(db, candidate, a, b, 1);
    recordCheap(cheap(close-6000,'0.9900'), cheap(close-4500,'0.9800'));
    recordCheap(cheap(close-6000,'0.9800'), cheap(close-4500,'0.9800','0.99'));
    assert.equal(rows().length, 3);
    const confirm = () => recordCheap(cheap(close-6000,'0.9800'), cheap(close-4500,'0.9900'));
    confirm();
    confirm();
    const cheapRows = () => rows().filter(r => r.strategy === 'btc_underdog');
    assert.deepEqual(cheapRows().map(r => [r.side,r.quantity,r.price,r.fees]), [['no',1,0.01,0.0007]]);
    await settle(db, { get: async () => ({
      body: { market: { ...candidate, status: 'finalized', result: 'no' } }
    }) });
    assert.equal(cheapRows()[0].payout, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
