import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {delayedAuctionDepth} from '../auction-delayed-depth.mjs';

test('late auction observations preserve depth, empty books, missed windows and independent trade evidence',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const monitor=delayedAuctionDepth(db);
    const published=Date.parse('2026-11-19T20:00:00Z'), minute=60000;
    const history=[{kind:'published_sale',amount:100,seenAt:new Date(published).toISOString()}];
    const markets=[90,100].map(strike=>({ticker:'LOT-'+strike,floor_strike:strike,strike_type:'greater',
      status:'active',close_time:'2026-11-21T20:00:00Z'}));
    const target={event:'LOT',markets}, config={maxQuoteAgeMs:2000,maxSourceAgeMs:15000};
    monitor.register('LOT',history);
    function record(at,qty,options={}){
      const sig={kind:'published_sale',amount:100,url:'house',requestedAt:at-2000};
      const books=new Map(markets.map((m,i)=>[m.ticker,{httpDate:new Date(at).toUTCString(),cacheAge:options.age??0,
        requestedAt:at-50,receivedAt:at,body:{ticker:m.ticker,orderbook_fp:{
          yes_dollars:i&&qty?[['0.20',String(qty)]]:[],no_dollars:!i&&qty?[['0.10','20']]:[]}}}]));
      monitor.record(target,sig,options.partial?markets.slice(1):markets,books,config,at);
    }
    const t=published+15*minute;
    record(t+2000,12,{age:5});
    record(t+2000,12,{partial:true});
    assert.equal(monitor.summary(t+2000).at(-1).state,'Scheduled');
    record(t+2000,12);
    record(t+2800,1);
    assert.equal(monitor.summary(t+2800).at(-1).state,'Awaiting second book');
    const restarted=delayedAuctionDepth(db);
    restarted.register('LOT',history);
    record(t+8000,7);
    record(t+12000,50);
    const row=restarted.summary(t+13000).at(-1);
    assert.equal(row.elapsedMs,6000);
    assert.equal(row.repeated,27);
    assert.deepEqual(row.pick,{ticker:'LOT-100',side:'NO',price:.8,quantity:7});
    assert.equal(row.supported,null);
    const io={get:async p=>{
      if(p==='/historical/cutoff')return {body:{trades_created_ts:'2026-09-01T00:00:00Z'}};
      assert(p.startsWith('/markets/trades?'));assert(p.includes('ticker=LOT-100'));
      const trade=(id,price,qty,offset)=>({ticker:'LOT-100',trade_id:id,is_block_trade:false,
        taker_outcome_side:'no',taker_book_side:'ask',created_time:new Date(t+8000+offset).toISOString(),
        no_price_dollars:price,count_fp:qty});
      return {body:{trades:[trade('a','.79','3.50',3000),trade('b','.81','100',3000),trade('c','.80','2',6000)]}};
    }};
    await restarted.review(io,t+80000);
    assert.equal(restarted.summary(t+81000).at(-1).supported,3);
    record(published+30*minute+2000,0);
    record(published+30*minute+9000,0);
    const summary=restarted.summary(published+65*minute);
    assert.equal(summary.length,3);
    assert.equal(summary[0].state,'Missed window');
    assert.equal(summary[1].state,'Observed');assert.equal(summary[1].repeated,0);
    restarted.verify('LOT',{kind:'unsold',amount:null});
    assert(restarted.summary(t).every(r=>r.state==='Revised result'&&r.supported===null));
  } finally {db.close();}
});
