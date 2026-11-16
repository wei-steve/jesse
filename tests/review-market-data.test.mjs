import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol, klinesUrl, endTimeBefore, parseKlines, mergeCandles, parseMiniTicker,
  miniTickerStreamUrl, restoreWatchlist, addToWatchlist, removeFromWatchlist, restoreTimeframes,
  orderTimeframes, shiftLogical, DEFAULT_WATCHLIST, DEFAULT_TIMEFRAMES, KLINE_LIMIT, MAX_BARS,
  MAX_WATCHLIST } from '../jesse/static/review/market-data.mjs';
import { chartHeightOf, CHART_HEIGHTS, DEFAULT_CHART_HEIGHT, CHART_HEIGHT_KEY } from '../jesse/static/review/finder-data.mjs';

// --- Symbol normalization -----------------------------------------------------------------------------------------

test('a symbol typed any sensible way becomes the exchange pair', () => {
  for (const typed of ['btc', 'BTC', 'BTCUSDT', 'btcusdt', 'BTC-USDT', 'btc/usdt', ' btc_usdt ', 'Btc-Usdt']) {
    assert.equal(normalizeSymbol(typed), 'BTCUSDT', typed);
  }
  // A base alone gets the quote currency; digits are part of real base names.
  assert.equal(normalizeSymbol('1000pepe'), '1000PEPEUSDT');
  assert.equal(normalizeSymbol('ETH-USDT'), 'ETHUSDT');
});

test('what cannot be a USDT perpetual gives an empty symbol', () => {
  for (const typed of ['', '   ', null, undefined, 'usdt', '-', '///', 'a']) {
    assert.equal(normalizeSymbol(typed), '', String(typed));
  }
});

// --- Request URLs -------------------------------------------------------------------------------------------------

test('the klines URL carries the pair, the Binance interval and the page size', () => {
  assert.equal(klinesUrl('BTCUSDT', '15m'),
    'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=1000');
  assert.equal(klinesUrl('btc', '1h', { limit: 500 }),
    'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=500');
  // Binance writes the daily interval in lower case; the finder / review label is 1D.
  assert.equal(klinesUrl('BTC-USDT', '1D'), 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=1000');
  assert.equal(KLINE_LIMIT, 1000);
});

test('the page before the oldest bar ends one millisecond before it', () => {
  const earliest = 1763199960; // 2026-11-15 08:26:00 UTC
  assert.equal(endTimeBefore(earliest), 1763199959999);
  // The REST filter is inclusive: asking for exactly that open time would return the bar we already have again.
  assert.ok(klinesUrl('BTCUSDT', '4h', { endTime: endTimeBefore(earliest) }).endsWith('&endTime=1763199959999'));
  assert.ok(!klinesUrl('BTCUSDT', '4h').includes('endTime'));
});

// --- REST rows -> candles -----------------------------------------------------------------------------------------

// Binance's row: open time (ms), OHLCV as strings, close time (ms), then fields this page ignores.
const row = (openTime, [o, h, l, c], v = '12.5', closeTime = openTime + 899999) =>
  [openTime, String(o), String(h), String(l), String(c), String(v), closeTime, '0', 40, '0', '0', '0'];
const NOW = 1763201000000; // 2026-11-15 08:43:20 UTC

test('a REST row becomes a candle in UTC seconds', () => {
  const rows = [row(1763199900000, [64000.1, 64020, 63999.9, 64010.5])];
  const { closed, forming } = parseKlines(rows, NOW);
  assert.deepEqual(closed, [{ time: 1763199900, open: 64000.1, high: 64020, low: 63999.9, close: 64010.5, volume: 12.5 }]);
  assert.equal(forming, null);
});

test('the bar the exchange is still building is split off, not counted as closed', () => {
  const rows = [row(1763199900000, [64000.1, 64020, 63999.9, 64010.5]),
    row(1763200800000, [64010.5, 64030, 64005, 64022], '3.25', 1763201699999)];
  const { closed, forming } = parseKlines(rows, NOW);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].time, 1763199900);
  assert.deepEqual(forming, { time: 1763200800, open: 64010.5, high: 64030, low: 64005, close: 64022, volume: 3.25 });
  // Once its close time has passed, the same row is closed data.
  assert.equal(parseKlines(rows, 1763201700000).forming, null);
  assert.equal(parseKlines(rows, 1763201700000).closed.length, 2);
});

test('rows that are not a sane bar are dropped instead of drawn', () => {
  const rows = [row(1763189100000, [64000.1, 64020, 63999.9, 64010.5]),
    null, [], [1, 2, 3],
    [1763188200000, 'x', '1', '1', '1', '1', 1763189099999],
    row(1763190000000, [64010, 64000, 64020, 64005]), // high below the open
    row(1763190900000, [64010, 64020, 64005, 64015], '-2')];
  const { closed } = parseKlines(rows, NOW);
  assert.deepEqual(closed.map(candle => candle.time), [1763189100, 1763190900]);
  assert.equal(closed[1].volume, 0, 'a negative volume is written as 0, not as a made-up number');
  assert.deepEqual(parseKlines(null, NOW), { closed: [], forming: null });
});

// --- Merging pages ------------------------------------------------------------------------------------------------

const candle = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });

test('history pages and the newest bars merge into one sorted, duplicate-free series', () => {
  const older = [candle(300, 3), candle(100, 1), candle(200, 2)];
  const newer = [candle(200, 22), candle(400, 4), candle(400, 44)];
  assert.deepEqual(mergeCandles(older, newer).map(c => [c.time, c.close]),
    [[100, 1], [200, 22], [300, 3], [400, 44]]);
  // The same bar from both pages keeps the later (fresher) copy.
  assert.deepEqual(mergeCandles(newer, older).find(c => c.time === 200), candle(200, 2));
  assert.deepEqual(mergeCandles(), []);
});

// --- Watchlist quotes ---------------------------------------------------------------------------------------------

test('a miniTicker message gives the last price and the 24-hour change', () => {
  const message = { stream: 'btcusdt@miniTicker',
    data: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '64100.0', o: '63000.0', h: '64300', l: '62900', v: '1234' } };
  const quote = parseMiniTicker(message);
  assert.deepEqual(quote, { symbol: 'BTCUSDT', price: 64100, change: (64100 - 63000) / 63000 });
  assert.ok(quote.change > 0);
  // A fall is a negative change; the plain (unwrapped) event works the same way.
  assert.deepEqual(parseMiniTicker({ e: '24hrMiniTicker', s: 'ETHUSDT', c: '2000', o: '2500' }),
    { symbol: 'ETHUSDT', price: 2000, change: -0.2 });
  // No open price means no change, never a divide by zero.
  assert.equal(parseMiniTicker({ s: 'SOLUSDT', c: '150', o: '0' }).change, null);
  for (const bad of [null, {}, { s: 'BTCUSDT', c: '0' }, { s: 'BTCUSDT', c: 'abc', o: '1' }, { c: '10', o: '9' }]) {
    assert.equal(parseMiniTicker(bad), null);
  }
});

test('one combined stream for the whole watchlist', () => {
  assert.equal(miniTickerStreamUrl(['BTCUSDT', 'ethusdt', 'BTC-USDT']),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker');
  assert.equal(miniTickerStreamUrl([]), null);
  assert.equal(miniTickerStreamUrl(['---']), null);
});

// --- Saved choices ------------------------------------------------------------------------------------------------

test('the watchlist survives a reload, and a broken value falls back to the default list', () => {
  assert.deepEqual(restoreWatchlist(JSON.stringify(['btc', 'ETH-USDT'])), ['BTCUSDT', 'ETHUSDT']);
  for (const broken of [null, undefined, '', 'not json', '{}', '[]', '["", null]']) {
    assert.deepEqual(restoreWatchlist(broken), DEFAULT_WATCHLIST, String(broken));
  }
  assert.deepEqual(DEFAULT_WATCHLIST.slice(0, 3), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  // Duplicates and junk collapse, and the list stays bounded.
  assert.deepEqual(restoreWatchlist(JSON.stringify(['BTCUSDT', 'BTCUSDT', 'x!', 'SOLUSDT'])), ['BTCUSDT', 'SOLUSDT']);
  const many = Array.from({ length: MAX_WATCHLIST + 5 }, (_, i) => `C${String(i).padStart(2, '0')}`);
  assert.equal(restoreWatchlist(JSON.stringify(many)).length, MAX_WATCHLIST);
});

test('adding and removing coins keeps the list clean', () => {
  const list = ['BTCUSDT'];
  assert.deepEqual(addToWatchlist(list, 'eth-usdt'), ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(addToWatchlist(list, 'BTCUSDT'), ['BTCUSDT'], 'no duplicates');
  assert.deepEqual(addToWatchlist(list, '???'), ['BTCUSDT'], 'nothing to add');
  assert.deepEqual(removeFromWatchlist(['BTCUSDT', 'ETHUSDT'], 'btc'), ['ETHUSDT']);
  assert.deepEqual(removeFromWatchlist(['BTCUSDT'], 'ETHUSDT'), ['BTCUSDT']);
  assert.deepEqual(addToWatchlist([], 'sol'), ['SOLUSDT']);
});

test('the checked timeframes survive a reload, in ascending order', () => {
  assert.deepEqual(restoreTimeframes(JSON.stringify(['15m', '4h', '1D'])), ['15m', '4h', '1D']);
  assert.deepEqual(restoreTimeframes(JSON.stringify(['1h', 'nonsense', '1h', '5m'])), ['5m', '1h']);
  for (const broken of [null, '', 'oops', '{}', '[]', '["45m","3h"]']) {
    assert.deepEqual(restoreTimeframes(broken), DEFAULT_TIMEFRAMES, String(broken));
  }
  assert.deepEqual(DEFAULT_TIMEFRAMES, ['4h', '1h', '15m', '5m']);
  assert.deepEqual(orderTimeframes(['1D', '1m', '1h']), ['1m', '1h', '1D']);
});

test('a chart window moves right by the bars that were prepended', () => {
  assert.deepEqual(shiftLogical({ from: 50, to: 230 }, 1000), { from: 1050, to: 1230 });
  assert.deepEqual(shiftLogical({ from: 10, to: 20 }, 0), { from: 10, to: 20 });
  assert.equal(shiftLogical(null, 1000), null);
});

test('the chart height is shared with the finder and only offered values count', () => {
  assert.equal(CHART_HEIGHT_KEY, 'jesse.finder.chartHeight.v2');
  assert.deepEqual(CHART_HEIGHTS[0], [0, '适应屏幕']);
  assert.equal(chartHeightOf('360'), 360);
  assert.equal(chartHeightOf(0), 0);
  for (const raw of [null, undefined, '', 'abc', '999']) assert.equal(chartHeightOf(raw), DEFAULT_CHART_HEIGHT);
});

test('the market page keeps at most 5000 bars per timeframe', () => {
  assert.equal(MAX_BARS, 5000);
  assert.ok(KLINE_LIMIT < MAX_BARS);
});
