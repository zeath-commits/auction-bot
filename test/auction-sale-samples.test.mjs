import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as flush} from 'node:timers/promises';
import {saleSampler} from '../auction-sale-samples.mjs';

test('sale samples retain empty books, timing failures and revisions without duplicating a release',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE auction_source_signals(event TEXT,kind TEXT,amount REAL)');
    const release=Math.floor(Date.now()/1000)*1000;
    let now=release,reads=0;
    const waits=[];
    const target={event:'LOT',markets:[{ticker:'LOT-10'}]};
    const markets=Promise.resolve([{ticker:'LOT-10',event_ticker:'LOT',floor_strike:10,status:'active',close_time:new Date(release+60000).toISOString()}]);
    const status={};
    const io={get:async()=>{
      reads++;
      return {requestedAt:now,receivedAt:now,httpDate:new Date(now).toUTCString(),
        body:{orderbooks:[{ticker:'LOT-10',orderbook_fp:{yes_dollars:[],no_dollars:[]}}]}};
    }};
    const sampler=saleSampler({db,io,status,stop:()=>false,now:()=>now,
      wait:ms=>new Promise(resolve=>waits.push({due:now+ms,resolve}))});
    sampler.start(target,release,12,markets);
    sampler.start(target,release,12,markets);
    await flush();
    for(const w of waits){
      const offset=w.due-release;
      now=w.due+(offset===4000?900:0);
      if(offset===15000)db.exec("INSERT INTO auction_source_signals VALUES('LOT','published_sale',15)");
      w.resolve();
      await flush();
    }
    await sampler.drain();
    sampler.start(target,release,12,markets);
    assert.equal(reads,6);
    const rows=db.prepare('SELECT offset,state,sample FROM auction_sale_samples ORDER BY offset').all();
    assert.equal(rows.length,7);
    assert.equal(rows[0].state,'Book timestamp overlaps release');
    assert.equal(rows[3].state,'Sampling window missed');
    assert.deepEqual(JSON.parse(rows[1].sample).rows[0].depth,{yes:[],no:[]});
    assert.equal(rows.at(-1).state,'Conflicting house results');
    assert.equal(status.releaseSampling.observations.Observed,4);
  } finally {db.close();}
});
