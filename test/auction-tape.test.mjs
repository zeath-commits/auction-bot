import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBook, simulate } from '../auction-tape-replay.mjs';
import { auctionPhase } from '../late-auction.mjs';

test('archive only corroborates fresh prior visible quantity at the executed price', () => {
  const b = { at: '2026-11-16T20:00:00Z', levels: [[0.93, 2]] };
  const trade = { at: '2026-11-16T20:00:02Z', price: 0.93 };
  assert.equal(matchBook([b], trade), 2);
  assert.equal(
    matchBook([b, { at: '2026-11-16T20:00:01Z', levels: [] }], trade),
    0
  );
  assert.equal(matchBook([b], { ...trade, at: '2026-11-16T20:00:00.999Z' }), 0);
  assert.equal(matchBook([b], { ...trade, at: '2026-11-16T20:00:30.001Z' }), 0);
  assert.equal(matchBook([b], { ...trade, price: 0.92 }), 0);
});
test('historical allocation consumes cash once per ticker and withholds net until settlement', () => {
  const r = {
    ticker: 'A',
    event: 'E',
    artwork: 'S/1',
    elapsedMs: 40000,
    price: 0.95,
    size: 5,
    shown: 2,
    won: true
  };
  const b = { ...r, ticker: 'B', won: false };
  const x = simulate([{ ...r, elapsedMs: 1 }, r, r, b], 5, 30000, true);
  assert.equal(x.quantity, 4);
  assert.equal(x.lots, 1);
  assert.equal(x.cost, 3.82);
  assert.equal(x.net, -1.82);
  assert.equal(simulate([{ ...r, won: null }], 5, 0, true).net, null);
  const q = simulate(
    [
      { ...r, size: 5000, shown: 5000 },
      { ...b, size: 5000, shown: 5000 }
    ],
    5000,
    0,
    true
  );
  assert.ok(q.cost <= 1000 && q.cost > 999);
});
test('sale-window book sampling starts on time and hands off at the end of the tail', () => {
  const a = { startAt: '2026-11-19T18:55Z', deadline: '2026-11-19T23:00Z' };
  assert.equal(auctionPhase(a, Date.parse(a.startAt) - 1, 12), null);
  assert.equal(auctionPhase(a, Date.parse(a.startAt), 12), 'sale_depth');
  assert.equal(
    auctionPhase(a, Date.parse('2026-11-20T11:00Z') - 1, 12),
    'sale_depth'
  );
  assert.equal(
    auctionPhase(a, Date.parse('2026-11-20T11:00Z'), 12),
    'late_auction'
  );
});
