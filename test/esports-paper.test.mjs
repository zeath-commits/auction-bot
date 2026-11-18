import test from 'node:test';
import assert from 'node:assert/strict';
import { cs2Quotes, confirmedCS2, matchCS2 } from '../esports-paper.mjs';

const start=Date.parse('2026-11-18T21:00:00Z'), at=start-300000;
const teams=['Los Ninos','BORRACHEIROS'];
const e={event_ticker:'KXCS2GAME-X',series_ticker:'KXCS2GAME',mutually_exclusive:true,
  markets:teams.map((team,i)=>({ticker:'KXCS2GAME-X-'+i,event_ticker:'KXCS2GAME-X',yes_sub_title:team,
    market_type:'binary',status:'active',notional_value_dollars:'1',close_time:new Date(start+86400000).toISOString(),
    rules_primary:'If '+team+' wins the CS2 match originally scheduled for Nov 18, 2026 at 4:00 PM EST, then the market resolves to Yes.',
    rules_secondary:'The following market refers to the full match'}))};
const pm={slug:'aec-cs2-test',gameStartTime:new Date(start).toISOString(),active:true,closed:false,
  status:'MARKET_STATUS_OPEN',sportsMarketType:'esports_match_winner',marketType:'moneyline',description:'winner of the CS2 match',
  marketSides:['Los Niños','BORRACHEIROS'].map((description,i)=>({description,long:!i,tradable:true,team:{league:'cs2'}}))};
const match=matchCS2(e,pm,at);
const level=(p,n)=>({px:{currency:'USD',value:String(p)},qty:String(n)});
const reference={marketSlug:pm.slug,state:'MARKET_STATE_OPEN',transactTime:new Date(at-5000).toISOString(),
  bids:[level(.58,.1),level(.55,20)],offers:[level(.57,8)]};
const books=e.markets.map(m=>({ticker:m.ticker,orderbook_fp:{no_dollars:[['0.5000','20.00']]}}));

test('CS2 checks both team identities, full match, and scheduled start',()=>{
  assert.equal(match.routes.length,2);
  assert.equal(matchCS2(e,{...pm,marketSides:[pm.marketSides[0],pm.marketSides[0]]},at),null);
  assert.equal(matchCS2(e,{...pm,gameStartTime:new Date(start+60000).toISOString()},at),null);
  assert.equal(matchCS2(e,pm,start-120000),null);
});
test('CS2 directional reference uses depth, opposite side orientation and after-fee gap',()=>{
  const rows=cs2Quotes(match,reference,books,at);
  assert.deepEqual(rows.map(x=>[x.referenceBid,x.gap]),[[.55,.0325],[.43,-.0875]]);
  assert.equal(confirmedCS2(rows,rows).team,teams[0]);
  assert.equal(confirmedCS2(rows,[{...rows[0],price:.51}]),null);
  assert.equal(confirmedCS2(rows,[{...rows[0],gap:.0199}]),null);
  for(const change of [{offers:[level(.62,5)]},{offers:[level(.57,2)]},{transactTime:new Date(at-61000).toISOString()}])
    assert.deepEqual(cs2Quotes(match,{...reference,...change},books,at),[]);
});
