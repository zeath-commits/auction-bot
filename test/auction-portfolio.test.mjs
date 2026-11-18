import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  auctionPortfolio,
  auctionHoldings,
  exitQuote
} from '../auction-portfolio.mjs';
test('auction cash reserves open cost, releases final payout and excludes parallel single-share tests', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE paper(ticker,side,strategy,quantity,price,fees,payout);INSERT INTO paper VALUES ('T','no','late_auction',100,.98,.14,NULL),('T','no','sale_depth',1,.95,.01,NULL),('T','no','unsold',1,.92,.01,NULL),('S','yes','sothebys_sold',2,.50,.04,2)"
    );
    const p = auctionPortfolio(db),
      h = auctionHoldings(db);
    assert.equal(p.openQuantity, 101);
    assert.ok(Math.abs(p.openCost - 99.1) < 1e-7);
    assert.ok(Math.abs(p.settledNet - 0.96) < 1e-7);
    assert.ok(Math.abs(p.cash - 901.86) < 1e-7);
    assert.equal(h.length, 1);
    assert.equal(h[0].quantity, 101);
  } finally {
    db.close();
  }
});
test('selling NO uses repeated NO bids in best-price order and reports unpriced holdings', () => {
  const b = (rows) => ({
    orderbook_fp: { no_dollars: rows, yes_dollars: [['.99', '9999']] }
  });
  const a = b([
      ['0.90', '5.80'],
      ['0.81', '11']
    ]),
    second = b([
      ['0.92', '9'],
      ['0.90', '2.90'],
      ['0.81', '7']
    ]);
  const p = { quantity: 10, side: 'no', cost: 9.5 };
  const q = exitQuote(p, a, second);
  assert.equal(q.quantity, 9);
  assert.equal(q.unpriced, 1);
  assert.equal(q.netIfFullySold, null);
  assert.deepEqual(
    q.levels.map((l) => [l.price, l.quantity]),
    [
      [0.9, 2],
      [0.81, 7]
    ]
  );
  const full = exitQuote({ ...p, quantity: 2, cost: 1.9 }, a, second);
  assert.ok(Math.abs(full.proceeds - 1.7874) < 1e-7);
  assert.ok(Math.abs(full.netIfFullySold + 0.1126) < 1e-7);
});
