import test from 'node:test';
import assert from 'node:assert/strict';
import { klinesUrl, endTimeBefore, parseKlines, mergeCandles, parseMiniTicker,
  miniTickerStreamUrl, restoreWatchlist, addToWatchlist, removeFromWatchlist, restoreTimeframes,
  orderTimeframes, shiftLogical, spotKlinesUrl, klinesUrlFor, okxCandlesUrl, tickersUrlFor, watchItem, watchKey,
  withDefaultYields, restoreSelection, defaultSymbolFor, restoreAsideTab, restoreListMarket, parseOkxCandles,
  aggregateAnswer, tickerRows, proxyTickerRows, orderProducts, filterProducts, pageSizeOf, sameWatchItem, OKX_LIMIT,
  OKX_HISTORY_LIMIT,
  PRODUCT_PAGE, DEFAULT_WATCHLIST, DEFAULT_TIMEFRAMES, KLINE_LIMIT, MAX_BARS, MAX_WATCHLIST, MARKET_KEYS } from
  '../jesse/static/review/market-data.mjs';
import { DEFAULT_YIELD_SYMBOLS, normalizeSymbol } from '../jesse/static/review/market-sources.mjs';
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

test('the spot market asks the spot host, and the proxied sources have no exchange URL at all', () => {
  assert.equal(spotKlinesUrl('BTCUSDT', '15m'),
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000');
  assert.equal(klinesUrlFor('binance', 'spot', 'eth-usdt', '1h', { limit: 500 }),
    'https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1h&limit=500');
  assert.equal(klinesUrlFor('binance', 'swap', 'BTCUSDT', '4h'), klinesUrl('BTCUSDT', '4h'));
  // The rest of a page request is the same on both markets, `endTime` included.
  assert.ok(klinesUrlFor('binance', 'spot', 'BTCUSDT', '1h', { endTime: 1763199959999 }).endsWith('&endTime=1763199959999'));
  // The yields and Deepcoin come from Jesse; OKX is its own envelope (below).
  assert.equal(klinesUrlFor('us-yields', null, 'US10Y', '1h'), null);
  assert.equal(klinesUrlFor('deepcoin', 'swap', 'BTC-USDT-SWAP', '1h'), null);
});

test('the OKX candles URL uses the venue bar spelling and pages history by `after`', () => {
  assert.equal(okxCandlesUrl('BTC-USDT-SWAP', '15m'),
    'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=300');
  // 1h -> 1H and 1D -> 1Dutc: the venue's own spelling, and the UTC day bar.
  assert.equal(okxCandlesUrl('BTC-USDT', '1h'),
    'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=300');
  assert.equal(okxCandlesUrl('BTC-USDT', '1D'),
    'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1Dutc&limit=300');
  // An older page comes from history-candles, which is capped at 100 rows and takes the open time in milliseconds.
  assert.equal(okxCandlesUrl('BTC-USDT-SWAP', '15m', { limit: 300, before: 1763199960 }),
    'https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=15m&limit=100&after=1763199960000');
  assert.equal(OKX_LIMIT, 300);
  assert.equal(OKX_HISTORY_LIMIT, 100);
  assert.equal(pageSizeOf('binance'), 1000);
  assert.equal(pageSizeOf('okx'), 300);
});

test('the product list asks each venue for the tickers of the market on screen', () => {
  assert.equal(tickersUrlFor('binance', 'swap'), 'https://fapi.binance.com/fapi/v1/ticker/24hr');
  assert.equal(tickersUrlFor('binance', 'spot'), 'https://api.binance.com/api/v3/ticker/24hr');
  assert.equal(tickersUrlFor('okx', 'swap'), 'https://www.okx.com/api/v5/market/tickers?instType=SWAP');
  assert.equal(tickersUrlFor('okx', 'spot'), 'https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  // Deepcoin goes through Jesse's proxy, and the yields are a fixed list of six.
  assert.equal(tickersUrlFor('deepcoin', 'swap'), null);
  assert.equal(tickersUrlFor('us-yields', null), null);
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

// OKX's row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
const okxRow = (openTime, [o, h, l, c], confirm = '1', v = '10') =>
  [String(openTime), String(o), String(h), String(l), String(c), v, '1', '1', confirm];

test('OKX\'s newest-first answer is reversed and its unconfirmed bar is the forming one', () => {
  // 15m bars: 06:00 (confirmed) and 06:15 (still forming).
  const closedRow = okxRow(1763195400000, [64000, 64020, 63990, 64010]);
  const formingRow = okxRow(1763196300000, [64010, 64030, 64005, 64022], '0', '3.5');
  const answer = { code: '0', data: [formingRow, closedRow] };
  const { closed, forming } = parseOkxCandles(answer);
  assert.deepEqual(closed, [{ time: 1763195400, open: 64000, high: 64020, low: 63990, close: 64010, volume: 10 }]);
  assert.deepEqual(forming, { time: 1763196300, open: 64010, high: 64030, low: 64005, close: 64022, volume: 3.5 });
  // The same rows once the newest one is confirmed: both are closed data, nothing is forming.
  const done = parseOkxCandles({ code: '0', data: [okxRow(1763196300000, [64010, 64030, 64005, 64022]),
    closedRow] });
  assert.deepEqual(done.closed.map(candle => candle.time), [1763195400, 1763196300]);
  assert.equal(done.forming, null);
});

test('an OKX error answer or a broken row draws nothing', () => {
  assert.deepEqual(parseOkxCandles({ code: '51000', msg: 'Parameter bar error', data: [] }), { closed: [], forming: null });
  for (const broken of [null, {}, { data: null }, { code: '0', data: [{}] }, { code: '0', data: [['x']] },
    { code: '0', data: [okxRow(0, [1, 1, 1, 1])] }, { code: '0', data: [okxRow(1763195400000, [10, 1, 1, 1])] }]) {
    assert.deepEqual(parseOkxCandles(broken), { closed: [], forming: null }, JSON.stringify(broken));
  }
});

test('a bucketed Deepcoin 3m panel keeps the half-built bucket as the forming bar', () => {
  // 1m bars 06:00 … 06:04, plus the 1m bar the venue is still building at 06:05: the 06:03 bucket (three minutes) is
  // the forming 3m bar and everything before it is closed.
  const bars = [0, 60, 120, 180, 240].map(offset => ({ time: 1763195400 + offset, open: 64000 + offset, high: 64010 + offset,
    low: 63990 + offset, close: 64005 + offset, volume: 1 }));
  const forming = { time: 1763195400 + 300, open: 64300, high: 64310, low: 64290, close: 64305, volume: 1 };
  const answer = aggregateAnswer(bars, forming, 3);
  assert.deepEqual(answer.closed.map(bar => bar.time), [1763195400]);
  // The forming bucket holds its two closed 1m bars and the bar still being built: open of the first, close of the
  // last, the extremes of all three.
  assert.deepEqual(answer.forming, { time: 1763195580, open: 64180, high: 64310, low: 64170, close: 64305, volume: 3 });
  // Without a forming bar nothing is half-built: the last full bucket is closed data.
  const plain = aggregateAnswer(bars, null, 3);
  assert.deepEqual(plain.closed.map(bar => bar.time), [1763195400, 1763195580]);
  assert.equal(plain.forming, null);
  // minutes = 1 is a pass-through (the venue had the bar already).
  assert.deepEqual(aggregateAnswer(bars, forming, 1), { closed: bars, forming });
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

// --- Product list -------------------------------------------------------------------------------------------------

const BINANCE_TICKERS = [
  { symbol: 'BTCUSDT', lastPrice: '64100.0', openPrice: '63000.0', quoteVolume: '9000' },
  { symbol: 'ETHUSDT', lastPrice: '2000', openPrice: '2500', quoteVolume: '90000' },
  { symbol: 'BTCUSDC', lastPrice: '64100', openPrice: '63000', quoteVolume: '999999' },
  { symbol: 'ETHBTC', lastPrice: '0.03', openPrice: '0.04', quoteVolume: '500000' },
  { symbol: 'SOLUSDT', lastPrice: '0', openPrice: '1', quoteVolume: '1' },
  null,
];

test('Binance\'s ticker array becomes the product list: USDT only, biggest turnover first', () => {
  const rows = tickerRows('binance', 'swap', BINANCE_TICKERS);
  assert.deepEqual(rows.map(row => row.symbol), ['ETHUSDT', 'BTCUSDT']);
  assert.equal(rows[1].last, 64100);
  assert.ok(Math.abs(rows[1].change - (64100 - 63000) / 63000) < 1e-9);
  assert.equal(rows[1].quoteVolume, 9000);
  // Anything not an array (an error object, null) is an empty list.
  for (const broken of [null, {}, 'x']) assert.deepEqual(tickerRows('binance', 'swap', broken), []);
});

test('OKX / Deepcoin tickers are filtered by market and carry volCcy24h as the turnover', () => {
  const payload = { code: '0', data: [
    { instId: 'BTC-USDT-SWAP', last: '64100', open24h: '63000', volCcy24h: '500' },
    { instId: 'ETH-USDT-SWAP', last: '2000', open24h: '2500', volCcy24h: '900' },
    { instId: 'BTC-USDT', last: '64100', open24h: '63000', volCcy24h: '100000' },
    { instId: 'BTC-USD-SWAP', last: '64100', open24h: '63000', volCcy24h: '1' },
    { instId: 'BTC-USDC-SWAP', last: '64100', open24h: '63000', volCcy24h: '2' },
    { instId: 'ETH-USDT-SWAP', last: '0', open24h: '1', volCcy24h: '3' },
  ] };
  const swap = tickerRows('okx', 'swap', payload);
  assert.deepEqual(swap.map(row => row.symbol), ['ETH-USDT-SWAP', 'BTC-USDT-SWAP']);
  assert.ok(Math.abs(swap[0].change + 0.2) < 1e-9, '2000 from an open of 2500 is -20%');
  const spot = tickerRows('deepcoin', 'spot', payload);
  assert.deepEqual(spot.map(row => row.symbol), ['BTC-USDT']);
  // Deepcoin's answer goes through Jesse, which already sends the row shape the list draws.
  assert.deepEqual(proxyTickerRows({ tickers: [
    { symbol: 'BTC-USDT-SWAP', last: 64100, open24h: 63000, quoteVolume24h: 500 },
    { symbol: 'ETH-USDT-SWAP', last: 2000, open24h: 2500, quoteVolume24h: 900 },
  ] }).map(row => row.symbol), ['ETH-USDT-SWAP', 'BTC-USDT-SWAP']);
  assert.deepEqual(proxyTickerRows(null), []);
});

test('the list is ordered by turnover and searched over the whole list', () => {
  const rows = orderProducts([
    { symbol: 'AAAUSDT', quoteVolume: 10 }, { symbol: 'BTCUSDT', quoteVolume: 30 }, { symbol: 'ETHUSDT', quoteVolume: 30 }]);
  assert.deepEqual(rows.map(row => row.symbol), ['BTCUSDT', 'ETHUSDT', 'AAAUSDT']);
  const list = [{ symbol: 'SOLUSDT' }, { symbol: 'SOL-USDT-SWAP' }, { symbol: 'BTCUSDT' }, { symbol: 'SOLA-USDT' }];
  // `sol` finds the rows whose name contains it, whatever the spelling; a dash / space is not significant.
  assert.deepEqual(filterProducts(list, 'sol').map(row => row.symbol), ['SOLUSDT', 'SOL-USDT-SWAP', 'SOLA-USDT']);
  assert.deepEqual(filterProducts(list, 'sol-usdt').map(row => row.symbol), ['SOLUSDT', 'SOL-USDT-SWAP']);
  assert.deepEqual(filterProducts(list, 'bTc').map(row => row.symbol), ['BTCUSDT']);
  assert.equal(filterProducts(list, '  ').length, list.length, 'an empty query keeps the whole list');
  assert.deepEqual(filterProducts(null, 'sol'), []);
  assert.equal(PRODUCT_PAGE, 200);
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

test('a watchlist row keeps its source and market, and the old shapes migrate', () => {
  assert.deepEqual(watchItem({ source: 'binance', market: 'spot', symbol: 'btc' }),
    { source: 'binance', market: 'spot', symbol: 'BTCUSDT' });
  assert.deepEqual(watchItem({ source: 'okx', market: 'swap', symbol: 'btc-usdt' }),
    { source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' });
  assert.deepEqual(watchItem({ source: 'deepcoin', market: 'spot', symbol: 'BTC-USDT-SWAP' }),
    { source: 'deepcoin', market: 'spot', symbol: 'BTC-USDT' });
  assert.deepEqual(watchItem({ source: 'us-yields', symbol: 'us10y' }),
    { source: 'us-yields', market: null, symbol: 'US10Y' });
  // Pre-T-54 rows named the venue; a row without a market takes the source's first.
  assert.deepEqual(watchItem({ source: 'binance-perp', symbol: 'ETHUSDT' }),
    { source: 'binance', market: 'swap', symbol: 'ETHUSDT' });
  assert.deepEqual(watchItem({ source: 'binance-spot', symbol: 'ETHUSDT' }),
    { source: 'binance', market: 'spot', symbol: 'ETHUSDT' });
  assert.deepEqual(watchItem({ source: 'okx', symbol: 'BTC-USDT-SWAP' }),
    { source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' });
  // A bare string is the pre-T-53 format: one source, Binance perpetual.
  assert.deepEqual(watchItem('btc'), { source: 'binance', market: 'swap', symbol: 'BTCUSDT' });
  for (const broken of [null, 42, {}, { source: 'nonsense', symbol: 'BTCUSDT' }, { source: 'okx', symbol: '---' },
    { source: 'us-yields', symbol: 'US07Y' }]) {
    assert.equal(watchItem(broken), null, JSON.stringify(broken));
  }
  assert.equal(sameWatchItem(watchItem({ source: 'binance-spot', symbol: 'btc' }),
    { source: 'binance', market: 'spot', symbol: 'BTCUSDT' }), true);
});

test('the watchlist survives a reload, and a broken value falls back to the default list', () => {
  // Strings are the pre-T-53 format (one source existed then): they migrate to Binance perpetual futures.
  assert.deepEqual(restoreWatchlist(JSON.stringify(['btc', 'ETH-USDT'])),
    [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }, { source: 'binance', market: 'swap', symbol: 'ETHUSDT' }]);
  for (const broken of [null, undefined, '', 'not json', '{}', '[]', '["", null]']) {
    assert.deepEqual(restoreWatchlist(broken), DEFAULT_WATCHLIST, String(broken));
  }
  assert.deepEqual(DEFAULT_WATCHLIST.slice(0, 3), [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' },
    { source: 'binance', market: 'swap', symbol: 'ETHUSDT' }, { source: 'binance', market: 'swap', symbol: 'SOLUSDT' }]);
  // Duplicates and junk collapse, and the list stays bounded. The same pair on another market / venue is another row.
  assert.deepEqual(restoreWatchlist(JSON.stringify(['BTCUSDT', 'BTCUSDT', 'x!', 'SOLUSDT'])),
    [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }, { source: 'binance', market: 'swap', symbol: 'SOLUSDT' }]);
  assert.deepEqual(restoreWatchlist(JSON.stringify([
    { source: 'binance-perp', symbol: 'btc' }, { source: 'binance-spot', symbol: 'BTCUSDT' },
    { source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' }, { source: 'us-yields', symbol: 'us10y' },
    { source: 'nonsense', symbol: 'BTCUSDT' }, { source: 'us-yields', symbol: 'US07Y' }, null, 42])),
  [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }, { source: 'binance', market: 'spot', symbol: 'BTCUSDT' },
    { source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' }, { source: 'us-yields', market: null, symbol: 'US10Y' }]);
  const many = Array.from({ length: MAX_WATCHLIST + 5 }, (_, i) => `C${String(i).padStart(2, '0')}`);
  assert.equal(restoreWatchlist(JSON.stringify(many)).length, MAX_WATCHLIST);
});

test('adding and removing rows keeps the list clean and each row keeps its source and market', () => {
  const list = [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }];
  assert.deepEqual(addToWatchlist(list, 'eth-usdt'),
    [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }, { source: 'binance', market: 'swap', symbol: 'ETHUSDT' }]);
  assert.deepEqual(addToWatchlist(list, 'BTCUSDT'), list, 'no duplicates');
  assert.deepEqual(addToWatchlist(list, '???'), list, 'nothing to add');
  // The same pair on spot is another row, and clicking it must not touch the perpetual one. This is also what the
  // product list's ☆ does: one click adds that row, the next removes exactly it.
  assert.deepEqual(addToWatchlist(list, { source: 'binance', market: 'spot', symbol: 'btc' }),
    [...list, { source: 'binance', market: 'spot', symbol: 'BTCUSDT' }]);
  const both = [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' },
    { source: 'binance', market: 'spot', symbol: 'BTCUSDT' }];
  assert.deepEqual(removeFromWatchlist(both, { source: 'binance', market: 'spot', symbol: 'BTCUSDT' }),
    [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }]);
  assert.deepEqual(removeFromWatchlist([{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }], 'ETHUSDT'),
    [{ source: 'binance', market: 'swap', symbol: 'BTCUSDT' }]);
  assert.deepEqual(addToWatchlist([], 'sol'), [{ source: 'binance', market: 'swap', symbol: 'SOLUSDT' }]);
  // An OKX row is added with the instId of the market it came from, a yield row with its code.
  assert.deepEqual(addToWatchlist([], { source: 'okx', market: 'spot', symbol: 'sol' }),
    [{ source: 'okx', market: 'spot', symbol: 'SOL-USDT' }]);
  assert.deepEqual(addToWatchlist([], { source: 'us-yields', symbol: '10y' }),
    [{ source: 'us-yields', market: null, symbol: 'US10Y' }]);
});

test('the four default yields are seeded once and never resurrected', () => {
  const list = withDefaultYields(DEFAULT_WATCHLIST);
  assert.deepEqual(list.slice(-4), DEFAULT_YIELD_SYMBOLS.map(symbol => ({ source: 'us-yields', market: null, symbol })));
  assert.equal(list.length, DEFAULT_WATCHLIST.length + 4);
  // Already there: the list is unchanged (so the page can call this on every load without duplicating rows).
  assert.deepEqual(withDefaultYields(list), list);
  // Deleted by the owner: only the flag keeps them deleted, the list itself stays as it is.
  assert.deepEqual(withDefaultYields(removeFromWatchlist(list, { source: 'us-yields', symbol: 'US10Y' }))
    .filter(item => item.symbol === 'US10Y'), [{ source: 'us-yields', market: null, symbol: 'US10Y' }]);
});

test('the last chart restores as source + market + symbol, and the older shapes still open', () => {
  assert.deepEqual(restoreSelection(JSON.stringify({ source: 'okx', market: 'spot', symbol: 'ETH-USDT' })),
    { source: 'okx', market: 'spot', symbol: 'ETH-USDT' });
  assert.deepEqual(restoreSelection(JSON.stringify({ source: 'us-yields', symbol: 'US10Y' })),
    { source: 'us-yields', market: null, symbol: 'US10Y' });
  // The pre-T-53 value was the plain pair string, the pre-T-54 one named the venue.
  assert.deepEqual(restoreSelection('BTCUSDT'), { source: 'binance', market: 'swap', symbol: 'BTCUSDT' });
  assert.deepEqual(restoreSelection(JSON.stringify({ source: 'binance-spot', symbol: 'ETHUSDT' })),
    { source: 'binance', market: 'spot', symbol: 'ETHUSDT' });
  assert.deepEqual(restoreSelection(JSON.stringify('eth-usdt')), { source: 'binance', market: 'swap', symbol: 'ETHUSDT' });
  for (const broken of [null, '', '-', '{}', JSON.stringify({ source: 'nope', symbol: 'BTCUSDT' })]) {
    assert.deepEqual(restoreSelection(broken), { source: 'binance', market: 'swap', symbol: 'BTCUSDT' }, String(broken));
  }
  assert.equal(defaultSymbolFor('okx', 'swap'), 'BTC-USDT-SWAP');
  assert.equal(defaultSymbolFor('okx', 'spot'), 'BTC-USDT');
  assert.equal(defaultSymbolFor('us-yields'), 'US10Y');
  assert.equal(defaultSymbolFor('binance-spot', 'spot'), 'BTCUSDT');
});

test('the left column remembers which tab was open, and the product list its market', () => {
  assert.equal(MARKET_KEYS.aside, 'jesse.market.asidetab.v1');
  assert.equal(restoreAsideTab('products'), 'products');
  for (const broken of [null, '', 'watch', 'nonsense']) assert.equal(restoreAsideTab(broken), 'watch', String(broken));
  assert.equal(restoreListMarket('spot'), 'spot');
  assert.equal(restoreListMarket('swap'), 'swap');
  for (const broken of [null, '', 'nonsense']) assert.equal(restoreListMarket(broken), null, String(broken));
});

test('a quote stream is asked of the venue the row belongs to', () => {
  assert.equal(miniTickerStreamUrl(['BTCUSDT'], 'Binance Spot'),
    'wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker');
  assert.equal(miniTickerStreamUrl(['BTCUSDT'], 'Binance Perpetual Futures'),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@miniTicker');
  assert.equal(miniTickerStreamUrl(['BTCUSDT'], 'Bybit'), null);
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
