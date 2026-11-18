import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT } from './bot.mjs';
import { Transport } from './transport.mjs';
import {
  addPaper,
  observe,
  openLedger,
  strategies
} from './strategy-monitor.mjs';

const runtime = path.join(ROOT, 'runtime');
const db = openLedger(runtime);
const config = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      fs.existsSync(path.join(ROOT, 'config.json'))
        ? 'config.json'
        : 'config.example.json'
    )
  )
);
const status = { state: 'Starting', at: null };
let stopping = false;
const exists = fs.existsSync;
function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function records(file) {
  if (!exists(file)) return [];
  // A worker may be appending the last line when the dashboard reads its journal.
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
function botReceipts() {
  const rows = records(path.join(runtime, 'live', 'orders.jsonl'));
  const intents = new Map(
    rows.filter((r) => r.type === 'intent').map((r) => [r.clientOrderId, r])
  );
  return rows
    .filter(
      (r) =>
        r.mode === 'live' &&
        r.type === 'receipt' &&
        !r.hypothetical &&
        r.filled > 0
    )
    .map((r) => {
      const order = intents.get(r.clientOrderId);
      return {
        ticker: order?.ticker,
        side: order?.side,
        quantity: r.filled,
        cost: r.costCents / 100,
        at: r.recordedAt,
        source: 'Bot execution receipt',
        net: r.realizedProfit ?? null
      };
    });
}
function importAuction() {
  const archived = path.join(ROOT, 'research.json');
  if (exists(archived)) for (const r of json(archived).paper) addPaper(db, r);
  const track = (row, id, kind, at) => {
    const q = row.quote;
    if (!q?.quantity || !strategies[kind]) return;
    addPaper(db, {
      id,
      strategy: kind,
      ticker: row.ticker,
      side: row.side.toLowerCase(),
      at,
      quantity: q.quantity,
      price: (q.reserveCents - q.feeReserveCents) / 100 / q.quantity,
      fees: q.feeReserveCents / 100,
      closeAt: row.marketClose
    });
  };
  const rows = records(path.join(runtime, 'paper', 'orders.jsonl'));
  const receipts = new Set(
    rows
      .filter((r) => r.type === 'receipt' && r.hypothetical)
      .map((r) => r.clientOrderId)
  );
  for (const r of rows.filter(
    (r) => r.type === 'intent' && receipts.has(r.clientOrderId)
  ))
    track(
      r,
      r.clientOrderId,
      r.kind === 'current_bid' ? 'live_bid' : (r.kind ?? 'published_sale'),
      r.recordedAt
    );
  const bids = path.join(runtime, 'paper-bids');
  if (exists(bids))
    for (const sale of fs.readdirSync(bids)) {
      for (const r of records(path.join(bids, sale, 'signals.jsonl')).filter(
        (r) => ['paper_buy_yes', 'paper_buy_no'].includes(r.decision)
      ))
        track(
          r,
          'bid/' + sale + '/' + r.ticker,
          r.strategy === 'explicit_unsold' ? 'unsold' : 'live_bid',
          r.observedAt ?? r.bookAt
        );
    }
}
const cachedDays = new Map();
function replay() {
  const dir = path.join(runtime, 'replay');
  const baseline = path.join(ROOT, 'replay-baseline.json');
  const byDay = new Map(
    (exists(baseline) ? json(baseline) : []).map((r) => [r.day, r])
  );
  for (const f of (exists(dir) ? fs.readdirSync(dir) : []).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.json$/.test(f)
  )) {
    const file = path.join(dir, f);
    const stamp = fs.statSync(file).mtimeMs;
    const cached = cachedDays.get(f);
    if (cached?.stamp === stamp) {
      byDay.set(cached.day, cached.summary);
      continue;
    }
    const { rows, listed, possible } = json(file);
    const prints = rows.filter((r) => r.first);
    const day = f.slice(0, 10);
    const ten = rows.filter((r) => r.finalTen);
    const modeledNet = (cohort, field) =>
      cohort.reduce((sum, r) => {
        const p = r[field].price;
        return (
          sum +
          Number(r[field].side === r.result) -
          p -
          Math.ceil(0.07 * p * (1 - p) * 10000 - 1e-9) / 10000
        );
      }, 0);
    byDay.set(day, {
      day,
      windows: rows.length,
      listed: listed ?? rows.length,
      possible: possible ?? 96,
      prints: prints.length,
      byPrice: [0.98, 0.99].map((price) => {
        const cohort = prints.filter((r) => r.first.price === price);
        return {
          price,
          count: cohort.length,
          wins: cohort.filter((r) => r.first.side === r.result).length,
          net: modeledNet(cohort, 'first')
        };
      }),
      wins: prints.filter((r) => r.first.side === r.result).length,
      finalTen: rows.every((r) => 'finalTen' in r)
        ? {
            count: ten.length,
            wins: ten.filter((r) => r.finalTen.side === r.result).length,
            net: modeledNet(ten, 'finalTen')
          }
        : null,
      net: modeledNet(prints, 'first'),
      gross: prints.reduce(
        (sum, r) => sum + Number(r.first.side === r.result) - r.first.price,
        0
      ),
      losses: prints
        .filter((r) => r.first.side !== r.result)
        .map((r) => ({ ticker: r.ticker, ...r.first, result: r.result }))
    });
    cachedDays.set(f, { stamp, day, summary: byDay.get(day) });
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}
const account = {
  state: 'Account API disconnected',
  asOf: null,
  fills: [],
  settlements: []
};
async function refreshAccount() {
  if (
    !process.env[config.apiKeyIdEnvironmentVariable] ||
    !(process.env.KALSHI_PRIVATE_KEY_PATH || config.privateKeyPath)
  )
    return;
  try {
    const io = new Transport(config);
    await io.loadCredentials(true);
    const q = '?limit=100&subaccount=' + config.subaccount;
    const [fills, settled] = await Promise.all(
      ['/portfolio/fills', '/portfolio/settlements'].map((route) =>
        io.get(route + q, true)
      )
    );
    account.fills = fills.body.fills.map((r) => ({
      ticker: r.ticker,
      at: r.created_time,
      side: r.side,
      action: r.action,
      quantity: r.count_fp,
      price: r[r.side + '_price_dollars'],
      fee: r.fee_cost
    }));
    account.settlements = settled.body.settlements.map((r) => ({
      ticker: r.ticker,
      at: r.settled_time,
      result: r.market_result,
      revenue: Number.isFinite(r.revenue) ? r.revenue / 100 : null
    }));
    account.asOf = new Date().toISOString();
    account.state = 'Connected · latest 100 fills and settlements';
  } catch {
    account.state = 'Account API unavailable · check credentials or connection';
  }
}

const watch = json(path.join(ROOT, 'watchlist.json'));
const children = new Set();
function launchWorker(args) {
  const child = spawn(process.execPath, ['bot.mjs', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
}
let replayProcess;
function nightlyReplay() {
  if (stopping || replayProcess || exists(path.join(ROOT, 'STOP'))) return;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const day = fmt.format(Date.now() - 86400000);
  if (replay().some((r) => r.day === day)) return;
  // Convert each Eastern midnight separately so DST days span 23 or 25 hours.
  function midnight(date) {
    const anchor = Date.parse(date + 'T00:00:00Z');
    const guessed = new Date(anchor + 4 * 3600000);
    return fmt.format(guessed) === date
      ? guessed.toISOString()
      : new Date(anchor + 5 * 3600000).toISOString();
  }
  const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86400000)
    .toISOString()
    .slice(0, 10);
  const child = spawn(
    process.execPath,
    ['btc-replay.mjs', midnight(day), midnight(tomorrow)],
    { cwd: ROOT, windowsHide: true, stdio: 'inherit' }
  );
  replayProcess = child;
  children.add(child);
  child.on('exit', () => {
    children.delete(child);
    replayProcess = null;
  });
}
const auctionStatus = {
  offers: 'Outside watch window',
  bids: 'Outside watch window'
};
function runAuctions() {
  if (stopping || exists(path.join(ROOT, 'STOP'))) return;
  const now = Date.now();
  const current = watch.auctions.some(
    (a) => now < Date.parse(a.deadline) + config.offerTailHours * 3600000
  );
  const christies = watch.auctions.some(
    (a) => a.house === 'christies' && now < Date.parse(a.deadline)
  );
  if (
    current &&
    ![...children].some((c) => c.spawnargs.includes('--watch-offers'))
  )
    launchWorker(['--paper', '--watch-offers']);
  if (
    christies &&
    ![...children].some((c) => c.spawnargs.includes('--paper-bids'))
  )
    launchWorker(['--paper-bids']);
  auctionStatus.offers = current
    ? 'Within configured watch window'
    : 'Outside watch window';
  auctionStatus.bids = christies
    ? 'Within configured watch window'
    : 'Outside watch window';
}

// Port-only cloud deployments expose public research data. Personal records
// require a password on any non-loopback listener, even behind a reverse proxy.
const host =
  process.env.DASHBOARD_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || 8787);
const password = process.env.DASHBOARD_PASSWORD;
const digest = (s) => createHash('sha256').update(s).digest();
const local = host === '127.0.0.1' || host === '::1';
function owner(req) {
  if (local && !password) return true;
  if (!password) return false;
  const expected =
    'Basic ' + Buffer.from('owner:' + password).toString('base64');
  return timingSafeEqual(
    digest(req.headers.authorization || ''),
    digest(expected)
  );
}
const assets = {
  '/': ['dashboard.html', 'text/html'],
  '/dashboard.js': ['dashboard.js', 'text/javascript'],
  '/dashboard.css': ['dashboard.css', 'text/css']
};
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
  if (
    local &&
    !['localhost', '127.0.0.1', '[::1]'].some(
      (h) => req.headers.host === h || req.headers.host === h + ':' + port
    )
  ) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  const route = req.url.split('?')[0];
  try {
    if (route === '/api/account' && !owner(req)) {
      if (password)
        res.setHeader(
          'WWW-Authenticate',
          'Basic realm="Private trading records"'
        );
      res.writeHead(password ? 401 : 403).end();
      return;
    }
    if (route === '/api/status' || route === '/api/account') {
      let body;
      if (route === '/api/status') {
        const paper = db
          .prepare(
            'SELECT *, payout-price*quantity-fees AS net FROM paper ORDER BY at DESC'
          )
          .all();
        body = {
          status,
          auctionStatus,
          strategies,
          paper,
          replay: replay(),
          research: json(path.join(ROOT, 'research.json')).studies,
          windows: db
            .prepare(
              'SELECT COUNT(*) AS n,COALESCE(SUM(checks),0) AS checks FROM windows'
            )
            .get()
        };
      } else {
        const file = path.join(runtime, 'account-history.json');
        body = {
          ...account,
          history: [...(exists(file) ? json(file) : []), ...botReceipts()]
        };
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(body));
    } else if (Object.hasOwn(assets, route)) {
      const [file, type] = assets[route];
      res
        .writeHead(200, { 'Content-Type': type + '; charset=utf-8' })
        .end(fs.readFileSync(path.join(ROOT, file)));
    } else res.writeHead(404).end();
  } catch {
    res.writeHead(500).end('Dashboard data unavailable');
  }
});
server.listen(port, host, () => {
  console.log(
    'Strategy dashboard listening on ' + host + ':' + server.address().port
  );
  function importSafe() {
    try {
      importAuction();
      status.importError = null;
    } catch (e) {
      status.importError = e.message;
    }
  }
  importSafe();
  runAuctions();
  refreshAccount();
  setTimeout(nightlyReplay, 60000).unref();
  setInterval(nightlyReplay, 3600000).unref();
  setInterval(importSafe, 15000).unref();
  setInterval(runAuctions, 60000).unref();
  setInterval(refreshAccount, 60000).unref();
  observe({
    db,
    config,
    status,
    stop: () => stopping || exists(path.join(ROOT, 'STOP'))
  })
    .then(() => {
      status.state = 'Stopped';
      status.at = new Date().toISOString();
    })
    .catch((e) => {
      status.state = 'Stopped';
      status.error = e.message;
    });
});
function shutdown() {
  stopping = true;
  for (const c of children) c.kill();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
