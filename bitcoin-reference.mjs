const gateway = 'https://gateway.polymarket.us';

export function usSlug(start) {
  const iso = new Date(start * 1000).toISOString();
  return (
    'cpc-btc-updown-5m-' +
    iso.slice(0, 10) +
    '-' +
    iso.slice(11, 16).replace(':', '') +
    'z'
  );
}

export async function usPublic(route) {
  // A five-minute market's canonical book URL can retain a pre-opening 404
  // into trading. Share a cache key for each UTC second across readers.
  const url = new URL(gateway + route);
  if (/^\/v1\/markets\/cpc-btc-updown-5m-[\d-]+-\d{4}z\/book$/.test(route))
    url.searchParams.set('asof', String(Math.floor(Date.now() / 1000)));
  const r = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!r.ok) {
    const error = Error('Polymarket US public read returned ' + r.status);
    error.status = r.status;
    if (r.status === 429) {
      const retry = r.headers.get('retry-after');
      const ms =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now();
      error.retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    }
    throw error;
  }
  if (route.endsWith('/book') && Number(r.headers.get('age') ?? 0) > 1)
    throw Error('Cached US book exceeded one second');
  return r.json();
}

export async function referencePrices(from, to) {
  const q = new URLSearchParams({
    assets: 'crypto:btc',
    from,
    to,
    bucket: 'ASSET_PRICE_BUCKET_1S'
  });
  const d = await usPublic('/v1/asset-prices/history?' + q);
  const s = d.series?.[0];
  if (
    d.series?.length !== 1 ||
    s.asset?.symbol !== 'btc' ||
    s.currency !== 'USD' ||
    s.bucket !== 'ASSET_PRICE_BUCKET_1S'
  )
    throw Error('Unexpected reference series');
  const prices = new Map();
  for (const c of s.candles) {
    const p = Number(c.close);
    if (
      !Number.isInteger(c.timestamp) ||
      !(p > 0) ||
      !Number.isFinite(p) ||
      prices.has(c.timestamp)
    )
      throw Error('Invalid reference observation');
    prices.set(c.timestamp, p);
  }
  return prices;
}

export function openingTerms(m, start) {
  const t = m?.assetPriceTerms;
  if (
    m?.slug !== usSlug(start) ||
    t?.indexSymbol !== 'BRTI' ||
    t.asset?.symbol !== 'btc' ||
    t.horizon !== '5m' ||
    t.marketType !== 'ASSET_PRICE_MARKET_TYPE_UP_DOWN' ||
    Date.parse(t.windowStart) !== start * 1000 ||
    Date.parse(t.windowEnd) !== (start + 300) * 1000 ||
    t.priceToBeat?.currency !== 'USD' ||
    !(Number(t.priceToBeat.value) > 0)
  )
    return null;
  if (
    !/^This market will settle to Up if the Bitcoin price at .+ is greater than or equal to the price at .+?\. Otherwise, this market will settle to Down\./.test(
      m.description
    ) ||
    !/60 BRTI prices/.test(m.description) ||
    !m.marketSides?.some(
      (s) =>
        s.identifier === m.slug && s.long === true && s.description === 'Yes'
    ) ||
    !m.marketSides?.some(
      (s) =>
        s.identifier === m.slug && s.long === false && s.description === 'No'
    )
  )
    return null;
  return t;
}

export function averageAt(prices, end) {
  let sum = 0;
  for (let t = end - 60; t < end; t++) {
    if (!prices.has(t)) return null;
    sum += Math.round(prices.get(t) * 100);
  }
  return Math.round(sum / 60) / 100;
}

// Fixed before retrieving the historical chart slices for these candidates.
// At ten seconds to close, the last included one-second candle is four
// seconds old. Fill the remaining fourteen seconds with its closing price.
export function chartProjection(prices, close, strike) {
  if (!Number.isSafeInteger(close) || !(strike > 0) || !Number.isFinite(strike)) return null;
  let cents = 0, last;
  for (let t = close - 60; t <= close - 15; t++) {
    last = prices.get(t);
    if (!(last > 0) || !Number.isFinite(last)) return null;
    cents += Math.round(last * 100);
  }
  const mean = (cents + 14 * Math.round(last * 100)) / 6000;
  const gapBps = 10000 * (mean - strike) / strike;
  return { mean, gapBps, side: mean >= strike ? 'yes' : 'no' };
}
