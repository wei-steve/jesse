import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFactor, nextSpan, spanRange, MIN_FACTOR, MAX_FACTOR } from '../jesse/static/review/pricezoom.mjs';

test('wheel notches in and out cancel, and the factor is bounded', () => {
  assert.ok(Math.abs(nextFactor(nextFactor(1, 120), -120) - 1) < 1e-12);
  assert.ok(nextFactor(1, 100) > 1);     // scroll down -> more price visible -> shorter candles
  assert.ok(nextFactor(1, -100) < 1);
  assert.equal(nextFactor(1, 1e6), MAX_FACTOR);
  assert.equal(nextFactor(1, -1e6), MIN_FACTOR);
});

test('the span is bounded against the visible candles range', () => {
  assert.ok(Math.abs(nextSpan(nextSpan(20, 120, 20), -120, 20) - 20) < 1e-9);
  assert.equal(nextSpan(20, 1e6, 20), 20 * MAX_FACTOR);
  assert.equal(nextSpan(20, -1e6, 20), 20 * MIN_FACTOR);
});

test('a stretch keeps the same span wherever the chart is scrolled', () => {
  assert.deepEqual(spanRange({ minValue: 90, maxValue: 110 }, 10), { minValue: 95, maxValue: 105 });
  // a later window with a wider automatic range: same 10 of price, centred on its middle
  assert.deepEqual(spanRange({ minValue: 100, maxValue: 200 }, 10), { minValue: 145, maxValue: 155 });
  const same = { minValue: 1, maxValue: 2 };
  assert.equal(spanRange(same, null), same);
  assert.equal(spanRange(null, 10), null);
});

test('offset moves the range by whole spans', () => {
  assert.deepEqual(spanRange({ minValue: 90, maxValue: 110 }, 20, 0.5), { minValue: 100, maxValue: 120 });
  assert.deepEqual(spanRange({ minValue: 90, maxValue: 110 }, 10, -1), { minValue: 85, maxValue: 95 });
});
