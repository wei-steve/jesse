import test from 'node:test';
import assert from 'node:assert/strict';
import { FILL_PRICES_KEY, FILL_PRICE_ALPHA, FILL_PRICE_BUY_COLOR, FILL_PRICE_LINE, FILL_PRICE_MAX_ORDERS,
  FILL_PRICE_RADIUS, FILL_PRICE_SELL_COLOR, FillPricesPrimitive, drawFillPrices, fillArrowMarkers, fillPriceMarksOn,
  fillPricePoint, fillPricesDefault, fillPricesOn, orderAction, orderMarkText, orderMarks, orderMarksText,
  readFillPrices, tfMinutes, toggleFillPrices } from '../jesse/static/review/fill-prices.mjs';

// The owner's fills are private: every number below is invented, in the shape parseFills returns (a venue's rows parsed
// down to what the page draws). 1794839400 is an exact 15m candle.
const FILLS = [
  // One 分仓 order split into two fills inside the same 15m candle.
  { time: 1794839700, price: 64300, size: 100, side: 'buy', posSide: 'long', fee: 0.04, feeCcy: 'USDT',
    ordId: '7001', tradeId: '9001' },
  { time: 1794839820, price: 64400, size: 300, side: 'buy', posSide: 'long', fee: 0.12, feeCcy: 'USDT',
    ordId: '7001', tradeId: '9002' },
  // Another order in the same candle, in the other direction: its own mark.
  { time: 1794840000, price: 64500, size: 50, side: 'sell', posSide: 'long', fee: 0.02, feeCcy: 'USDT',
    ordId: '7002', tradeId: '9003' },
  // And one order in the next candle.
  { time: 1794840300, price: 65000, size: 60, side: 'sell', posSide: 'long', fee: 0.03, feeCcy: 'USDT',
    ordId: '7003', tradeId: '9004' },
];

// --- One mark per order -------------------------------------------------------------------------------------------

test('fills of one order are one mark at their size-weighted price, other orders of the candle stay apart', () => {
  const marks = orderMarks(FILLS, 15);
  assert.deepEqual(marks.map(mark => mark.time), [1794839400, 1794839400, 1794840300]);
  const merged = marks.find(mark => mark.ordId === '7001');
  // (100 × 64,300 + 300 × 64,400) / 400 = 64,375: 均价 is weighted, never the plain mean of the two prices.
  assert.equal(merged.price, 64375);
  assert.equal(merged.size, 400);
  assert.equal(merged.count, 2);
  assert.equal(merged.fee, 0.16);
  assert.equal(merged.feeCcy, 'USDT');
  assert.equal(merged.open, true);
  assert.deepEqual(merged.action, { id: 'open-long', label: '开多', kind: 'buy' });
  // A different ordId in the same candle is a separate mark, at its own price.
  const other = marks.find(mark => mark.ordId === '7002');
  assert.equal(other.price, 64500);
  assert.equal(other.count, 1);
  assert.deepEqual(other.action, { id: 'close-long', label: '平多', kind: 'sell' });
  assert.equal(other.open, false);
});

test('a fill without an ordId groups by action and price; junk rows and broken intervals draw nothing', () => {
  const marks = orderMarks([
    { time: 1794839700, price: 10, size: 1, side: 'buy' },
    { time: 1794839710, price: 11, size: 1, side: 'buy' },
    { time: 1794839720, price: 10, size: 2, side: 'buy' },
  ], 15);
  // The two buys at 10 are one order's worth of marks (one price), the buy at 11 is another.
  assert.deepEqual(marks.map(mark => mark.price), [10, 11]);
  assert.equal(marks[0].count, 2);
  assert.equal(marks[0].size, 3);
  assert.equal(marks[0].ordId, '');
  assert.equal(marks[1].price, 11);
  // Rows that cannot be drawn are dropped; an interval with no width has no candles at all.
  assert.deepEqual(orderMarks([
    { time: 0, price: 10, size: 1, side: 'buy' },
    { time: 1794839700, price: 0, size: 1, side: 'buy' },
    { time: 1794839700, price: 10, size: 0, side: 'buy' },
    { time: 1794839700, price: 10, size: 1, side: 'hold' },
    null,
  ], 15), []);
  assert.deepEqual(orderMarks(FILLS, 0), []);
  assert.deepEqual(orderMarks(FILLS, null), []);
  assert.deepEqual(orderMarks(null, 15), []);
});

test('a finer timeframe splits what a coarser one merges, and the order of a candle keeps the fills\' own order', () => {
  // 1m: each fill is its own candle, so the one order of 7001 is two marks there.
  const minute = orderMarks(FILLS, 1);
  assert.deepEqual(minute.map(mark => mark.time), [1794839700, 1794839820, 1794840000, 1794840300]);
  assert.deepEqual(minute.map(mark => mark.count), [1, 1, 1, 1]);
  // 1h: everything in one candle; the 7001 group is still one mark, the marks keep the fills' order.
  const hourly = orderMarks(FILLS, 60);
  assert.deepEqual(hourly.map(mark => mark.time), [1794837600, 1794837600, 1794837600]);
  assert.deepEqual(hourly.map(mark => mark.ordId), ['7001', '7002', '7003']);
  assert.equal(hourly[0].price, 64375);
});

test('开 / 平 comes from side and posSide; a spot fill (no posSide) is buy = 开, sell = 平', () => {
  assert.deepEqual(orderAction({ side: 'buy', posSide: 'long' }), { id: 'open-long', label: '开多', kind: 'buy', open: true });
  assert.deepEqual(orderAction({ side: 'sell', posSide: 'long' }), { id: 'close-long', label: '平多', kind: 'sell', open: false });
  assert.deepEqual(orderAction({ side: 'sell', posSide: 'short' }), { id: 'open-short', label: '开空', kind: 'sell', open: true });
  assert.deepEqual(orderAction({ side: 'buy', posSide: 'short' }), { id: 'close-short', label: '平空', kind: 'buy', open: false });
  assert.deepEqual(orderAction({ side: 'buy', posSide: '' }), { id: 'open', label: '开', kind: 'buy', open: true });
  assert.deepEqual(orderAction({ side: 'SELL', posSide: null }), { id: 'close', label: '平', kind: 'sell', open: false });
  assert.equal(orderAction({ side: 'hold' }), null);
  assert.equal(orderAction(null), null);
  // A spot buy is a filled triangle above the price, a spot sell a hollow circle.
  const [spot] = orderMarks([{ time: 1794839700, price: 10, size: 1, side: 'sell' }], 15);
  assert.equal(spot.open, false);
  assert.deepEqual(spot.action, { id: 'close', label: '平', kind: 'sell' });
});

// --- Per-timeframe switch -----------------------------------------------------------------------------------------

test('1m…30m start with the marks on, 1h / 4h / 1D off; the labels are read into minutes', () => {
  assert.equal(FILL_PRICES_KEY, 'jesse.market.fillPrices.v1');
  assert.equal(tfMinutes('1D'), 1440);
  assert.equal(tfMinutes('4h'), 240);
  assert.equal(tfMinutes('15m'), 15);
  assert.equal(tfMinutes('1w'), null);
  assert.equal(tfMinutes(''), null);
  assert.equal(tfMinutes('0m'), null);
  for (const tf of ['1m', '3m', '5m', '15m', '30m']) assert.equal(fillPricesDefault(tf), true, tf);
  for (const tf of ['1h', '4h', '1D']) assert.equal(fillPricesDefault(tf), false, tf);
  // Anything not one of the eight labels of the page is simply off.
  assert.equal(fillPricesDefault('45m'), false);
  assert.equal(fillPricesDefault(null), false);
});

test('the stored switches survive junk, and a timeframe the owner never touched takes its default', () => {
  assert.deepEqual(readFillPrices(null), {});
  assert.deepEqual(readFillPrices(''), {});
  assert.deepEqual(readFillPrices('not json'), {});
  assert.deepEqual(readFillPrices('[true,false]'), {});
  assert.deepEqual(readFillPrices('"1m"'), {});
  assert.deepEqual(readFillPrices('{"1m":false,"4h":true,"1w":true,"2h":"yes","5m":1}'),
    { '1m': false, '4h': true });
  assert.deepEqual(readFillPrices(JSON.stringify({ '1m': false, '4h': true })), { '1m': false, '4h': true });
  // A saved boolean wins; without one the timeframe's default applies.
  assert.equal(fillPricesOn({ '1m': false }, '1m'), false);
  assert.equal(fillPricesOn({ '4h': true }, '4h'), true);
  assert.equal(fillPricesOn({}, '5m'), true);
  assert.equal(fillPricesOn({}, '1h'), false);
  assert.equal(fillPricesOn(undefined, '15m'), true);
  // A click flips one timeframe, keeps the others, and works from nothing at all.
  assert.deepEqual(toggleFillPrices({}, '4h'), { '4h': true });
  assert.deepEqual(toggleFillPrices({ '4h': true, '1m': false }, '4h'), { '4h': false, '1m': false });
  assert.deepEqual(toggleFillPrices(null, '15m'), { '15m': false });
  // The marks need both switches: 我的成交 and this timeframe.
  assert.equal(fillPriceMarksOn(false, { '15m': true }, '15m'), false);
  assert.equal(fillPriceMarksOn(true, { '4h': true }, '4h'), true);
  assert.equal(fillPriceMarksOn(true, {}, '1h'), false);
  assert.equal(fillPriceMarksOn(true, { '1m': false }, '1m'), false);
});

// --- The line under the chart -------------------------------------------------------------------------------------

test('the line names one order at a time, its count only when it took several fills', () => {
  assert.equal(FILL_PRICE_MAX_ORDERS, 6);
  assert.equal(orderMarkText({ action: { label: '开多' }, price: 64320.5, size: 300, count: 3 }),
    '开多 64,320.5 ×300（3 笔）');
  assert.equal(orderMarkText({ action: { label: '平多' }, price: 1800, size: 1, count: 1 }), '平多 1,800 ×1');
  assert.equal(orderMarkText({ action: { label: '平空' }, price: 0.1234, size: 12, count: 2 }),
    '平空 0.1234 ×12（2 笔）');
  const order = index => ({ action: { label: '开多' }, price: 10 + index, size: 1, count: 1 });
  assert.equal(orderMarksText([order(0), order(1)]), '开多 10 ×1 · 开多 11 ×1');
  // Six orders are listed, the rest becomes one trailing phrase instead of pushing the candle's numbers out of the line.
  assert.equal(orderMarksText(Array.from({ length: 9 }, (_, index) => order(index))),
    '开多 10 ×1 · 开多 11 ×1 · 开多 12 ×1 · 开多 13 ×1 · 开多 14 ×1 · 开多 15 ×1 · …另 3 个订单');
  assert.equal(orderMarksText([order(0), order(1)], 1), '开多 10 ×1 · …另 1 个订单');
  assert.equal(orderMarksText([]), '');
  assert.equal(orderMarksText(null), '');
});

// --- Arrows are replaced, never doubled --------------------------------------------------------------------------

test('a chart with the 价位 marks draws no fill arrows, and 我的成交 off draws neither', () => {
  const buckets = [{ time: 1794839400,
    groups: [{ id: 'open-long', label: '开多', kind: 'buy', count: 2, price: 64375, size: 400, fee: 0, feeCcy: '' }] }];
  const arrows = fillArrowMarkers(buckets, () => true, {});
  assert.equal(arrows.length, 1);
  assert.equal(arrows[0].position, 'belowBar');
  // 价位 on: the same orders are on the price itself, so no arrow of them (the purple 「注」 is drawn separately).
  assert.deepEqual(fillArrowMarkers(buckets, () => true, {}, { pricesOn: true }), []);
  assert.deepEqual(fillArrowMarkers(buckets, () => true, {}, { on: false }), []);
  // Zoomed out the arrow still exists, just without text.
  assert.equal(fillArrowMarkers(buckets, () => true, { labels: false }, {})[0].text, '');
});

// --- Drawing ------------------------------------------------------------------------------------------------------

// A 2D context that records what was asked of it: which path primitives, and the style / alpha each fill or stroke used.
class FakeCtx {
  constructor() {
    this.ops = [];
    this.globalAlpha = 1;
    this.fillStyle = '';
    this.strokeStyle = '';
    this.lineWidth = 0;
  }
  save() { this.ops.push(['save']); }
  restore() { this.ops.push(['restore']); }
  beginPath() { this.ops.push(['beginPath']); }
  moveTo(x, y) { this.ops.push(['moveTo', x, y]); }
  lineTo(x, y) { this.ops.push(['lineTo', x, y]); }
  closePath() { this.ops.push(['closePath']); }
  arc(x, y, radius) { this.ops.push(['arc', x, y, radius]); }
  fill() { this.ops.push(['fill', this.fillStyle, this.globalAlpha]); }
  stroke() { this.ops.push(['stroke', this.strokeStyle, this.lineWidth, this.globalAlpha]); }
}

const view = (times = () => 100, prices = price => price / 100) => ({ timeToCoordinate: times,
  priceToCoordinate: prices, horizontalPixelRatio: 2, verticalPixelRatio: 2 });

test('a mark goes where the chart puts its time and price, in bitmap pixels', () => {
  assert.deepEqual(fillPricePoint({ time: 1, price: 2 }, { timeToCoordinate: () => 10,
    priceToCoordinate: () => 20, horizontalPixelRatio: 2, verticalPixelRatio: 3 }), { x: 20, y: 60, ratio: 2.5 });
  // A time the chart does not have / a price the scale cannot map is the library's null: no mark.
  assert.equal(fillPricePoint({ time: 1, price: 2 }, { timeToCoordinate: () => 10, priceToCoordinate: () => null }), null);
  assert.equal(fillPricePoint({ time: 1, price: 2 }, { timeToCoordinate: () => null, priceToCoordinate: () => 20 }), null);
  assert.equal(fillPricePoint({ time: 'x', price: 2 }, { timeToCoordinate: () => 10, priceToCoordinate: () => 20 }), null);
  assert.equal(fillPricePoint(null, { timeToCoordinate: () => 10, priceToCoordinate: () => 20 }), null);
  // A removed chart (its converter throws) is a skipped mark, never an exception in the paint loop.
  assert.equal(fillPricePoint({ time: 1, price: 2 }, { timeToCoordinate: () => { throw new Error('gone'); },
    priceToCoordinate: () => 20 }), null);
  // A missing / broken pixel ratio is 1, not NaN.
  const point = fillPricePoint({ time: 1, price: 2 }, { timeToCoordinate: () => 10, priceToCoordinate: () => 20 });
  assert.deepEqual(point, { x: 10, y: 20, ratio: 1 });
});

test('the marks are small: an 开 is a filled triangle, a 平 a hollow circle, the colour follows the trade', () => {
  const ctx = new FakeCtx();
  const marks = [
    { time: 1794839400, price: 64300, action: { id: 'open-long', kind: 'buy' }, open: true },
    { time: 1794839400, price: 64400, action: { id: 'close-long', kind: 'sell' }, open: false },
    { time: 1794839600, price: 64500, action: { id: 'open-short', kind: 'sell' }, open: true },
  ];
  assert.equal(drawFillPrices(ctx, marks, view()), 3);
  // 开多: a triangle at 2×3.5 = 7 bitmap px, pointing up, filled in the buy green.
  assert.deepEqual(ctx.ops.slice(0, 7), [
    ['save'], ['beginPath'], ['moveTo', 200, 1286 - 8.4], ['lineTo', 193, 1286 + 5.6], ['lineTo', 207, 1286 + 5.6],
    ['closePath'], ['fill', FILL_PRICE_BUY_COLOR, FILL_PRICE_ALPHA]]);
  // 平多: a hollow circle — arc + stroke in the sell red, with the 1.5 px line scaled by the pixel ratio.
  const arc = ctx.ops.find(op => op[0] === 'arc');
  assert.deepEqual(arc, ['arc', 200, 1288, FILL_PRICE_RADIUS * 2]);
  const stroke = ctx.ops.find(op => op[0] === 'stroke');
  assert.deepEqual(stroke, ['stroke', FILL_PRICE_SELL_COLOR, FILL_PRICE_LINE * 2, FILL_PRICE_ALPHA]);
  // 开空: a triangle too, pointed down (the apex below the price), in the sell red.
  const filled = ctx.ops.filter(op => op[0] === 'fill');
  assert.equal(filled.length, 2);
  assert.equal(filled[1][1], FILL_PRICE_SELL_COLOR);
  const down = ctx.ops.filter(op => op[0] === 'moveTo')[1];
  assert.ok(down[2] > 1290, 'a sell triangle points down');
});

test('only the marks inside the visible time range are drawn; one with no coordinate is skipped', () => {
  const ctx = new FakeCtx();
  const marks = [
    { time: 1, price: 10, action: { kind: 'buy' }, open: true },
    { time: 2, price: 20, action: { kind: 'buy' }, open: true },
    { time: 3, price: 30, action: { kind: 'sell' }, open: false },
  ];
  const drawn = drawFillPrices(ctx, marks, view(time => (time === 2 ? null : 50)));
  assert.equal(drawn, 2);
  assert.equal(ctx.ops.filter(op => op[0] === 'beginPath').length, 2);
  // Nothing to draw (no marks, no x / y, no context) is not an error.
  assert.equal(drawFillPrices(new FakeCtx(), [], view()), 0);
  assert.equal(drawFillPrices(new FakeCtx(), null, view()), 0);
  assert.equal(drawFillPrices(null, marks, view()), 0);
  // A radius / alpha can be tuned from the page.
  const thin = new FakeCtx();
  drawFillPrices(thin, [{ time: 3, price: 3000, action: { kind: 'sell' }, open: false }], view(), { radius: 1, alpha: 0.5 });
  assert.deepEqual(thin.ops.find(op => op[0] === 'arc'), ['arc', 200, 60, 2]);
  assert.equal(thin.ops.find(op => op[0] === 'stroke')[3], 0.5);
});

test('the primitive redraws when its marks change, draws through the bitmap target, and stops once detached', () => {
  const requests = [];
  const primitive = new FillPricesPrimitive();
  // The library keeps one view array per primitive; a new array each frame would re-map its renderers.
  assert.equal(primitive.paneViews(), primitive.paneViews());
  assert.equal(primitive.paneViews()[0].zOrder(), 'normal');
  const chart = { timeScale: () => ({ timeToCoordinate: time => (time === 1794839400 ? 10 : null) }) };
  const series = { priceToCoordinate: price => price / 100 };
  primitive.attached({ chart, series, requestUpdate: () => requests.push('update') });
  const renderer = primitive.paneViews()[0].renderer();
  const ctx = new FakeCtx();
  const target = { useBitmapCoordinateSpace: run => run({ context: ctx, bitmapSize: { width: 100, height: 100 },
    horizontalPixelRatio: 2, verticalPixelRatio: 2, mediaSize: { width: 50, height: 50 } }) };
  // Nothing yet: the target is not even asked to draw (an empty primitive costs nothing per frame).
  renderer.draw(target);
  assert.equal(ctx.ops.length, 0);
  const marks = [{ time: 1794839400, price: 64300, action: { kind: 'buy' }, open: true }];
  primitive.setMarks(marks);
  assert.deepEqual(requests, ['update']);
  assert.deepEqual(primitive.marks(), marks);
  renderer.draw(target);
  assert.equal(ctx.ops.filter(op => op[0] === 'fill').length, 1);
  // A time the chart no longer has draws nothing.
  primitive.setMarks([{ time: 1, price: 2, action: { kind: 'buy' }, open: true }]);
  const before = ctx.ops.length;
  renderer.draw(target);
  assert.equal(ctx.ops.length, before);
  // Detached with the panel: no marks, no chart, and a late setMarks asks for no redraw.
  primitive.detached();
  primitive.setMarks(marks);
  assert.deepEqual(requests, ['update', 'update']);
  renderer.draw(target);
  assert.equal(ctx.ops.length, before);
  // Marks are only lists; junk is empty rather than an exception.
  primitive.setMarks('nope');
  assert.deepEqual(primitive.marks(), []);
});

test('orderMarks respects offsetSeconds for Beijing 1D candles (16:00 UTC boundary)', () => {
  const dayStart = 1794844800; // 2026-11-16 16:00:00 UTC
  const before = { time: dayStart - 60, price: 64000, size: 1, side: 'buy', posSide: 'long', ordId: '1', tradeId: 't1' };
  const after = { time: dayStart, price: 64100, size: 2, side: 'buy', posSide: 'long', ordId: '2', tradeId: 't2' };
  const marks = orderMarks([before, after], 1440, { offsetSeconds: 28800 });
  assert.equal(marks.length, 2);
  assert.equal(marks[0].time, dayStart - 86400);
  assert.equal(marks[1].time, dayStart);
});
