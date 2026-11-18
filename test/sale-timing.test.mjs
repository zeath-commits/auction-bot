import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { saleTiming } from '../sale-timing.mjs';
import { quoteTiming } from '../auction-quote-timing.mjs';
test('pre-sale depth overlaps only at the same strike, outcome and price through 95 cents', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const store=quoteTiming(db);
    const row=(ticker,strike,yes,no)=>({event:'E',ticker,strike,depth:{yes,no},yes:null,no:null});
    const initial=[row('T1',100,[[900000,8]],[[910000,99]]),row('T2',110,[],[[940000,4],[960000,20]])];
    store.recordBaseline('E',1000,initial);
    const later=[row('T1',100,[[900000,3],[930000,7]],[]),row('T2',110,[],[[940000,6],[960000,25]])];
    store.recordBaseline('E',2000,later);
    store.record({begin:5000,asOf:5000,at:5200,rows:later});
    const check=store.compare('E',4900,110);
    assert.equal(check.baselineAt,1000);
    assert.equal(check.baselineShares,12);
    assert.deepEqual(check.after.depth95,{shares:16,overlap:7});
    assert.equal(check.after30,null);
  } finally {db.close();}
});
test('auction quote timing excludes straddling requests and distinguishes an empty book from missing coverage', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const timing = quoteTiming(db), anchor = 100000;
    const row = {event:'E',ticker:'T',strike:100,yes:{price:0.6,size:2},no:{price:0.72,size:1}};
    const save = (begin,at,r,asOf=begin) => timing.record({begin:anchor+begin,at:anchor+at,asOf:anchor+asOf,rows:[r]});
    save(-2000,-1000,row);
    save(-40,20,{...row,no:{price:0.04,size:2}});
    save(50,130,{...row,no:{price:0.08,size:2}},-900);
    save(80,180,{...row,no:null});
    save(30000,30100,row);
    const result = timing.compare('E',anchor,100);
    assert.equal(result.before.best,0.72);
    assert.equal(result.before.lagMs,-1000);
    assert.equal(result.after.quoted,0);
    assert.equal(result.after30.best,0.72);
    assert.equal(result.after300,null);
    assert.equal(timing.compare('E',anchor+20000,101).before,null);
  } finally {db.close();}
});
test('first source comparison preserves missed offers, origin receipt order and actual prices', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const t = { event: 'E', title: 'Art' },
      timing = saleTiming(db, [t]),
      base = Date.now();
    const read = (at, price, fresh = true) => ({
      at,
      requestedAt: at - 99,
      age: 0,
      soldFresh: fresh,
      lots: [{ event: 'E', phase: 'Closed', salePrice: price }]
    });
    const m = {
      ticker: 'T',
      floor_strike: 100,
      status: 'active',
      close_time: new Date(base + 60000).toISOString()
    };
    const ctx = {
      stop: () => false,
      marketList: async () => [m],
      io: {
        get: async () => ({
          receivedAt: base + 800,
          requestedAt: base + 500,
          body: {
            orderbooks: [
              { ticker: 'T', orderbook_fp: { yes_dollars: [['0.12', '2.00']] } }
            ]
          }
        })
      }
    };
    await timing.record('lot', read(base - 3000, null), ctx);
    await timing.record('lot', read(base - 2000, 90, false), ctx);
    assert.equal(timing.summary()[0].lot, null);
    await timing.record('lot', read(base, 100), ctx);
    await timing.record('catalog', read(base + 400, 100), ctx);
    assert.equal(timing.remaining().length, 0);
    let row = timing.summary()[0];
    assert.equal(row.lotLeadMs, 400);
    assert.equal(row.lot.best, 0.88);
    assert.equal(row.lot.previous, base - 3000);
    assert.equal(row.catalog.previous, null);
    await timing.record('catalog', read(base + 1000, 105), ctx);
    assert.equal(timing.remaining().length, 1);
    assert.equal(timing.summary()[0].catalog.price, 100);
  } finally {
    db.close();
  }
});
