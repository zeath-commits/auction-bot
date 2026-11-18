import path from 'node:path';
import { openLedger, settle } from './strategy-monitor.mjs';
import { initSoldStudy, recordSoldBooks } from './sothebys-sold.mjs';

export function openSoldLimits(runtime) {
  const cohorts = [95, 99].map((cap) => {
    const db = openLedger(
      path.join(runtime, 'sothebys-price-limits', String(cap))
    );
    initSoldStudy(db);
    return { cap, db };
  });
  let checking = false;
  return {
    record(quotes, previous, maxGapMs) {
      for (const { cap, db } of cohorts)
        recordSoldBooks(db, quotes, previous, maxGapMs, cap);
    },
    summary() {
      return cohorts.map(({ cap, db }) => ({
        cap,
        ...db
          .prepare(
            `SELECT
        COALESCE(SUM(quantity),0) AS quantity,
        COALESCE(SUM(price*quantity+fees),0) AS cost,
        COALESCE(SUM(quantity) FILTER(WHERE payout IS NOT NULL),0) AS settled,
        SUM(payout-price*quantity-fees) FILTER(WHERE payout IS NOT NULL) AS net
        FROM paper`
          )
          .get()
      }));
    },
    async reconcile(io) {
      if (checking) return;
      checking = true;
      try {
        for (const { db } of cohorts) {
          if (
            db.prepare('SELECT 1 FROM paper WHERE payout IS NULL LIMIT 1').get()
          )
            await settle(db, io);
        }
      } finally {
        checking = false;
      }
    },
    close() {
      for (const { db } of cohorts) db.close();
    }
  };
}
