import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFactor, scaledRange, MIN_FACTOR, MAX_FACTOR } from '../jesse/static/review/pricezoom.mjs';

test('wheel notches in and out cancel, and the factor is bounded', () => {
  assert.ok(Math.abs(nextFactor(nextFactor(1, 120), -120) - 1) < 1e-12);
  assert.ok(nextFactor(1, 100) > 1);     // scroll down -> more price visible -> shorter candles
  assert.ok(nextFactor(1, -100) < 1);
  assert.equal(nextFactor(1, 1e6), MAX_FACTOR);
  assert.equal(nextFactor(1, -1e6), MIN_FACTOR);
});

test('the automatic range is scaled around its middle', () => {
  assert.deepEqual(scaledRange({ minValue: 90, maxValue: 110 }, 2), { minValue: 80, maxValue: 120 });
  assert.deepEqual(scaledRange({ minValue: 90, maxValue: 110 }, 0.5), { minValue: 95, maxValue: 105 });
  const same = { minValue: 1, maxValue: 2 };
  assert.equal(scaledRange(same, 1), same);
  assert.equal(scaledRange(null, 2), null);
});
