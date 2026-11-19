import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT } from '../bot.mjs';
import {botFills,ledgerFingerprint} from '../live-ledger.mjs';

test(
  'network dashboard keeps personal records behind owner access',
  { timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strategy-dashboard-'));
    let child;
    try {
      for (const file of [
        'bot.mjs',
        'core.mjs',
        'journal.mjs',
        'live-ledger.mjs',
        'parsers.mjs',
        'transport.mjs',
        'strategy-monitor.mjs',
        'auction-pairs.mjs',
        'auction-portfolio.mjs',
        'late-auction.mjs',
        'catalog-results.mjs',
        'withdrawal-reports.mjs',
        'withdrawal-bids.mjs',
        'auction-discount-bids.mjs',
        'auction-sale-samples.mjs',
        'auction-delayed-depth.mjs',
        'auction-sweep-paper.mjs',
        'us-bitcoin-paper.mjs',
        'bitcoin-reference.mjs',
        'btc-maker-study.mjs',
        'sothebys-bids.mjs',
        'sothebys-sold.mjs',
        'auction-resting.mjs',
        'auction-entry-depth.mjs',
        'public-trades.mjs',
        'sold-limits.mjs',
        'sale-timing.mjs',
        'auction-quote-timing.mjs',
        'nba-paper.mjs',
        'nba-final-queue.mjs',
        'nba-total-queue.mjs',
        'nba-total-pairs.mjs',
        'art-record-pair.mjs',
        'art-range-bids.mjs',
        'esports-paper.mjs',
        'weather-paper.mjs',
        'weather-station.mjs',
        'weather-three.mjs',
        'weather-high.mjs',
        'sothebys-bid-calendar.json',
        'watch-offers.mjs',
        'paper-unsold.mjs',
        'dashboard.mjs',
        'config.example.json',
        'research.json',
        'paper-calendar.json',
        'watchlist.json'
      ]) {
        await fs.copyFile(path.join(ROOT, file), path.join(dir, file));
      }
      await fs.mkdir(path.join(dir, 'runtime'));
      await fs.writeFile(path.join(dir, 'STOP'), '');
      await fs.writeFile(
        path.join(dir, 'runtime', 'account-history.json'),
        JSON.stringify([{ ticker: 'PRIVATE-TEST' }])
      );
      const live = path.join(dir, 'runtime', 'live');
      await fs.mkdir(live);
      const intent = {
        type: 'intent',
        mode: 'live',
        ticker: 'BOT-TEST',
        side: 'YES',
        clientOrderId: 'bot-a'
      };
      const receipt = {
        type: 'receipt',
        mode: 'live',
        clientOrderId: 'bot-a',
        orderId: 'exchange-a',
        filled: 2,
        costCents: 105
      };
      await fs.writeFile(
        path.join(live, 'orders.jsonl'),
        [
          intent,
          receipt,
          { ...receipt, recordedAt: 'later' },
          { ...intent, clientOrderId: 'conflict' },
          { ...receipt, clientOrderId: 'conflict', orderId: 'exchange-c' },
          {
            ...receipt,
            clientOrderId: 'conflict',
            orderId: 'exchange-c',
            filled: 3
          },
          { ...receipt, clientOrderId: 'orphan' },
          { ...receipt, mode: 'paper' },
          { ...receipt, filled: 0 },
          { ...receipt, hypothetical: true }
        ]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n'
      );
      const file=path.join(live,'orders.jsonl');
      const rows=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
      const reconciliation={fingerprint:ledgerFingerprint(botFills(rows)),checkedAt:new Date().toISOString(),markets:[],
        tradingNet:null,operatingCosts:null,pilotNet:null,privateMarker:'PRIVATE-PAYOUT-TEST'};
      await fs.writeFile(path.join(live,'reconciliation.json'),JSON.stringify(reconciliation));
      // Exercise network-mode authentication on loopback, with no exchange access.
      child = spawn(process.execPath, ['dashboard.mjs'], {
        cwd: dir,
        windowsHide: true,
        env: {
          ...process.env,
          PORT: '0',
          DASHBOARD_HOST: 'localhost',
          DASHBOARD_PASSWORD: 'test-private',
          KALSHI_API_KEY_ID: ''
        }
      });
      const [chunk] = await once(child.stdout, 'data');
      const port = chunk.toString().match(/localhost:(\d+)/)[1];
      const base = 'http://localhost:' + port;
      const status = await fetch(base + '/api/status');
      assert.equal(status.status, 200);
      const publicBody=await status.text();
      assert.ok(!publicBody.includes('PRIVATE-TEST')&&!publicBody.includes('PRIVATE-PAYOUT-TEST'));
      assert.equal((await fetch(base + '/api/account')).status, 401);
      const headers = {
        Authorization:
          'Basic ' + Buffer.from('owner:test-private').toString('base64')
      };
      const account = await (
        await fetch(base + '/api/account', { headers })
      ).json();
      assert.equal(account.mode, 'paper');
      assert.equal(account.reconciliation.privateMarker,'PRIVATE-PAYOUT-TEST');
      assert.equal(account.conflicts, 1);
      assert.deepEqual(
        account.history.map((r) => [r.ticker, r.quantity, r.cost]),
        [['BOT-TEST', 2, 1.05]]
      );
      assert.equal(
        (await fetch(base + '/api/account', { headers, method: 'POST' }))
          .status,
        405
      );
      await fs.appendFile(file,JSON.stringify({...intent,clientOrderId:'pending'})+'\n');
      const changed=await (await fetch(base+'/api/account',{headers})).json();
      assert.equal(changed.unresolved,1);
      assert.equal(changed.reconciliation,null);
    } finally {
      if (child && child.exitCode === null) {
        const done = once(child, 'exit');
        child.kill();
        await done;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);
