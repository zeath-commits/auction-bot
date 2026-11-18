import { createHash, randomUUID } from 'node:crypto';

export const MICRO = 1_000_000;
export function requireThat(value, message) {
  if (!value) throw new Error(message);
}
export function decimal(value) {
  requireThat(typeof value === 'string' && /^\d+(\.\d{1,6})?$/.test(value), 'Invalid fixed-point value');
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * MICRO + Number(fraction.padEnd(6, '0'));
  requireThat(Number.isSafeInteger(n), 'Fixed-point value overflow');
  return n;
}
export function dollars(micro) {
  requireThat(Number.isSafeInteger(micro) && micro >= 0, 'Invalid money amount');
  return `${Math.floor(micro / MICRO)}.${String(micro % MICRO).padStart(6, '0')}`;
}
export const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const artworkKey = (auction, target) => `${auction.house}:${auction.sale}:${target.id}`;

export function validateConfig(c) {
  c = {maxOfferAttemptsPerArtwork: 2, offerCooldownSeconds: 60, offerTailHours: 12, ...c};
  requireThat(typeof c.liveEnabled === 'boolean', 'liveEnabled must be boolean');
  const bounds = {
    pollIntervalMs: [5000, 60000], requestTimeoutMs: [1000, 30000],
    maxSourceAgeMs: [1000, 30000], maxQuoteAgeMs: [100, 5000],
    maxHttpAgeSeconds: [0, 60], contractsPerOrder: [1, 100],
    maxPriceCents: [1, 99], minConditionalProfitCents: [1, 10000],
    maxOrderCostCents: [1, 100000], maxTotalReservedCents: [1, 1000000],
    maxOrders: [1, 100], subaccount: [0, 63], maxOfferAttemptsPerArtwork:[1,100],
    offerCooldownSeconds:[5,86400], offerTailHours:[0,168]
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    requireThat(Number.isInteger(c[key]) && c[key] >= min && c[key] <= max, `Invalid ${key}`);
  }
  requireThat(c.maxOrderCostCents <= c.maxTotalReservedCents, 'Order cap exceeds total cap');
  requireThat(typeof c.privateKeyPath === 'string', 'Invalid privateKeyPath');
  requireThat(/^[A-Z][A-Z0-9_]+$/.test(c.apiKeyIdEnvironmentVariable), 'Invalid API key variable name');
  return c;
}

export function validateWatchlist(w) {
  requireThat(Array.isArray(w.auctions) && w.auctions.length > 0, 'Empty watchlist');
  const seen = new Set();
  for (const a of w.auctions) {
    const u = new URL(a.sourceUrl);
    requireThat(u.protocol === 'https:' && !u.username && !u.password, 'Invalid source URL');
    requireThat((a.house === 'phillips' && u.hostname === 'www.phillips.com') ||
      (a.house === 'christies' && u.hostname === 'www.christies.com'), 'Unsupported auction source');
    requireThat(Number.isFinite(Date.parse(a.startAt)) && Date.parse(a.deadline) > Date.parse(a.startAt), 'Invalid auction window');
    requireThat(Date.parse(a.deadline) - Date.parse(a.startAt) < 86400000, 'Auction window exceeds one day');
    for (const t of a.targets) {
      requireThat(typeof t.id === 'string' && typeof t.lot === 'string' && t.artist && t.title, 'Incomplete lot identity');
      requireThat(/^KXART-[A-Z0-9]+$/.test(t.event) && !seen.has(t.event), 'Invalid or duplicate event');
      seen.add(t.event);
      requireThat(t.markets.length > 0, 'No frozen market rules');
      for (const m of t.markets) {
        requireThat(m.ticker.startsWith(t.event + '-') && m.primary && typeof m.secondary === 'string', 'Incomplete market rules');
        requireThat(m.strikeType === 'greater' && Number.isFinite(m.threshold) && m.threshold >= 0, 'Unsupported strike');
        requireThat(decimal(m.notional) === MICRO, 'Only $1 binary contracts supported');
      }
    }
  }
  return w;
}

export function checkEvent(body, target) {
  const e = body.event;
  requireThat(e?.event_ticker === target.event, 'Event identity changed');
  const sources = e.settlement_sources;
  requireThat(Array.isArray(sources) && sources.length > 0 && sources.every(s => {
    try { return /^artnet$/i.test(s.name) && /(^|\.)artnet\.com$/.test(new URL(s.url).hostname); }
    catch { return false; }
  }), 'Settlement source is not exclusively Artnet');
  const ms = body.markets?.length ? body.markets : e.markets;
  requireThat(Array.isArray(ms), 'Missing event markets');
  return ms.filter(m => target.markets.some(f => f.ticker === m.ticker)).map(m => {
    const f = target.markets.find(f => f.ticker === m.ticker);
    requireThat(m.event_ticker === target.event && m.rules_primary === f.primary && m.rules_secondary === f.secondary &&
      m.strike_type === f.strikeType && m.floor_strike === f.threshold && decimal(m.notional_value_dollars) === MICRO,
    'Frozen contract rules changed: ' + m.ticker);
    requireThat(m.market_type === 'binary', 'Non-binary contract');
    return m;
  });
}

export function checkLot(rows, target) {
  const matches = rows.filter(l => l.id === target.id && l.lot === target.lot);
  requireThat(matches.length === 1, 'Missing or duplicate lot: ' + target.lot);
  const lot = matches[0];
  requireThat(lot.artist === target.artist && lot.title === target.title && lot.identityValid, 'Lot identity changed');
  if (!lot.strictPublishedResult) return null;
  requireThat(lot.currency === 'USD' && Number.isFinite(lot.amount) && lot.amount > 0, 'Invalid published price');
  return lot;
}

export function checkFees(body) {
  const s = body.series;
  requireThat(s?.ticker === 'KXART' && s.fee_type === 'quadratic' && s.fee_multiplier === 1, 'Fee schedule requires review');
}

// Both sides of REST orderbook are bids. Complement the opposite side to buy.
export function askLevels(body, side, maxPriceCents) {
  requireThat(side === 'YES' || side === 'NO', 'Invalid outcome side');
  const rows = body.orderbook_fp?.[side === 'YES' ? 'no_dollars' : 'yes_dollars'];
  requireThat(Array.isArray(rows), 'Missing fixed-point orderbook');
  return rows.map(row => {
    requireThat(Array.isArray(row) && row.length === 2, 'Malformed orderbook level');
    const bid = decimal(row[0]), q = decimal(row[1]);
    requireThat(bid > 0 && bid < MICRO && q >= 0, 'Invalid bid');
    return { price: MICRO - bid, quantity: q };
  }).filter(l => l.price <= maxPriceCents * 10000 && l.quantity > 0).sort((a, b) => a.price - b.price);
}

export function quoteBook(body, side, quantity, maxPriceCents) {
  const levels = askLevels(body, side, maxPriceCents);
  let remaining = quantity * MICRO;
  const used = [];
  for (const l of levels) {
    if (!remaining) break;
    const n = Math.min(remaining, l.quantity);
    used.push({ price: l.price, quantity: n });
    remaining -= n;
  }
  if (remaining) return null;
  // Round a subcent ask upward to a cent limit; no slippage beyond that limit.
  const limitCents = Math.ceil(used.at(-1).price / 10000);
  if (limitCents > maxPriceCents) return null;
  // Conservative standard quadratic fee reserve: 2 cents per contract maximum
  // at multiplier 1, plus 1 cent per contract cushion. Actual fees are reconciled.
  const feeReserveCents = 3 * quantity;
  const reserveCents = quantity * limitCents + feeReserveCents;
  return { quantity, limitCents, feeReserveCents, reserveCents,
    conditionalProfitCents: quantity * 100 - reserveCents, levels: used };
}

export function checkMarketActive(m, now) {
  return m.status === 'active' && !m.result && Number.isFinite(Date.parse(m.close_time)) && Date.parse(m.close_time) > now;
}

export function orderV2(candidate, subaccount) {
  return {
    ticker: candidate.ticker, client_order_id: candidate.clientOrderId || randomUUID(),
    side: candidate.side === 'YES' ? 'bid' : 'ask',
    count: String(candidate.quote.quantity),
    price: ((candidate.side === 'YES' ? candidate.quote.limitCents : 100 - candidate.quote.limitCents) / 100).toFixed(4),
    time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross',
    cancel_order_on_pause: true, subaccount
  };
}

export function summarizeReceipt(body, candidate) {
  requireThat(typeof body.order_id === 'string' && body.order_id, 'Missing order receipt ID');
  if (body.client_order_id !== undefined) requireThat(body.client_order_id === candidate.clientOrderId, 'Receipt client ID mismatch');
  const filled = decimal(body.fill_count) / MICRO;
  const remaining = decimal(body.remaining_count) / MICRO;
  requireThat(filled <= candidate.quote.quantity && remaining === 0, 'Unexpected IOC receipt; reconcile before continuing');
  let costCents = 0;
  if (filled > 0) {
    const yesPrice = decimal(body.average_fill_price), fee = decimal(body.average_fee_paid);
    requireThat(yesPrice > 0 && yesPrice < MICRO, 'Invalid fill price');
    const sidePrice = candidate.side === 'YES' ? yesPrice : MICRO - yesPrice;
    requireThat(sidePrice <= candidate.quote.limitCents * 10000, 'Fill price exceeds limit');
    costCents = Math.ceil((sidePrice + fee) * filled / 10000 - 1e-8);
    requireThat(costCents <= candidate.quote.reserveCents, 'Actual cost exceeds reserve; stop and reconcile');
  }
  return { orderId: body.order_id, filled, costCents, remaining, realizedProfit: null };
}
