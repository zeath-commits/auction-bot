import test from 'node:test';
import assert from 'node:assert/strict';
import { findTotalPair, sizeTotalPair } from '../nba-total-pairs.mjs';

const market = (ticker, strike) => ({ ticker, floor_strike: strike, event_ticker: 'game', close_time: 'close',
  rules_primary: 'If over ' + strike + ' total points are scored in this game.', rules_secondary: 'Includes overtime.' });
const markets = [market('low', 210.5), market('high', 220.5)];
const book = (no, yes) => ({orderbook_fp: {no_dollars: no, yes_dollars: yes}});
const a = new Map([
  ['low', book([['0.60','25'],['0.55','20']], [['0.50','8']])],
  ['high', book([['0.52','10']], [['0.46','15'],['0.45','12']])]
]);
test('NBA pairs require the same terms and affordable asks in the monotonic direction', () => {
  const r = findTotalPair(markets, a);
  assert.equal(r.comparisons, 1);
  assert.equal(r.chosen.low.ticker, 'low');
  assert.equal(r.chosen.cost, .94);
  assert.equal(findTotalPair([markets[0], {...markets[1], rules_secondary: 'Regulation only.'}], a).comparisons, 0);
  assert.equal(findTotalPair(markets, new Map([['low',book([['0.55','2']],[])],['high',book([],[['0.46','2']])]])).chosen, null);
});
test('NBA pair matches repeated whole-contract depth, trading budget and fees on both legs', () => {
  const b = new Map([['low',book([['0.60','13'],['0.55','8']],[])],['high',book([],[['0.46','8'],['0.45','8']])]]);
  const pair = findTotalPair(markets, a).chosen;
  const sized = sizeTotalPair(a, b, pair, 1000);
  assert.equal(sized.quantity, 13);
  assert.ok(sized.legs.reduce((n,l)=>n+l.principal+l.fees,0) < sized.quantity);
  assert.equal(sizeTotalPair(a,b,pair,1).quantity, 1);
  assert.equal(sizeTotalPair(a,b,pair,.9).quantity, 0);
  assert.equal(sizeTotalPair(a,new Map([['low',book([['0.61','13']],[])],['high',b.get('high')]]),pair,1000).quantity, 0);
});
