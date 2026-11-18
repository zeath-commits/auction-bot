import test from 'node:test';
import assert from 'node:assert/strict';
import { stations, parseReport, crossed } from '../weather-high.mjs';
import { repeatedWeatherAsk } from '../weather-paper.mjs';
test('NWS high crossing preserves source, calendar date, one-degree cushion and inclusive brackets', () => {
  const s = stations[0],
    text =
      'CLIPHL\n...THE PHILADELPHIA PA CLIMATE SUMMARY FOR NOVEMBER 17 2026...\nVALID TODAY AS OF 0400 PM LOCAL TIME.\nTEMPERATURE (F)\n TODAY\n MAXIMUM 58 3:45 PM';
  const doc = {
    id: 'sample',
    issuanceTime: '2026-11-17T21:39:00Z',
    issuingOffice: 'KPHI',
    productCode: 'CLI',
    productText: text
  };
  const r = parseReport(s, doc);
  assert.equal(r.event, 'KXHIGHPHIL-26NOV17');
  assert.equal(
    parseReport(s, { ...doc, issuanceTime: '2026-11-18T21:39:00Z' }),
    null
  );
  assert.equal(
    parseReport(s, {
      ...doc,
      productText: text.replace('PHILADELPHIA PA', 'CENTRAL PARK NY')
    }),
    null
  );
  const m = {
    event_ticker: r.event,
    market_type: 'binary',
    notional_value_dollars: '1.0000',
    strike_type: 'between',
    floor_strike: 56,
    cap_strike: 57,
    rules_primary:
      'If the maximum temperature recorded at Philadelphia (CLIPHL) for Nov 17, 2026, is between 56-57° fahrenheit according to The Weather Company, then the market resolves to Yes.'
  };
  assert.equal(crossed(s, r, m), null);
  assert.equal(crossed(s, { ...r, high: 59 }, m), 'no');
  assert.equal(
    crossed(
      s,
      { ...r, high: 59 },
      { ...m, rules_primary: m.rules_primary.replace('CLIPHL', 'CLIPIT') }
    ),
    null
  );
});
test('paper weather quotes require a whole contract on the signal side in two reads', () => {
  const book = (bid, q) => ({ orderbook_fp: { yes_dollars: [[bid, q]] } });
  assert.deepEqual(
    repeatedWeatherAsk(book('0.01', '3'), book('0.02', '2'), 'no'),
    { price: 0.98, depth: 2 }
  );
  assert.equal(
    repeatedWeatherAsk(book('0.02', '3'), book('0.01', '2'), 'no'),
    null
  );
  assert.equal(
    repeatedWeatherAsk(book('0.01', '0.50'), book('0.01', '2'), 'no'),
    null
  );
});
