import test from 'node:test';
import assert from 'node:assert/strict';
import { liveSignal, nbaOffer, nbaRoutes, repeatedNbaOffers, nbaPlayContext } from '../nba-paper.mjs';

test('NBA model evidence belongs to the exact play and the leading team',()=>{
  const summary={header:{competitions:[{competitors:[{homeAway:'away',team:{id:'3'}}]}]},
    winprobability:[{playId:'p1',homeWinPercentage:.12,tiePercentage:0},{playId:'p2',homeWinPercentage:.2,tiePercentage:0}]};
  const play={id:'p1',type:{text:'Shooting Foul'},team:{id:'3'},awayScore:115,homeScore:110};
  const evidence=nbaPlayContext(summary,play);
  assert.equal(evidence.leaderProbability,.88);assert.equal(evidence.byLeader,true);
  assert.equal(nbaPlayContext(summary,{...play,id:'p0'}).leaderProbability,null);
  summary.winprobability.push(summary.winprobability[0]);
  assert.equal(nbaPlayContext(summary,play).leaderProbability,null);
});

test('NBA offer comparison validates game equivalence and confirms each route independently', () => {
  const event = 'KXNBAGAME-TEST';
  const signal = {ticker:event+'-NYK',opponent:event+'-PHI'};
  function market(ticker, team) {
    return {ticker,event_ticker:event,market_type:'binary',notional_value_dollars:'1.0000',status:'active',
      close_time:'2026-11-19T03:00:00Z',yes_sub_title:team,
      rules_primary:'If '+team+' wins the New York vs Philadelphia game, then the market resolves to Yes.',
      rules_secondary:'League cancellation rules apply.'};
  }
  const markets = [market(signal.ticker,'New York'),market(signal.opponent,'Philadelphia')];
  const body = {event:{event_ticker:event, series_ticker:'KXNBAGAME', mutually_exclusive:true,markets}};
  const routes = nbaRoutes(body,signal,event);
  assert.deepEqual(routes.map(r=>r.side),['yes','no']);
  function books(leaderBid,opponentBid) {
    return [{ticker:signal.ticker,orderbook_fp:{no_dollars:[[leaderBid,'2.00']]}},
      {ticker:signal.opponent,orderbook_fp:{yes_dollars:[[opponentBid,'5.00']]}}];
  }
  const at = Date.parse('2026-11-19T02:00:00Z');
  const offers = (a,b) => repeatedNbaOffers(routes,a,b,at);
  assert.equal(offers(books('.02','.03'),books('.02','.03'))[0].side,'no');
  assert.equal(offers(books('.02','.02'),books('.02','.02'))[0].side,'yes');
  assert.deepEqual(offers(books('.02','.04'),books('.02','.03')).map(o=>o.side),['yes']);
  assert.equal(repeatedNbaOffers(routes,books('.02','.03'),books('.02','.03'),Date.parse(markets[0].close_time)).length,0);
  markets[1].rules_secondary='Different cancellation rules.';
  assert.deepEqual(nbaRoutes(body,signal,event).map(r=>r.side),['yes']);
});

test('five-point NBA signal needs a fresh play and a matching live scoreboard', () => {
  const now = Date.parse('2026-11-19T02:00:00Z'),
    stamp = new Date(now - 4000).toISOString();
  const competitors = [
    { homeAway: 'away', score: '106', team: { abbreviation: 'WSH' } },
    { homeAway: 'home', score: '111', team: { abbreviation: 'TOR' } }
  ];
  const game = {
    id: 'g',
    date: '2026-11-19T00:00:00Z',
    competitions: [{ competitors }],
    status: { period: 4, displayClock: '47.0', type: { state: 'in' } }
  };
  const summary = {
    header: {
      id: 'g',
      competitions: [
        {
          competitors: structuredClone(competitors),
          status: { type: { state: 'in' } }
        }
      ]
    },
    plays: [
      {
        period: { number: 4 },
        clock: { displayValue: '47.0' },
        wallclock: stamp,
        homeScore: 111,
        awayScore: 106
      }
    ]
  };
  assert.equal(
    liveSignal(summary, game, now).ticker,
    'KXNBAGAME-26NOV18WASTOR-TOR'
  );
  assert.equal(liveSignal(summary, game, now + 12000), null);
  game.competitions[0].competitors[0].score = '108';
  assert.equal(liveSignal(summary, game, now), null);
  assert.deepEqual(
    nbaOffer({
      orderbook_fp: {
        no_dollars: [
          ['0.0100', '5'],
          ['0.0200', '3']
        ]
      }
    }),
    { price: 0.98, depth: 3 }
  );
  assert.equal(
    nbaOffer({ orderbook_fp: { no_dollars: [['0.0100', '0.2']] } }),
    null
  );
});
