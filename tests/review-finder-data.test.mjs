import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultForm, restoreForm, localToIso, isoToLocal, clampParam, runBody, importStartDate, rideExtra } from '../jesse/static/review/finder-data.mjs';
import { buildRides, rideSeries, signalStatus } from '../jesse/static/review/rides.mjs';

test('restoreForm falls back to defaults field by field', () => {
  assert.deepEqual(restoreForm(null), defaultForm());
  assert.deepEqual(restoreForm('not json'), defaultForm());
  const saved = restoreForm(JSON.stringify({ exchange: ' Bybit ', symbol: '', rangeMode: 'custom', recentDays: 5, window: 7,
    factor: 'x', params: { x: { a: 1, b: 'no' }, y: 3 }, timeframes: { x: ['1h', '7q', 5] }, overlay: true }));
  assert.equal(saved.exchange, 'Bybit');
  assert.equal(saved.symbol, 'BTC-USDT');
  assert.equal(saved.rangeMode, 'custom');
  assert.equal(saved.recentDays, 7);
  assert.equal(saved.window, 86400);
  assert.deepEqual(saved.params, { x: { a: 1 }, y: {} });
  assert.deepEqual(saved.timeframes, { x: ['1h'] });
  assert.equal(saved.overlay, true);
});

test('datetime-local values are UTC', () => {
  assert.equal(localToIso('2026-10-27T08:30'), '2026-10-27T08:30:00Z');
  assert.equal(localToIso(''), null);
  assert.equal(isoToLocal(Date.UTC(2026, 9, 27, 8, 30)), '2026-10-27T08:30');
});

test('clampParam keeps ints as ints and falls back to the default', () => {
  const spec = { default: 8, min: 3, max: 50 };
  assert.equal(clampParam(spec, '12.6'), 13);
  assert.equal(clampParam(spec, '1'), 3);
  assert.equal(clampParam(spec, '999'), 50);
  assert.equal(clampParam(spec, ''), 8);
  assert.equal(clampParam({ default: 0.25, min: 0, max: 2 }, '0.35'), 0.35);
});

test('runBody: recent mode has no finish; custom mode converts UTC fields', () => {
  const now = Date.UTC(2026, 9, 27, 12, 0);
  const form = { ...defaultForm(), recentDays: 3 };
  const body = runBody(form, 'f', { a: 1 }, ['1h'], now);
  assert.equal(body.start, '2026-10-24T12:00:00.000Z');
  assert.ok(!('finish' in body));
  assert.deepEqual([body.factor, body.params, body.timeframes], ['f', { a: 1 }, ['1h']]);
  const custom = runBody({ ...form, rangeMode: 'custom', start: '2026-10-20T00:00', finish: '2026-10-21T06:30' }, 'f', {}, ['1h'], now);
  assert.deepEqual([custom.start, custom.finish], ['2026-10-20T00:00:00Z', '2026-10-21T06:30:00Z']);
  assert.ok(!('finish' in runBody({ ...form, rangeMode: 'custom', start: '2026-10-20T00:00' }, 'f', {}, [], now)));
  assert.throws(() => runBody({ ...form, rangeMode: 'custom' }, 'f', {}, [], now), /开始时间/);
});

test('importStartDate is yesterday in UTC', () => {
  assert.equal(importStartDate(Date.UTC(2026, 9, 27, 0, 5)), '2026-10-26');
  assert.equal(importStartDate(Date.UTC(2026, 10, 1, 23, 59)), '2026-10-31');
});

test('rideExtra writes only changes, timed at the last 1m candle of the bar, and feeds rides.mjs', () => {
  const c5 = [0, 300, 600, 900, 1200, 1500].map(time => ({ time }));
  const answer = { '5m': { candles: c5, value: [0, 10, 10, 20, 0, -5], touches: [0, 0, 1, 2, 0, 0] } };
  const extra = rideExtra(answer);
  assert.deepEqual(extra.ride['5m'].data, [
    { time: 240, value: 0 }, { time: 540, value: 10 }, { time: 1140, value: 20 }, { time: 1440, value: 0 }, { time: 1740, value: -5 }]);
  const series = rideSeries(extra);
  const rides = buildRides(extra, 1800 + 60);
  assert.deepEqual(rides.map(r => [r.dir, r.start, r.end, r.ended, r.periods, r.maxTouches]), [
    [1, 540, 1440, true, [10, 20], 2],
    [-1, 1740, 1860, false, [5], 0]]);
  assert.equal(signalStatus(series, 1000).text, '5m ↑MA10');
  assert.equal(signalStatus(series, 1800).advice, '5m 向下 → 不宜做多');
});

test('timeframes the page does not know are skipped, empty answers give no series', () => {
  assert.deepEqual(rideExtra({ '7q': { candles: [{ time: 0 }], value: [1] } }), { ride: {}, ride_touches: {} });
  assert.deepEqual(rideExtra({ '1h': { candles: [], value: [] } }).ride, {});
});
