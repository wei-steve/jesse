import test from 'node:test';
import assert from 'node:assert/strict';
import { BINANCE_SOURCE, DEEPCOIN_SOURCE, OKX_SOURCE, YIELD_SOURCE } from '../jesse/static/review/market-sources.mjs';
import { BAR_NOTE_COLOR } from '../jesse/static/review/labels.mjs';
import { BUY_MARKER_COLOR, FILLS_KEY, FILLS_NOT_CONFIGURED, SELL_MARKER_COLOR, bucketFills, configuredOf,
  fillAction, fillGroupText, fillGroupsText, fillMarkers, fillsBase, fillsInstrument, fillsRequest, mergeMarkers,
  parseFills } from '../jesse/static/review/market-fills.mjs';

// The owner's fills are private: every number here is invented, and the shape is the one the Jesse route returns
// (`{configured, fills}`), which is itself the venue's `data` row parsed down to what the chart draws.
const FILLS = [
  { time: 1794839700, price: 64320.5, size: 200, side: 'buy', posSide: 'long', execType: 'T', fee: 0.08,
    feeCcy: 'USDT', ordId: '7001', tradeId: '9001' },
  { time: 1794839820, price: 64320.5, size: 100, side: 'buy', posSide: 'long', execType: 'T', fee: 0.04,
    feeCcy: 'USDT', ordId: '7001', tradeId: '9002' },
  { time: 1794840300, price: 65000, size: 50, side: 'sell', posSide: 'long', execType: 'M', fee: 0.02,
    feeCcy: 'USDT', ordId: '7002', tradeId: '9003' },
];

// --- Instrument mapping -------------------------------------------------------------------------------------------

test('the checkbox is on by default and the unconfigured line names the file', () => {
  assert.equal(FILLS_KEY, 'jesse.market.fills.v1');
  assert.match(FILLS_NOT_CONFIGURED, /^未配置 Deepcoin API：在 jesse-project\/\.env\.deepcoin 填三项后刷新$/);
});

test('a base coin is read out of every venue\'s spelling', () => {
  assert.equal(fillsBase('BTCUSDT'), 'BTC');
  assert.equal(fillsBase('BTC-USDT'), 'BTC');
  assert.equal(fillsBase('BTC-USDT-SWAP'), 'BTC');
  assert.equal(fillsBase('1000PEPEUSDT'), '1000PEPE');
  assert.equal(fillsBase('BTCUSD'), 'BTCUSD');
  assert.equal(fillsBase('USDT'), '');
  assert.equal(fillsBase(''), '');
});

test('a chart maps to the Deepcoin instrument of the same base and kind', () => {
  // 合约 stays the perpetual (SWAP), 现货 the spot pair (SPOT), whichever exchange the chart is showing.
  assert.deepEqual(fillsInstrument(BINANCE_SOURCE, 'swap', 'BTCUSDT'),
    { market: 'swap', instType: 'SWAP', symbol: 'BTC-USDT' });
  assert.deepEqual(fillsInstrument(BINANCE_SOURCE, 'spot', 'BTCUSDT'),
    { market: 'spot', instType: 'SPOT', symbol: 'BTC-USDT' });
  assert.deepEqual(fillsInstrument(OKX_SOURCE, 'swap', 'BTC-USDT-SWAP'),
    { market: 'swap', instType: 'SWAP', symbol: 'BTC-USDT' });
  assert.deepEqual(fillsInstrument(DEEPCOIN_SOURCE, 'spot', 'BTC-USDT'),
    { market: 'spot', instType: 'SPOT', symbol: 'BTC-USDT' });
  // The yields are not traded on Deepcoin: no instrument, so no request.
  assert.equal(fillsInstrument(YIELD_SOURCE, null, 'US10Y'), null);
  assert.equal(fillsInstrument(BINANCE_SOURCE, 'swap', 'btc/usdt'), null);
});

test('the request body carries the window and only the fields the route takes', () => {
  assert.deepEqual(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', 1794835200.8),
    { market: 'swap', symbol: 'BTC-USDT', begin: 1794835200 });
  assert.deepEqual(fillsRequest(OKX_SOURCE, 'spot', 'ETH-USDT', 1794835200, 1794841200.4),
    { market: 'spot', symbol: 'ETH-USDT', begin: 1794835200, end: 1794841200 });
  // No begin (nothing loaded yet) / a yield chart / an end before the begin: nothing to ask for.
  assert.equal(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', 0), null);
  assert.equal(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', null), null);
  assert.equal(fillsRequest(YIELD_SOURCE, null, 'US10Y', 1794835200), null);
  assert.deepEqual(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', 1794835200, 1794835100),
    { market: 'swap', symbol: 'BTC-USDT', begin: 1794835200 });
});

// --- Parsing -----------------------------------------------------------------------------------------------------

test('an answer is only drawn when it is configured and its fills are sane', () => {
  assert.equal(configuredOf({ configured: true, fills: [] }), true);
  assert.equal(configuredOf({ configured: false, fills: [] }), false);
  assert.equal(configuredOf({ fills: [] }), false);
  assert.equal(configuredOf(null), false);

  const fills = parseFills({ configured: true, fills: [
    { ...FILLS[2] },
    { ...FILLS[0], tradeId: '9009' },
    { time: 0, price: 1, size: 1, side: 'buy' },
    { time: 1794839700, price: 0, size: 1, side: 'buy' },
    { time: 1794839700, price: 1, size: 0, side: 'buy' },
    { time: 1794839700, price: 1, size: 1, side: 'hold' },
    { time: 1794839700, price: 1, size: 1, side: 'buy', fee: 'x' },
    null,
  ] });
  assert.deepEqual(fills.map(fill => fill.tradeId), ['', '9009', '9003']);
  // Oldest first; a fee that is not a number is 0, a posSide that is not long / short is ''.
  assert.equal(fills[0].time, 1794839700);
  assert.equal(fills[0].fee, 0);
  assert.equal(fills[0].posSide, '');
  assert.equal(parseFills({ fills: FILLS }).length, 3);
  assert.deepEqual(parseFills(null), []);
  assert.deepEqual(parseFills({ configured: false, fills: [] }), []);
});

// --- 方向 + 开平 ----------------------------------------------------------------------------------------------------

test('the four combinations of side and posSide name the action, a missing posSide is only 买 / 卖', () => {
  assert.deepEqual(fillAction({ side: 'buy', posSide: 'long' }), { id: 'open-long', label: '开多', kind: 'buy' });
  assert.deepEqual(fillAction({ side: 'sell', posSide: 'long' }), { id: 'close-long', label: '平多', kind: 'sell' });
  assert.deepEqual(fillAction({ side: 'sell', posSide: 'short' }), { id: 'open-short', label: '开空', kind: 'sell' });
  assert.deepEqual(fillAction({ side: 'buy', posSide: 'short' }), { id: 'close-short', label: '平空', kind: 'buy' });
  assert.deepEqual(fillAction({ side: 'buy', posSide: '' }), { id: 'buy', label: '买', kind: 'buy' });
  assert.deepEqual(fillAction({ side: 'SELL', posSide: null }), { id: 'sell', label: '卖', kind: 'sell' });
});

// --- Buckets -----------------------------------------------------------------------------------------------------

test('fills are bucketed into the candles of the panel, merged by direction inside one candle', () => {
  const buckets = bucketFills(FILLS, 15);
  // 1794839700 and 1794839820 are the same 15m candle (1794839400), the sell is the next one (1794840300).
  assert.deepEqual(buckets.map(bucket => bucket.time), [1794839400, 1794840300]);
  assert.equal(buckets[0].groups.length, 1);
  const group = buckets[0].groups[0];
  assert.equal(group.label, '开多');
  assert.equal(group.kind, 'buy');
  assert.equal(group.count, 2);
  // 均价 is size weighted, size and fee are summed, the fee currency is the group's own.
  assert.equal(group.price, 64320.5);
  assert.equal(group.size, 300);
  assert.equal(group.fee, 0.12);
  assert.equal(group.feeCcy, 'USDT');
  assert.equal(buckets[1].groups[0].label, '平多');
});

test('a finer timeframe splits what a coarse one merges, and the groups of a candle keep a fixed order', () => {
  const minute = bucketFills(FILLS, 1);
  assert.deepEqual(minute.map(bucket => bucket.time), [1794839700, 1794839820, 1794840300]);
  // 开多 before 平多 before 开空 before 平空, whatever order the venue listed them in.
  const mixed = bucketFills([
    { time: 1794839710, price: 10, size: 1, side: 'buy', posSide: 'short', fee: 0, feeCcy: 'USDT' },
    { time: 1794839720, price: 10, size: 1, side: 'sell', posSide: 'short', fee: 0, feeCcy: 'USDT' },
    { time: 1794839730, price: 10, size: 1, side: 'sell', posSide: 'long', fee: 0, feeCcy: 'USDT' },
    { time: 1794839740, price: 10, size: 1, side: 'buy', posSide: 'long', fee: 0, feeCcy: 'USDT' },
  ], 15);
  assert.deepEqual(mixed[0].groups.map(group => group.label), ['开多', '平多', '开空', '平空']);
  // Nothing usable: no bucket at all, never a marker on a made-up candle.
  assert.deepEqual(bucketFills([], 15), []);
  assert.deepEqual(bucketFills(FILLS, 0), []);
  assert.deepEqual(bucketFills([{ time: 1794839700, price: 0, size: 1, side: 'buy' }], 15), []);
});

// --- Markers -----------------------------------------------------------------------------------------------------

test('a buy group is a green up arrow below the candle, a sell group a red down arrow above it', () => {
  const buckets = bucketFills(FILLS, 15);
  const markers = fillMarkers(buckets, time => time === 1794839400);
  // Only the candles that are drawn: the second bucket is not in this chart's history.
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0], { time: 1794839400, position: 'belowBar', color: BUY_MARKER_COLOR,
    shape: 'arrowUp', text: '开多' });
  const sell = fillMarkers(buckets)[1];
  assert.deepEqual(sell, { time: 1794840300, position: 'aboveBar', color: SELL_MARKER_COLOR,
    shape: 'arrowDown', text: '平多' });
  // 平空 is a buy (it closes a short) and 开空 a sell: the arrow follows the trade's direction, not the position.
  const short = fillMarkers(bucketFills([
    { time: 1794838800, price: 10, size: 1, side: 'sell', posSide: 'short', fee: 0, feeCcy: '' },
    { time: 1794838860, price: 10, size: 1, side: 'buy', posSide: 'short', fee: 0, feeCcy: '' },
  ], 15));
  assert.deepEqual(short.map(marker => [marker.text, marker.position, marker.shape]), [
    ['开空', 'aboveBar', 'arrowDown'], ['平空', 'belowBar', 'arrowUp']]);
});

test('the note markers and the fill markers are drawn together, oldest first, neither dropped', () => {
  const notes = [
    { time: 1794839400, position: 'aboveBar', shape: 'square', color: BAR_NOTE_COLOR, text: '注' },
    { time: 1794844800, position: 'aboveBar', shape: 'square', color: BAR_NOTE_COLOR, text: '注' },
  ];
  const merged = mergeMarkers(notes, fillMarkers(bucketFills(FILLS, 15)));
  assert.deepEqual(merged.map(marker => [marker.time, marker.text]),
    [[1794839400, '注'], [1794839400, '开多'], [1794840300, '平多'], [1794844800, '注']]);
  // A note and a fill on the same candle are both there: the stable sort keeps the note first, as it was passed.
  assert.equal(merged.filter(marker => marker.time === 1794839400).length, 2);
  // Junk lists are skipped instead of becoming markers without a time.
  assert.deepEqual(mergeMarkers(null, [null, { time: 'x' }], undefined, []), []);
});

// --- The line under the chart ------------------------------------------------------------------------------------

test('the line under the chart reads the group out in full', () => {
  const group = { label: '开多', count: 2, price: 64320.5, size: 300, fee: 0.12, feeCcy: 'USDT' };
  assert.equal(fillGroupText(group), '开多 2 笔 均价 64,320.5 数量 300 手续费 0.12 USDT');
  // Thousands are separated, no invented decimals, no trailing zeros; a group without a fee says 0.
  assert.equal(fillGroupText({ label: '卖', count: 1, price: 1800, size: 1, fee: 0, feeCcy: '' }),
    '卖 1 笔 均价 1,800 数量 1 手续费 0');
  assert.equal(fillGroupsText(bucketFills(FILLS, 15)[0].groups),
    '开多 2 笔 均价 64,320.5 数量 300 手续费 0.12 USDT');
  // Several groups of one candle are one line, each its own sentence.
  assert.equal(fillGroupsText([
    { label: '开多', count: 1, price: 10, size: 1, fee: 0, feeCcy: 'USDT' },
    { label: '平多', count: 3, price: 12.5, size: 4, fee: 0.5, feeCcy: 'USDT' },
  ]), '开多 1 笔 均价 10 数量 1 手续费 0 USDT · 平多 3 笔 均价 12.5 数量 4 手续费 0.5 USDT');
  assert.equal(fillGroupsText([]), '');
  assert.equal(fillGroupsText(undefined), '');
});
