import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSothebys,
  confirmedBid,
  sourceGeneration
} from '../sothebys-bids.mjs';
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
  card.withdrawnState.state = 'UnWithdrawn';
  assert.equal(read().salePrice, 4200);
  for (const state of ['Withdrawn', 'Unknown', null]) {
    card.withdrawnState.state = state;
    assert.equal(read().salePrice, null);
    assert.equal(read().explicitUnsold, false);
  }
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

test('response Date advancing with CDN Age cannot reconfirm the same cached catalog', () => {
  assert.equal(
    sourceGeneration(42653, 43000, 4),
    sourceGeneration(47369, 48000, 9)
  );
  assert.ok(
    sourceGeneration(54000, 54000, 0) > sourceGeneration(47369, 48000, 9)
  );
});

test('lot page requires the matched auction currency and a closed sale', () => {
  const target = {
    id: 'I',
    event: 'E',
    lot: '4',
    url: 'https://www.sothebys.com/sale/art',
    artist: 'A',
    title: 'T'
  };
  const c = {
    url: 'https://www.sothebys.com/sale',
    sale: 'S',
    auctionId: 'Auction',
    targets: [target]
  };
  const lot = {
    lotId: 'I',
    __typename: 'LotV2',
    lotNumber: { lotDisplayNumber: '4' },
    title: 'T',
    creatorsDisplayTitle: 'A',
    slug: 'art',
    sapAuctionSaleNumber: 'S',
    auction: { __ref: 'auction' },
    bidState: { __ref: 'b' },
    withdrawnState: { __ref: 'withdrawal' }
  };
  const b = {
    isClosed: true,
    bidTypeV2: { liveBidPhase: 'Closed' },
    sold: {
      __typename: 'ResultVisible',
      isSold: true,
      premiums: { finalPriceV2: { amount: '1000' } }
    }
  };
  const auction = { auctionId: 'Auction', currency: 'USD', currencyV2: 'USD' };
  const page = {
    auctionId: 'Auction',
    lotId: 'I',
    apolloCache: { lot, b, auction, withdrawal: { state: 'UnWithdrawn' } }
  };
  const read = () =>
    extractSothebys(
      '<script id="__NEXT_DATA__">' +
        JSON.stringify({ props: { pageProps: page } }) +
        '</script>',
      c,
      target
    )[0];
  assert.equal(read().salePrice, 1000);
  auction.currencyV2 = 'EUR';
  assert.equal(read().salePrice, null);
  auction.currencyV2 = 'USD';
  b.sold.premiums.finalPriceV2.currency = 'EUR';
  assert.equal(read().salePrice, null);
  delete b.sold.premiums.finalPriceV2.currency;
  b.isClosed = false;
  b.bidTypeV2.liveBidPhase = 'Live';
  assert.equal(read().salePrice, null);
  page.lotId = 'Different';
  assert.throws(read, /identity/);
});
