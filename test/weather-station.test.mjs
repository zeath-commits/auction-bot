import test from 'node:test';
import assert from 'node:assert/strict';
import { stationEvidence, stationSupports } from '../weather-station.mjs';
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
