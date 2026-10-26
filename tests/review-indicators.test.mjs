import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateIndicator } from '../jesse/static/review/indicators.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/review-indicators-jesse.json', import.meta.url)));
const candles = fixture.candles;
const closeEnough = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);

test('flat RSI uses the installed Jesse zero-loss convention', () => {
  const flat = candles.map(c => ({ ...c, open: 10, high: 10, low: 10, close: 10 }));
  assert.equal(calculateIndicator(flat, { type: 'RSI', period: 3 }, 1).series[0].data.at(-1).value, fixture.rsi_flat_last);
});

for (const sample of fixture.indicators ?? []) test(`${sample.config.type} matches installed Jesse deterministic fixture`, () => {
  const result = calculateIndicator(candles, sample.config, 1);
  assert.equal(result.series.length, sample.expected.length);
  for (const [index, expected] of sample.expected.entries()) {
    assert.deepEqual(result.series[index].data.map(p => p.time), candles.map(c => c.time));
    result.series[index].data.forEach((point, i) => {
      if (expected[i] === null) assert.equal(point.value, undefined);
      else closeEnough(point.value, expected[i]);
    });
  }
});

test('indicators never change a prefix when future candles are appended', () => {
  for (const type of ['SMA', 'EMA', 'BOLL', 'RSI', 'MACD', 'ATR', 'VOLUME']) {
    const config = type === 'MACD' ? { type, fast: 2, slow: 3, signal: 2 }
      : type === 'VOLUME' ? { type } : { type, period: 3, deviation: 2 };
    const full = calculateIndicator(candles, config, 1);
    const prefix = calculateIndicator(candles.slice(0, 8), config, 1);
    full.series.forEach((series, i) => assert.deepEqual(series.data.slice(0, 8), prefix.series[i].data));
  }
});

test('gaps restart indicator warmup and retain every candle timestamp as whitespace', () => {
  const gapped = [candles[0], candles[1], ...candles.slice(4, 8)];
  for (const type of ['SMA', 'RSI', 'ATR', 'BOLL']) {
    const result = calculateIndicator(gapped, { type, period: 3, deviation: 2 }, 1);
    assert.deepEqual(result.series[0].data.map(p => p.time), gapped.map(c => c.time));
    assert.equal(result.series[0].data[2].value, undefined);
  }
});

test('volume is aggregated input volume, with no warmup or invented values', () => {
  assert.deepEqual(calculateIndicator(candles, { type: 'VOLUME' }, 1).series[0].data.map(p => p.value), candles.map(c => c.volume));
  assert.deepEqual(calculateIndicator([], { type: 'RSI', period: 14 }, 1).series[0].data, []);
});
