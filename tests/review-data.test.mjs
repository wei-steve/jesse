import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCandles, sma, lastClosedCandle, contextAt, executionMarkers, centeredRange, contextPointsFor, linkTimeRanges,
} from '../jesse/static/review/data.mjs';

// UTC-aligned, complete minute bars; asymmetric OHLC catches swapped fields.
const minutes = (count, start = 0) => Array.from({ length: count }, (_, i) => ({
  time: start + i * 60, open: 100 + i, high: 106 + i,
  low: 97 + i, close: 102 + i, volume: i + 1,
}));

test('aggregates UTC-aligned OHLCV and preserves source bars', () => {
  const source = minutes(6).reverse();
  const before = structuredClone(source);
  assert.deepEqual(aggregateCandles(source, 3), {
    candles: [
      { time: 0, open: 100, high: 108, low: 97, close: 104, volume: 6 },
      { time: 180, open: 103, high: 111, low: 100, close: 107, volume: 15 },
    ], omittedBuckets: 0,
  });
  assert.deepEqual(source, before);
});

test('does not fabricate incomplete boundary or gapped context candles', () => {
  const source = minutes(10, 60).filter(c => c.time !== 240);
  const result = aggregateCandles(source, 3);
  assert.deepEqual(result.candles.map(c => c.time), [360]);
  assert.equal(result.omittedBuckets, 3);
});

test('rejects duplicate timestamps, non-minute inputs, invalid OHLC and unsupported intervals', () => {
  assert.throws(() => aggregateCandles([...minutes(2), ...minutes(1)], 3), /duplicate/i);
  assert.throws(() => aggregateCandles(minutes(2, 1), 3), /minute/i);
  assert.throws(() => aggregateCandles([{ ...minutes(1)[0], high: 0 }], 3), /OHLC/);
  assert.throws(() => aggregateCandles([{ ...minutes(1)[0], close: NaN }], 3), /finite/i);
  assert.throws(() => aggregateCandles(minutes(3), 2.5), /interval/i);
});

test('SMA5 has no values before five available candles and restarts across gaps', () => {
  assert.deepEqual(sma(minutes(6), 5, 1), [
    { time: 240, value: 104 }, { time: 300, value: 105 },
  ]);
  assert.deepEqual(sma([...minutes(3), ...minutes(5, 600)], 5, 1), [
    { time: 840, value: 104 },
  ]);
});

test('as-of summary excludes forming candles including exact entry boundary', () => {
  const bars = aggregateCandles(minutes(9), 3).candles;
  assert.equal(lastClosedCandle(bars, 3, 179), null);
  assert.equal(lastClosedCandle(bars, 3, 180).time, 0);
  assert.equal(lastClosedCandle(bars, 3, 359).time, 0);
  assert.equal(lastClosedCandle(bars, 3, 360).time, 180);
});

test('recorded context becomes available only at the close of the source candle', () => {
  const points = [{ time: 0, value: 3 }, { time: 60, value: 15 }];
  assert.equal(contextAt(points, 59, 1), null);
  assert.equal(contextAt(points, 60, 1), 3);
  assert.equal(contextAt(points, 119, 1), 3);
  assert.equal(contextAt(points, 120, 1), 15);
});

test('actual executions map to containing timeframe candle, preserving side and price', () => {
  const bars = aggregateCandles(minutes(9), 3).candles;
  const trade = {
    id: 't1', opened_at: 120000, closed_at: 360000, type: 'short',
    entry_price: 104, exit_price: 108,
    orders: [
      { id: 'entry', executed_at: 120000, price: 104, side: 'sell', reduce_only: false, status: 'EXECUTED' },
      { id: 'exit', executed_at: 360000, price: 108, side: 'buy', reduce_only: true, status: 'EXECUTED' },
    ],
  };
  const markers = executionMarkers([trade], bars, 3);
  assert.deepEqual(markers.map(m => [m.time, m.position, m.text]), [
    [0, 'aboveBar', '开空 104.00'], [360, 'belowBar', '平空 108.00'],
  ]);
  assert.equal(executionMarkers([trade], bars.filter(c => c.time !== 0), 3).length, 1);
});

test('view range is a time range shared by all intervals', () => {
  assert.deepEqual(centeredRange(10000, 3600), { from: 7300, to: 10900 });
});

test('reads the strategy chart title without changing its case', () => {
  // These titles come from MA5TrendRiderV1.update_chart(), not the uppercase UI.
  assert.deepEqual(contextPointsFor({ extra_charts: {
    'MA5 context': { 'Selected minutes': { data: [{ time: 60, value: 15 }, { time: 0, value: 5 }] } },
  } }), [{ time: 0, value: 5 }, { time: 60, value: 15 }]);
  assert.deepEqual(contextPointsFor({}), []);
});

test('SMA inserts whitespace instead of drawing through missing history', () => {
  assert.deepEqual(sma([...minutes(5), ...minutes(5, 600)], 5, 1), [
    { time: 240, value: 104 }, { time: 600 }, { time: 840, value: 104 },
  ]);
});

test('range synchronization ignores asynchronous programmatic feedback', async () => {
  let writes = 0;
  const panels = [1, 3, 5, 15].map(interval => {
    let listener;
    const scale = {
      subscribeVisibleTimeRangeChange: f => { listener = f; },
      setVisibleRange: range => {
        writes++;
        // Real charts round to their own candle interval and deliver later.
        queueMicrotask(() => listener({ from: Math.floor(range.from / (interval * 60)) * interval * 60, to: range.to }));
      },
    };
    return { chart: { timeScale: () => scale }, emit: range => listener(range) };
  });
  const linked = linkTimeRanges(panels);
  linked.set({ from: 1001, to: 10000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 4);
  linked.activate(panels[1]);
  panels[1].emit({ from: 2001, to: 12000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 7);
});

test('linked charts follow position but keep their own zoom', () => {
  const panels = ['a', 'b', 'c'].map(name => {
    let listener; const writes = [];
    const scale = { subscribeVisibleTimeRangeChange: f => { listener = f; }, setVisibleRange: r => writes.push(r) };
    return { name, writes, chart: { timeScale: () => scale }, emit: r => listener(r) };
  });
  // a and b are one group (a main chart and its indicator pane); c is another timeframe.
  const linked = linkTimeRanges(panels, () => {}, p => (p.name === 'c' ? 'c' : 'ab'));
  linked.set({ from: 0, to: 1000 });
  assert.deepEqual(panels[2].writes.at(-1), { from: 0, to: 1000 });
  // Zoom c in to 200 seconds around 500: a/b keep 1000 seconds, centred on the same moment.
  linked.activate(panels[2]); panels[2].emit({ from: 400, to: 600 });
  assert.deepEqual(panels[0].writes.at(-1), { from: 0, to: 1000 });
  // Zoom a: its pane b gets the exact range, c keeps its 200 seconds.
  linked.activate(panels[0]); panels[0].emit({ from: 1000, to: 1400 });
  assert.deepEqual(panels[1].writes.at(-1), { from: 1000, to: 1400 });
  assert.deepEqual(panels[2].writes.at(-1), { from: 1100, to: 1300 });
  // Navigating with keepSpan keeps each zoom, the moment at 3/4 of each chart.
  linked.set({ from: 2000, to: 3000 }, { keepSpan: true, at: 0.75 });
  assert.deepEqual(panels[0].writes.at(-1), { from: 2450, to: 2850 });
  assert.deepEqual(panels[2].writes.at(-1), { from: 2600, to: 2800 });
  // A plain set (new window choice) resets every zoom.
  linked.set({ from: 0, to: 1000 });
  assert.deepEqual(panels[2].writes.at(-1), { from: 0, to: 1000 });
});

test('the first placement records each chart span even with keepSpan', () => {
  const panels = ['a', 'b'].map(name => {
    let listener; const writes = [];
    const scale = { subscribeVisibleTimeRangeChange: f => { listener = f; }, setVisibleRange: r => writes.push(r) };
    return { name, writes, chart: { timeScale: () => scale }, emit: r => listener(r) };
  });
  const linked = linkTimeRanges(panels);
  linked.set({ from: 0, to: 1000 }, { keepSpan: true, at: 0.95 });
  linked.activate(panels[1]); panels[1].emit({ from: 0, to: 5000 });
  assert.deepEqual(panels[0].writes.at(-1), { from: 2000, to: 3000 });
});
