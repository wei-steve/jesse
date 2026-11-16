import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_SOURCES, DEFAULT_SOURCE, YIELD_SOURCE, SPOT_SOURCE, restoreSource, sourceLabel, exchangeOf,
  defaultSymbolOf, isYieldSource, YIELD_SYMBOLS, DEFAULT_YIELD_SYMBOLS, normalizeYieldSymbol, isDailyOnlyYield,
  yieldRequest, pollRangeOf, aggregateCandles, parseMarketCandles, yieldQuote, signedPoints } from
  '../jesse/static/review/market-sources.mjs';
import { mergeCandles, watchKey } from '../jesse/static/review/market-data.mjs';

// --- Sources ------------------------------------------------------------------------------------------------------

test('the dropdown offers the three sources, the perpetual first', () => {
  assert.deepEqual(MARKET_SOURCES.map(source => source.id), ['binance-perp', 'binance-spot', 'us-yields']);
  assert.deepEqual(MARKET_SOURCES.map(source => source.label), ['币安永续', '币安现货', '美债收益率']);
  assert.equal(DEFAULT_SOURCE, 'binance-perp');
  assert.equal(sourceLabel('us-yields'), '美债收益率');
  assert.equal(defaultSymbolOf(YIELD_SOURCE), 'US10Y');
  assert.equal(defaultSymbolOf(SPOT_SOURCE), 'BTCUSDT');
  assert.equal(isYieldSource(YIELD_SOURCE), true);
  assert.equal(isYieldSource(SPOT_SOURCE), false);
});

test('a saved source id restores, anything else falls back to the perpetual', () => {
  assert.equal(restoreSource('binance-spot'), 'binance-spot');
  assert.equal(restoreSource('"us-yields"'), 'us-yields');
  assert.equal(restoreSource(' us-yields '), 'us-yields');
  for (const broken of [null, undefined, '', 'bybit', '{}', 'BTCUSDT']) {
    assert.equal(restoreSource(broken), 'binance-perp', String(broken));
  }
});

test('the live streams know which venue each source belongs to, and the yields have none', () => {
  assert.equal(exchangeOf('binance-perp'), 'Binance Perpetual Futures');
  assert.equal(exchangeOf('binance-spot'), 'Binance Spot');
  assert.equal(exchangeOf('us-yields'), '');
});

// --- Yield instruments --------------------------------------------------------------------------------------------

test('the six yields are named the way the owner names them', () => {
  assert.deepEqual(YIELD_SYMBOLS, ['US03M', 'US02Y', 'US05Y', 'US10Y', 'US20Y', 'US30Y']);
  assert.deepEqual(DEFAULT_YIELD_SYMBOLS, ['US02Y', 'US10Y', 'US20Y', 'US30Y']);
  for (const typed of ['US10Y', 'us10y', '10y', ' 10Y ']) {
    assert.equal(normalizeYieldSymbol(typed), 'US10Y', typed);
  }
  for (const broken of ['', null, 'US07Y', 'US10', 'btc']) {
    assert.equal(normalizeYieldSymbol(broken), '', String(broken));
  }
});

test('only the 2 and the 20 year are daily-only (FRED has no intraday series for them)', () => {
  assert.deepEqual(YIELD_SYMBOLS.filter(isDailyOnlyYield), ['US02Y', 'US20Y']);
  assert.equal(isDailyOnlyYield('US10Y'), false);
});

// --- Interval mapping ----------------------------------------------------------------------------------------------

test('a yield panel asks for the series it can be built from', () => {
  // Straight through for the five the upstream has.
  for (const tf of ['1m', '5m', '15m', '30m', '1h', '1D']) {
    assert.deepEqual(yieldRequest('US10Y', tf), { interval: tf, aggregate: 1, dailyOnly: false, timeframe: tf });
  }
  // 3m and 4h exist only as aggregations; Yahoo has no bond data for those intervals.
  assert.equal(yieldRequest('US10Y', '3m').interval, '1m');
  assert.equal(yieldRequest('US10Y', '3m').aggregate, 3);
  assert.equal(yieldRequest('US10Y', '4h').interval, '1h');
  assert.equal(yieldRequest('US10Y', '4h').aggregate, 4);
  // A daily-only instrument is asked for its daily series whatever the panel shows: the panel says so instead.
  for (const tf of ['1m', '5m', '4h']) {
    assert.deepEqual(yieldRequest('US02Y', tf), { interval: '1D', aggregate: 1, dailyOnly: true, timeframe: tf });
  }
  assert.equal(yieldRequest('US20Y', '1D').interval, '1D');
});

test('the 60-second poll only asks for the newest bars', () => {
  assert.deepEqual(['1m', '5m', '15m', '30m', '1h', '1D'].map(pollRangeOf),
    ['1d', '5d', '5d', '5d', '1mo', '1mo']);
  assert.equal(pollRangeOf('3m'), '5d', 'an aggregated panel polls like its source series');
  assert.equal(pollRangeOf('4h'), '5d');
});

// --- Aggregation --------------------------------------------------------------------------------------------------

const candle = (time, values) => ({ time, open: values[0], high: values[1], low: values[2], close: values[3],
  volume: values[4] });

test('3m bars are UTC-aligned buckets of three 1m bars', () => {
  // 540, 600 and 660 are three consecutive minutes of the same 3m bucket (the bucket starts at a multiple of 180).
  const series = [candle(540, [4.1, 4.12, 4.09, 4.11, 1]), candle(600, [4.11, 4.2, 4.1, 4.18, 2]),
    candle(660, [4.18, 4.19, 4.15, 4.16, 3]), candle(720, [4.16, 4.17, 4.14, 4.15, 4])];
  assert.deepEqual(aggregateCandles(series, 3), [
    { time: 540, open: 4.1, high: 4.2, low: 4.09, close: 4.16, volume: 6 },
    { time: 720, open: 4.16, high: 4.17, low: 4.14, close: 4.15, volume: 4 }]);
});

test('a short bucket is kept: a bond session is not a full day of minutes', () => {
  // 13:30–13:31 UTC of a session that opens at 13:30: the 15m bucket has two bars and nothing before it.
  const series = [candle(48600, [4.1, 4.12, 4.09, 4.11, 1]), candle(48660, [4.11, 4.13, 4.1, 4.12, 1])];
  assert.deepEqual(aggregateCandles(series, 15), [
    { time: 48600, open: 4.1, high: 4.13, low: 4.09, close: 4.12, volume: 2 }]);
  // 4h from 1h: four bars of a 1h series, one bucket (1763193600 is a 4h boundary).
  const hourly = [0, 3600, 7200, 10800].map((offset, i) => candle(1763193600 + offset, [4 + i / 100, 4 + i / 100,
    4 + i / 100, 4 + i / 100, 10]));
  const bars = aggregateCandles(hourly, 240);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].time % 14400, 0);
  assert.equal(bars[0].open, 4);
  assert.equal(bars[0].close, 4.03);
  assert.equal(bars[0].volume, 40);
});

test('aggregating nothing / one-minute candles is a no-op, and junk is dropped', () => {
  assert.deepEqual(aggregateCandles([], 3), []);
  assert.deepEqual(aggregateCandles(null, 3), []);
  const series = [candle(60, [4, 4, 4, 4, 0]), null, { time: 'x' }];
  assert.equal(aggregateCandles(series, 1).length, 3, 'minutes=1 passes the list through');
  assert.deepEqual(aggregateCandles(series, 15), [{ time: 0, open: 4, high: 4, low: 4, close: 4, volume: 0 }]);
});

// --- The proxy's answer --------------------------------------------------------------------------------------------

test('the proxy answer becomes candles in UTC seconds plus what the chart has to say about them', () => {
  const payload = { provider: 'Yahoo', delayed: true, note: '来源 Yahoo Finance，延迟约 0~10 分钟',
    daily_only: false, cached: false, candles: [
      { time: 1763178600, open: 4.11, high: 4.13, low: 4.09, close: 4.12, volume: 0 },
      { time: '1763178660', open: '4.12', high: '4.14', low: '4.1', close: '4.13' },
      { time: 1763178720, open: 4.13, high: 4.14, low: 4.12, close: null },
      { time: 1763178780, open: 4.13, high: 'x', low: 4.12, close: 4.14 },
      { time: 0, open: 4, high: 4, low: 4, close: 4 },
    ] };
  const parsed = parseMarketCandles(payload);
  assert.equal(parsed.provider, 'Yahoo');
  assert.equal(parsed.delayed, true);
  assert.ok(parsed.note.includes('延迟'));
  assert.equal(parsed.dailyOnly, false);
  // Two sane bars: nulls and text are dropped instead of drawn as holes.
  assert.deepEqual(parsed.closed, [
    { time: 1763178600, open: 4.11, high: 4.13, low: 4.09, close: 4.12, volume: 0 },
    { time: 1763178660, open: 4.12, high: 4.14, low: 4.1, close: 4.13, volume: 0 },
  ]);
  for (const broken of [null, {}, { candles: null }, { candles: [{}] }]) {
    assert.deepEqual(parseMarketCandles(broken).closed, [], JSON.stringify(broken));
  }
});

// --- Watchlist values ----------------------------------------------------------------------------------------------

test('a yield quote is the newest value and its change in percentage points', () => {
  const daily = [candle(1794441600, [4.11, 4.11, 4.11, 4.11, 0]), candle(1794528000, [4.14, 4.14, 4.14, 4.14, 0])];
  const quote = yieldQuote(daily);
  assert.deepEqual(quote, { price: 4.14, change: quote.change, time: 1794528000 });
  assert.ok(Math.abs(quote.change - 0.03) < 1e-9, '3 basis points, in percentage points');
  // One bar is a value without a change (no yesterday to compare with).
  assert.deepEqual(yieldQuote([daily[0]]), { price: 4.11, change: null, time: 1794441600 });
  assert.equal(yieldQuote([]), null);
  assert.equal(yieldQuote(null), null);
  // The page writes the change as +0.03: a yield is a percentage already, 0.03% of it would read wrong.
  assert.equal(signedPoints(0.03), '+0.03');
  assert.equal(signedPoints(0.02999999999999936), '+0.03');
  assert.equal(signedPoints(-0.125), '-0.13');
  assert.equal(signedPoints(0), '+0.00');
  assert.equal(signedPoints(null), '');
});

test('the 60-second poll merges into the loaded history instead of replacing it', () => {
  const loaded = [candle(600, [4.1, 4.1, 4.1, 4.1, 0]), candle(660, [4.1, 4.1, 4.1, 4.1, 0]),
    candle(720, [4.1, 4.1, 4.1, 4.1, 0])];
  const polled = parseMarketCandles({ provider: 'Yahoo', candles: [
    { time: 720, open: 4.1, high: 4.2, low: 4.1, close: 4.19, volume: 0 },
    { time: 780, open: 4.19, high: 4.21, low: 4.18, close: 4.2, volume: 0 },
  ] }).closed;
  const merged = mergeCandles(loaded, polled);
  // The refreshed bar wins, the history before it stays, the new bar lands last.
  assert.deepEqual(merged.map(bar => [bar.time, bar.close]), [[600, 4.1], [660, 4.1], [720, 4.19], [780, 4.2]]);
  // Nothing new (the upstream had no fresh bar): the chart keeps exactly what it had.
  assert.deepEqual(mergeCandles(loaded, parseMarketCandles({ candles: [] }).closed), loaded);
});

test('a watchlist row is identified by source and symbol together', () => {
  assert.equal(watchKey({ source: 'binance-perp', symbol: 'BTCUSDT' }), 'binance-perp|BTCUSDT');
  assert.equal(watchKey({ source: 'us-yields', symbol: 'US10Y' }), 'us-yields|US10Y');
  // The same pair on spot is a different row: the sidebar keeps both quotes apart.
  assert.notEqual(watchKey({ source: 'binance-perp', symbol: 'BTCUSDT' }),
    watchKey({ source: 'binance-spot', symbol: 'BTCUSDT' }));
});
