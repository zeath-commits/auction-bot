import test from 'node:test';
import assert from 'node:assert/strict';
import { ladderCandidates, costedPair } from '../auction-pairs.mjs';

test('only identical auction rules produce comparable thresholds', () => {
  const m = {
    event_ticker: 'KXART-TEST',
    market_type: 'binary',
    notional_value_dollars: '1.0000',
    status: 'active',
    floor_strike: 500000,
    strike_type: 'greater',
    rules_primary: 'If A on Artnet is above $500K then Yes.',
    rules_secondary: 'With premium.',
    close_time: '2027-01-01T00:00:00Z',
    yes_ask_dollars: '0.41',
    no_ask_dollars: '0.62'
  };
  const high = {
    ...m,
    floor_strike: 600000,
    rules_primary: m.rules_primary.replace('500K', '600K'),
    no_ask_dollars: '0.42'
  };
  const scan = (hi) =>
    ladderCandidates([m, hi], Date.parse('2026-01-01')).pairs.length;
  assert.equal(scan(high), 1);
  const numeric = (m) => ({
    ...m,
    event_ticker: 'KXBTCD-TEST',
    rules_primary:
      'If the index is above ' + m.floor_strike + ' at noon then YES.'
  });
  assert.equal(
    ladderCandidates([numeric(m), numeric(high)], Date.parse('2026-01-01'))
      .pairs.length,
    1
  );
  assert.equal(
    ladderCandidates([m, numeric(high)], Date.parse('2026-01-01')).pairs.length,
    0
  );
  for (const changed of [
    { rules_secondary: 'Without premium.' },
    { rules_primary: high.rules_primary.replace('Artnet', 'Phillips') },
    { floor_strike: 800000 },
    { event_ticker: 'KXART-OTHER' },
    { notional_value_dollars: '0.5000' },
    { status: 'closed' }
  ])
    assert.equal(scan({ ...high, ...changed }), 0);
});
test('two-leg executable-depth model includes both taker fees', () => {
  const pair = (p, size) => [
    { body: { orderbook_fp: { no_dollars: [['0.59', '1.0']] } } },
    { body: { orderbook_fp: { yes_dollars: [[p, size]] } } }
  ];
  assert.ok(costedPair(pair('0.58', '2.0')));
  assert.equal(costedPair(pair('0.42', '2.0')), null);
  assert.equal(costedPair(pair('0.58', '0.99')), null);
});
