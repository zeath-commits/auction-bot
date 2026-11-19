import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {withdrawalListing,observeWithdrawalReports} from '../withdrawal-reports.mjs';

const lot='https://www.christies.com/en/lot/lot-123';
const article='12345678-aaaa-aaaa-aaaa-123456789abc';
const entry=url=>'news_link:[{collection:"HENI_News_Articles",item:{__typename:"HENI_News_Articles",id:"'+article+'",url:"'+url+'",publishDate:"2026-11-17T22:00:00"}}]';
const html='title:"Highest Value Withdrawn Lots",entries:[{'+entry(lot+'?ref=a')+'}]},{column_names:[{'+entry(lot+'4')+'}]';
test('withdrawal listing matches the house lot URL and stops before the next category',()=>{
  const {count,reports}=withdrawalListing(html);
  assert.equal(count,1);
  assert.deepEqual([...reports.keys()],[lot]);
  assert.throws(()=>withdrawalListing(html.replace('news_link:','news_link:[],news_link:')),/Incomplete/);
});
test('withdrawal report stores the first books and the shared NO depth for the exact active lot',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const event='KXART-ABC',ticker=event+'-1000',terms={ticker,primary:'sale above $1,000',secondary:'',strikeType:'greater',threshold:1000};
    const target={event,url:lot,markets:[terms]};
    const market={ticker,event_ticker:event,rules_primary:terms.primary,rules_secondary:'',strike_type:'greater',
      floor_strike:1000,notional_value_dollars:'1.0000',market_type:'binary',status:'active',close_time:new Date(Date.now()+3600000).toISOString()};
    const eventBody={event:{event_ticker:event,settlement_sources:[{name:'Artnet',url:'https://www.artnet.com'}],markets:[market]}};
    let bookCount=0;
    const io={async get(route){
      if(route.startsWith('/events/'))return {body:eventBody};
      const at=(Math.ceil(Date.now()/1000)+ ++bookCount)*1000;
      return {requestedAt:at-50,receivedAt:at+50,httpDate:new Date(at).toUTCString(),cacheAge:0,
        body:{orderbooks:[{ticker,orderbook_fp:{yes_dollars:[['0.0600',bookCount===1?'10.5':'3.8']]}}]}};
    }};
    const options={db,io,auctions:[{startAt:new Date().toISOString(),deadline:market.close_time,targets:[target,{...target,event:'other',url:lot+'4'}]}],
      fetchPage:async()=>new Response(html),pause:async()=>{}};
    for(let scan=0;scan<2;scan++){
      const status={};
      await observeWithdrawalReports({...options,status,stop:()=>!!status.at||!!status.error});
      assert.equal(status.error,null);
      assert.equal(status.open,1);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM auction_withdrawal_reports').get().n,1);
    const quotes=db.prepare('SELECT kind,detail FROM auction_withdrawal_quotes ORDER BY kind').all();
    assert.deepEqual(quotes.map(r=>r.kind),['first','through95','through99']);
    assert.deepEqual(JSON.parse(quotes[0].detail).levels,[{price:.94,quantity:3}]);
  }finally{db.close();}
});
