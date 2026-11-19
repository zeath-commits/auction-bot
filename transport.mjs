import { createPrivateKey, sign, constants } from 'node:crypto';
import fs from 'node:fs/promises';
import { requireThat } from './core.mjs';

export const API = 'https://external-api.kalshi.com/trade-api/v2';
export function authHeaders(key, id, method, url, timestamp = Date.now()) {
  const message = Buffer.from(String(timestamp) + method.toUpperCase() + new URL(url).pathname);
  let signature;
  if (key.asymmetricKeyType === 'ed25519') signature = sign(null, message, key);
  else {
    requireThat(key.asymmetricKeyType === 'rsa', 'Unsupported private key type');
    signature = sign('sha256', message, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  }
  return { 'KALSHI-ACCESS-KEY': id, 'KALSHI-ACCESS-TIMESTAMP': String(timestamp),
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64') };
}

export class Transport {
  constructor(config, { live = false, fetchImpl = fetch, checkStop = async () => {} } = {}) {
    this.config = config; this.live = live; this.fetchImpl = fetchImpl; this.checkStop = checkStop;
    this.key = null; this.id = null;
  }
  async loadCredentials(readOnlyCheck=false) {
    requireThat(readOnlyCheck || (this.live && this.config.liveEnabled), 'Live mode is disabled');
    this.readOnlyCheck = readOnlyCheck;
    this.id = process.env[this.config.apiKeyIdEnvironmentVariable];
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH || this.config.privateKeyPath;
    requireThat(this.id && keyPath, 'Supply API key ID and local private-key file');
    this.key = createPrivateKey(await fs.readFile(keyPath, 'utf8'));
  }
  async request(url, { method = 'GET', body, authenticated = false } = {}) {
    await this.checkStop();
    const u = new URL(url);
    requireThat(u.protocol === 'https:' && !u.username && !u.password, 'HTTPS URL required');
    const apiRequest = u.origin === 'https://external-api.kalshi.com' && u.pathname.startsWith('/trade-api/v2/');
    requireThat(apiRequest || (method === 'GET' && ['www.phillips.com', 'www.christies.com'].includes(u.hostname)), 'Destination is not allowed');
    const headers = { Accept: apiRequest ? 'application/json' : 'text/html', 'Cache-Control': 'no-cache' };
    if (method !== 'GET') {
      requireThat(this.live && this.config.liveEnabled && authenticated && method === 'POST' &&
        u.pathname === '/trade-api/v2/portfolio/events/orders', 'Order submission disabled');
    }
    if (authenticated) {
      const portfolioRead=this.readOnlyCheck && method==='GET' &&
        ['/portfolio/balance','/portfolio/fills','/portfolio/settlements','/historical/fills'].some(route=>u.pathname==='/trade-api/v2'+route);
      requireThat(apiRequest && (this.live || portfolioRead) && this.key && this.id, 'Authenticated access unavailable');
      Object.assign(headers, authHeaders(this.key, this.id, method, url));
    }
    if (body) headers['Content-Type'] = 'application/json';
    const requestedAt = Date.now();
    // Never retry a POST. A timeout is an unknown order, not a failed trade.
    const response = await this.fetchImpl(url, { method, headers, redirect: 'error', cache: 'no-store',
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${u.hostname}${u.pathname}; stopped without retry`);
    const text = await response.text();
    const receivedAt = Date.now();
    const age = response.headers.get('age');
    requireThat(age === null || (Number.isFinite(Number(age)) && Number(age) <= this.config.maxHttpAgeSeconds), 'Cached response too old');
    requireThat(receivedAt - requestedAt <= this.config.requestTimeoutMs, 'Response exceeded timeout');
    return { text, body: apiRequest ? JSON.parse(text) : null, requestedAt, receivedAt,
      httpDate: response.headers.get('date'), cacheAge: age };
  }
  get(path, authenticated = false) { return this.request(API + path, { authenticated }); }
  async createOrder(body) { return this.request(API + '/portfolio/events/orders', { method: 'POST', authenticated: true, body }); }
}
