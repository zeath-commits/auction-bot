import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreWindow } from '../polymarket-replay.mjs';
import { usAsks, boundedPair, pairStrategy } from '../us-bitcoin-paper.mjs';

test('wide-gap paper entry accepts only the predeclared opening time, gap and premium', () => {
  const t = 1794978000,
    at = t * 1000;
  const snap = (cost, begin = at, finish = at + 1000) => ({
    pair: { cost },
    begin,
    finish
  });
  assert.equal(pairStrategy(snap(13), t, 20), 'cross_us_middle');
  assert.equal(pairStrategy(snap(10), t, 20), 'cross_us_middle');
  assert.equal(pairStrategy(snap(13.0001), t, 30), null);
  assert.equal(pairStrategy(snap(12), t, 19.999), null);
  assert.equal(pairStrategy(snap(12, at - 1), t, 30), null);
  assert.equal(pairStrategy(snap(12, at + 29800, at + 30000), t, 30), null);
  assert.equal(
    pairStrategy(snap(9.99, at + 31000, at + 33000), t, 0.5),
    'cross_us_btc'
  );
});

test('international replay counts the first in-window buyer and excludes post-close prints', () => {
  const t = 1800000000,
    slug = 'btc-updown-5m-' + t,
    m = {
      eventStartTime: new Date(t * 1000).toISOString(),
      endDate: new Date((t + 300) * 1000).toISOString(),
      slug,
      conditionId: 'test',
      closed: true,
      umaResolutionStatus: 'resolved',
      resolutionSource:
        'https://data.chain.link/streams/btc-usd-twap-60s-streams',
      feesEnabled: true,
      feeSchedule: { exponent: 1, rate: 0.07 },
      outcomes: '["Up","Down"]',
      outcomePrices: '["0","1"]'
    };
  const trade = (offset, side, outcome) => ({
    condition_id: 'test',
    slug,
    side,
    outcome,
    price: 0.99,
    size: 4,
    timestamp: t + offset
  });
  const r = scoreWindow(
    m,
    [
      trade(289, 'BUY', 'Down'),
      trade(290, 'SELL', 'Down'),
      trade(295, 'BUY', 'Up'),
      trade(297, 'BUY', 'Down'),
      trade(300, 'BUY', 'Down')
    ],
    t
  );
  assert.equal(r.first.outcome, 'Up');
  assert.ok(Math.abs(r.net + 0.99069) < 1e-9);
  assert.equal(scoreWindow({ ...m, closed: false }, [], t).first, undefined);
});
test('cross-venue pair buys up at the lower reference and down at the higher one', () => {
  const slug = 'test';
  const us = usAsks(
    {
      marketSlug: slug,
      state: 'MARKET_STATE_OPEN',
      bids: [{ px: { currency: 'USD', value: '0.85' }, qty: '15' }],
      offers: [{ px: { currency: 'USD', value: '0.90' }, qty: '22' }]
    },
    slug
  );
  const k = { yes: { price: 0.4, size: 100 }, no: { price: 0.5, size: 50 } };
  const expensive = boundedPair(us, k, 63000, 63100, 0.095, slug, 'K');
  assert.deepEqual(
    expensive.legs.map((v) => v.side),
    ['yes', 'no']
  );
  assert.ok(expensive.cost > 10);
  const cheap = boundedPair(us, k, 63100, 63000, 0.095, slug, 'K');
  assert.deepEqual(
    cheap.legs.map((v) => v.side),
    ['no', 'yes']
  );
  assert.ok(cheap.cost < 10);
  assert.equal(boundedPair(us, k, 63000, 63000, 0.095, slug, 'K'), null);
  assert.equal(
    boundedPair(
      us,
      { ...k, yes: { price: 0.4, size: 9 } },
      63100,
      63000,
      0.095,
      slug,
      'K'
    ),
    null
  );
});
