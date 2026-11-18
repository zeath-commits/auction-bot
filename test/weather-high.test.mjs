import test from 'node:test';
import assert from 'node:assert/strict';
import { stations, westernStations, stationDay, afternoonForecast, parseReport, crossed } from '../weather-high.mjs';
import { forecastOffer, repeatedWeatherAsk } from '../weather-paper.mjs';
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
  assert.equal(afternoonForecast(s,{...r,high:56},[m]),m);
  assert.equal(afternoonForecast(s,{...r,high:57},[m,m]),null);
  assert.equal(afternoonForecast(s,r,[m]),null);
  assert.equal(afternoonForecast(s,{...r,high:56},[{...m,rules_primary:'Different settlement station'}]),null);
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

test('western cities use local standard-day boundaries and a full five-share fee-adjusted quote', () => {
  const at=Date.parse('2026-11-18T07:30:00Z');
  assert.equal(stationDay(westernStations[0],at).event,'KXHIGHDEN-26NOV18');
  assert.equal(stationDay(westernStations[1],at).event,'KXHIGHLAX-26NOV17');
  const snap=(at,bids)=>({at,asOf:at-500,books:new Map([['T',{orderbook_fp:{no_dollars:bids}}]])});
  const levels=[['0.07','2'],['0.05','3']];
  const a=snap(1500,levels),b=snap(2800,levels);
  const q=forecastOffer(a,b,'T');
  assert.equal(q.quantity,5);
  assert.ok(Math.abs(q.price-.942)<1e-9);
  assert.equal(q.fees,.02);
  assert.equal(forecastOffer(a,{...b,asOf:a.asOf},'T'),null);
  assert.equal(forecastOffer(a,snap(2800,[['0.05','5']]),'T'),null);
  assert.equal(forecastOffer(a,snap(2800,[['0.04','8']]),'T'),null);
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
