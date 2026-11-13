import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT_RULES, LIMIT_DEFAULTS, atr14, limitOrder, simulateOrder, summarize } from '../jesse/static/review/limit-rules.mjs';

const bar = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 0 });
// 5m bars closed at 100 with high 101 / low 99: every true range is 2, so ATR(14) = 2 from bar 14 on.
const flat = (count = 20) => Array.from({ length: count }, (_, i) => bar(i * 300, 100, 101, 99, 100));
const at = (candles, i, ohlc) => { candles[i] = bar(i * 300, ...ohlc); return candles; };
// The signal bar used by most cases: close 102, high 104, low 96. Its own true range is 8, so ATR(15) is not 2;
// the expected stop/target are derived from atr14 instead of being written out by hand.
const signal = () => at(flat(), 15, [100, 104, 96, 102]);
const riskOf = (candles, j = 15) => atr14(candles)[j];
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} != ${expected}`);

test('the rule list is exactly the seven algorithms, each with a label', () => {
  assert.deepEqual(LIMIT_RULES.map(rule => rule.id), ['open', 'close', 'close_atr', 'mid', 'retrace', 'sma5', 'sma10']);
  for (const rule of LIMIT_RULES) assert.ok(rule.label.length > 0);
  assert.deepEqual(LIMIT_DEFAULTS, { rule: 'sma5', x: 0.25, y: 0.382, k: 1, r: 2, hold: 48 });
});

test('ATR(14) is Wilder-smoothed and unknown before bar 14', () => {
  const flatAtr = atr14(flat());
  assert.equal(flatAtr[0], null);
  assert.equal(flatAtr[13], null);
  assert.equal(flatAtr[14], 2);
  assert.equal(flatAtr[19], 2);
  // a wide bar 15: its own true range (8) enters only from ATR(15) on, smoothed into the flat history
  const wide = at(flat(), 15, [100, 104, 96, 102]);
  assert.equal(atr14(wide)[14], 2);
  near(atr14(wide)[15], (2 * 13 + 8) / 14, 'ATR after the wide bar');
  const later = at(flat(), 16, [100, 104, 96, 102]);
  assert.equal(atr14(later)[15], 2);
  near(atr14(later)[16], (2 * 13 + 8) / 14, 'ATR of the wide bar');
  assert.deepEqual(atr14([]), []);
});

test('every rule gives the price the user described, for a 100/104/96/102 signal bar', () => {
  const candles = signal();
  at(candles, 16, [103, 105, 101, 104]);                 // next bar opens at 103
  const j = 15, risk = riskOf(candles);
  assert.equal(limitOrder(candles, j, 1, 'open').price, 103);          // next open, both directions
  assert.equal(limitOrder(candles, j, -1, 'open').price, 103);
  assert.equal(limitOrder(candles, j, 1, 'close').price, 102);
  assert.equal(limitOrder(candles, j, -1, 'close').price, 102);
  // long lets price come back by x·ATR, short goes along with it
  near(limitOrder(candles, j, 1, 'close_atr', { x: 0.25 }).price, 102 - 0.25 * risk);
  near(limitOrder(candles, j, -1, 'close_atr', { x: 0.25 }).price, 102 + 0.25 * risk);
  near(limitOrder(candles, j, 1, 'close_atr').price, 102 - LIMIT_DEFAULTS.x * risk);
  assert.equal(limitOrder(candles, j, 1, 'mid').price, 100);           // (104 + 96) / 2
  // retrace: long below the close, short above it; y times the bar's range
  assert.equal(limitOrder(candles, j, 1, 'retrace', { y: 0.5 }).price, 102 - 0.5 * 8);
  assert.equal(limitOrder(candles, j, -1, 'retrace', { y: 0.5 }).price, 102 + 0.5 * 8);
  near(limitOrder(candles, j, 1, 'retrace').price, 102 - LIMIT_DEFAULTS.y * 8);
  // SMA estimates: ma[j] + (ma[j] - ma[j-1]) = 2·ma[j] - ma[j-1]
  near(limitOrder(candles, j, 1, 'sma5').price, 100.4 + 0.4);
  near(limitOrder(candles, j, -1, 'sma5').price, 100.4 + 0.4);
  near(limitOrder(candles, j, 1, 'sma10').price, 100.2 + 0.2);
});

test('a rule without its data returns null instead of a made-up price', () => {
  const candles = signal();
  assert.equal(limitOrder(candles, 5, 1, 'close_atr'), null);          // no ATR yet (bar 5)
  assert.equal(limitOrder(candles, 3, 1, 'sma5'), null);               // needs bar j-5
  assert.equal(limitOrder(candles, 5, 1, 'sma5').price, 100);
  assert.equal(limitOrder(candles, 9, 1, 'sma10'), null);
  assert.equal(limitOrder(candles, 19, 1, 'open'), null);              // no next bar
  assert.equal(limitOrder(candles, 15, 0, 'close'), null);             // direction is ±1
  assert.equal(limitOrder(candles, 15, 1, 'nope'), null);
  assert.equal(limitOrder(candles, -1, 1, 'close'), null);
  assert.equal(limitOrder([], 0, 1, 'close'), null);
  // the page's precomputed ATR array is used as is
  const atr = atr14(candles);
  near(limitOrder(candles, 15, 1, 'close_atr', { x: 0.5, atr }).price, 102 - 0.5 * atr[15]);
});

test('long order: unfilled, gap on the open, filled on the low', () => {
  const candles = signal();
  // opens above the limit and never comes back down to it
  at(candles, 16, [105, 106, 104, 105]);
  assert.equal(simulateOrder(candles, 15, 1, 100).status, 'unfilled');
  // opens below the limit: reported as a gap, not as a fill
  at(candles, 16, [99, 100, 98, 99]);
  assert.deepEqual(simulateOrder(candles, 15, 1, 100), { status: 'gap', fillIndex: null, exitIndex: null,
    exitPrice: null, R: null, stop: null, target: null, reason: null });
  // opens exactly at the limit: also a gap (<= the price)
  at(candles, 16, [100, 100.5, 99, 100]);
  assert.equal(simulateOrder(candles, 15, 1, 100).status, 'gap');
  // opens above and trades down through the limit: filled at the limit
  at(candles, 16, [101, 101.5, 99.5, 100.5]);
  const risk = riskOf(candles);
  const filled = simulateOrder(candles, 15, 1, 100, { hold: 1 });
  assert.equal(filled.status, 'filled');
  assert.equal(filled.fillIndex, 16);
  near(filled.stop, 100 - risk);                        // price - 1·ATR
  near(filled.target, 100 + 2 * risk);                  // price + 2·(1·ATR)
});

test('short order mirrors every case', () => {
  const candles = signal();
  // opens above the sell limit (>= is the short gap condition) -> gap
  at(candles, 16, [101, 101.5, 99.5, 100.5]);
  assert.equal(simulateOrder(candles, 15, -1, 100).status, 'gap');
  // opens below the limit and never trades up to it -> unfilled
  at(candles, 16, [97, 98, 96, 97]);
  assert.equal(simulateOrder(candles, 15, -1, 100).status, 'unfilled');
  // opens below but the high reaches the limit -> filled; target below, stop above
  at(candles, 16, [99, 100.5, 98.5, 99.5]);
  const risk = riskOf(candles);
  const target = 100 - 2 * risk, stop = 100 + risk;
  at(candles, 17, [99.5, 99.8, target - 0.5, 99]);
  const filled = simulateOrder(candles, 15, -1, 100);
  assert.equal(filled.status, 'filled');
  near(filled.stop, stop);
  near(filled.target, target);
  assert.equal(filled.reason, 'target');
  assert.equal(filled.exitIndex, 17);
  near(filled.exitPrice, target);
  near(filled.R, 2);                                    // the target sits 2R away
  // stop mirror
  at(candles, 17, [100, stop + 0.5, 99.5, 100]);
  const stopped = simulateOrder(candles, 15, -1, 100);
  assert.equal(stopped.reason, 'stop');
  near(stopped.exitPrice, stop);
  near(stopped.R, -1);
});

test('the trade is only looked at from the fill bar on: that bar checks the stop, not the target', () => {
  const candles = signal();
  const risk = riskOf(candles);
  // filled, and the fill bar touches the target: ignored, so the trade is still running at the end of the data
  at(candles, 16, [101, 102.5, 99.5, 102]);
  const open = simulateOrder(candles, 15, 1, 100);
  assert.equal(open.status, 'open');
  assert.equal(open.fillIndex, 16);
  assert.equal(open.exitIndex, null);
  assert.equal(open.R, null);
  // the same fill bar also hits the stop: the stop wins even though the target was touched
  at(candles, 16, [101, 102.5, 100 - risk - 0.5, 100]);
  const stopped = simulateOrder(candles, 15, 1, 100);
  assert.equal(stopped.status, 'filled');
  assert.equal(stopped.reason, 'stop');
  assert.equal(stopped.exitIndex, 16);
  near(stopped.exitPrice, 100 - risk);
  near(stopped.R, -1);
});

test('a bar that touches both the stop and the target counts as the stop', () => {
  const candles = signal();
  const risk = riskOf(candles), stop = 100 - risk, target = 100 + 2 * risk;
  at(candles, 16, [101, 101.5, 99.5, 101]);
  at(candles, 17, [101, target + 0.5, stop - 0.5, 100]);   // both levels inside bar 17
  const result = simulateOrder(candles, 15, 1, 100);
  assert.equal(result.reason, 'stop');
  assert.equal(result.exitIndex, 17);
  near(result.exitPrice, stop);
  near(result.R, -1);
});

test('the target closes the trade, and time closes it after opts.hold bars', () => {
  const candles = signal();
  const risk = riskOf(candles), target = 100 + 2 * risk;
  at(candles, 16, [101, 101.5, 99.5, 101]);
  at(candles, 17, [101, target + 0.2, 100.8, target]);
  const hit = simulateOrder(candles, 15, 1, 100);
  assert.equal(hit.reason, 'target');
  assert.equal(hit.exitIndex, 17);
  near(hit.exitPrice, target);
  near(hit.R, 2);                                       // a 2R target
  // nothing hit: the close of the hold-th bar ends it
  at(candles, 17, [101, 101.2, 100.6, 100.9]);
  at(candles, 18, [100.9, 101.3, 100.7, 101.1]);
  const time = simulateOrder(candles, 15, 1, 100, { hold: 2 });
  assert.equal(time.reason, 'time');
  assert.equal(time.exitIndex, 17);
  assert.equal(time.exitPrice, 100.9);
  near(time.R, 0.9 / risk);
  // fewer candles than the trade needs -> still running
  assert.equal(simulateOrder(candles.slice(0, 17), 15, 1, 100, { hold: 2 }).status, 'open');
});

test('the market rule fills on the next open without a gap test', () => {
  const candles = signal();
  at(candles, 16, [96, 97, 95, 96]);                    // opens far below any limit
  assert.equal(simulateOrder(candles, 15, 1, 100).status, 'gap');
  const risk = riskOf(candles);
  const market = simulateOrder(candles, 15, 1, 96, { ruleId: 'open', hold: 1 });
  assert.equal(market.status, 'filled');
  assert.equal(market.fillIndex, 16);
  near(market.stop, 96 - risk);
  near(simulateOrder(candles, 15, 1, 96, { market: true, hold: 1 }).exitPrice, 96);
  assert.equal(simulateOrder(candles, 19, 1, 96, { ruleId: 'open' }), null);   // no next bar
  assert.equal(simulateOrder(candles, 15, 1, 96, { ruleId: 'open', k: 0 }), null);   // a zero stop cannot be sized
});

test('summarize counts marks, fills, gaps and only closed trades in the R numbers', () => {
  const results = [{ status: 'filled', R: 2 }, { status: 'filled', R: -1 }, { status: 'filled', R: 0.5 },
    { status: 'open', R: null }, { status: 'gap' }, { status: 'unfilled' }];
  assert.deepEqual(summarize(results), { marks: 6, filled: 4, gap: 1, unfilled: 1, fillRate: 4 / 6, wins: 2,
    winRate: 2 / 3, avgR: 0.5, sumR: 1.5 });
  const empty = { marks: 0, filled: 0, gap: 0, unfilled: 0, fillRate: 0, wins: 0, winRate: 0, avgR: 0, sumR: 0 };
  assert.deepEqual(summarize([]), empty);
  assert.deepEqual(summarize([null, undefined]), empty);
  assert.deepEqual(summarize(undefined), empty);
});
