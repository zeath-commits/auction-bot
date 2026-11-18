import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger, addPaper } from '../strategy-monitor.mjs';
import {
  auctionPortfolio,
  auctionHoldings,
  auctionStudyHoldings,
  registerExitTrials,
  checkExitTrials,
  exitTrialResults,
  exitQuote
} from '../auction-portfolio.mjs';
test('paper exit freezes the cohort and requires two fresh profitable books for every leg', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paper-exit-')),db=openLedger(dir);
  try {
    const at=Math.floor(Date.now()/1000)*1000,strategy='art_record_pair';
    for (const [ticker,side,price] of [['AN','yes',0.74],['LOT','no',0.20]])
      addPaper(db,{id:ticker,strategy,ticker,side,price,fees:0.01,quantity:10,at:new Date(at).toISOString()});
    const held=auctionStudyHoldings(db);
    registerExitTrials(db,held,at);
    registerExitTrials(db,held.map(h=>({...h,quantity:h.quantity*2,cost:h.cost*2})),at+1);
    const snap=(ms,size,yesPrice='0.85')=>({requestedAt:ms,receivedAt:ms+20,httpDate:new Date(ms).toUTCString(),
      body:{orderbooks:[{ticker:'AN',orderbook_fp:{yes_dollars:[[yesPrice,'20']]}},
        {ticker:'LOT',orderbook_fp:{no_dollars:[['0.15',size]]}}]}});
    const a=snap(at+1000,'10'),b=snap(at+2200,'10');
    const check=(first,second,tickers=['AN','LOT'])=>checkExitTrials(db,held,first,second,tickers);
    check(a,b,['AN']);
    check(a,{...b,httpDate:a.httpDate});
    check(a,snap(at+2200,'9'));
    check(snap(at+1000,'10','0.80'),snap(at+2200,'10','0.80'));
    assert.equal(exitTrialResults(db)[0].soldAt,null);
    check(a,b);
    check(a,snap(at+3200,'10'));
    let t=exitTrialResults(db)[0];
    assert.equal(t.soldAt,b.receivedAt);
    assert.ok(Math.abs(t.cost-9.42)<1e-8 && Math.abs(t.exitNet-0.40)<1e-8);
    db.prepare("UPDATE paper SET payout=10 WHERE ticker='AN'").run();
    assert.equal(exitTrialResults(db)[0].heldNet,null);
    db.prepare("UPDATE paper SET payout=0 WHERE ticker='LOT'").run();
    assert.ok(Math.abs(exitTrialResults(db)[0].heldNet-0.58)<1e-8);
  } finally {
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('auction cash reserves open cost, releases final payout and excludes parallel single-share tests', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE paper(ticker,side,strategy,quantity,price,fees,payout);INSERT INTO paper VALUES ('T','no','late_auction',100,.98,.14,NULL),('T','no','sale_depth',1,.95,.01,NULL),('T','no','unsold',1,.92,.01,NULL),('S','yes','sothebys_sold',2,.50,.04,2)"
    );
    const p = auctionPortfolio(db),
      h = auctionHoldings(db);
    assert.equal(p.openQuantity, 101);
    assert.ok(Math.abs(p.openCost - 99.1) < 1e-7);
    assert.ok(Math.abs(p.settledNet - 0.96) < 1e-7);
    assert.ok(Math.abs(p.cash - 901.86) < 1e-7);
    assert.equal(h.length, 1);
    assert.equal(h[0].quantity, 101);
    db.exec("INSERT INTO paper VALUES ('T','no','art_record_pair',2,.04,.01,NULL),('T','no','art_range_bids',7,.5,.05,NULL)");
    assert.deepEqual(auctionStudyHoldings(db).map(p=>[p.strategy,p.quantity]),[['art_range_bids',7],['art_record_pair',2]]);
    assert.equal(auctionHoldings(db)[0].quantity,101);
  } finally {
    db.close();
  }
});
test('selling NO uses repeated NO bids in best-price order and reports unpriced holdings', () => {
  const b = (rows) => ({
    orderbook_fp: { no_dollars: rows, yes_dollars: [['.99', '9999']] }
  });
  const a = b([
      ['0.90', '5.80'],
      ['0.81', '11']
    ]),
    second = b([
      ['0.92', '9'],
      ['0.90', '2.90'],
      ['0.81', '7']
    ]);
  const p = { quantity: 10, side: 'no', cost: 9.5 };
  const q = exitQuote(p, a, second);
  assert.equal(q.quantity, 9);
  assert.equal(q.unpriced, 1);
  assert.equal(q.netIfFullySold, null);
  assert.deepEqual(
    q.levels.map((l) => [l.price, l.quantity]),
    [
      [0.9, 2],
      [0.81, 7]
    ]
  );
  const full = exitQuote({ ...p, quantity: 2, cost: 1.9 }, a, second);
  assert.ok(Math.abs(full.proceeds - 1.7874) < 1e-7);
  assert.ok(Math.abs(full.netIfFullySold + 0.1126) < 1e-7);
  assert.equal(exitQuote({...p, strategy:'art_record_pair',quantity:2},a,second).fees,0.02);
});
