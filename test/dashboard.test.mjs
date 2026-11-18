import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT } from '../bot.mjs';

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
        'parsers.mjs',
        'transport.mjs',
        'strategy-monitor.mjs',
        'auction-pairs.mjs',
        'late-auction.mjs',
        'us-bitcoin-paper.mjs',
        'bitcoin-reference.mjs',
        'sothebys-bids.mjs',
        'sothebys-sold.mjs',
        'sold-limits.mjs',
        'nba-paper.mjs',
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
          { ...receipt, clientOrderId: 'orphan' },
          { ...receipt, mode: 'paper' },
          { ...receipt, filled: 0 },
          { ...receipt, hypothetical: true }
        ]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n'
      );
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
      assert.ok(!(await status.text()).includes('PRIVATE-TEST'));
      assert.equal((await fetch(base + '/api/account')).status, 401);
      const headers = {
        Authorization:
          'Basic ' + Buffer.from('owner:test-private').toString('base64')
      };
      const account = await (
        await fetch(base + '/api/account', { headers })
      ).json();
      assert.equal(account.mode, 'paper');
      assert.deepEqual(
        account.history.map((r) => [r.ticker, r.quantity, r.cost]),
        [['BOT-TEST', 2, 1.05]]
      );
      assert.equal(
        (await fetch(base + '/api/account', { headers, method: 'POST' }))
          .status,
        405
      );
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
