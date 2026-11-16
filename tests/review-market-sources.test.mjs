import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_SOURCES, DEFAULT_SOURCE, DEFAULT_MARKET, MARKETS, YIELD_SOURCE, BINANCE_SOURCE, OKX_SOURCE,
  DEEPCOIN_SOURCE, migrateSource, restoreSource, sourceLabel, marketsOf, hasMarkets, normalizeMarket, defaultSymbolOf,
  exchangeOf, isYieldSource, marketLabel, normalizeSymbol, normalizeInstId, symbolOf, instrumentName, candleRequest,
  BARS, YIELD_SYMBOLS, DEFAULT_YIELD_SYMBOLS, normalizeYieldSymbol, isDailyOnlyYield, yieldRequest, pollRangeOf,
  aggregateCandles, parseMarketCandles, yieldQuote, signedPoints, sessionIndicator, sessionTail } from
  '../jesse/static/review/market-sources.mjs';
import { mergeCandles, watchKey } from '../jesse/static/review/market-data.mjs';

// --- Sources ------------------------------------------------------------------------------------------------------

test('the dropdown offers the three exchanges plus the yields, Binance first', () => {
  assert.deepEqual(MARKET_SOURCES.map(source => source.id), ['binance', 'okx', 'deepcoin', 'us-yields']);
  assert.deepEqual(MARKET_SOURCES.map(source => source.label), ['Binance', 'OKX', 'Deepcoin', '美债收益率']);
  assert.equal(DEFAULT_SOURCE, 'binance');
  assert.equal(DEFAULT_MARKET, 'swap');
  // 合约 / 现货 are sub-tabs of the product list, not sources of their own any more.
  assert.deepEqual(MARKETS.map(market => [market.id, market.label]), [['swap', '合约'], ['spot', '现货']]);
  assert.equal(marketLabel('swap'), '合约');
  assert.equal(marketLabel('spot'), '现货');
  assert.equal(marketLabel(null), '');
});

test('every exchange has both markets, the yields have none', () => {
  for (const source of [BINANCE_SOURCE, OKX_SOURCE, DEEPCOIN_SOURCE]) {
    assert.deepEqual(marketsOf(source), ['swap', 'spot'], source);
    assert.equal(hasMarkets(source), true);
  }
  assert.deepEqual(marketsOf(YIELD_SOURCE), []);
  assert.equal(hasMarkets(YIELD_SOURCE), false);
  assert.equal(normalizeMarket(OKX_SOURCE, 'spot'), 'spot');
  assert.equal(normalizeMarket(OKX_SOURCE, 'nonsense'), 'swap');
  assert.equal(normalizeMarket(YIELD_SOURCE, 'swap'), null);
  assert.equal(isYieldSource(YIELD_SOURCE), true);
  assert.equal(isYieldSource(OKX_SOURCE), false);
  assert.equal(sourceLabel('deepcoin'), 'Deepcoin');
  assert.equal(sourceLabel('us-yields'), '美债收益率');
});

test('the defaults are one instrument per market, in that venue\'s own spelling', () => {
  assert.equal(defaultSymbolOf(BINANCE_SOURCE, 'swap'), 'BTCUSDT');
  assert.equal(defaultSymbolOf(BINANCE_SOURCE, 'spot'), 'BTCUSDT');
  assert.equal(defaultSymbolOf(OKX_SOURCE, 'swap'), 'BTC-USDT-SWAP');
  assert.equal(defaultSymbolOf(OKX_SOURCE, 'spot'), 'BTC-USDT');
  assert.equal(defaultSymbolOf(DEEPCOIN_SOURCE, 'swap'), 'BTC-USDT-SWAP');
  assert.equal(defaultSymbolOf(YIELD_SOURCE, null), 'US10Y');
});

test('only Binance rows have a Binance-style stream venue', () => {
  assert.equal(exchangeOf(BINANCE_SOURCE, 'swap'), 'Binance Perpetual Futures');
  assert.equal(exchangeOf(BINANCE_SOURCE, 'spot'), 'Binance Spot');
  for (const source of [OKX_SOURCE, DEEPCOIN_SOURCE, YIELD_SOURCE]) assert.equal(exchangeOf(source, 'swap'), '');
});

test('a pre-T-54 source id migrates to the exchange and market it named', () => {
  // The old dropdown listed the venue: binance-perp / binance-spot / us-yields.
  assert.deepEqual(migrateSource('binance-perp'), { source: 'binance', market: 'swap' });
  assert.deepEqual(migrateSource('binance-spot'), { source: 'binance', market: 'spot' });
  assert.deepEqual(migrateSource('"binance-spot"'), { source: 'binance', market: 'spot' });
  assert.deepEqual(migrateSource(' us-yields '), { source: 'us-yields', market: null });
  // Current ids restore with their first market.
  assert.deepEqual(migrateSource('okx'), { source: 'okx', market: 'swap' });
  assert.deepEqual(migrateSource('deepcoin'), { source: 'deepcoin', market: 'swap' });
  for (const broken of [null, undefined, '', 'bybit', '{}', 'BTCUSDT']) assert.equal(migrateSource(broken), null, String(broken));
  // restoreSource keeps the old name and returns just the id.
  assert.equal(restoreSource('binance-spot'), 'binance');
  assert.equal(restoreSource('"us-yields"'), 'us-yields');
  for (const broken of [null, '', 'bybit', 'BTCUSDT']) assert.equal(restoreSource(broken), 'binance', String(broken));
});

// --- Symbols ------------------------------------------------------------------------------------------------------

test('Binance symbols stay the concatenated pair', () => {
  for (const typed of ['btc', 'BTC', 'BTCUSDT', 'btcusdt', 'BTC-USDT', 'btc/usdt', ' btc_usdt ', 'Btc-Usdt']) {
    assert.equal(normalizeSymbol(typed), 'BTCUSDT', typed);
    assert.equal(symbolOf(BINANCE_SOURCE, 'swap', typed), 'BTCUSDT', typed);
  }
  assert.equal(normalizeSymbol('1000pepe'), '1000PEPEUSDT');
  for (const typed of ['', '   ', null, undefined, 'usdt', '-', '///', 'a']) {
    assert.equal(normalizeSymbol(typed), '', String(typed));
  }
});

test('OKX / Deepcoin symbols become the instId of the market on screen', () => {
  for (const typed of ['btc', 'BTC-USDT', 'BTC-USDT-SWAP', 'btcusdt', 'btc/usdt', '  btc ']) {
    assert.equal(normalizeInstId('swap', typed), 'BTC-USDT-SWAP', typed);
    assert.equal(normalizeInstId('spot', typed), 'BTC-USDT', typed);
    assert.equal(symbolOf(OKX_SOURCE, 'swap', typed), 'BTC-USDT-SWAP', typed);
    assert.equal(symbolOf(DEEPCOIN_SOURCE, 'spot', typed), 'BTC-USDT', typed);
  }
  assert.equal(normalizeInstId('swap', '1000pepe'), '1000PEPE-USDT-SWAP');
  for (const typed of ['', null, 'usdt', '-', 'a']) assert.equal(normalizeInstId('swap', typed), '', String(typed));
});

test('a row shows the base name, and a yield its own code', () => {
  assert.equal(instrumentName(BINANCE_SOURCE, 'BTCUSDT'), 'BTC');
  assert.equal(instrumentName(OKX_SOURCE, 'BTC-USDT-SWAP'), 'BTC');
  assert.equal(instrumentName(DEEPCOIN_SOURCE, 'BTC-USDT'), 'BTC');
  assert.equal(instrumentName(YIELD_SOURCE, 'US10Y'), 'US10Y');
});

// --- Bars ---------------------------------------------------------------------------------------------------------

test('each exchange\'s bar spelling of a panel timeframe', () => {
  assert.deepEqual(BARS[OKX_SOURCE]['1h'], '1H');
  assert.deepEqual(BARS[OKX_SOURCE]['4h'], '4H');
  // The daily bar must be OKX's UTC one: plain 1D opens at the venue's UTC+8 midnight.
  assert.deepEqual(BARS[OKX_SOURCE]['1D'], '1Dutc');
  assert.equal(BARS[DEEPCOIN_SOURCE]['1D'], '1D');
  // Deepcoin has no 3m bar (checked 2026-11-16), so that panel asks for 1m and buckets three; OKX has one.
  assert.deepEqual(candleRequest(DEEPCOIN_SOURCE, '3m'), { interval: '1m', aggregate: 3 });
  assert.deepEqual(candleRequest(DEEPCOIN_SOURCE, '15m'), { interval: '15m', aggregate: 1 });
  assert.deepEqual(candleRequest(OKX_SOURCE, '3m'), { interval: '3m', aggregate: 1 });
  assert.deepEqual(candleRequest(OKX_SOURCE, '1h'), { interval: '1H', aggregate: 1 });
  // A source without its own table (Binance, the yields) hands the label through unchanged.
  assert.deepEqual(candleRequest(BINANCE_SOURCE, '1h'), { interval: '1h', aggregate: 1 });
  assert.deepEqual(candleRequest(YIELD_SOURCE, '1m'), { interval: '1m', aggregate: 1 });
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
  assert.equal(symbolOf(YIELD_SOURCE, null, '10y'), 'US10Y');
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
  assert.deepEqual(['1m', '5m', '15m', '30m', '1h', '1D'].map(tf => pollRangeOf(tf, 'US10Y')),
    ['1d', '5d', '5d', '5d', '1mo', '1mo']);
  assert.equal(pollRangeOf('3m', 'US10Y'), '1d', 'an aggregated panel polls like its source series (1m)');
  assert.equal(pollRangeOf('4h', 'US10Y'), '1mo', '4h asks Yahoo for 1h, whose shortest range is 1mo');
  assert.equal(pollRangeOf('5m', 'US02Y'), '1mo', 'a FRED symbol asks for 1D on every panel');
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

test('a Deepcoin answer carries the bar the venue is still building separately', () => {
  // The proxy sends `{candles: [...closed, oldest first...], forming: {...} | null}`; a malformed forming bar is no bar.
  const parsed = parseMarketCandles({ source: 'deepcoin', candles: [
    { time: 1763178600, open: 64000, high: 64020, low: 63990, close: 64010, volume: 12 },
  ], forming: { time: 1763179200, open: 64010, high: 64030, low: 64005, close: 64022, volume: 3 } });
  assert.equal(parsed.closed.length, 1);
  assert.deepEqual(parsed.forming, { time: 1763179200, open: 64010, high: 64030, low: 64005, close: 64022, volume: 3 });
  assert.equal(parseMarketCandles({ forming: { time: 0 } }).forming, null);
  assert.equal(parseMarketCandles({}).forming, null);
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

test('a watchlist row is identified by source, market and symbol', () => {
  assert.equal(watchKey({ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }), 'binance|swap|BTCUSDT');
  assert.equal(watchKey({ source: 'us-yields', market: null, symbol: 'US10Y' }), 'us-yields||US10Y');
  // The same pair on spot, or on another venue, is a different row: the sidebar keeps both quotes apart.
  assert.notEqual(watchKey({ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }),
    watchKey({ source: 'binance', market: 'spot', symbol: 'BTCUSDT' }));
  assert.notEqual(watchKey({ source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' }),
    watchKey({ source: 'deepcoin', market: 'swap', symbol: 'BTC-USDT-SWAP' }));
});

test('session indicators bridge the overnight gap and keep real times', () => {
  const hour = 3600;
  // Two sessions of 5 bars with a 10-hour gap between them.
  const bars = [...Array(10)].map((_, i) => {
    const time = 1700000000 - (1700000000 % hour) + (i < 5 ? i : i + 10) * hour;
    return { time, open: i + 1, high: i + 1, low: i + 1, close: i + 1, volume: 0 };
  });
  const config = { type: 'SMA', period: 3, color: '#000000' };
  const line = sessionIndicator(bars, config, 60).series[0].data.filter(p => Number.isFinite(p.value));
  assert.equal(line.length, 8, 'an SMA3 over 10 bars has 8 points, the gap does not restart it');
  assert.equal(line[3].time, bars[5].time);
  assert.equal(line[3].value, (4 + 5 + 6) / 3, 'the first bar after the gap averages with the bars before it');
  const tail = sessionTail(bars.slice(0, 9), bars[9], config, 60);
  assert.deepEqual(tail[0].point, { time: bars[9].time, value: (8 + 9 + 10) / 3 });
});
