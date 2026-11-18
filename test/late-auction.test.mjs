import test from 'node:test';
import assert from 'node:assert/strict';
import { auditArtCoverage, persistentOffer } from '../late-auction.mjs';

test('auction coverage checks active thresholds across pages and flags unmapped strikes', async () => {
  const e = 'KXART-ART',
    source = [{ name: 'Artnet', url: 'https://www.artnet.com/' }];
  const m = {
    event_ticker: e,
    ticker: e + '-10',
    rules_primary: 'above ten',
    rules_secondary: 'premium',
    strike_type: 'greater',
    floor_strike: 10,
    market_type: 'binary',
    notional_value_dollars: '1.0000',
    status: 'active'
  };
  const base = {
    event_ticker: e,
    title: 'art',
    settlement_sources: source,
    markets: [m, { ...m, ticker: e + '-20' }, { ...m, status: 'finalized' }]
  };
  const other = {
    ...base,
    event_ticker: 'KXART-OTHER',
    settlement_sources: [
      { name: 'Sothebys', url: 'https://www.sothebys.com/' }
    ],
    markets: [m]
  };
  const target = {
    event: e,
    markets: [
      {
        ticker: m.ticker,
        primary: m.rules_primary,
        secondary: m.rules_secondary,
        strikeType: 'greater',
        threshold: 10
      }
    ]
  };
  const io = {
    get: async (p) => ({
      body: p.includes('&cursor=')
        ? { events: [other], cursor: '' }
        : { events: [base], cursor: 'next' }
    })
  };
  const a = await auditArtCoverage(io, [{ targets: [target] }]);
  assert.deepEqual([a.open, a.artnet, a.mapped, a.other], [3, 2, 1, 1]);
  assert.deepEqual(a.review[0].tickers, [e + '-20']);
});

test('late auction sizing uses repeat depth, fees, and available cash', () => {
  const book = (one, two) => ({
    orderbook_fp: {
      yes_dollars: [
        ['0.01', one],
        ['0.02', two]
      ]
    }
  });
  const a = book('124.00', '2.00'),
    b = book('143.50', '1.90');
  const q = persistentOffer(a, b, 'NO', 1000);
  assert.equal(q.quantity, 125);
  assert.deepEqual(
    q.levels.map((l) => l.quantity),
    [1, 124]
  );
  assert.ok(Math.abs(q.quantity * q.price + q.fees - 123.8274) < 0.000001);
  assert.equal(persistentOffer(a, b, 'NO', 0.9813), null);
  assert.equal(persistentOffer(a, b, 'NO', 0.9814).quantity, 1);
  assert.equal(persistentOffer(a, book('0', '0'), 'NO', 1000), null);
  // Reserve the original 125 contracts first. Repricing or temporary removal
  // does not make an existing block available a second time.
  assert.equal(persistentOffer(a, b, 'NO', 1000, 125), null);
  const expanded = book('125', '4');
  const extra = persistentOffer(expanded, expanded, 'NO', 1000, 125);
  assert.equal(extra.quantity, 4);
  assert.equal(extra.price, 0.99);
  assert.equal(persistentOffer(expanded, a, 'NO', 1000, 126), null);
});
