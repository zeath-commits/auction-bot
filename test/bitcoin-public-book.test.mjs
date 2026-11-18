import assert from 'node:assert/strict';
import test from 'node:test';
import { usPublic } from '../bitcoin-reference.mjs';

test('US closing book refreshes once per UTC second and rejects cached and rate-limited reads', async t => {
  const route = '/v1/markets/cpc-btc-updown-5m-2026-11-18-2040z/book';
  const requests = [];
  let now = 1795034500000;
  t.mock.method(Date, 'now', () => now);
  const responses = [
    new Response('{}'), new Response('{}'), new Response('{}'),
    new Response('{}', { headers: { Age: '10' } }),
    new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    new Response('{}')
  ];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(new URL(url));
    return responses.shift();
  });
  await usPublic(route);
  now += 999;
  await usPublic(route);
  assert.equal(requests[0].href, requests[1].href);
  assert.equal(requests[0].searchParams.get('asof'), '1795034500');
  now++;
  await usPublic(route);
  assert.equal(requests[2].searchParams.get('asof'), '1795034501');
  await assert.rejects(usPublic(route), /Cached US book/);
  await assert.rejects(usPublic(route), e => e.status === 429 && e.retryAfterMs === 60000);
  await usPublic('/v1/market/slug/example');
  assert.equal(requests[5].search, '');
  assert.equal(responses.length, 0);
});
