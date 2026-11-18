import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBook, simulate, repeatStudy } from '../auction-tape-replay.mjs';
import { auctionPhase } from '../late-auction.mjs';

test('repeat purchases group simultaneous executions and require a full minute between entries', () => {
  const t = Date.parse('2026-11-16T22:00Z');
  const trade = (ms, price, size) => ({
    ticker: 'A',
    artwork: '1',
    event: 'E',
    at: new Date(t + ms).toISOString(),
    elapsedMs: ms,
    price,
    size,
    won: true
  });
  const s = repeatStudy([
    trade(30000, 0.8, 10),
    trade(30000, 0.93, 1.5),
    trade(30000, 0.93, 1.5),
    trade(89999, 0.94, 5),
    trade(90000, 0.91, 5)
  ]);
  assert.equal(s.first.quantity, 3);
  assert.equal(s.first.entries[0].price, 0.93);
  assert.equal(s.repeat.entries.length, 2);
  assert.equal(s.repeat.quantity, 8);
  assert.equal(s.repeat.tickers, 1);
});

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
import {
  priceSensitivity,
  confirmedDepthReplay
} from '../auction-tape-replay.mjs';
test('auction competition skips an entire qualifying timestamp per threshold and compares the same cash budget', () => {
  const base = Date.parse('2026-11-16T22:00Z');
  const row = (seconds, price, size) => ({
    at: new Date(base + seconds * 1000).toISOString(),
    elapsedMs: seconds * 1000,
    price,
    size,
    won: true,
    ticker: 'A',
    artwork: 'lot A'
  });
  const d = priceSensitivity([
    row(31, 0.8, 1000),
    row(31, 0.99, 100),
    row(100, 0.95, 10),
    row(170, 0.9, 2)
  ]);
  const m = d.models.find(
    (m) => m.delay === 30 && m.cap === 0.95 && m.missFirst
  );
  assert.equal(m.quantity, 2);
  assert.equal(m.top.artwork, 'lot A');
  assert.equal(m.withoutTop.cost, 0);
  const pending = priceSensitivity([
    { ...row(31, 0.98, 100), won: null }
  ]).models.find((m) => m.cap === 0.99 && !m.missFirst && m.delay === 30);
  assert.equal(pending.net, null);
  assert.ok(pending.pendingCost > 0);
});
test('two observed books cap paper size across repeated and interrupted snapshots', () => {
  const seenAt = '2026-11-16T22:00:00Z',
    book = (s, levels) => ({
      at: new Date(Date.parse(seenAt) + s * 1000).toISOString(),
      levels,
      ticker: 'T'
    });
  const l = {
    sale: 'S',
    lot: 'L',
    sampled: ['T'],
    seenAt,
    books: [
      book(1, [
        [0.91, 1],
        [0.92, 1]
      ]),
      book(20, [
        [0.91, 1],
        [0.92, 1]
      ]),
      book(25, [
        [0.91, 1],
        [0.92, 1]
      ]),
      book(28, []),
      book(32, [[0.7, 10]]),
      book(75, [[0.7, 10]])
    ]
  };
  const outcomes = [{ ticker: 'T', aligned: true }];
  const baseline = confirmedDepthReplay([l], outcomes, 0);
  assert.equal(baseline.quantity, 2);
  assert.equal(confirmedDepthReplay([l], outcomes, 1).quantity, 1);
  assert.equal(confirmedDepthReplay([l], [], 0).net, null);
});
