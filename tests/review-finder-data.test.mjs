import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultForm, restoreForm, localToIso, isoToLocal, clampParam, runBody, importStartDate, rideExtra,
  barSnapshot, nextTickDelay, newKeys, atRightEdge, shiftRange } from '../jesse/static/review/finder-data.mjs';
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

test('the 挂单 controls are saved with the form and sanitized', () => {
  assert.deepEqual(defaultForm().limit, { rule: 'sma5', x: 0.25, y: 0.382, k: 1, r: 2, hold: 48 });
  const saved = restoreForm(JSON.stringify({ limit: { v: 2, rule: 'retrace', x: 0, y: 1.5, k: 0, r: -2, hold: 2.6 } }));
  assert.deepEqual(saved.limit, { rule: 'retrace', v: 2, x: 0, y: 1.5, k: 0.01, r: 0.01, hold: 3 });
  // an unknown rule or non-numbers fall back to the defaults instead of drawing nonsense
  assert.deepEqual(restoreForm(JSON.stringify({ limit: { v: 2, rule: 'nope', x: 'a', y: null, k: 999, r: 1, hold: 0 } })).limit,
    { rule: 'sma5', v: 2, x: 0.25, y: 0.382, k: 999, r: 1, hold: 1 });
  // a form saved before v2 held the old default (next-bar open), not a user choice: it moves to SMA5
  assert.equal(restoreForm(JSON.stringify({ limit: { rule: 'open', x: 0.25 } })).limit.rule, 'sma5');
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
  // A database days behind starts from its newest candle's day, so no hole is left.
  assert.equal(importStartDate(Date.UTC(2026, 10, 15, 3, 0), Date.UTC(2026, 9, 27, 20, 29) / 1000), '2026-10-27');
  // A newest candle from today never pushes the start past yesterday.
  assert.equal(importStartDate(Date.UTC(2026, 10, 15, 3, 0), Date.UTC(2026, 10, 15, 2, 0) / 1000), '2026-11-14');
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

test('barSnapshot carries the numbers of the clicked candle, computed up to it only', () => {
  // 30 bars of a rising-then-flat series so MA, ATR and BOLL all have full windows.
  const candles = Array.from({ length: 30 }, (_, i) => {
    const close = 100 + i;
    return { time: 1763000000 + i * 180, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 10 };
  });
  const time = candles[24].time;
  const at24 = barSnapshot(candles, time, 3);
  // The candle's own OHLC is passed through untouched.
  assert.deepEqual([at24.open, at24.high, at24.low, at24.close], [123.5, 125, 123, 124]);
  // MA5 / MA10 of closes ending at bar 24 (120, 121, 122, 123, 124 / 115 … 124).
  assert.equal(at24.ma5, 122);
  assert.equal(at24.ma10, 119.5);
  // BOLL(20, 2) over bars 5..24: mid 114.5, the closes step by 1 so the population sd is sqrt((20²-1)/12).
  const sd = Math.sqrt((20 * 20 - 1) / 12);
  assert.equal(at24.bollMid, 114.5);
  assert.equal(at24.bollUpper, Math.round((114.5 + 2 * sd) * 1e6) / 1e6);
  assert.equal(at24.bollLower, Math.round((114.5 - 2 * sd) * 1e6) / 1e6);
  // ATR(14) is the Wilder average of the true ranges: every range here is 2, so it is 2 once warmed up.
  assert.equal(at24.atr, 2);
  // A bar whose windows are not complete yet has nulls, not invented numbers.
  const early = barSnapshot(candles, candles[2].time, 3);
  assert.deepEqual([early.ma5, early.ma10, early.atr, early.bollMid, early.bollUpper], [null, null, null, null, null]);
  // A time that is not a candle of this series gives nothing to note (the page opens no box for it).
  assert.equal(barSnapshot(candles, 1763000000 + 1, 3), null);
  assert.equal(barSnapshot(undefined, 1763000000, 3), null);
  // The ATR needs a previous bar: the first bar has none.
  assert.equal(barSnapshot(candles, candles[0].time, 3).atr, null);
});

test('nextTickDelay fires ~5s after every UTC minute and does not drift', () => {
  const at = (h, m, s, ms = 0) => Date.UTC(2026, 10, 15, h, m, s, ms);
  assert.equal(nextTickDelay(at(9, 30, 0)), 5000);
  assert.equal(nextTickDelay(at(9, 30, 5)), 60000);       // exactly on a trigger: the next minute, not "now"
  assert.equal(nextTickDelay(at(9, 30, 59, 500)), 5500);
  assert.equal(nextTickDelay(at(9, 30, 6)), 59000);
  // Following the delays one after another keeps the trigger at :05 of every minute.
  let now = at(9, 30, 7);
  const fired = [];
  for (let i = 0; i < 3; i++) { now += nextTickDelay(now); fired.push(new Date(now).toISOString().slice(11, 19)); }
  assert.deepEqual(fired, ['09:31:05', '09:32:05', '09:33:05']);
  // A NaN clock must not schedule a round in a tight loop.
  assert.equal(nextTickDelay(NaN), 5000);
});

test('newKeys names only the signals the previous answer did not have', () => {
  const old = [{ key: 'a' }, { key: 'b' }];
  const fresh = [{ key: 'a' }, { key: 'c' }, { key: 'd' }];
  assert.deepEqual(newKeys(old, fresh), ['c', 'd']);
  assert.deepEqual(newKeys([], fresh), ['a', 'c', 'd']);
  assert.deepEqual(newKeys(old, old), []);
  // A ride without a key (never drawn in the list) is not an event.
  assert.deepEqual(newKeys([], [{ start: 1 }]), []);
  assert.deepEqual(newKeys(undefined, undefined), []);
});

test('atRightEdge tells a chart glued to the newest bar from one dragged into history', () => {
  const last = 1800;
  assert.equal(atRightEdge({ from: 1200, to: 1800 }, last), true);
  assert.equal(atRightEdge({ from: 1200, to: 1860 }, last), true);   // past the last bar (right offset)
  assert.equal(atRightEdge({ from: 600, to: 1740 }, last), false);   // dragged back one bar
  assert.equal(atRightEdge(null, last), false);
  assert.equal(atRightEdge({ from: 1800, to: 1800 }, last), false);  // no width: nothing to follow
  assert.equal(atRightEdge({ from: 1200, to: 1800 }, null), false);
  assert.deepEqual(shiftRange({ from: 1200, to: 1800 }, 420), { from: 1620, to: 2220 });
});

test('the 实时 checkbox is saved with the form', () => {
  assert.equal(defaultForm().live, false);
  assert.equal(restoreForm(JSON.stringify({ live: true })).live, true);
  assert.equal(restoreForm(JSON.stringify({ live: 'yes' })).live, false);
});

test('live price: stream url, trade price, reconnect delay', async () => {
  const { streamUrl, tradePrice, reconnectDelay } = await import('../jesse/static/review/live-price.mjs');
  assert.equal(streamUrl('Binance Perpetual Futures', 'BTC-USDT'), 'wss://fstream.binance.com/market/ws/btcusdt@aggTrade');
  assert.equal(streamUrl('Binance Spot', 'ETH-USDT'), 'wss://stream.binance.com:9443/ws/ethusdt@aggTrade');
  assert.equal(streamUrl('Bybit USDT Perpetual', 'BTC-USDT'), null);
  assert.equal(tradePrice({ e: 'aggTrade', p: '80123.40' }), 80123.4);
  assert.equal(tradePrice({ e: 'trade', p: '1' }), null);
  assert.equal(tradePrice({ e: 'aggTrade', p: 'x' }), null);
  assert.deepEqual([0, 1, 2, 10].map(reconnectDelay), [1000, 2000, 4000, 30000]);
});
