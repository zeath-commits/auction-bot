import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT } from './bot.mjs';
import { observePairs, pairSeries } from './auction-pairs.mjs';
import { observeLateAuctions } from './late-auction.mjs';
import { catalogObservations, catalogObservedAt, catalogSource, summarizeSettlement } from './catalog-results.mjs';
import { openSoldLimits } from './sold-limits.mjs';
import { Transport } from './transport.mjs';
import { observeWeather } from './weather-paper.mjs';
import {
  auctionPortfolio,
  auctionHoldings,
  observeAuctionExits
} from './auction-portfolio.mjs';
import { observeNBA } from './nba-paper.mjs';
import { observeUS } from './us-bitcoin-paper.mjs';
import { observeSothebysBids } from './sothebys-bids.mjs';
import {
  addPaper,
  observe,
  openLedger,
  paperRows,
  strategies
} from './strategy-monitor.mjs';

const runtime = path.join(ROOT, 'runtime');
const db = openLedger(runtime);
const soldLimits = openSoldLimits(runtime);
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
const lateAuctionStatus = { at: null };
const usBitcoinStatus = { at: null };
const sothebysStatus = {};
const nbaStatus = {};
const auctionExits = {};
const weatherStatus = {};
const pairStatus = Object.fromEntries(
  Object.entries(pairSeries).map(([k, label]) => [k, { label, at: null }])
);
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
    rows
      .filter(
        (r) =>
          r.type === 'intent' &&
          r.mode === 'live' &&
          r.clientOrderId &&
          r.ticker
      )
      .map((r) => [r.clientOrderId, r])
  );
  const fills = rows.filter(
    (r) =>
      r.mode === 'live' &&
      r.type === 'receipt' &&
      !r.hypothetical &&
      intents.has(r.clientOrderId) &&
      typeof r.orderId === 'string' &&
      r.orderId &&
      Number.isFinite(r.costCents) &&
      r.costCents >= 0 &&
      Number.isFinite(r.filled) &&
      r.filled > 0
  );
  const grouped = Map.groupBy(fills, (r) => r.orderId);
  const clientGroups = Map.groupBy(fills, (r) => r.clientOrderId);
  const history = [];
  let conflicts = 0;
  for (const group of grouped.values()) {
    const r = group[0],
      order = intents.get(r.clientOrderId);
    if (
      group.some(
        (x) =>
          x.clientOrderId !== r.clientOrderId ||
          x.costCents !== r.costCents ||
          x.filled !== r.filled ||
          (x.realizedProfit ?? null) !== (r.realizedProfit ?? null)
      ) ||
      clientGroups.get(r.clientOrderId).some((x) => x.orderId !== r.orderId)
    ) {
      conflicts++;
      continue;
    }
    history.push({
      ticker: order.ticker,
      side: order.side,
      quantity: r.filled,
      cost: r.costCents / 100,
      at: r.recordedAt,
      source: 'Bot execution receipt',
      net: r.realizedProfit ?? null
    });
  }
  return { history, conflicts };
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
  const rows = ['paper', 'paper-calendar'].flatMap((dir) =>
    records(path.join(runtime, dir, 'orders.jsonl'))
  );
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
function replay(cheapTaker = false) {
  const dir = path.join(runtime, cheapTaker ? 'cheap-taker' : 'replay');
  const baseline = path.join(ROOT, 'replay-baseline.json');
  const byDay = new Map(
    (!cheapTaker && exists(baseline) ? json(baseline) : []).map((r) => [r.day, r])
  );
  for (const f of (exists(dir) ? fs.readdirSync(dir) : []).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.json$/.test(f)
  )) {
    const file = path.join(dir, f);
    const stamp = fs.statSync(file).mtimeMs;
    const cached = cachedDays.get(file);
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
      byPrice: (cheapTaker ? [0.01, 0.02] : [0.98, 0.99]).map((price) => {
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
    cachedDays.set(file, { stamp, day, summary: byDay.get(day) });
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}
const calendars = ['watchlist.json', 'paper-calendar.json'].map((file) => ({
  extra: file === 'paper-calendar.json',
  auctions: json(path.join(ROOT, file)).auctions
}));
const catalogCases = catalogObservations.map(observation => ({
  ...observation, checkedAt: null, counts: null, error: null
}));
async function checkCatalogCases(io) {
  for (const item of catalogCases) {
    if (stopping || exists(path.join(ROOT, 'STOP'))) return;
    try {
      const target = calendars[0].auctions.flatMap(a => a.targets).find(t => t.event === item.event);
      const read = await io.get('/events/' + item.event + '?with_nested_markets=true');
      item.counts = summarizeSettlement(target, read.body);
      item.checkedAt = new Date(read.receivedAt).toISOString();
      item.error = null;
    } catch (e) {
      item.error = e.message;
    }
  }
}
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
const runningReplays = new Set();
let latestGlobalStudy = null;
let desktopAuctionStudy = null;
function nightlyReplay() {
  if (stopping || exists(path.join(ROOT, 'STOP'))) return;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const today = fmt.format(Date.now());
  const day = new Date(Date.parse(today + 'T00:00:00Z') - 86400000)
    .toISOString()
    .slice(0, 10);
  // Convert each Eastern midnight separately so DST days span 23 or 25 hours.
  function midnight(date) {
    const anchor = Date.parse(date + 'T00:00:00Z');
    const guessed = new Date(anchor + 4 * 3600000);
    return fmt.format(guessed) === date
      ? guessed.toISOString()
      : new Date(anchor + 5 * 3600000).toISOString();
  }
  const from = midnight(day),
    to = midnight(today);
  function launch(script, done, args = [from, to]) {
    if (runningReplays.has(script)) return;
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'inherit'
    });
    children.add(child);
    runningReplays.add(script);
    child.once('close', (code) => {
      children.delete(child);
      runningReplays.delete(script);
      if (code === 0) done?.();
    });
  }
  const auctionArchive = path.join(runtime, 'auction-desktop-replay.json');
  function readDesktopAuction() {
    if (!exists(auctionArchive)) return null;
    const d = json(auctionArchive),
      m = d.models.find((x) => x.max === 5 && x.delay === 30 && !x.book);
    if (!m) return null;
    desktopAuctionStudy = {
      market: 'Fine art',
      test:
        'November 17 alerts · checked ' +
        d.at.slice(0, 16).replace('T', ' ') +
        ' UTC',
      finding:
        m.entries.length +
        ' thresholds on ' +
        m.lots +
        ' artworks had a qualifying buyer 30 seconds or more after the alert signal. Modeled ' +
        m.quantity +
        ' contracts at $' +
        m.cost.toFixed(2) +
        ' including fees. ' +
        d.checked.length +
        ' thresholds finalized, ' +
        d.pending.length +
        ' pending. ' +
        (m.net == null
          ? 'Payouts for selected trades are pending.'
          : 'Modeled net after settlement $' + m.net.toFixed(2) + '.')
    };
    const repeat = d.repeated?.repeat;
    if (repeat)
      desktopAuctionStudy.finding +=
        ' Grouping simultaneous fills and allowing another purchase after 60 seconds gave ' +
        repeat.entries.length +
        ' modeled entries across ' +
        repeat.tickers +
        ' thresholds, ' +
        repeat.quantity +
        ' shares and $' +
        repeat.cost.toFixed(2) +
        ' in cost.';
    return d;
  }
  const auction = readDesktopAuction();
  if (
    !auction ||
    (auction.pending.length &&
      Date.now() - Date.parse(auction.at) >= 6 * 3600000)
  )
    launch('auction-tape-replay.mjs', readDesktopAuction, ['--desktop']);
  if (!replay().some((r) => r.day === day)) launch('btc-replay.mjs');
  if (!exists(path.join(runtime, 'cheap-taker', day + '.json')))
    launch('btc-replay.mjs', undefined, [from, to, '--cheap-taker']);
  const first = Date.parse(from) / 1000,
    end = Date.parse(to) / 1000,
    files = [];
  for (let t = first; t < end; t += 86400)
    files.push(
      path.join(
        runtime,
        'polymarket-replay',
        t + '-' + Math.min(end, t + 86400) + '.json'
      )
    );
  function summarize() {
    if (!files.every(exists)) return;
    const rows = files.flatMap(json),
      hits = rows.filter((r) => r.first);
    const wins = hits.filter((r) => r.net > 0).length;
    const net = hits.reduce((sum, r) => sum + r.net, 0);
    latestGlobalStudy = {
      market: 'Polymarket international BTC 5m',
      test: day + ' ET historical buys',
      finding:
        rows.length +
        ' windows, ' +
        rows.filter((r) => r.excluded).length +
        ' excluded. ' +
        wins +
        ' wins in ' +
        hits.length +
        ' qualifying buys. Modeled net at one share each $' +
        net.toFixed(2) +
        '.'
    };
  }
  if (files.every(exists)) summarize();
  else launch('polymarket-replay.mjs', summarize);
}
const auctionStatus = {
  offers: 'Outside watch window',
  bids: 'Outside watch window'
};
function runAuctions() {
  if (stopping || exists(path.join(ROOT, 'STOP'))) return;
  const now = Date.now();
  let offers = false,
    bids = false;
  auctionStatus.next = [];
  for (const { extra, auctions } of calendars) {
    for (const a of auctions.filter((a) => Date.parse(a.deadline) > now))
      auctionStatus.next.push({
        house: a.house,
        at: a.startAt,
        targets: a.targets.length,
        lots: a.targets.map((t) => ({
          lot: t.lot,
          title: t.title,
          event: t.event,
          source: t.url,
          sessionAt: t.sessionAt ?? null,
          thresholds: t.markets.length
        }))
      });
    const within = (a, tail = 0) =>
      now >= Date.parse(a.startAt) && now < Date.parse(a.deadline) + tail;
    const hasOffers = auctions.some((a) =>
      within(a, config.offerTailHours * 3600000)
    );
    const hasBids = auctions.some((a) => within(a));
    const start = (mode, args) => {
      if (
        ![...children].some(
          (c) =>
            c.spawnargs.includes(mode) &&
            c.spawnargs.includes('--paper-calendar') === extra
        )
      )
        launchWorker([...args, ...(extra ? ['--paper-calendar'] : [])]);
    };
    if (hasOffers) start('--watch-offers', ['--paper', '--watch-offers']);
    if (hasBids) start('--paper-bids', ['--paper-bids']);
    offers ||= hasOffers;
    bids ||= hasBids;
  }
  auctionStatus.offers = offers
    ? 'Within configured watch window'
    : 'Outside watch window';
  auctionStatus.bids = bids
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
        const paper = paperRows(db);
        body = {
          status,
          auctionStatus,
          pairStatus,
          lateAuctionStatus,
          usBitcoinStatus,
          sothebysStatus,
          soldLimits: soldLimits.summary(),
          nbaStatus,
          auctionPortfolio: auctionPortfolio(db),
          catalogComparison: { observedAt: catalogObservedAt, source: catalogSource, cases: catalogCases },
          auctionHoldings: auctionHoldings(db),
          auctionExits,
          weatherStatus,
          sothebysCoverage: db
            .prepare(
              'SELECT COUNT(*) AS scans,COALESCE(SUM(fresh),0) AS fresh FROM sothebys_bid_scans'
            )
            .get(),
          closingCoverage: db
            .prepare(
              'SELECT COUNT(*) AS closed, COUNT(CASE WHEN attempts>0 THEN 1 END) AS attempted, COUNT(CASE WHEN usable>0 THEN 1 END) AS usable FROM us_closing_windows WHERE closeAt<=?'
            )
            .get(Date.now()),
          usCoverage: db
            .prepare(
              'SELECT COUNT(*) AS windows,COALESCE(SUM(last10),0) AS last10,COALESCE(SUM(pairChecks),0) AS paired,MIN(minCost) AS minCost FROM us_samples'
            )
            .get(),
          middleCoverage: db
            .prepare(
              'SELECT COUNT(*) AS aligned, COUNT(CASE WHEN gapBps>=20 THEN 1 END) AS wide, COUNT(CASE WHEN priced>0 THEN 1 END) AS priced, MIN(bestCost) AS best FROM us_middle_windows'
            )
            .get(),
          strategies,
          paper,
          replay: replay(),
          cheapTakerReplay: replay(true).map(({day, windows, prints, wins, net}) =>
            ({day, windows, prints, wins, net})),
          btcChartCoverage: db.prepare(`SELECT COUNT(*) AS closed, COUNT(requestedAt) AS attempted,
            COUNT(side) AS beforeClose, COUNT(CASE WHEN side IS NOT NULL AND receivedAt<=closeAt-10000 THEN 1 END) AS atTen,
            COUNT(CASE WHEN abs(gapBps)>=5 THEN 1 END) AS wide,
            COUNT(CASE WHEN side=result THEN 1 END) AS correct,
            COUNT(CASE WHEN result IN ('yes','no') THEN 1 END) AS settled
            FROM btc_chart_windows WHERE closeAt<=?`).get(Date.now()),
          tenSecondValidation:
            json(path.join(ROOT, 'research.json')).tenSecondValidation ?? [],
          research: [
            ...(desktopAuctionStudy ? [desktopAuctionStudy] : []),
            ...(latestGlobalStudy ? [latestGlobalStudy] : []),
            ...json(path.join(ROOT, 'research.json')).studies
          ],
          windows: db
            .prepare(
              'SELECT COUNT(*) AS n,COALESCE(SUM(checks),0) AS checks FROM windows'
            )
            .get()
        };
      } else {
        body = { mode: 'paper', ...botReceipts() };
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
  observeWeather({
    db,
    config,
    status: weatherStatus,
    stop: () => stopping || exists(path.join(ROOT, 'STOP'))
  }).catch((e) => {
    weatherStatus.error = e.message;
  });
  observeAuctionExits({
    db,
    config,
    status: auctionExits,
    stop: () => stopping || exists(path.join(ROOT, 'STOP'))
  }).catch((e) => {
    auctionExits.error = e.message;
  });
  observeNBA({
    db,
    config,
    status: nbaStatus,
    stop: () => stopping || exists(path.join(ROOT, 'STOP'))
  }).catch((e) => {
    nbaStatus.error = e.message;
  });
  observeSothebysBids({
    db,
    config,
    status: sothebysStatus,
    limits: soldLimits,
    stop: () => stopping || exists(path.join(ROOT, 'STOP'))
  }).catch((e) => {
    sothebysStatus.error = e.message;
  });
  observeUS({
    db,
    config,
    stop: () => stopping || exists(path.join(ROOT, 'STOP')),
    status: usBitcoinStatus
  }).catch((e) => {
    usBitcoinStatus.error = e.message;
  });
  observeLateAuctions({
    db,
    config,
    auctions: calendars.flatMap((c) => c.auctions),
    stop: () => stopping || exists(path.join(ROOT, 'STOP')),
    status: lateAuctionStatus
  }).catch((e) => {
    lateAuctionStatus.error = e.message;
  });
  for (const [series, state] of Object.entries(pairStatus))
    observePairs({
      series,
      db,
      config,
      stop: () => stopping || exists(path.join(ROOT, 'STOP')),
      status: state
    }).catch((e) => {
      state.error = e.message;
    });
  runAuctions();
  setTimeout(nightlyReplay, 60000).unref();
  setInterval(nightlyReplay, 3600000).unref();
  setInterval(importSafe, 15000).unref();
  setInterval(runAuctions, 60000).unref();
  const soldIO = new Transport(config);
  checkCatalogCases(soldIO);
  setInterval(() => checkCatalogCases(soldIO), 300000).unref();
  const reconcileLimits = () => {
    if (!stopping && !exists(path.join(ROOT, 'STOP')))
      soldLimits
        .reconcile(soldIO)
        .then(() => {
          delete sothebysStatus.settlementError;
        })
        .catch((e) => {
          sothebysStatus.settlementError = e.message;
        });
  };
  reconcileLimits();
  setInterval(reconcileLimits, 60000).unref();
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
