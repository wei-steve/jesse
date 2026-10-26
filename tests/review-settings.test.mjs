import test from 'node:test';
import assert from 'node:assert/strict';
import { timeframeMinutes, configuredIntervals, chooseIntervals, validateIndicator, restorePreferences } from '../jesse/static/review/settings.mjs';

test('parses fixed Jesse minute/hour/day periods without confusing months with minutes', () => {
  assert.equal(timeframeMinutes('45m'), 45);
  assert.equal(timeframeMinutes('4h'), 240);
  assert.equal(timeframeMinutes('1D'), 1440);
  assert.equal(timeframeMinutes('1M'), null);
  assert.equal(timeframeMinutes('1W'), null);
  assert.equal(timeframeMinutes('0m'), null);
});

test('discovers only the selected exchange-symbol configured intervals', () => {
  const route = { exchange: 'A', symbol: 'BTC-USDT', timeframe: '1m' };
  const form = { routes: [route], data_routes: [
    { ...route, timeframe: '15m' }, { ...route, timeframe: '1h' },
    { ...route, timeframe: '4h' }, { ...route, timeframe: '1D' },
    { ...route, symbol: 'ETH-USDT', timeframe: '3m' },
    { ...route, exchange: 'B', timeframe: '5m' },
  ] };
  assert.deepEqual(configuredIntervals(form, route), [1, 15, 60, 240, 1440]);
  assert.deepEqual(chooseIntervals(configuredIntervals(form, route)), [1440, 240, 60, 1]);
});

test('initial selection preserves four currently configured periods', () => {
  assert.deepEqual(chooseIntervals([1, 3, 5, 15]), [15, 5, 3, 1]);
  assert.deepEqual(chooseIntervals([60]), [60]);
});

test('validates parameter ranges and prevents unsupported indicator/placement combinations', () => {
  assert.deepEqual(validateIndicator({ type: 'EMA', period: 20, color: '#aabbcc' }),
    { type: 'EMA', period: 20, color: '#aabbcc' });
  for (const config of [
    { type: 'EMA', period: 0 }, { type: 'RSI', period: 2.5 },
    { type: 'BOLL', period: 20, deviation: -1 },
    { type: 'MACD', fast: 26, slow: 12, signal: 9 },
    { type: 'SCRIPT', source: 'alert(1)' }, { type: 'SMA', period: 5, color: 'url(x)' },
  ]) assert.throws(() => validateIndicator(config));
});

test('display preferences recover from invalid JSON and validate saved settings', () => {
  const defaults = restorePreferences('bad json');
  assert.deepEqual(defaults.indicators.map(i => i.type), ['SMA']);
  assert.equal(defaults.intervals, null);
  const restored = restorePreferences(JSON.stringify({ version: 1, intervals: [1, 60, 240],
    indicators: [{ type: 'RSI', period: 14, color: '#aabbcc' }], authToken: 'ignored' }));
  assert.deepEqual(restored.intervals, [240, 60, 1]);
  assert.deepEqual(Object.keys(restored).sort(), ['indicators', 'intervals', 'version']);
  assert.deepEqual(restorePreferences(JSON.stringify({ version: 1, intervals: [1, 3, 5, 15, 60], indicators: [] })).intervals, null);
  assert.equal(restorePreferences(JSON.stringify({ version: 1, indicators: [{ type: 'EMA', period: -5 }] })).indicators[0].type, 'SMA');
  assert.deepEqual(restorePreferences(JSON.stringify({ version: 1, indicators: [] })).indicators, []);
});
