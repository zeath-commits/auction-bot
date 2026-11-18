import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger, recordBtc, settle } from '../strategy-monitor.mjs';

test('BTC strategies require repeatable size and settle both paper variants only once', async () => {
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
    const io = {
      get: async () => ({
        body: { market: { ...market, status: 'finalized', result: 'no' } }
      })
    };
    await settle(db, io);
    await settle(db, io);
    assert.deepEqual(
      rows().map((r) => r.payout),
      [0, 0]
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
