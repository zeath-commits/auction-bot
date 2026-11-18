import test from 'node:test';
import assert from 'node:assert/strict';
import { stationEvidence, stationSupports } from '../weather-station.mjs';
import { stations } from '../weather-high.mjs';
import { threeOClock, threeSignals, beforeThreeCrossings } from '../weather-three.mjs';

test('3 p.m. weather snapshot keeps the climate day and excludes later reports and corrections', () => {
  const station = stations[0];
  const when = Date.parse('2026-07-04T20:06:00Z');
  const window = threeOClock(station, when);
  assert.equal(window.start,Date.parse('2026-07-04T20:00:00Z'));
  assert.equal(threeOClock(station,Date.parse('2026-07-05T04:30:00Z')).event,window.event);
  const market = {event_ticker:window.event, market_type:'binary', notional_value_dollars:'1.0000',
    strike_type:'greater',floor_strike:65,rules_primary:'If the maximum temperature recorded at Philadelphia (CLIPHL) for Jul 4, 2026, is greater than 65° fahrenheit according to The Weather Company, then the market resolves to Yes.'};
  function reading(minutes,raw,receipt = minutes + 1) {
    return {icaoId:'KPHL',metarType:'METAR',obsTime:window.start/1000+minutes*60,
      reportTime:new Date(window.start+minutes*60000).toISOString(),receiptTime:new Date(window.start+receipt*60000).toISOString(),
      rawOb:'METAR KPHL RMK '+raw};
  }
  const rows = [reading(-60,'T02000000'), reading(-30,'T02000000'), reading(-10,'T03000000',3)];
  const early = beforeThreeCrossings(station,window,rows,[{...market,ticker:'EXAMPLE'}]);
  assert.equal(early.length,1);
  assert.equal(early[0].window.start,window.start-29*60000);
  assert.equal(early[0].window.end,window.start);
  const check = (time,observations=rows) => threeSignals(station,window,observations,[market],time);
  assert.equal(check(when).evidence.maximum,68);
  assert.deepEqual(check(when).signals.map(r=>r.side),['yes']);
  assert.equal(check(window.start-1).signals.length,0);
  assert.equal(check(window.end).signals.length,0);
  assert.equal(check(when,[...rows,reading(-30,'COR T01000000',2)]).signals.length,0);
});
test('a six-hour maximum crossing midnight can check a reported peak but cannot set a minimum for the new day', () => {
  const hour = 3600000,
    start = Date.parse('2026-11-13T05:00Z'),
    s = { cli: 'NYC' },
    r = {
      dayStart: start,
      ts: start + 16 * hour,
      peakAt: start + 11 * 60000,
      high: 52
    };
  const metar = (end, raw) => ({
    icaoId: 'KNYC',
    metarType: 'METAR',
    reportTime: new Date(end).toISOString(),
    obsTime: (end - 9 * 60000) / 1000,
    receiptTime: new Date(end - 6 * 60000).toISOString(),
    rawOb: 'METAR KNYC RMK ' + raw
  });
  const a = metar(start + hour, 'T00890060 10111'),
    b = metar(start + 7 * hour, 'T00390022 10089');
  const future = {
    ...b,
    receiptTime: new Date(r.ts + 1000).toISOString(),
    rawOb: 'METAR KNYC RMK 10278'
  };
  const e = stationEvidence(s, r, [a, b, future]);
  assert.equal(e.peakWindow.temp, 52);
  assert.equal(e.maximum, 48);
  assert.equal(e.contradicted, false);
  assert.equal(
    stationSupports(e, { strike_type: 'less', cap_strike: 50 }, 'no'),
    false
  );
  assert.equal(
    stationEvidence(s, { ...r, high: 54 }, [a, b]).contradicted,
    true
  );
});
