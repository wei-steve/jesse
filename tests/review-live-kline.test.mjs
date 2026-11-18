import test from 'node:test';
import assert from 'node:assert/strict';
import { klineStreamUrl, klineInterval, klineCandle, okxCandleChannel, okxCandleChannels, okxCandle,
  okxTickerQuote, okxTickerPrice, deepcoinSubscription, deepcoinWsFilter, deepcoinTickerPrice } from
  '../jesse/static/review/live-price.mjs';
import { calculateIndicator, formingTail, tailBars } from '../jesse/static/review/indicators.mjs';
import { validateIndicator, defaultMaLines, MA_LINE_COUNT } from '../jesse/static/review/settings.mjs';

const FUTURES = 'Binance Perpetual Futures';
const SPOT = 'Binance Spot';
const closeEnough = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, message ?? `${a} differs from ${b}`);

// --- kline stream URL ---------------------------------------------------------------------------------------------

test('one combined kline stream for every timeframe the exchange supports', () => {
  assert.equal(klineStreamUrl(FUTURES, 'BTC-USDT', ['3m', '1h', '1D']),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_3m/btcusdt@kline_1h/btcusdt@kline_1d');
  assert.equal(klineStreamUrl(SPOT, 'eth-usdt', ['5m']),
    'wss://stream.binance.com:9443/stream?streams=ethusdt@kline_5m');
});

test('timeframes without a Binance stream are left out of the subscription', () => {
  // 45m / 3h are the finder's own choices (they have candles in the database) but Binance pushes no kline for them.
  assert.equal(klineStreamUrl(FUTURES, 'BTC-USDT', ['45m', '3m']),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_3m');
  assert.equal(klineStreamUrl(FUTURES, 'BTC-USDT', ['45m', '3h']), null);
  assert.equal(klineStreamUrl(FUTURES, 'BTC-USDT', []), null);
  assert.equal(klineStreamUrl(FUTURES, 'BTC-USDT', null), null);
  // Duplicates (and the same timeframe written both ways) collapse to one stream.
  assert.equal(klineStreamUrl(FUTURES, 'BTC-USDT', ['1D', '1d', '1440' /* not a label */]),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1d');
});

test('an exchange or symbol without a public stream has no kline URL', () => {
  assert.equal(klineStreamUrl('Deepcoin', 'BTC-USDT', ['1m']), null);
  assert.equal(klineStreamUrl(FUTURES, '', ['1m']), null);
  assert.equal(klineStreamUrl(FUTURES, '---', ['1m']), null);
});

test('klineInterval maps the finder labels onto Binance interval names', () => {
  assert.equal(klineInterval('1D'), '1d');
  assert.equal(klineInterval('1d'), '1d');
  assert.equal(klineInterval('4h'), '4h');
  assert.equal(klineInterval('45m'), null);
  assert.equal(klineInterval('1440'), null);
  assert.equal(klineInterval(undefined), null);
});

// --- kline message parsing ----------------------------------------------------------------------------------------

const klineMessage = (stream, k) => ({ stream, data: { e: 'kline', E: 1763200000000, k } });
const bar = (extra = {}) => ({ t: 1763199960000, T: 1763200019999, s: 'BTCUSDT', i: '3m',
  o: '64000.1', c: '64010.5', h: '64020.0', l: '63999.9', v: '12.5', n: 40, x: false, ...extra });

test('a kline message becomes the candle the chart draws (seconds, not milliseconds)', () => {
  assert.deepEqual(klineCandle(klineMessage('btcusdt@kline_3m', bar())),
    { tf: '3m', time: 1763199960, open: 64000.1, high: 64020, low: 63999.9, close: 64010.5, volume: 12.5, closed: false });
  assert.equal(klineCandle(klineMessage('btcusdt@kline_3m', bar({ x: true }))).closed, true);
  // Binance writes the daily interval as "1d"; the finder labels it "1D".
  assert.equal(klineCandle(klineMessage('btcusdt@kline_1d', bar({ i: '1d' }))).tf, '1D');
  assert.equal(klineCandle(klineMessage('btcusdt@kline_1h', bar({ i: '1h' }))).tf, '1h');
});

test('anything else in the socket is dropped, not turned into a candle', () => {
  assert.equal(klineCandle({ e: 'aggTrade', p: '64000' }), null);
  assert.equal(klineCandle(klineMessage('btcusdt@kline_45m', bar({ i: '45m' }))), null);
  assert.equal(klineCandle(klineMessage('btcusdt@kline_3m', bar({ c: 'abc' }))), null);
  assert.equal(klineCandle(klineMessage('btcusdt@kline_3m', bar({ o: '0' }))), null);
  assert.equal(klineCandle(klineMessage('btcusdt@kline_3m', bar({ t: 0 }))), null);
  assert.equal(klineCandle({ stream: 'btcusdt@kline_3m' }), null);
  assert.equal(klineCandle(null), null);
});

// --- the last indicator point of a forming bar -------------------------------------------------------------------

// 300 three-minute candles on a grid; the average of one period group is exact from a window of one period on.
const interval = 3;
const candles = Array.from({ length: 300 }, (_, i) => {
  const close = 100 + 10 * Math.sin(i / 7) + i * 0.1;
  return { time: 1763000000 - (1763000000 % 180) + i * interval * 60, open: close - 0.5, high: close + 1.5,
    low: close - 1.5, close, volume: 10 + i % 5 };
});
const forming = { time: candles.at(-1).time + interval * 60, open: 130, high: 133, low: 129, close: 131.5, volume: 3 };

const maGroup = (enabled, mode = 'SMA') => ({ type: 'MAGROUP', mode,
  lines: defaultMaLines().map(line => ({ ...line, enabled: enabled.includes(line.period) })) });

test('the forming tail equals the end of the full calculation for SMA and BOLL', () => {
  for (const config of [{ type: 'SMA', period: 20, color: '#dd9a23' }, { type: 'BOLL', period: 20, deviation: 2, color: '#5488c9' },
    maGroup([5, 20, 60])]) {
    const full = calculateIndicator([...candles, forming], config, interval);
    const tail = formingTail(candles, forming, config, interval);
    assert.equal(tail.length, full.series.length);
    assert.ok(tailBars(config) < candles.length);
    tail.forEach(({ point }, i) => {
      const expected = full.series[i].data.at(-1);
      assert.equal(point.time, expected.time, `series ${i} is at the forming bar`);
      assert.equal(point.time, forming.time);
      closeEnough(point.value, expected.value);
    });
  }
});

test('the tail reads only the last N closed bars, so a long history costs nothing', () => {
  const config = { type: 'SMA', period: 5, color: '#dd9a23' };
  const bars = tailBars(config);
  const short = candles.slice(-bars);
  const tail = formingTail(candles, forming, config, interval);
  const tailOfShort = formingTail(short, forming, config, interval);
  assert.deepEqual(tail.map(({ point }) => point), tailOfShort.map(({ point }) => point));
});

test('a forming bar that does not follow the last closed bar gets a point of its own, never a fake one', () => {
  const config = { type: 'SMA', period: 20, color: '#dd9a23' };
  const gapped = { ...forming, time: forming.time + interval * 60 * 5 };
  const [line] = formingTail(candles, gapped, config, interval);
  // The gap makes calculateIndicator start a new segment: one bar cannot fill a 20-bar window, so there is no value.
  assert.equal(line.point.time, gapped.time);
  assert.equal(line.point.value, undefined);
});

test('the tail does not touch the candles it is given', () => {
  const before = JSON.stringify(candles);
  formingTail(candles, forming, { type: 'EMA', period: 20, color: '#8b5dc8' }, interval);
  assert.equal(JSON.stringify(candles), before);
  assert.equal(candles.at(-1).time, forming.time - interval * 60);
});

test('tailBars always covers the slowest window of the configuration', () => {
  for (const config of [validateIndicator({ type: 'SMA', period: 500 }), validateIndicator({ type: 'ATR', period: 14 }),
    validateIndicator({ type: 'MACD', fast: 12, slow: 26, signal: 9 }), validateIndicator({ type: 'VOLUME' }),
    validateIndicator({ type: 'MAGROUP', mode: 'EMA', lines: defaultMaLines() })]) {
    const longest = config.type === 'MAGROUP' ? Math.max(...config.lines.filter(l => l.enabled).map(l => l.period))
      : config.type === 'MACD' ? config.slow : config.type === 'VOLUME' ? 1 : config.period;
    assert.ok(tailBars(config) >= longest * 3);
  }
});

test('an EMA tail converges on the full-history value instead of restarting at the window edge', () => {
  const config = { type: 'EMA', period: 20, color: '#8b5dc8' };
  const full = calculateIndicator([...candles, forming], config, interval).series[0].data.at(-1).value;
  const { point } = formingTail(candles, forming, config, interval)[0];
  // Seeded from the first bar of the tail window, so it is close but not bit-identical: 110 bars of a 20-period EMA
  // leave a difference of ~1e-4. SMA/BOLL above are exact.
  assert.ok(Math.abs(point.value - full) < 1e-3, `${point.value} differs from ${full}`);
  assert.equal(point.time, forming.time);
});

// --- OKX and Deepcoin sockets (T-54) -------------------------------------------------------------------------------

test('OKX subscribes with its own candle channels, upper-case hours and the UTC+8 day bar', () => {
  assert.equal(okxCandleChannel('1m'), 'candle1m');
  assert.equal(okxCandleChannel('1h'), 'candle1H');
  assert.equal(okxCandleChannel('4h'), 'candle4H');
  // Plain 1D opens at the venue's UTC+8 midnight (16:00 UTC).
  assert.equal(okxCandleChannel('1D'), 'candle1D');
  assert.equal(okxCandleChannel('45m'), null);
  assert.deepEqual(okxCandleChannels(['4h', '1h', '4h', '45m', '1m']), ['candle4H', 'candle1H', 'candle1m']);
  assert.deepEqual(okxCandleChannels(null), []);
});

test('an OKX candle push is a candle, with confirm=0 meaning the bar is still forming', () => {
  const forming = { arg: { channel: 'candle15m', instId: 'BTC-USDT-SWAP' },
    data: [['1763196300000', '64010', '64030', '64005', '64022', '3.5', '0.035', '2242', '0']] };
  assert.deepEqual(okxCandle(forming), { tf: '15m', time: 1763196300, open: 64010, high: 64030, low: 64005,
    close: 64022, volume: 3.5, closed: false });
  const closed = { arg: { channel: 'candle1H', instId: 'BTC-USDT-SWAP' },
    data: [['1763193600000', '63900', '64100', '63800', '64000', '120', '1.2', '768000', '1']] };
  assert.equal(okxCandle(closed).closed, true);
  assert.equal(okxCandle(closed).tf, '1h');
  // A subscription ack, another channel, a malformed row: nothing to draw.
  for (const message of [{ event: 'subscribe', arg: { channel: 'candle15m' } }, { arg: { channel: 'tickers' }, data: [] },
    { arg: { channel: 'candle15m' }, data: [] }, { arg: { channel: 'candle15m' }, data: [['x']] },
    { arg: { channel: 'candle15m' }, data: [['0', '1', '1', '1', '1', '1', '1', '1', '1']] }]) {
    assert.equal(okxCandle(message), null, JSON.stringify(message));
  }
});

test('an OKX ticker push is a price and a 24-hour change; Deepcoin sends a topic bus', () => {
  const ticker = { arg: { channel: 'tickers', instId: 'BTC-USDT' },
    data: [{ instId: 'BTC-USDT', last: '64100', open24h: '63000' }] };
  assert.deepEqual(okxTickerQuote(ticker), { symbol: 'BTC-USDT', price: 64100, change: (64100 - 63000) / 63000 });
  assert.equal(okxTickerPrice(ticker), 64100);
  assert.equal(okxTickerQuote({ arg: { channel: 'tickers', instId: 'BTC-USDT' }, data: [{ last: '0' }] }), null);
  assert.equal(okxTickerPrice({ arg: { channel: 'candle1m' }, data: [] }), null);

  // `BTC-USDT-SWAP` -> `DeepCoin_BTCUSDT`: the instrument code drops the quote and the perpetual suffix.
  assert.equal(deepcoinWsFilter('BTC-USDT-SWAP'), 'DeepCoin_BTCUSDT');
  assert.equal(deepcoinWsFilter('BTC-USDT'), 'DeepCoin_BTCUSDT');
  const frame = deepcoinSubscription('ETH-USDT-SWAP');
  assert.equal(frame.SendTopicAction.TopicID, '7');
  assert.equal(frame.SendTopicAction.Action, '1');
  assert.equal(frame.SendTopicAction.FilterValue, 'DeepCoin_ETHUSDT');
  // The ticker push carries the last price in `N`; the topic ack, the kline topic and a zero price are not prices.
  assert.equal(deepcoinTickerPrice({ a: 'PO', r: [{ d: { I: 'BTCUSDT', N: 64627.4, O: 64720.1 } }] }), 64627.4);
  for (const message of [{ a: 'RecvTopicAction', r: [{ d: { T: '7' } }] },
    { a: 'PK', r: [{ d: { I: 'BTCUSDT', P: '1m' } }] }, { a: 'PO', r: [{ d: { N: 'x' } }] },
    { a: 'PO', r: [{ d: { N: 0 } }] }, null]) {
    assert.equal(deepcoinTickerPrice(message), null, JSON.stringify(message));
  }
});

test('Binance Beijing daily kline streams use @+08:00 on spot and 8h on perpetual futures', () => {
  const spotUrl = klineStreamUrl('Binance Spot', 'BTCUSDT', ['4h', '1D'], { beijingDaily: true });
  assert.equal(spotUrl, 'wss://stream.binance.com:9443/stream?streams=btcusdt@kline_4h/btcusdt@kline_1d@+08:00');
  const swapUrl = klineStreamUrl('Binance Perpetual Futures', 'BTCUSDT', ['4h', '1D'], { beijingDaily: true });
  assert.equal(swapUrl, 'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_4h/btcusdt@kline_8h');
  // Without beijingDaily (finder), 1D stays @kline_1d.
  assert.equal(klineStreamUrl('Binance Spot', 'BTCUSDT', ['1D']),
    'wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1d');

  // klineCandle parses @kline_1d@+08:00 as tf: '1D'
  const msg = { stream: 'btcusdt@kline_1d@+08:00',
    data: { k: { t: 1794844800000, o: '64000', h: '65000', l: '63000', c: '64500', v: '123', x: false } } };
  assert.deepEqual(klineCandle(msg), {
    tf: '1D', time: 1794844800, open: 64000, high: 65000, low: 63000, close: 64500, volume: 123, closed: false,
  });
});
