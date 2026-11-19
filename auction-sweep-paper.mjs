import {decimal, MICRO} from './core.mjs';
import {windowTrades} from './public-trades.mjs';

export function paperSweepAudit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auction_sweep_paper(id TEXT PRIMARY KEY,session TEXT,ticker TEXT,side TEXT,
    at INTEGER,quantity INTEGER,limitCents INTEGER,reserveCents INTEGER,checked INTEGER,volume REAL,
    matched INTEGER,trades TEXT,settlementCheck INTEGER,payoutPerShare REAL)`);
  const insert=db.prepare('INSERT OR IGNORE INTO auction_sweep_paper(id,session,ticker,side,at,quantity,limitCents,reserveCents) VALUES(?,?,?,?,?,?,?,?)');
  function ingest(session,records) {
    const receipts=new Set(records.filter(r=>r.mode==='paper'&&r.type==='receipt'&&r.hypothetical===true&&r.fillAssumed===false).map(r=>r.clientOrderId));
    for(const r of records){
      if(r.mode!=='paper'||r.type!=='intent'||r.strategy!=='auction_sweep'||!receipts.has(r.clientOrderId))continue;
      const q=r.quote,at=Date.parse(r.recordedAt);
      if(!r.clientOrderId||!/^KXART-[A-Z0-9]+-\d+$/.test(r.ticker)||!['YES','NO'].includes(r.side)||
        !Number.isFinite(at)||!Number.isSafeInteger(q?.quantity)||q.quantity<=0||!Number.isInteger(q.limitCents)||
        q.limitCents<=0||q.limitCents>=100||!Number.isSafeInteger(q.reserveCents)||q.reserveCents<q.quantity*q.limitCents)
        throw Error('Invalid dated paper order');
      insert.run(r.clientOrderId,session,r.ticker,r.side.toLowerCase(),at,q.quantity,q.limitCents,q.reserveCents);
    }
  }
  async function review(io,now) {
    const r=db.prepare('SELECT * FROM auction_sweep_paper WHERE volume IS NULL AND at<=? AND COALESCE(checked,0)<? ORDER BY COALESCE(checked,0),at LIMIT 1').get(now-66000,now-60000);
    if(r){
      db.prepare('UPDATE auction_sweep_paper SET checked=? WHERE id=?').run(now,r.id);
      const tape=await windowTrades(io,{ticker:r.ticker,arrival:r.at+1000,untilAt:r.at+6000},r.side,r.side);
      const matches=tape.filter(t=>Math.round(t.price*MICRO)<=r.limitCents*10000);
      const volume=matches.reduce((n,t)=>n+Math.round(t.qty*100),0)/100;
      db.prepare('UPDATE auction_sweep_paper SET volume=?,matched=?,trades=? WHERE id=?')
        .run(volume,Math.min(r.quantity,Math.floor(volume)),JSON.stringify(matches),r.id);
    }
    const m=db.prepare('SELECT ticker FROM auction_sweep_paper WHERE matched>0 AND payoutPerShare IS NULL AND COALESCE(settlementCheck,0)<? ORDER BY COALESCE(settlementCheck,0),at LIMIT 1').get(now-600000);
    if(!m)return;
    db.prepare('UPDATE auction_sweep_paper SET settlementCheck=? WHERE ticker=?').run(now,m.ticker);
    const market=(await io.get('/markets/'+m.ticker)).body.market;
    if(market.ticker!==m.ticker)throw Error('Wrong dated sweep settlement');
    if(market.status!=='finalized'||market.is_provisional||!Number.isFinite(Date.parse(market.settlement_ts)))return;
    const value=decimal(market.settlement_value_dollars)/MICRO;
    if(value>1)throw Error('Invalid binary settlement value');
    db.prepare("UPDATE auction_sweep_paper SET payoutPerShare=CASE WHEN side='yes' THEN ? ELSE ? END WHERE ticker=? AND matched>0").run(value,1-value,m.ticker);
  }
  function summary() {
    return db.prepare(`SELECT session,COUNT(*) attempts,SUM(quantity) requested,COUNT(volume) reviewed,SUM(COALESCE(matched,0)) supported,
      SUM(CASE WHEN payoutPerShare IS NOT NULL THEN matched ELSE 0 END) settledShares,
      SUM(CASE WHEN payoutPerShare IS NOT NULL THEN matched*(payoutPerShare-limitCents/100.0)
        - (((reserveCents-quantity*limitCents)*matched+quantity-1)/quantity)/100.0 ELSE 0 END) AS modeledNet
      FROM auction_sweep_paper GROUP BY session ORDER BY session DESC`).all();
  }
  return {ingest,review,summary};
}
