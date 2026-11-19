import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { validateConfig, validateWatchlist, quoteBook, orderV2, summarizeReceipt, checkEvent,
  checkLot, checkFees, decimal, artworkKey } from '../core.mjs';
import { Transport, authHeaders } from '../transport.mjs';
import { Journal } from '../journal.mjs';
import { submitCandidate, processTarget } from '../bot.mjs';
import { christies, phillips } from '../parsers.mjs';
import { scanOffers, offerSide } from '../watch-offers.mjs';
import {datedSweepConfig, scanSweep, sessionWatchlist, sweepQuote} from '../auction-sweep.mjs';

const config = JSON.parse(await fs.readFile(new URL('../config.example.json', import.meta.url)));
const watch = JSON.parse(await fs.readFile(new URL('../watchlist.json', import.meta.url)));
const frozen = { ticker: 'KXART-TEST-500', primary: 'Price including buyer premium on Artnet above 500', secondary: '', strikeType: 'greater', threshold: 500, notional: '1.0000' };
const target = { event: 'KXART-TEST', lot: '1A', id: '123', artist: 'Artist', title: 'Work', markets: [frozen] };
function market() { return { ticker: frozen.ticker, event_ticker: target.event, rules_primary: frozen.primary,
  rules_secondary: '', strike_type: 'greater', floor_strike: 500, notional_value_dollars: '1.0000',
  market_type: 'binary', status: 'active', result: '', close_time: new Date(Date.now() + 60000).toISOString() }; }
function eventBody() { return { event: { event_ticker: target.event, settlement_sources: [{ name: 'Artnet', url: 'https://www.artnet.com/' }] }, markets: [market()] }; }
function candidate() { const now = Date.now(); return { ticker: frozen.ticker, side: 'NO', artworkKey: 'christies:1:123',
  clientOrderId: 'test-order-1', sourceRequestedAt: now, quoteRequestedAt: now,
  quote: { quantity: 1, limitCents: 87, reserveCents: 90, feeReserveCents: 3, conditionalProfitCents: 10 } }; }
async function withJournal(fn, mode = 'paper') {
  const base = process.env.AUCTION_TEST_TEMP_DIR || os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'auction-bot-test-'));
  const j = new Journal(dir, mode);
  try { await j.open(); await fn(j, dir); } finally { await j.close(); }
  // Test data is intentionally tiny; no recursive deletion of computed Windows paths.
}
const noop = async () => {};

test('dated auction sweep sizes repeated depth within cash and skips other session dates',()=>{
  const cal={auctions:[{startAt:'2026-11-20T00:00:00Z'},{startAt:'2026-11-20T15:00:00Z'}]};
  assert.deepEqual(sessionWatchlist(cal,'2026-11-19').auctions,[cal.auctions[0]]);
  assert.throws(()=>sessionWatchlist(cal,'2026-11-21'),/No reviewed/);
  const make=n=>({orderbook_fp:{no_dollars:[['0.3600',n],['0.1000','30.00']]}});
  const q=sweepQuote(make('21.00'),make('3.50'),'YES',{fractional_trading_enabled:true},config,250);
  assert.equal(q.quantity,3);assert.equal(q.limitCents,64);assert.ok(q.reserveCents<=250);
  assert.equal(sweepQuote(make('21.00'),make('3.50'),'YES',{},config,65),null);
  const monet=sweepQuote(make('21.00'),make('23.00'),'YES',{},config,500);
  assert.equal(monet.quantity,7);assert.equal(monet.reserveCents,467);
  const full=datedSweepConfig(validateConfig({...config,datedAuctionSizing:'available_cash'}));
  for(const side of ['YES','NO']){
    const key=side==='YES'?'no_dollars':'yes_dollars';
    const mixed={orderbook_fp:{[key]:[['0.0490','30.00'],['0.0500','20.00']]}};
    const quote=sweepQuote(mixed,mixed,side,{},full,5000);
    assert.equal(quote.quantity,20);assert.equal(quote.limitCents,95);
  }
  assert.equal(datedSweepConfig({...full,maxPriceCents:99}).maxPriceCents,95);
  assert.equal(datedSweepConfig({...full,maxPriceCents:90}).maxPriceCents,90);
  assert.equal(config.maxPriceCents,95);
});

test('dated sweeps can revisit after fresh books and stop at cumulative spend including fees',async()=>withJournal(async j=>{
  const c={...candidate(),strategy:'auction_sweep',firstBookAt:Date.now()+4000};
  const limits={...config,maxOrders:1,maxOfferAttemptsPerArtwork:1,maxOrderCostCents:1,maxTotalReservedCents:500};
  for(let n=0;n<6;n++){
    const i={...c,clientOrderId:'attempt-'+n};
    j.checkBudget(i,limits);
    await j.append({...i,type:'intent'});
    await j.append({type:'receipt',clientOrderId:i.clientOrderId,costCents:n===0?80:0,filled:n===0?1:0});
  }
  assert.equal(j.committedCents(),80);
  assert.equal(j.canSweep(c.ticker,c.side,Date.now()),false);
  j.checkBudget({...c,quote:{reserveCents:420}},limits);
  assert.throws(()=>j.checkBudget({...c,quote:{reserveCents:421}},limits),/Total reserved/);
},'live'));

for(const mode of ['pilot','available_cash','paper_cash']){
test('dated auction sizing and journal budget with '+mode,()=>withJournal(async j=>{
  const lower={...frozen,ticker:'KXART-TEST-300',threshold:300,primary:'Above 300'};
  const t={...target,markets:[frozen,lower]};
  const a={house:'christies',sale:'1',sourceUrl:'https://www.christies.com/list',targets:[t]};
  const posts=[],positions=new Map();let balances=0;
  const wrap=body=>({body,requestedAt:Date.now(),receivedAt:Date.now(),httpDate:new Date().toUTCString()});
  const book=ticker=>({ticker,orderbook_fp:{yes_dollars:[['0.2000','40.00']],no_dollars:[['0.5000','40.00']]}});
  const io={live:true,request:async()=>({...wrap(null),text:catalogue(400)}),get:async route=>{
    if(route.startsWith('/events/')){
      const e=eventBody();e.markets.push({...market(),ticker:lower.ticker,floor_strike:300,rules_primary:lower.primary});return wrap(e);
    }
    if(route.startsWith('/markets/orderbooks?'))return wrap({orderbooks:t.markets.map(m=>book(m.ticker))});
    if(route.startsWith('/markets/'))return wrap(book(route.split('/')[2]));
    if(route.startsWith('/series/'))return wrap({series:{ticker:'KXART',fee_type:'quadratic',fee_multiplier:1}});
    if(route==='/exchange/status')return wrap({exchange_active:true,trading_active:true});
    if(route.startsWith('/portfolio/positions'))return wrap({market_positions:[...positions].map(([ticker,position_fp])=>({ticker,position_fp}))});
    if(route.startsWith('/portfolio/orders'))return wrap({orders:[]});
    if(route.startsWith('/portfolio/balance?exchange_index=0'))return wrap({balance:mode==='pilot'?500:++balances===1?2500:1000});
    throw Error(route);
  },createOrder:async payload=>{
    posts.push(payload);
    const yes=payload.side==='bid',filled=yes?2:Number(payload.count);
    positions.set(payload.ticker,(yes?filled:-filled).toFixed(2));
    return wrap({order_id:'sim-'+posts.length,client_order_id:payload.client_order_id,remaining_count:'0.00',
      fill_count:filled.toFixed(2),average_fill_price:payload.price,average_fee_paid:'0.0100'});
  }};
  const opts={io,auction:a,journal:j,live:mode!=='paper_cash',stop:noop,log:noop,deadline:Date.now()+60000,
    config:datedSweepConfig({...config,datedAuctionSizing:mode==='pilot'?'pilot':'available_cash',datedPaperBankrollCents:2500,
      liveEnabled:mode!=='paper_cash',maxOrderCostCents:100,maxTotalReservedCents:500,maxOrders:1,maxOfferAttemptsPerArtwork:1})};
  await scanSweep(opts);
  if(mode==='paper_cash'){
    assert.deepEqual(j.intents().map(i=>i.quote.quantity),[40,4]);
    assert.equal(j.committedCents(),2439);assert.equal(posts.length,0);assert.equal(balances,0);
  }else{
    const counts=mode==='pilot'?['9','4']:['40','12'];
    assert.deepEqual(posts.map(p=>[p.side,p.count,p.price,p.time_in_force]),[['bid',counts[0],'0.5000','immediate_or_cancel'],['ask',counts[1],'0.2000','immediate_or_cancel']]);
    assert.equal(j.committedCents(),mode==='pilot'?426:1074);
    await scanSweep(opts);assert.equal(posts.length,2);
  }
  assert.equal(j.unresolved().length,0);
},mode==='paper_cash'?'paper':'live'));
}

test('a crossed bid can buy YES, but equality or a lower bid cannot imply NO', () => {
  assert.equal(offerSide({kind:'current_bid',amount:501},500),'YES');
  for(const amount of [500,499,null]) assert.equal(offerSide({kind:'current_bid',amount},500),null);
  assert.equal(offerSide({kind:'published_sale',amount:500},500),'NO');
  assert.equal(offerSide({kind:'unsold'},500),'NO');
});

test('offer worker reconfirms each bid, reconciles fractional fills, and enforces repeat caps',async()=>withJournal(async j=>{
  const a={house:'christies',sale:'1',sourceUrl:'https://www.christies.com/list',targets:[{...target,url:'https://www.christies.com/lot'}]};
  let position=0,reads=0,posts=0,confirmBid=600;
  const wrap=body=>({body,requestedAt:Date.now(),receivedAt:Date.now()});
  const io={live:true,request:async url=>{
    let text;
    if(url===a.sourceUrl){
      const bid=++reads%2?600:confirmBid;
      text=catalogue(0,{price_realised_txt:'',is_auction_over:false,is_in_progress:true,current_bid:bid,current_bid_txt:'USD '+bid});
    }else{
      const l={object_id:'123',lot_id_txt:'1 A',title_primary_txt:'Artist',title_secondary_txt:'Work',analytics_id:'1.1.A',is_unsold:false,price_realised:0,price_realised_txt:''};
      text='window.chrComponents.lotHeader_1 = '+JSON.stringify({data:{sale:{sale_number:'1'},lots:[l]},labels:{currency_txt:'USD'}})+';';
    }
    return {...wrap(null),text};
  },get:async route=>{
    if(route.startsWith('/events/')) return wrap(eventBody());
    if(route.startsWith('/series/')) return wrap({series:{ticker:'KXART',fee_type:'quadratic',fee_multiplier:1}});
    if(route==='/exchange/status') return wrap({exchange_active:true,trading_active:true});
    if(route.startsWith('/portfolio/positions'))return wrap({market_positions:[{ticker:frozen.ticker,position_fp:position.toFixed(2)}]});
    if(route.startsWith('/portfolio/orders'))return wrap({orders:[]});
    return wrap({orderbook_fp:{no_dollars:[['0.1800','1.00']]}});
  },createOrder:async payload=>{
    posts++;position+=0.5;assert.equal(payload.side,'bid');assert.equal(payload.price,'0.8200');
    return wrap({order_id:'fake-'+posts,client_order_id:payload.client_order_id,fill_count:'0.50',remaining_count:'0.00',average_fill_price:'0.8200',average_fee_paid:'0.0100'});
  }};
  const run=()=>scanOffers({auction:a,io,log:noop,stop:noop,live:true,journal:j,deadline:Date.now()+60000,
    config:{...config,liveEnabled:true,maxOfferAttemptsPerArtwork:2,offerCooldownSeconds:0}});
  confirmBid=500;await run();assert.equal(posts,0);
  confirmBid=600;await run();assert.equal(posts,1);
  position+=1;await run();assert.equal(posts,1);
  position-=1;await run();await run();assert.equal(posts,2);
  assert.equal(j.unresolved().length,0);
},'live'));
function catalogue(amount = 400, changes = {}) {
  return `<script>window.chrComponents.lots = ${JSON.stringify({ labels: { currency_txt: 'USD' }, data: {
    total_hits_filtered: 1, lots: [{ lot_id_txt: '1 A', object_id: '123', analytics_id: '1.123', title_primary_txt: 'Artist',
      title_secondary_txt: 'Work', price_realised: amount, price_realised_txt: 'USD ' + amount,
      is_auction_over: true, is_in_progress: false, lot_withdrawn: false, ...changes }] } })};</script>`;
}
function phillipsCatalogue(changes = {}) {
  const pool = [];
  function scalar(value) { const i = pool.length; pool.push(value); return i; }
  function object(fields) { const result = {}; const index = scalar(result);
    for (const [k, v] of Object.entries(fields)) result['_' + scalar(k)] =
      Array.isArray(v) ? scalar(v.map(x => object(x))) : typeof v === 'object' ? object(v) : scalar(v);
    return index;
  }
  scalar('routes/auction/$auctionCode');
  object({ auction: { auctionCode: 'SALE', auctionId: 'auction1', totalLotCount: 1,
    auctionCurrency: { currencyCode: 'USD' }, lots: [{ auctionId: 'auction1', lotNumberFull: '1', objectNumber: '123', makerName: 'Artist',
      description: 'Work', auctionCurrency: { currencyCode: 'USD' }, soldPrice: 400, hammerPricePlusBP: 400,
      hammerPrice: 300, lotStatus: 'Sold', isNoLot: false, showSoldPrice: true, ...changes }] } });
  return '<script>window.__reactRouterContext.streamController.enqueue(' + JSON.stringify(JSON.stringify(pool)) + ');</script>';
}

test('default configuration is paper-only and frozen watchlist is valid', () => {
  assert.equal(validateConfig(config).liveEnabled, false);
  assert.equal(validateWatchlist(watch).auctions.flatMap(a => a.targets).length, 20);
  assert.throws(() => validateConfig({ ...config, maxPriceCents: NaN }));
  assert.throws(() => validateConfig({ ...config, pollIntervalMs: 1 }));
  assert.throws(() => decimal('NaN'));
});

test('opposite-side bids, fractional depth, subcent limit and incomplete depth', () => {
  const book = { orderbook_fp: { yes_dollars: [['0.1300', '0.40'], ['0.1299', '0.60']], no_dollars: [['0.2000', '1.00']] } };
  assert.equal(quoteBook(book, 'NO', 1, 95).limitCents, 88);
  assert.equal(quoteBook(book, 'YES', 1, 95).limitCents, 80);
  assert.equal(quoteBook(book, 'NO', 2, 95), null);
  assert.equal(quoteBook(book, 'NO', 1, 87), null);
  assert.throws(() => quoteBook({ orderbook_fp: { yes_dollars: [['1.2', '1.0']] } }, 'NO', 1, 95));
});

test('NO order is YES-side ask at complementary price, with IOC and no expiry', () => {
  const p = orderV2(candidate(), 0);
  assert.equal(p.side, 'ask'); assert.equal(p.price, '0.1300');
  assert.equal(p.time_in_force, 'immediate_or_cancel');
  assert.equal(p.expiration_time, undefined);
  assert.equal(orderV2({ ...candidate(), side: 'YES' }, 0).price, '0.8700');
});

test('Artnet-only requirement and frozen rule mismatch block candidates', () => {
  assert.equal(checkEvent(eventBody(), target).length, 1);
  const b = eventBody(); b.event.settlement_sources = [{ name: 'Sothebys', url: 'https://sothebys.com' }];
  assert.throws(() => checkEvent(b, target), /Artnet/);
  b.event.settlement_sources = [{ name: 'Artnet', url: 'https://artnet.com.evil.example' }];
  assert.throws(() => checkEvent(b, target));
  const c = eventBody(); c.markets[0].floor_strike = 600;
  assert.throws(() => checkEvent(c, target), /rules changed/);
  assert.throws(() => checkFees({ series: { ticker: 'KXART', fee_type: 'quadratic', fee_multiplier: 2 } }));
});

test('Christies rejects provisional, withdrawn, mismatched and malformed results', () => {
  assert.equal(checkLot(christies(catalogue(), '1'), target).amount, 400);
  for (const changes of [{ is_in_progress: true }, { is_auction_over: false }, { lot_withdrawn: true }, { price_realised_txt: 'USD 999' }]) {
    assert.equal(checkLot(christies(catalogue(400, changes), '1'), target), null);
  }
  assert.throws(() => checkLot(christies(catalogue(400, { title_primary_txt: 'Different artist' }), '1'), target));
  assert.throws(() => christies('<html>changed schema</html>', '1'));
});

test('Phillips requires sold, visible, premium-inclusive price and matching auction', () => {
  assert.equal(phillips(phillipsCatalogue(), 'SALE')[0].strictPublishedResult, true);
  for (const changes of [{ lotStatus: 'Upcoming' }, { isNoLot: true }, { showSoldPrice: false }, { hammerPricePlusBP: 500 }, { auctionId: 'other' }]) {
    assert.equal(phillips(phillipsCatalogue(changes), 'SALE')[0].strictPublishedResult, false);
  }
  assert.throws(() => phillips(phillipsCatalogue(), 'OTHER'));
});

test('Klimt thresholds share one artwork budget group', () => {
  const a = watch.auctions.find(a => a.house === 'christies');
  const ts = a.targets.filter(t => t.artist.includes('KLIMT'));
  assert.equal(ts.length, 2); assert.equal(artworkKey(a, ts[0]), artworkKey(a, ts[1]));
});

test('Ed25519 and RSA-PSS signatures exclude query strings and include full path', () => {
  for (const type of ['ed25519', 'rsa']) {
    const pair = generateKeyPairSync(type, type === 'rsa' ? { modulusLength: 2048 } : {});
    const headers = authHeaders(pair.privateKey, 'local-test', 'GET', 'https://external-api.kalshi.com/trade-api/v2/portfolio/orders?limit=5', 123);
    const bytes = Buffer.from('123GET/trade-api/v2/portfolio/orders');
    const options = type === 'rsa' ? { key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : pair.publicKey;
    assert.equal(verify(type === 'rsa' ? 'sha256' : null, bytes, options, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64')), true);
  }
});

test('paper transport cannot POST or load private keys, even if config enables live', async () => {
  let calls = 0;
  const t = new Transport({ ...config, liveEnabled: true }, { fetchImpl: async () => { calls++; } });
  await assert.rejects(t.createOrder(orderV2(candidate(), 0)), /disabled/);
  await assert.rejects(t.loadCredentials(), /disabled/);
  assert.equal(calls, 0);
});

test('old HTTP cache, 429 and redirects fail without retry', async () => {
  for (const response of [new Response('{}', { headers: { age: '90' } }), new Response('', { status: 429 })]) {
    let calls = 0;
    const t = new Transport(config, { fetchImpl: async (_, o) => { calls++; assert.equal(o.redirect, 'error'); return response; } });
    await assert.rejects(t.get('/series/KXART')); assert.equal(calls, 1);
  }
});

test('paper submission is recorded as hypothetical, never sends an order', async () => withJournal(async j => {
  let posted = 0;
  await submitCandidate({ io: { createOrder: async () => posted++ }, candidate: candidate(), config, journal: j,
    live: false, stop: noop, log: noop, deadline: Date.now() + 10000 });
  assert.equal(posted, 0); assert.equal(j.entries[1].fillAssumed, false);
  assert.equal(j.entries[1].realizedProfit, null); assert.equal(j.blocked(candidate().artworkKey), true);
  assert.throws(() => j.checkBudget(candidate(), config), /already attempted/);
}));

test('unknown POST stops, reserves budget, and cannot be retried after restart', async () => withJournal(async (j, dir) => {
  let calls = 0;
  const opts = { io: { live: true, createOrder: async () => { calls++; throw new Error('timeout'); } },
    candidate: candidate(), config: { ...config, liveEnabled: true }, journal: j, live: true,
    stop: noop, log: noop, deadline: Date.now() + 10000 };
  await assert.rejects(submitCandidate(opts), /timeout/);
  assert.equal(calls, 1); assert.equal(j.unresolved().length, 1);
  await j.close();
  const restarted = await new Journal(dir, 'live').open();
  try { assert.throws(() => restarted.checkBudget(candidate(), config), /Unresolved/); }
  finally { await restarted.close(); }
}, 'live'));

test('durable journal locks out concurrent processes and detects truncated writes', async () => withJournal(async (j, dir) => {
  const second = new Journal(dir, 'paper'); await assert.rejects(second.open(), { code: 'EEXIST' });
  await fs.writeFile(j.path, '{"partial":'); await j.close();
  const broken = new Journal(dir, 'paper');
  try { await assert.rejects(broken.open(), /Incomplete journal/); } finally { await broken.close(); }
}));

test('stale quote, expired window and STOP never submit', async () => {
  for (const variant of ['stale', 'expired', 'stop']) await withJournal(async j => {
    let calls = 0; const c = candidate(); if (variant === 'stale') c.quoteRequestedAt -= 6000;
    await assert.rejects(submitCandidate({ io: { createOrder: async () => calls++ }, candidate: c, config, journal: j,
      live: false, log: noop, stop: variant === 'stop' ? async () => { throw Error('STOP'); } : noop,
      deadline: variant === 'expired' ? Date.now() - 1 : Date.now() + 10000 }));
    assert.equal(calls, 0); assert.equal(j.intents().length, 0);
  });
});

test('total reserve cannot be recycled by zero or partial fills', async () => withJournal(async j => {
  const c = candidate(); await j.append({ type: 'intent', ...c });
  await j.append({ type: 'receipt', clientOrderId: c.clientOrderId, filled: 0 });
  assert.throws(() => j.checkBudget({ ...candidate(), artworkKey: 'another' }, { ...config, maxTotalReservedCents: 150 }), /Total reserved/);
}));

test('partial NO receipt uses complemented YES fill price and never labels profit', () => {
  const c = candidate();
  const b = { order_id: 'order', client_order_id: c.clientOrderId, fill_count: '0.50', remaining_count: '0.00', average_fill_price: '0.1400', average_fee_paid: '0.0200' };
  assert.deepEqual(summarizeReceipt(b, c), { orderId: 'order', filled: .5, costCents: 44, remaining: 0, realizedProfit: null });
  assert.throws(() => summarizeReceipt({ ...b, remaining_count: '0.50' }, c));
  assert.throws(() => summarizeReceipt({ ...b, client_order_id: 'other' }, c));
  assert.throws(() => summarizeReceipt({ ...b, average_fill_price: '0.10' }, c));
});

test('whole pipeline confirms source twice and drops a disappearing quote', async () => {
  for (const disappears of [false, true]) await withJournal(async j => {
    const a = { house: 'christies', sale: '1', sourceUrl: 'https://www.christies.com/test', targets: [target], deadline: new Date(Date.now() + 60000).toISOString() };
    let reads = 0, books = 0, posts = 0;
    const wrap = body => ({ body, requestedAt: Date.now(), receivedAt: Date.now() });
    const io = {
      request: async () => { reads++; return { text: catalogue(), requestedAt: Date.now(), receivedAt: Date.now() }; },
      get: async p => {
        if (p.startsWith('/events/')) return wrap(eventBody());
        if (p.startsWith('/series/')) return wrap({ series: { ticker: 'KXART', fee_type: 'quadratic', fee_multiplier: 1 } });
        if (p === '/exchange/status') return wrap({ exchange_active: true, trading_active: true });
        if (p.includes('/orderbook')) { books++; return wrap({ orderbook_fp: { yes_dollars: disappears && books > 1 ? [] : [['0.1300', '2.00']] } }); }
        throw Error('Unexpected request ' + p);
      }, createOrder: async () => posts++
    };
    await processTarget({ io, auction: a, target, source: { rows: christies(catalogue(), '1') }, config, journal: j,
      live: false, stop: noop, log: noop });
    assert.equal(reads, 1); assert.equal(books, 2); assert.equal(posts, 0);
    assert.equal(j.intents().length, disappears ? 0 : 1);
  });
});

test('live pipeline against a fake exchange checks exposure and records a single IOC receipt', async () => withJournal(async j => {
  const a = { house: 'christies', sale: '1', sourceUrl: 'https://www.christies.com/test', targets: [target], deadline: new Date(Date.now() + 60000).toISOString() };
  let posts = 0, privateReads = 0;
  const wrap = body => ({ body, requestedAt: Date.now(), receivedAt: Date.now() });
  const io = { live: true,
    request: async () => ({ text: catalogue(), requestedAt: Date.now(), receivedAt: Date.now() }),
    get: async (p, authenticated) => {
      if (p.startsWith('/portfolio/')) {
        assert.equal(authenticated, true); privateReads++;
        return wrap(p.startsWith('/portfolio/positions') ? { market_positions: [], cursor: '' } : { orders: [], cursor: '' });
      }
      if (p.startsWith('/events/')) return wrap(eventBody());
      if (p.startsWith('/series/')) return wrap({ series: { ticker: 'KXART', fee_type: 'quadratic', fee_multiplier: 1 } });
      if (p === '/exchange/status') return wrap({ exchange_active: true, trading_active: true });
      if (p.includes('/orderbook')) return wrap({ orderbook_fp: { yes_dollars: [['0.1300', '2.00']] } });
      throw Error('Unexpected request');
    },
    createOrder: async payload => {
      posts++; assert.equal(payload.side, 'ask'); assert.equal(payload.price, '0.1300');
      assert.equal(payload.time_in_force, 'immediate_or_cancel');
      return wrap({ order_id: 'fake-only', client_order_id: payload.client_order_id, fill_count: '1.00', remaining_count: '0.00', average_fill_price: '0.1300', average_fee_paid: '0.0100' });
    }
  };
  const options = { io, auction: a, target, source: { rows: christies(catalogue(), '1') }, config: { ...config, liveEnabled: true }, journal: j, live: true, stop: noop, log: noop };
  await processTarget(options); await processTarget(options);
  assert.equal(posts, 1); assert.equal(privateReads, 2);
  assert.equal(j.entries[1].costCents, 88); assert.equal(j.unresolved().length, 0);
}, 'live'));

test('source revision between discovery and confirmation blocks any order', async () => withJournal(async j => {
  const a = { house: 'christies', sale: '1', sourceUrl: 'https://www.christies.com/test', targets: [target], deadline: new Date(Date.now() + 60000).toISOString() };
  let posts = 0;
  const wrap = body => ({ body, requestedAt: Date.now(), receivedAt: Date.now() });
  const io = { request: async () => ({ text: catalogue(700), requestedAt: Date.now(), receivedAt: Date.now() }),
    get: async p => wrap(p.startsWith('/events/') ? eventBody() : { orderbook_fp: { yes_dollars: [['0.1300', '2.00']] } }),
    createOrder: async () => posts++ };
  await assert.rejects(processTarget({ io, auction: a, target, source: { rows: christies(catalogue(), '1') }, config,
    journal: j, live: false, stop: noop, log: noop }), /result changed/);
  assert.equal(posts, 0); assert.equal(j.intents().length, 0);
}));

test('STOP arriving after durable intent still prevents POST and blocks retry', async () => withJournal(async j => {
  let stops = 0, posts = 0;
  await assert.rejects(submitCandidate({ io: { live: true, createOrder: async () => posts++ }, candidate: candidate(),
    config: { ...config, liveEnabled: true }, journal: j, live: true, log: noop,
    stop: async () => { if (++stops === 2) throw Error('STOP'); }, deadline: Date.now() + 10000 }), /STOP/);
  assert.equal(posts, 0); assert.equal(j.unresolved().length, 1);
}, 'live'));
