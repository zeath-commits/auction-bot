import fs from 'node:fs/promises';
import path from 'node:path';
import { requireThat } from './core.mjs';

export class Journal {
  constructor(directory, mode) { this.directory = directory; this.mode = mode; this.entries = []; }
  async open() {
    await fs.mkdir(this.directory, { recursive: true });
    this.lockPath = path.join(this.directory, 'process.lock');
    this.lock = await fs.open(this.lockPath, 'wx');
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, mode: this.mode, startedAt: new Date().toISOString() }));
    this.path = path.join(this.directory, 'orders.jsonl');
    try {
      const text = await fs.readFile(this.path, 'utf8');
      requireThat(!text || text.endsWith('\n'), 'Incomplete journal; manual reconciliation required');
      this.entries = text.split('\n').filter(Boolean).map(x => JSON.parse(x));
      const ids = new Set();
      for (const row of this.entries) {
        requireThat(row.mode === this.mode && ['intent', 'receipt', 'unknown'].includes(row.type), 'Invalid journal entry');
        if (row.type === 'intent') {
          requireThat(!ids.has(row.clientOrderId) && Number.isSafeInteger(row.quote?.reserveCents) && row.quote.reserveCents > 0 && row.artworkKey,
            'Invalid journal intent');
          ids.add(row.clientOrderId);
        } else requireThat(ids.has(row.clientOrderId), 'Receipt without intent');
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }
  async append(entry) {
    const row = { ...entry, mode: this.mode, recordedAt: new Date().toISOString() };
    const f = await fs.open(this.path, 'a');
    try { await f.writeFile(JSON.stringify(row) + '\n'); await f.sync(); } finally { await f.close(); }
    this.entries.push(row);
  }
  intents() { return this.entries.filter(x => x.type === 'intent'); }
  unresolved() {
    return this.intents().filter(x => !this.entries.some(r => r.type === 'receipt' && r.clientOrderId === x.clientOrderId));
  }
  blocked(key) { return this.intents().some(x => x.artworkKey === key); }
  committedCents() {
    const costs = new Map(this.entries.filter(r=>r.type==='receipt' && !r.hypothetical &&
      Number.isSafeInteger(r.costCents) && r.costCents>=0).map(r=>[r.clientOrderId,r.costCents]));
    return this.intents().reduce((sum,i)=>sum+(i.strategy==='auction_sweep'
      ? costs.get(i.clientOrderId)??i.quote.reserveCents : i.quote.reserveCents),0);
  }
  canSweep(ticker, side, firstBookAt) {
    const prior=this.intents().filter(i=>i.ticker===ticker);
    if(!prior.length)return true;
    const receipts=new Map(this.entries.filter(r=>r.type==='receipt').map(r=>[r.clientOrderId,r]));
    return prior.every(i=>i.side===side && firstBookAt-1000>Date.parse(receipts.get(i.clientOrderId)?.recordedAt));
  }
  checkBudget(candidate, config) {
    requireThat(this.unresolved().length === 0, 'Unresolved order intent; inspect exchange and journal before restarting');
    const sweep=candidate.strategy==='auction_sweep';
    if (sweep) {
      requireThat(this.canSweep(candidate.ticker,candidate.side,candidate.firstBookAt),'Fresh book required after prior receipt');
    } else if (candidate.strategy==='watch_offers') {
      const prior = this.intents().filter(x => x.artworkKey === candidate.artworkKey);
      requireThat(prior.length < config.maxOfferAttemptsPerArtwork, 'Artwork attempt cap reached');
      requireThat(prior.every(x=>Date.now()-Date.parse(x.recordedAt)>=config.offerCooldownSeconds*1000), 'Artwork cooldown active');
    } else requireThat(!this.blocked(candidate.artworkKey), 'Artwork already attempted');
    if(!sweep){
      requireThat(this.intents().length < config.maxOrders, 'Order count budget exhausted');
      requireThat(candidate.quote.reserveCents <= config.maxOrderCostCents, 'Order cost cap exceeded');
    }
    const total = this.committedCents();
    requireThat(total + candidate.quote.reserveCents <= config.maxTotalReservedCents, 'Total reserved budget exhausted');
  }
  async close() {
    if (this.lock) { await this.lock.close(); this.lock = null; await fs.unlink(this.lockPath); }
  }
}
