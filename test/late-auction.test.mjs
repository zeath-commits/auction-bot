import test from 'node:test';
import assert from 'node:assert/strict';
import { persistentOffer } from '../late-auction.mjs';

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
});
