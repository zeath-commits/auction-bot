import test from 'node:test';
import assert from 'node:assert/strict';
import { liveSignal, nbaOffer } from '../nba-paper.mjs';

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
