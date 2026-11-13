import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT_RULES, LIMIT_DEFAULTS, atr14, limitOrder, simulateOrder, summarize } from '../jesse/static/review/limit-rules.mjs';

const STEP = 180;   // 3m bars, like the BTC example below
const bar = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 0 });
// 5m bars closed at 100 with high 101 / low 99: every true range is 2, so ATR(14) = 2 from bar 14 on.
const flat = (count = 30) => Array.from({ length: count }, (_, i) => bar(i * STEP, 100, 101, 99, 100));
const at = (candles, i, ohlc) => { candles[i] = bar(i * STEP, ...ohlc); return candles; };
// Every bar of both series closes at 100, so the 'close' rule puts the limit at 100 on every bar and only the
// high / low decides fills. `calm` bars trade at or below 100 and open below it: a short at 100 is not filled (its
// high is exactly 100) and no bar is a gap; `above` is the mirror for longs (low exactly 100, open above 100).
const calm = (count = 30) => Array.from({ length: count }, (_, i) => bar(i * STEP, 99.5, 100, 99, 100));
const above = (count = 30) => Array.from({ length: count }, (_, i) => bar(i * STEP, 100.5, 101, 100, 100));
// The signal bar used by most cases: close 102, high 104, low 96. Its own true range is 8, so ATR(15) is not 2;
// the expected stop/target come from atr14 instead of being written out by hand.
const signal = () => at(flat(), 15, [100, 104, 96, 102]);
const riskOf = (candles, i = 15) => atr14(candles)[i];
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
  assert.equal(flatAtr[29], 2);
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
  assert.equal(limitOrder(candles, 29, 1, 'open'), null);              // no next bar
  assert.equal(limitOrder(candles, 15, 0, 'close'), null);             // direction is ±1
  assert.equal(limitOrder(candles, 15, 1, 'nope'), null);
  assert.equal(limitOrder(candles, -1, 1, 'close'), null);
  assert.equal(limitOrder([], 0, 1, 'close'), null);
  // the page's precomputed ATR array is used as is
  const atr = atr14(candles);
  near(limitOrder(candles, 15, 1, 'close_atr', { x: 0.5, atr }).price, 102 - 0.5 * atr[15]);
});

test('the order follows the rule on every bar and fills later than the next one', () => {
  // A drop to 98 on the signal bar: the SMA5 estimate sits at 99.2, above the next bars, so a short waits for a
  // bounce. Two bars miss it, the third trades through the price the second bar's close had computed.
  const candles = flat();
  at(candles, 15, [100, 100.5, 97.5, 98]);      // signal bar (j)
  at(candles, 16, [97.9, 98.8, 97.5, 97.6]);    // high 98.8 < 99.2: no fill
  at(candles, 17, [97.7, 98.9, 97.6, 98.2]);    // high 98.9 > 98.64: fill
  const atr = atr14(candles);
  const j = 15;
  const first = limitOrder(candles, j, -1, 'sma5', { atr }).price;      // valid for bar 16
  const second = limitOrder(candles, j + 1, -1, 'sma5', { atr }).price; // valid for bar 17
  assert.notEqual(first, second, 'the price must follow the SMA, not stay at the signal bar');
  const result = simulateOrder(candles, j, -1, 'sma5', { atr, lastIndex: j + 1, ended: true });
  assert.equal(result.status, 'filled');
  assert.equal(result.fillIndex, 17);
  assert.equal(result.waitBars, 2);
  assert.equal(result.gapBars, 0);
  near(result.fillPrice, second);
  assert.deepEqual(result.path.map(point => point.index), [15, 16]);
  near(result.path[0].price, first);
  near(result.path[1].price, second);
  // the stop is sized with the ATR that was known when bar 17's price was computed (bar 16), not the signal's
  near(result.stop, second + atr[16]);
  assert.notEqual(atr[15], atr[16]);
  // the bars after the fill are back at 100/101/99: the short is stopped on the next one
  assert.equal(result.status, 'filled');
  assert.equal(result.reason, 'stop');
  assert.equal(result.exitIndex, 18);
});

test('an ended trend cancels the order: the last bar it kept it alive for is the last chance', () => {
  const candles = calm();
  const atr = atr14(candles);
  const j = 15, lastIndex = 18;
  // calm bars never reach 100 from above, so nothing fills; bar 19 is the bar after the trend's last bar and
  // bar 20 is already past the cancel bar.
  at(candles, 20, [99.5, 100.6, 99, 100]);
  const missed = simulateOrder(candles, j, -1, 'close', { atr, lastIndex, ended: true });
  assert.equal(missed.status, 'unfilled');
  assert.equal(missed.fillIndex, null);
  assert.equal(missed.fillPrice, null);
  assert.equal(missed.waitBars, 4);                        // bars 16, 17, 18, 19
  assert.equal(missed.gapBars, 0);
  assert.deepEqual(missed.path.map(point => point.index), [15, 16, 17, 18]);
  assert.equal(missed.path.at(-1).index, lastIndex, 'the last price is the one of the trend\'s last bar');
  // the same setup, but the bar after the trend's last bar (19) reaches the limit: filled there
  at(candles, 19, [99.5, 100.6, 99, 100]);
  const filled = simulateOrder(candles, j, -1, 'close', { atr, lastIndex, ended: true, hold: 1 });
  assert.equal(filled.status, 'filled');
  assert.equal(filled.fillIndex, 19);
  assert.equal(filled.waitBars, 4);
  assert.equal(filled.reason, 'time');           // hold 1: closed at the fill bar's close
  near(filled.fillPrice, 100);
  // a trend whose last bar is the last candle has no cancel bar yet: the order is still waiting
  const short = calm(20);
  const running = simulateOrder(short, j, -1, 'close', { atr: atr14(short), lastIndex: 19, ended: true });
  assert.equal(running.status, 'waiting');
  assert.equal(running.waitBars, 4);
});

test('a trend still running keeps the order alive to the end of the data', () => {
  const candles = calm();
  const atr = atr14(candles);
  const waiting = simulateOrder(candles, 15, -1, 'close', { atr, lastIndex: candles.length - 1, ended: false });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.fillIndex, null);
  assert.equal(waiting.stop, null);
  assert.equal(waiting.waitBars, 14);                      // bars 16 … 29
  assert.deepEqual(waiting.path.map(point => point.index), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
  // the last bar may still fill it
  const late = calm();
  at(late, 29, [99.5, 100.5, 99, 100]);
  const filled = simulateOrder(late, 15, -1, 'close', { atr: atr14(late), hold: 1 });
  assert.equal(filled.status, 'filled');
  assert.equal(filled.fillIndex, 29);
  assert.equal(filled.waitBars, 14);
});

test('a bar that opens past the limit fills at its open (taker, at least as good as the limit)', () => {
  const candles = calm();
  at(candles, 16, [100.2, 100.5, 99.8, 100]);   // short: the open is above the limit -> filled at 100.2
  const result = simulateOrder(candles, 15, -1, 'close', { atr: atr14(candles), hold: 1 });
  assert.equal(result.status, 'filled');
  assert.equal(result.fillIndex, 16);
  assert.equal(result.waitBars, 1);
  assert.equal(result.gapBars, 1);
  assert.equal(result.gapFill, true);
  near(result.fillPrice, 100.2);
  assert.equal(result.reason, 'time');           // hold 1: closed at the fill bar's close
  // long mirror: the open below the limit fills at that open
  const longs = above();
  at(longs, 16, [99.5, 100.6, 99.4, 100]);
  const long = simulateOrder(longs, 15, 1, 'close', { atr: atr14(longs), hold: 1 });
  assert.equal(long.status, 'filled');
  assert.equal(long.fillIndex, 16);
  near(long.fillPrice, 99.5);
  assert.equal(long.gapFill, true);
});

test('the stop is sized with the ATR of the bar whose close set the price', () => {
  const candles = calm();
  // Bar 18 is the bar that computes bar 19's price; its wide low lifts its own ATR but never reaches 100.
  at(candles, 18, [99.5, 100, 97, 100]);
  at(candles, 19, [99.5, 100.4, 99, 100]);
  const atr = atr14(candles);
  assert.ok(atr[18] > atr[15]);
  const result = simulateOrder(candles, 15, -1, 'close', { atr, hold: 1 });
  assert.equal(result.fillIndex, 19);
  near(result.fillPrice, 100);
  near(result.stop, 100 + atr[18]);            // short: the stop sits above the entry
  near(result.target, 100 - 2 * atr[18]);
  assert.equal(result.reason, 'time');         // hold 1: closed at the fill bar's close
  assert.equal(result.exitIndex, 19);
  near(result.R, 0);
});

test('the trade is only looked at from the fill bar on: that bar checks the stop, not the target', () => {
  const candles = above();
  const atr = atr14(candles);
  // filled on bar 16, and that bar also reaches the target (102): ignored, so the trade runs on
  at(candles, 16, [100.5, 103, 99.5, 100]);
  const open = simulateOrder(candles, 15, 1, 'close', { atr });
  assert.equal(open.status, 'open');
  assert.equal(open.fillIndex, 16);
  assert.equal(open.exitIndex, null);
  assert.equal(open.R, null);
  near(open.stop, 100 - atr[15]);
  near(open.target, 100 + 2 * atr[15]);
  // the same fill bar also hits the stop: the stop wins even though the target was touched
  at(candles, 16, [100.5, 103, 98.5, 100]);
  const stopped = simulateOrder(candles, 15, 1, 'close', { atr });
  assert.equal(stopped.status, 'filled');
  assert.equal(stopped.reason, 'stop');
  assert.equal(stopped.exitIndex, 16);
  near(stopped.R, -1);
});

test('a bar that touches both the stop and the target counts as the stop', () => {
  const candles = calm();
  const atr = atr14(candles), stop = 100 + atr[15], target = 100 - 2 * atr[15];
  at(candles, 16, [99.5, 100.4, 99, 100]);                 // filled on bar 16
  at(candles, 17, [100, 100.4, 99, 100]);
  at(candles, 17, [99.5, stop + 0.5, target - 0.5, 100]);  // both levels inside bar 17
  const result = simulateOrder(candles, 15, -1, 'close', { atr });
  assert.equal(result.reason, 'stop');
  assert.equal(result.exitIndex, 17);
  near(result.exitPrice, stop);
  near(result.R, -1);
});

test('the target closes the trade, and time closes it after opts.hold bars', () => {
  const candles = above();
  const atr = atr14(candles), target = 100 + 2 * atr[15];
  at(candles, 16, [100.5, 101, 99.5, 100]);                // filled on bar 16
  at(candles, 17, [100.5, target + 0.2, 100.4, target]);   // takes the target
  const hit = simulateOrder(candles, 15, 1, 'close', { atr });
  assert.equal(hit.reason, 'target');
  assert.equal(hit.exitIndex, 17);
  near(hit.exitPrice, target);
  near(hit.R, 2);                                          // a 2R target
  // nothing hit: the close of the hold-th bar ends it
  at(candles, 17, [100.5, 101.5, 100.2, 101]);
  const time = simulateOrder(candles, 15, 1, 'close', { atr, hold: 2 });
  assert.equal(time.reason, 'time');
  assert.equal(time.exitIndex, 17);
  near(time.exitPrice, 101);
  near(time.R, 1);
  // fewer candles than the trade needs -> still running
  assert.equal(simulateOrder(candles.slice(0, 17), 15, 1, 'close', { atr: atr.slice(0, 17), hold: 2 }).status, 'open');
});

test('the market rule fills on the next open without a gap test', () => {
  const candles = flat();
  at(candles, 16, [96, 97, 95, 96]);                       // opens far below any limit
  const atr = atr14(candles);
  const market = simulateOrder(candles, 15, 1, 'open', { atr, lastIndex: 20, ended: true, hold: 1 });
  assert.equal(market.status, 'filled');
  assert.equal(market.fillIndex, 16);
  assert.equal(market.waitBars, 1);
  assert.equal(market.gapBars, 0);
  near(market.fillPrice, 96);
  near(market.stop, 96 - atr[15]);
  assert.deepEqual(market.path, [{ index: 15, price: 96 }]);
  assert.equal(simulateOrder(candles, 29, 1, 'open', { atr }), null);            // no next bar
  assert.equal(simulateOrder(candles, 15, 1, 'open', { atr, k: 0 }), null);      // a zero stop cannot be sized
  assert.equal(simulateOrder(candles, 15, 0, 'open', { atr }), null);            // direction is ±1
  assert.equal(simulateOrder([], 0, 1, 'open'), null);
});

test('summarize counts marks, fills, waiting and waiting out of the fill rate', () => {
  const results = [{ status: 'filled', R: 2 }, { status: 'filled', R: -1 }, { status: 'filled', R: 0.5 },
    { status: 'open', R: null }, { status: 'waiting' }, { status: 'unfilled' }];
  assert.deepEqual(summarize(results), { marks: 6, filled: 4, waiting: 1, unfilled: 1, fillRate: 4 / 5,
    wins: 2, winRate: 2 / 3, avgR: 0.5, sumR: 1.5 });
  // everything still waiting: no decided mark, so the fill rate has nothing to divide by
  assert.equal(summarize([{ status: 'waiting' }, { status: 'waiting' }]).fillRate, 0);
  const empty = { marks: 0, filled: 0, waiting: 0, unfilled: 0, fillRate: 0, wins: 0, winRate: 0, avgR: 0, sumR: 0 };
  assert.deepEqual(summarize([]), empty);
  assert.deepEqual(summarize([null, undefined]), empty);
  assert.deepEqual(summarize(undefined), empty);
});

test('BTC 3m 2026-10-27 06:48 short: the SMA5 order is filled two bars later, not on the next bar', () => {
  // The user's case: the next bar's high stopped 1.3 USDT below the SMA5 estimate 79,639.5, yet the order was
  // cancelled; the bars after it are the ones that traded through a following estimate.
  const utc = (...parts) => Date.UTC(2026, 9, 27, ...parts) / 1000;
  const rows = [
    [utc(6, 30), 79724.5, 79800.0, 79724.4, 79780.3],
    [utc(6, 33), 79780.3, 79780.4, 79720.0, 79720.0],
    [utc(6, 36), 79720.0, 79767.2, 79720.0, 79745.5],
    [utc(6, 39), 79745.6, 79745.6, 79717.1, 79725.6],
    [utc(6, 42), 79725.6, 79736.6, 79681.8, 79684.3],
    [utc(6, 45), 79684.3, 79700.0, 79648.5, 79654.9],
    [utc(6, 48), 79654.9, 79659.1, 79553.6, 79553.6],       // signal bar (j = 6)
    [utc(6, 51), 79553.7, 79638.2, 79547.6, 79602.9],
    [utc(6, 54), 79602.9, 79635.7, 79602.9, 79615.1],
    [utc(6, 57), 79615.1, 79639.1, 79615.0, 79628.4],
    [utc(7, 0), 79628.5, 79628.5, 79555.0, 79586.3],
    [utc(7, 3), 79586.3, 79639.1, 79581.0, 79612.0],
    [utc(7, 6), 79611.9, 79643.1, 79598.9, 79634.3],
  ];
  const candles = rows.map(([time, open, high, low, close]) => bar(time, open, high, low, close));
  const opts = { atr: new Array(candles.length).fill(30), hold: 1 };
  const j = 6;
  // the signal bar's own price: ma5 + slope = 79,672.78 - 33.28
  near(limitOrder(candles, j, -1, 'sma5', opts).price, 79639.5);
  const result = simulateOrder(candles, j, -1, 'sma5', opts);
  assert.equal(result.status, 'filled');
  assert.equal(result.gapBars, 0);
  // 06:51 (bar 7) misses the 79,639.5 of bar 7; 06:54 (bar 8) opens below the estimate bar 7's close computed
  // (79,615.74) and trades through it. The next-bar-only rule of T-41 called this signal unfilled.
  near(result.path[0].price, 79639.5);
  near(result.path[1].price, 79615.74);
  assert.equal(result.fillIndex, 8);
  assert.equal(result.waitBars, 2);
  near(result.fillPrice, 79615.74);
  near(result.path.at(-1).price, result.fillPrice);
  // the 06:57 and 07:06 highs would have filled the original price, but the order is already filled by then
  assert.ok(candles[8].high > result.fillPrice);
  assert.ok(candles[7].high < result.path[0].price);
});
