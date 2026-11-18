import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSothebys, confirmedBid } from '../sothebys-bids.mjs';
import { bidWindows } from '../live-bid-replay.mjs';

test('live crossing needs a matched lot, active bidding, and a strictly lower strike', () => {
  const c = {
    url: 'https://www.sothebys.com/sale',
    auctionId: 'auction',
    sale: 'S',
    targets: [
      {
        event: 'E',
        lot: '1',
        id: 'L',
        title: 'T',
        artist: 'A',
        url: 'https://www.sothebys.com/sale/art'
      }
    ]
  };
  const card = {
    __typename: 'LotCard',
    lotId: 'L',
    lotNumber: { lotDisplayNumber: '1' },
    sapAuctionSaleNumber: 'S',
    title: 'T',
    creatorsDisplayTitle: 'A',
    withdrawnState: { state: 'NotAffected' },
    slug: { lotSlug: 'art' },
    bidState: { __ref: 'bid' }
  };
  const bid = {
    isClosed: false,
    numberOfBids: 3,
    reserveMet: false,
    bidTypeV2: { liveBidPhase: 'Live' },
    sold: { isSold: false },
    currentBidV2: { amount: '4000', currency: 'USD' }
  };
  const read = () =>
    extractSothebys(
      '<script id="__NEXT_DATA__">' +
        JSON.stringify({
          props: {
            pageProps: { auctionId: 'auction', apolloCache: { card, bid } }
          }
        }) +
        '</script>',
      c
    )[0];
  assert.equal(read().bid, 4000);
  bid.bidTypeV2.liveBidPhase = 'Upcoming';
  assert.equal(read().bid, null);
  bid.isClosed = true;
  bid.bidTypeV2.liveBidPhase = 'Closed';
  bid.sold.__typename = 'ResultVisible';
  assert.equal(read().explicitUnsold, true);
  bid.sold.isSold = true;
  bid.sold.premiums = { finalPriceV2: { currency: 'USD', amount: '4200' } };
  assert.equal(read().salePrice, 4200);
  assert.equal(read().bid, null);
  card.lotId = 'different';
  assert.throws(read, /identity/);
});
test('two fresh source responses and executable quotes are required before paper entry', () => {
  const a = {
    ticker: 'T',
    strike: 100,
    bid: 110,
    count: 2,
    at: 10000,
    generation: 9000,
    size: 5,
    price: 0.93
  };
  const b = { ...a, at: 20000, generation: 19000 };
  assert.ok(confirmedBid(a, b));
  assert.ok(confirmedBid({ ...a, price: 0.98 }, { ...b, price: 0.97 }, true));
  assert.ok(!confirmedBid({ ...a, price: 0.99 }, { ...b, price: 0.98 }, true));
  for (const change of [
    { bid: 100 },
    { bid: 109 },
    { count: 1 },
    { at: 41000 },
    { generation: 9000 },
    { size: 0.99 },
    { price: 0.94 },
    { ticker: 'ALT' }
  ])
    assert.ok(!confirmedBid(a, { ...b, ...change }));
  assert.ok(!confirmedBid({ ...a, bid: 100 }, b));
});
test('archived crossings expire and cannot bridge gaps or equality', () => {
  const t = Date.parse('2026-11-17T00:00Z');
  const rows = [0, 20000, 40000, 60000].map((ms, i) => ({
    tick: i,
    at: new Date(t + ms).toISOString(),
    until: t + ms + 10000,
    bid: i === 0 ? 100 : 110,
    count: 3
  }));
  rows[3].tick++;
  assert.deepEqual(bidWindows(rows, 100, true), [[t + 41000, t + 50000]]);
  assert.equal(bidWindows(rows, 110, false).length, 0);
});
