import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openLedger, addPaper, paperRows } from '../strategy-monitor.mjs';
import { initSoldStudy, recordSoldBooks, scanSold, publishedVerdicts } from '../sothebys-sold.mjs';
import { auctionDepthCash } from '../late-auction.mjs';

test('artwork-page confirmation uses independent books and shares inventory with catalog confirmations', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'sold-page-')),db=openLedger(dir);
  try {
    initSoldStudy(db);
    const q={ticker:'T',sourceKind:'lot',amount:120e6,side:'NO',generation:1000,at:2500,sourceAt:2000,
      bookAsOf:2000,url:'artwork',closeAt:20000,book:{orderbook_fp:{yes_dollars:[['0.10','4.0']]}}};
    const next={...q,generation:4000,at:5500,bookAsOf:5000,sourceAt:5100};
    const prior=new Map([['T',q]]);
    assert.equal(recordSoldBooks(db,[{...next,bookAsOf:q.bookAsOf}],prior,30000).contracts,0);
    assert.equal(recordSoldBooks(db,[next],prior,30000).contracts,4);
    assert.equal(recordSoldBooks(db,[{...next,at:6000,sourceKind:'catalog'}],new Map([['T',{...q,sourceKind:'catalog'}]]),30000).contracts,0);
    assert.equal(JSON.parse(db.prepare('SELECT detail FROM sothebys_sold_entries').get().detail).sourceKind,'lot');
    const v=publishedVerdicts(db);
    const save=(kind,generation,price,extra={})=>v.record(kind,{soldFresh:true,generation,at:generation+500,
      lots:[{event:'E',salePrice:price,...extra}]});
    save('lot',3000,120e6);
    save('catalog',4000,119e6);
    assert.equal(v.accepts('E',120e6),false);
    save('catalog',2000,120e6);
    assert.equal(v.accepts('E',120e6),false);
    save('catalog',5000,120e6);
    assert.equal(v.accepts('E',120e6),true);
    save('lot',6000,null,{withdrawn:'Withdrawn'});
    assert.equal(v.accepts('E',120e6),false);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('sold-price study shares cash across auctions and takes cheapest confirmed levels only once', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sold-depth-')),
    db = openLedger(directory);
  try {
    initSoldStudy(db);
    addPaper(db, {
      id: 'earlier',
      strategy: 'late_auction',
      ticker: 'older',
      side: 'no',
      at: 'earlier',
      quantity: 1000,
      price: 0.998,
      fees: 0
    });
    const sample = (ticker, bid, side) => ({
      ticker,
      side,
      amount: 5000,
      at: 5000,
      generation: 4000,
      sourceAt: 4800,
      closeAt: 20000,
      url: 'https://www.sothebys.com/',
      book: {
        orderbook_fp: {
          [side === 'YES' ? 'no_dollars' : 'yes_dollars']: [[bid, '8.00']]
        }
      }
    });
    const quotes = [
      sample('EXPENSIVE', '0.0100', 'YES'),
      sample('CHEAP', '0.5000', 'NO')
    ];
    const prior = new Map(
      quotes.map((q) => [q.ticker, { ...q, at: 2000, generation: 1000 }])
    );
    assert.equal(recordSoldBooks(db, quotes, new Map(), 30000).contracts, 0);
    assert.equal(recordSoldBooks(db, quotes, prior, 30000).contracts, 3);
    const bought = paperRows(db).filter((r) => r.strategy === 'sothebys_sold');
    assert.equal(bought.length, 1);
    assert.deepEqual(
      [bought[0].ticker, bought[0].side, bought[0].quantity],
      ['CHEAP', 'no', 3]
    );
    assert.ok(Math.abs(auctionDepthCash(db) - 0.4475) < 1e-7);
    assert.equal(recordSoldBooks(db, quotes, prior, 30000).contracts, 0);
    db.prepare("UPDATE paper SET payout=998 WHERE id='earlier'").run();
    const next = quotes.map((q) => ({ ...q, at: 8000, generation: 7000 }));
    assert.equal(
      recordSoldBooks(
        db,
        next,
        new Map(quotes.map((q) => [q.ticker, q])),
        30000
      ).contracts,
      13
    );
    assert.equal(
      recordSoldBooks(
        db,
        next.map((q) => ({ ...q, at: 11000, generation: 10000, amount: 6000 })),
        new Map(next.map((q) => [q.ticker, q])),
        30000
      ).contracts,
      0
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('closed USD result exactly on threshold uses NO and ignores unsold and stale results', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sold-scan-')),
    db = openLedger(directory);
  try {
    initSoldStudy(db);
    const now = Date.now(),
      deadline = now + 30000,
      expiry = new Date(deadline).toISOString();
    const lots = [
      { event: 'sold', salePrice: 5000 },
      { event: 'unsold', salePrice: null, explicitUnsold: true }
    ];
    const params = {
      db,
      targets: [{ event: 'sold', url: 'public catalog' }],
      previous: new Map(),
      tail: false,
      stop: () => false,
      deadline,
      source: {
        at: now,
        age: 3,
        generation: now - 3000,
        soldFresh: true,
        lots
      },
      marketList: async (_, t) => {
        assert.equal(t.event, 'sold');
        return [
          {
            ticker: 'test',
            strike_type: 'greater',
            floor_strike: 5000,
            status: 'active',
            close_time: expiry
          }
        ];
      },
      io: {
        get: async (url) => {
          if (url === '/series/KXART')
            return {
              body: {
                series: {
                  ticker: 'KXART',
                  fee_type: 'quadratic',
                  fee_multiplier: 1
                }
              }
            };
          if (url === '/exchange/status')
            return { body: { trading_active: true, exchange_active: true } };
          assert.match(url, /tickers=test/);
          return {
            requestedAt: now,
            receivedAt: now + 50,
            body: {
              orderbooks: [
                {
                  ticker: 'test',
                  orderbook_fp: { yes_dollars: [['0.05', '4.00']] }
                }
              ]
            }
          };
        }
      }
    };
    const fresh = await scanSold(params);
    assert.equal(fresh.next.get('test').side, 'NO');
    assert.equal(fresh.status.books, 1);
    const stale = await scanSold({
      ...params,
      source: { ...params.source, soldFresh: false },
      previous: fresh.next
    });
    assert.equal(stale.next.size, 0);
    assert.equal(stale.status.contracts, 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
import { openSoldLimits } from '../sold-limits.mjs';
test('two auction price caps persist separate budgets and settle their own shares', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'two-caps-'));
  let limits = openSoldLimits(dir);
  try {
    const base = Date.now(),
      q = {
        ticker: 'T',
        side: 'NO',
        amount: 5000,
        at: base,
        generation: base - 200,
        closeAt: base + 10000,
        url: 'catalog',
        book: {
          orderbook_fp: {
            yes_dollars: [
              ['0.01', '2000'],
              ['0.1', '2']
            ]
          }
        }
      };
    const previous = new Map([
      ['T', { ...q, at: base - 2500, generation: base - 3000 }]
    ]);
    limits.record([q], previous, 30000);
    const [low, high] = limits.summary();
    assert.equal(low.quantity, 2);
    assert.ok(high.quantity > 1000);
    assert.ok(high.cost <= 1000);
    assert.equal(low.settled, 0);
    assert.equal(low.net, null);
    limits.close();
    limits = openSoldLimits(dir);
    assert.deepEqual(limits.summary(), [low, high]);
    await limits.reconcile({
      get: async () => ({
        body: { market: { ticker: 'T', result: 'no', status: 'finalized' } }
      })
    });
    for (const cohort of limits.summary()) {
      assert.equal(cohort.quantity, cohort.settled);
      assert.ok(Math.abs(cohort.quantity - cohort.cost - cohort.net) < 1e-7);
    }
  } finally {
    limits.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
