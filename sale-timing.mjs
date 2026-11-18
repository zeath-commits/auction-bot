import { askLevels, checkMarketActive } from './core.mjs';

// Compare receipt times from reads started in the same polling cycle.
// Quotes are the first post-receipt snapshot, before evidence of repeat depth.
export function saleTiming(db, targets) {
  db.exec(`CREATE TABLE IF NOT EXISTS sale_page_reads(event TEXT,source TEXT,at INTEGER,requested INTEGER,age REAL,phase TEXT,price INTEGER,fresh INTEGER,PRIMARY KEY(event,source,at));
  CREATE TABLE IF NOT EXISTS sale_disclosures(event TEXT,at INTEGER,generation INTEGER,irrevocable INTEGER,PRIMARY KEY(event,at));
  CREATE TABLE IF NOT EXISTS sale_first_prices(event TEXT,source TEXT,at INTEGER,price INTEGER,books TEXT,PRIMARY KEY(event,source))`);
  const first = db.prepare(
    'SELECT * FROM sale_first_prices WHERE event=? AND source=?'
  );
  const last = db.prepare(
    'SELECT price FROM sale_page_reads WHERE event=? AND source=? AND fresh=1 ORDER BY at DESC LIMIT 1'
  );
  function paired(t) {
    const a = first.get(t.event, 'catalog'),
      b = first.get(t.event, 'lot');
    return !!(
      a &&
      b &&
      a.price === b.price &&
      last.get(t.event, 'catalog')?.price === a.price &&
      last.get(t.event, 'lot')?.price === b.price
    );
  }
  function recordDisclosure(read) {
    if (!Number.isFinite(read.generation) || read.generation > read.at + 1000) return;
    for (const lot of read.lots) {
      if (typeof lot.irrevocableBid !== 'boolean' || !targets.some(t=>t.event===lot.event)) continue;
      db.prepare('INSERT OR IGNORE INTO sale_disclosures VALUES(?,?,?,?)')
        .run(lot.event,read.at,read.generation,Number(lot.irrevocableBid));
    }
  }
  async function record(kind, read, { io, marketList, stop }) {
    if (kind === 'lot') recordDisclosure(read);
    await Promise.all(
      read.lots.map(async (lot) => {
        const t = targets.find((x) => x.event === lot.event);
        if (!t) throw Error('Unexpected timing observation');
        const price = lot.salePrice;
        db.prepare(
          'INSERT OR IGNORE INTO sale_page_reads VALUES(?,?,?,?,?,?,?,?)'
        ).run(
          t.event,
          kind,
          read.at,
          read.requestedAt,
          read.age,
          lot.phase ?? null,
          price,
          Number(read.soldFresh)
        );
        if (!read.soldFresh || price === null || stop()) return;
        const fresh = db
          .prepare(
            'INSERT OR IGNORE INTO sale_first_prices VALUES(?,?,?,?,NULL)'
          )
          .run(t.event, kind, read.at, price);
        if (!fresh.changes) return;
        let snapshot;
        try {
          const markets = (await marketList(io, t)).filter((m) =>
            checkMarketActive(m, Date.now())
          );
          const query = new URLSearchParams(
            markets.map((m) => ['tickers', m.ticker])
          );
          query.set('depth', '100');
          const book = markets.length
            ? await io.get('/markets/orderbooks?' + query)
            : null;
          const lag = book ? book.receivedAt - read.at : null;
          if (book && (lag > 5000 || book.receivedAt - book.requestedAt > 2000))
            throw Error('First quote arrived late');
          const offers = [];
          for (const m of markets) {
            const body = book.body.orderbooks.find(
              (b) => b.ticker === m.ticker
            );
            if (!body) throw Error('Missing book on first read');
            if (!checkMarketActive(m, book.receivedAt)) continue;
            const side = price > m.floor_strike ? 'YES' : 'NO';
            const levels = askLevels(body, side, 99)
              .map((l) => ({
                price: l.price / 1e6,
                size: Math.floor(l.quantity / 1e6)
              }))
              .filter((l) => l.size >= 1);
            if (levels.length) offers.push({ ticker: m.ticker, side, levels });
          }
          snapshot = {
            checked: markets.length,
            at: book?.receivedAt ?? null,
            lag,
            offers
          };
        } catch (e) {
          snapshot = { error: e.message };
        }
        db.prepare(
          'UPDATE sale_first_prices SET books=? WHERE event=? AND source=?'
        ).run(JSON.stringify(snapshot), t.event, kind);
      })
    );
  }
  function summary() {
    return targets.map((t) => {
      function observation(kind) {
        const r = first.get(t.event, kind);
        if (!r) return null;
        const b = r.books && JSON.parse(r.books);
        const previous = db
          .prepare(
            'SELECT MAX(at) AS at FROM sale_page_reads WHERE event=? AND source=? AND at<? AND fresh=1 AND price IS NULL'
          )
          .get(t.event, kind, r.at).at;
        return {
          at: r.at,
          previous,
          price: r.price,
          checked: b?.checked ?? null,
          quoted: b?.offers?.length ?? null,
          error: b?.error ?? null,
          best: b?.offers?.length
            ? Math.min(...b.offers.flatMap((o) => o.levels.map((l) => l.price)))
            : null
        };
      }
      const catalog = observation('catalog'),
        lot = observation('lot');
      return {
        title: t.title,
        event: t.event,
        catalog,
        lot,
        matched: paired(t),
        lotLeadMs:
          catalog && lot && catalog.price === lot.price
            ? catalog.at - lot.at
            : null
      };
    });
  }
  return {
    recordDisclosure,
    record,
    summary,
    remaining: () => targets.filter((t) => !paired(t))
  };
}
