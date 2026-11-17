import test from 'node:test';
import assert from 'node:assert/strict';
import { barRemaining, formatCountdown, CountdownPrimitive } from '../jesse/static/review/bar-countdown.mjs';

test('barRemaining computes UTC-aligned remaining seconds in 1..period', () => {
  assert.equal(barRemaining(1, 120), 60);
  assert.equal(barRemaining(1, 125), 55);
  assert.equal(barRemaining(1, 125.9), 55);
  assert.equal(barRemaining(15, 900 * 3 + 1), 899);

  // 4h (240m = 14400s) and 1D (1440m = 86400s) UTC boundaries
  assert.equal(barRemaining(240, 14400 * 10), 14400);
  assert.equal(barRemaining(240, 14400 * 10 + 3600), 10800);
  assert.equal(barRemaining(1440, 86400 * 5), 86400);
  assert.equal(barRemaining(1440, 86400 * 5 + 86399), 1);
  assert.equal(barRemaining(1, 0), 60);
});

test('barRemaining returns null for non-positive or non-finite inputs', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, '15']) {
    assert.equal(barRemaining(bad, 120), null);
  }
  for (const badNow of [-1, NaN, Infinity, -Infinity, null, undefined, '120']) {
    assert.equal(barRemaining(1, badNow), null);
  }
});

test('formatCountdown formats mm:ss under an hour, hh:mm:ss from an hour up, and empty for invalid', () => {
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(65), '01:05');
  assert.equal(formatCountdown(3599), '59:59');
  assert.equal(formatCountdown(3600), '01:00:00');
  assert.equal(formatCountdown(86399), '23:59:59');
  assert.equal(formatCountdown(86400), '24:00:00');

  for (const bad of [-1, NaN, Infinity, -Infinity, null, undefined, '65']) {
    assert.equal(formatCountdown(bad), '');
  }
});

test('CountdownPrimitive renders axis view below live price, preserves array identity, and handles detach/errors', () => {
  let nowSec = 125;
  let updates = 0;
  const primitive = new CountdownPrimitive({
    intervalMinutes: 1,
    color: '#f19aa4',
    now: () => nowSec,
  });

  // Before attach: not visible, paneViews empty
  assert.deepEqual(primitive.paneViews(), []);
  assert.equal(primitive.priceAxisViews()[0].visible(), false);

  const series = {
    priceToCoordinate: price => (price === 63765.9 ? 100 : null),
  };
  primitive.attached({ chart: {}, series, requestUpdate: () => { updates += 1; } });

  // Still hidden until price is set
  assert.equal(primitive.priceAxisViews()[0].visible(), false);

  primitive.setPrice(63765.9);
  assert.equal(updates, 1);

  const views1 = primitive.priceAxisViews();
  const views2 = primitive.priceAxisViews();
  assert.strictEqual(views1, views2);
  assert.equal(views1.length, 1);

  const view = views1[0];
  assert.equal(view.visible(), true);
  assert.equal(view.coordinate(), 118);
  assert.equal(view.text(), '00:55');
  assert.equal(view.textColor(), '#ffffff');
  assert.equal(view.backColor(), '#f19aa4');

  nowSec = 179;
  primitive.tick();
  assert.equal(updates, 2);
  assert.equal(view.text(), '00:01');

  // setPrice(null) hides the label and requests update
  primitive.setPrice(null);
  assert.equal(updates, 3);
  assert.equal(view.visible(), false);

  // priceToCoordinate throwing (e.g. removed chart) hides the label without throwing
  const throwingSeries = {
    priceToCoordinate: () => { throw new Error('chart disposed'); },
  };
  primitive.attached({ chart: {}, series: throwingSeries, requestUpdate: () => { updates += 1; } });
  primitive.setPrice(63765.9);
  assert.equal(view.visible(), false);
  assert.equal(view.coordinate(), null);

  // detached clears state and stops requesting updates
  primitive.detached();
  const beforeDetachCalls = updates;
  primitive.tick();
  primitive.setPrice(63765.9);
  assert.equal(updates, beforeDetachCalls);
  assert.equal(view.visible(), false);
});
