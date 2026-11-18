import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_SOURCES, DEFAULT_SOURCE, DEFAULT_MARKET, MARKETS, YIELD_SOURCE, BINANCE_SOURCE, OKX_SOURCE,
  DEEPCOIN_SOURCE, BEIJING_OFFSET_SECONDS, DAY_BOUNDARY_KEY, DAY_BOUNDARY_UTC, DAY_BOUNDARY_UTC8,
  DEFAULT_DAY_BOUNDARY, barOpen, dayOffsetSeconds, normalizeDayBoundary, restoreDayBoundary,
  migrateSource, restoreSource, sourceLabel, marketsOf, hasMarkets, normalizeMarket, defaultSymbolOf,
  exchangeOf, isYieldSource, marketLabel, normalizeSymbol, normalizeInstId, symbolOf, instrumentName, candleRequest,
  BARS, YIELD_SYMBOLS, YIELD_INSTRUMENTS, DEFAULT_YIELD_SYMBOLS, normalizeYieldSymbol, cnbcSymbolOf, yieldRequest,
  YIELD_POLL_RANGE, aggregateCandles, mergeYieldBars, mergeYieldDailyClose, parseCnbcBars, parseCnbcQuote,
  parseMarketCandles, signedPoints, sessionIndicator, sessionTail } from
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
  // Plain 1D on OKX opens at the venue's UTC+8 midnight (16:00 UTC), matching Deepcoin.
  assert.deepEqual(BARS[OKX_SOURCE]['1D'], '1D');
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

test('the six yields are named the way the owner names them, and CNBC spells them its own way', () => {
  assert.deepEqual(YIELD_SYMBOLS, ['US03M', 'US02Y', 'US05Y', 'US10Y', 'US20Y', 'US30Y']);
  assert.deepEqual(DEFAULT_YIELD_SYMBOLS, ['US02Y', 'US10Y', 'US20Y', 'US30Y']);
  for (const typed of ['US10Y', 'us10y', '10y', ' 10Y ']) {
    assert.equal(normalizeYieldSymbol(typed), 'US10Y', typed);
  }
  for (const broken of ['', null, 'US07Y', 'US10', 'btc']) {
    assert.equal(normalizeYieldSymbol(broken), '', String(broken));
  }
  assert.equal(symbolOf(YIELD_SOURCE, null, '10y'), 'US10Y');
  // Only the three-month one drops a character: US03M is CNBC's US3M.
  assert.deepEqual(YIELD_INSTRUMENTS.map(entry => entry.cnbc), ['US3M', 'US2Y', 'US5Y', 'US10Y', 'US20Y', 'US30Y']);
  assert.equal(cnbcSymbolOf('US03M'), 'US3M');
  assert.equal(cnbcSymbolOf('us02y'), 'US2Y');
  assert.equal(cnbcSymbolOf('US20Y'), 'US20Y');
  for (const broken of ['', null, 'US07Y', 'btc']) assert.equal(cnbcSymbolOf(broken), '', String(broken));
});

// --- CNBC chart ranges ------------------------------------------------------------------------------------------

test('every panel asks CNBC for the range it can be built from', () => {
  // 1m / 3m come from the session's one-minute series, the rest of the intraday panels from the 5-minute series of
  // the last ten days, and 1D from the daily series of the last three years.
  assert.deepEqual(yieldRequest('1m'), { range: '1D', base: 1, aggregate: 1, timeframe: '1m' });
  assert.deepEqual(yieldRequest('3m'), { range: '1D', base: 1, aggregate: 3, timeframe: '3m' });
  assert.deepEqual(yieldRequest('5m'), { range: '5D', base: 5, aggregate: 1, timeframe: '5m' });
  for (const [tf, minutes] of [['15m', 15], ['30m', 30], ['1h', 60], ['4h', 240]]) {
    assert.deepEqual(yieldRequest(tf), { range: '5D', base: 5, aggregate: minutes, timeframe: tf }, tf);
  }
  assert.deepEqual(yieldRequest('1D'), { range: '6M', base: 1440, aggregate: 1, timeframe: '1D' });
  // An unknown timeframe falls back to the 1m series instead of asking CNBC for a range it does not serve.
  assert.equal(yieldRequest('7m').range, '1D');
  // The 15-second poll always reads the current session's one-minute bars.
  assert.equal(YIELD_POLL_RANGE, '1D');
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

// --- CNBC's answers ------------------------------------------------------------------------------------------------

// CNBC's bar: every number a string, the time in milliseconds, oldest first (measured 2026-11-16: US2Y `1D`).
const cnbcBar = (ms, [o, h, l, c], volume = 0) => ({ open: String(o), high: String(h), low: String(l),
  close: String(c), volume, tradeTimeinMills: ms, tradeTime: '20261116160700' });

test('CNBC priceBars become candles: strings to numbers, milliseconds to seconds, bad rows dropped', () => {
  const parsed = parseCnbcBars({ barData: { priceBars: [
    cnbcBar(1794845220000, [4.846, 4.851, 4.846, 4.851]),
    cnbcBar(1794845280000, [4.851, 4.851, 4.848, 4.848], 3),
    // Half a bar is no bar: an empty close, text, a zero stamp, a duplicate of the first one (which loses to it).
    { open: '4.8', high: '4.8', low: '4.8', close: '', volume: 0, tradeTimeinMills: 1794845340000 },
    { open: '4.8', high: 'x', low: '4.8', close: '4.8', volume: 0, tradeTimeinMills: 1794845400000 },
    { open: '4.8', high: '4.8', low: '4.8', close: '4.8', volume: 0, tradeTimeinMills: 0 },
    null,
  ] } });
  assert.deepEqual(parsed, [
    { time: 1794845220, open: 4.846, high: 4.851, low: 4.846, close: 4.851, volume: 0 },
    { time: 1794845280, open: 4.851, high: 4.851, low: 4.848, close: 4.848, volume: 3 },
  ]);
  // A symbol CNBC does not know answers 200 with {status:'ERROR'} and no bars at all.
  for (const broken of [null, {}, { barData: null }, { barData: { priceBars: [] } },
    { status: 'ERROR', statusMessage: 'Security Master not found' }]) {
    assert.deepEqual(parseCnbcBars(broken), [], JSON.stringify(broken));
  }
});

test('CNBC quotes become the watchlist values, the change in percentage points', () => {
  const payload = { FormattedQuoteResult: { FormattedQuote: [
    { symbol: 'US2Y', last: '4.848%', change: '-0.026', last_time: '2026-11-16T11:11:36.000-0500' },
    { symbol: 'US10Y', last: '5.133%', change: '+0.012', last_time: '2026-11-16T11:11:52.000-0500' },
    // A closed instrument has no change; a code the page does not know, and a missing value, are dropped.
    { symbol: 'US30Y', last: '5.4%', change: '', last_time: '2026-11-16T11:11:52.000-0500' },
    { symbol: 'DE10Y', last: '2.5%', change: '+0.01' },
    { symbol: 'US05Y', last: '--', change: '+0.01' },
  ] } };
  assert.deepEqual(parseCnbcQuote(payload), [
    { symbol: 'US02Y', price: 4.848, change: -0.026 },
    { symbol: 'US10Y', price: 5.133, change: 0.012 },
    { symbol: 'US30Y', price: 5.4, change: null },
  ]);
  // One symbol comes back as a single object, not an array.
  assert.deepEqual(parseCnbcQuote({ FormattedQuoteResult: { FormattedQuote:
    { symbol: 'US20Y', last: '5.31%', change: '0.02' } } }),
  [{ symbol: 'US20Y', price: 5.31, change: 0.02 }]);
  for (const broken of [null, {}, { FormattedQuoteResult: null }, { FormattedQuoteResult: { FormattedQuote: [] } }]) {
    assert.deepEqual(parseCnbcQuote(broken), [], JSON.stringify(broken));
  }
});

// --- The poll merging into a panel ---------------------------------------------------------------------------------

test('the poll merges its one-minute bars into a 1m panel by open time', () => {
  const loaded = [candle(600, [4.1, 4.1, 4.1, 4.1, 0]), candle(660, [4.1, 4.1, 4.1, 4.1, 0]),
    candle(720, [4.1, 4.1, 4.1, 4.1, 0])];
  const polled = [candle(720, [4.12, 4.15, 4.1, 4.14, 0]), candle(780, [4.14, 4.16, 4.13, 4.15, 0])];
  // The minute the range already had is the one that keeps moving; the new minute lands last.
  assert.deepEqual(mergeYieldBars(loaded, 1, polled).map(bar => [bar.time, bar.close]),
    [[600, 4.1], [660, 4.1], [720, 4.14], [780, 4.15]]);
  // Nothing polled: the series stays exactly as it was.
  assert.deepEqual(mergeYieldBars(loaded, 1, []), loaded);
  assert.deepEqual(mergeYieldBars(loaded, 1, [null, { time: 'x' }]), loaded);
});

test("a 5-minute panel re-buckets the polled minutes on CNBC's own grid", () => {
  // CNBC's 5D bars start at :01 (1793981460 % 300 === 60), so a UTC-aligned bucket would draw the same minutes twice.
  const start = 1793981460;
  const series = [candle(start, [4.1, 4.12, 4.09, 4.11, 0]), candle(start + 300, [4.11, 4.13, 4.1, 4.12, 0]),
    candle(start + 600, [4.12, 4.12, 4.1, 4.11, 0])];
  const polled = [[300, 4.11, 4.14, 4.1, 4.13], [360, 4.13, 4.16, 4.12, 4.15], [420, 4.15, 4.15, 4.11, 4.12],
    [480, 4.12, 4.18, 4.11, 4.17], [540, 4.17, 4.19, 4.16, 4.18], [600, 4.18, 4.2, 4.17, 4.19]]
    .map(([offset, o, h, l, c]) => candle(start + offset, [o, h, l, c, 0]));
  const merged = mergeYieldBars(series, 5, polled);
  // The bar before the polled window stays; the two it covers are rebuilt from the minutes (the newest holds one).
  assert.deepEqual(merged.map(bar => bar.time), [start, start + 300, start + 600]);
  assert.deepEqual(merged[1], { time: start + 300, open: 4.11, high: 4.19, low: 4.1, close: 4.18, volume: 0 });
  assert.deepEqual(merged[2], { time: start + 600, open: 4.18, high: 4.2, low: 4.17, close: 4.19, volume: 0 });
});

test('a 5-minute series becomes the 15m / 1h / 4h panels', () => {
  // 48 five-minute bars are exactly one 4h window (1763193600 is a 4h boundary).
  const start = 1763193600;
  const five = [...Array(48)].map((_, i) => candle(start + i * 300, [4 + i / 2, 4.5 + i / 2, 3.5 + i / 2, 4 + i / 2, 0]));
  const buckets = tf => aggregateCandles(five, yieldRequest(tf).aggregate);
  const fifteen = buckets('15m'), hourly = buckets('1h'), four = buckets('4h');
  assert.equal(fifteen.length, 16);
  assert.deepEqual(fifteen[0], { time: start, open: 4, high: 5.5, low: 3.5, close: 5, volume: 0 });
  assert.equal(hourly.length, 4);
  assert.deepEqual(hourly[0], { time: start, open: 4, high: 10, low: 3.5, close: 9.5, volume: 0 });
  assert.equal(four.length, 1);
  assert.deepEqual(four[0], { time: start, open: 4, high: 28, low: 3.5, close: 27.5, volume: 0 });
});

test("the daily panel takes the newest minute as today's close", () => {
  // CNBC stamps its daily bars at 05:00 UTC (1794546000 = 2026-11-13 05:00), and publishes them a session late.
  const daily = [candle(1794546000, [4.867, 4.893, 4.827, 4.874, 0])];
  // A minute of the same session moves the close, and the high / low when it goes past them.
  const same = mergeYieldDailyClose(daily, candle(1794549600, [4.9, 4.9, 4.9, 4.9, 0]));
  assert.deepEqual(same, [{ time: 1794546000, open: 4.867, high: 4.9, low: 4.827, close: 4.9, volume: 0 }]);
  // A minute of a later session (2026-11-16 16:09 UTC) starts that session's bar, stamped on CNBC's own 05:00 grid.
  const next = mergeYieldDailyClose(daily, candle(1794845340, [4.846, 4.846, 4.846, 4.848, 0]));
  assert.deepEqual(next, [...daily,
    { time: 1794805200, open: 4.846, high: 4.848, low: 4.848, close: 4.848, volume: 0 }]);
  // Nothing polled, nothing changed.
  assert.deepEqual(mergeYieldDailyClose(daily, null), daily);
});

// --- Watchlist values ----------------------------------------------------------------------------------------------

test('a change is written in percentage points, never as a percentage of a percentage', () => {
  assert.equal(signedPoints(0.03), '+0.03');
  assert.equal(signedPoints(0.02999999999999936), '+0.03');
  assert.equal(signedPoints(-0.125), '-0.13');
  assert.equal(signedPoints(-0.026), '-0.03');
  assert.equal(signedPoints(0), '+0.00');
  assert.equal(signedPoints(null), '');
});

test('a refreshed page merges into the loaded history instead of replacing it', () => {
  const loaded = [candle(600, [4.1, 4.1, 4.1, 4.1, 0]), candle(660, [4.1, 4.1, 4.1, 4.1, 0]),
    candle(720, [4.1, 4.1, 4.1, 4.1, 0])];
  const refreshed = parseMarketCandles({ candles: [
    { time: 720, open: 4.1, high: 4.2, low: 4.1, close: 4.19, volume: 0 },
    { time: 780, open: 4.19, high: 4.21, low: 4.18, close: 4.2, volume: 0 },
  ] }).closed;
  const merged = mergeCandles(loaded, refreshed);
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

test('barOpen and dayOffsetSeconds align crypto 1D to UTC+8 midnight (16:00 UTC) and leave others UTC-aligned', () => {
  assert.equal(BEIJING_OFFSET_SECONDS, 28800);
  for (const src of [BINANCE_SOURCE, OKX_SOURCE, DEEPCOIN_SOURCE]) {
    assert.equal(dayOffsetSeconds(1440, src), 28800, src);
    assert.equal(dayOffsetSeconds(240, src), 0, src);
    assert.equal(dayOffsetSeconds(60, src), 0, src);
  }
  assert.equal(dayOffsetSeconds(1440, YIELD_SOURCE), 0);

  // 2026-11-16 16:00:00 UTC = 1794844800 (1794844800 % 86400 === 57600)
  const dayStart = 1794844800;
  const prevDayStart = dayStart - 86400;
  assert.equal(dayStart % 86400, 57600);
  assert.equal(barOpen(dayStart - 1, 1440, BINANCE_SOURCE), prevDayStart); // 15:59:59 UTC -> previous day
  assert.equal(barOpen(dayStart, 1440, BINANCE_SOURCE), dayStart);         // 16:00:00 UTC -> new day
  assert.equal(barOpen(dayStart + 3600, 1440, OKX_SOURCE), dayStart);
  assert.equal(barOpen(dayStart + 86399, 1440, DEEPCOIN_SOURCE), dayStart);

  // Non-1D crypto and US yields stay UTC-aligned
  assert.equal(barOpen(dayStart + 3600, 240, BINANCE_SOURCE), dayStart);
  assert.equal(barOpen(dayStart - 1, 240, BINANCE_SOURCE), dayStart - 14400);
  assert.equal(barOpen(dayStart, 1440, YIELD_SOURCE), Math.floor(dayStart / 86400) * 86400);

  // Under dayBoundary === 'utc', crypto 1D also aligns to UTC 00:00 and requests revert to UTC bars
  assert.equal(dayOffsetSeconds(1440, BINANCE_SOURCE, DAY_BOUNDARY_UTC), 0);
  assert.equal(barOpen(dayStart, 1440, BINANCE_SOURCE, DAY_BOUNDARY_UTC), Math.floor(dayStart / 86400) * 86400);
  assert.deepEqual(candleRequest(OKX_SOURCE, '1D', DAY_BOUNDARY_UTC), { interval: '1Dutc', aggregate: 1 });
  assert.deepEqual(candleRequest(DEEPCOIN_SOURCE, '1D', DAY_BOUNDARY_UTC), { interval: '4H', aggregate: 1440, scale: 6 });
});

test('restoreDayBoundary defaults to utc8 and recovers from invalid saved values', () => {
  assert.equal(DAY_BOUNDARY_KEY, 'jesse.market.dayBoundary.v1');
  assert.equal(DEFAULT_DAY_BOUNDARY, DAY_BOUNDARY_UTC8);
  assert.equal(restoreDayBoundary('utc'), DAY_BOUNDARY_UTC);
  assert.equal(restoreDayBoundary('"utc"'), DAY_BOUNDARY_UTC);
  assert.equal(restoreDayBoundary('utc8'), DAY_BOUNDARY_UTC8);
  for (const bad of [null, undefined, '', 'garbage', '123', '{}']) {
    assert.equal(restoreDayBoundary(bad), DAY_BOUNDARY_UTC8, String(bad));
  }
});
