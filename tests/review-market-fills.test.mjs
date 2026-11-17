import test from 'node:test';
import assert from 'node:assert/strict';
import { BINANCE_SOURCE, DEEPCOIN_SOURCE, OKX_SOURCE, YIELD_SOURCE } from '../jesse/static/review/market-sources.mjs';
import { BAR_NOTE_COLOR } from '../jesse/static/review/labels.mjs';
import { BUY_MARKER_COLOR, FILLS_BACKFILLING, FILLS_BACKFILLING_EMPTY, FILLS_KEY, FILLS_NOT_CONFIGURED,
  FILLS_POLL_MS, FILLS_STREAM_TEXT, FILLS_WAIT_BACKOFF, FILLS_WAIT_ENDPOINT,
  SELL_MARKER_COLOR, applyFillsWait, bucketFills, configuredOf, fillLabelsFit, fillAction, fillGroupText, fillGroupsText,
  fillKey, fillMarkers, fillsBase, fillsHave, fillsInstrument, fillsProgressText, fillsRequest, fillsStamp,
  fillsStatusLine, fillsStreamText, fillsWaitBackoff, fillsWaitBody, fillsWaitSeq, mergeFillRows, mergeMarkers, parseFills }
  from '../jesse/static/review/market-fills.mjs';

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
    shape: 'arrowUp', text: '开多2' });
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

test('one candle gets at most one arrow per side; the text sums its actions, and zoomed out it has none', () => {
  const busy = bucketFills([
    { time: 1794838800, price: 10, size: 1, side: 'buy', posSide: 'long', fee: 0, feeCcy: '' },
    { time: 1794838810, price: 10, size: 1, side: 'buy', posSide: 'long', fee: 0, feeCcy: '' },
    { time: 1794838820, price: 10, size: 1, side: 'buy', posSide: 'short', fee: 0, feeCcy: '' },
    { time: 1794838830, price: 10, size: 1, side: 'sell', posSide: 'short', fee: 0, feeCcy: '' },
    { time: 1794838840, price: 10, size: 1, side: 'sell', posSide: 'long', fee: 0, feeCcy: '' },
  ], 15);
  const labelled = fillMarkers(busy);
  assert.equal(labelled.length, 2);
  assert.deepEqual(labelled.map(marker => [marker.position, marker.text]).sort(),
    [['aboveBar', labelled.find(m => m.position === 'aboveBar').text], ['belowBar', '开多2 平空']].sort());
  assert.match(labelled.find(m => m.position === 'aboveBar').text, /^(开空 平多|平多 开空)$/);
  assert.deepEqual(fillMarkers(busy, () => true, { labels: false }).map(marker => marker.text), ['', '']);
  // Text only when every candle has room for it.
  assert.equal(fillLabelsFit(800, 20), true);
  assert.equal(fillLabelsFit(530, 40), false);
  assert.equal(fillLabelsFit(NaN, 20), false);
});

test('the note markers and the fill markers are drawn together, oldest first, neither dropped', () => {
  const notes = [
    { time: 1794839400, position: 'aboveBar', shape: 'square', color: BAR_NOTE_COLOR, text: '注' },
    { time: 1794844800, position: 'aboveBar', shape: 'square', color: BAR_NOTE_COLOR, text: '注' },
  ];
  const merged = mergeMarkers(notes, fillMarkers(bucketFills(FILLS, 15)));
  assert.deepEqual(merged.map(marker => [marker.time, marker.text]),
    [[1794839400, '注'], [1794839400, '开多2'], [1794840300, '平多'], [1794844800, '注']]);
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

// --- 正在补历史 (T-60) ----------------------------------------------------------------------------------

test('a window the store still misses says how far back it got, a complete one says nothing', () => {
  assert.equal(FILLS_BACKFILLING, '我的成交：正在补历史，已到 ');
  // `covered_from` is the oldest stored fill (seconds), named the way the charts name a candle time.
  assert.equal(fillsProgressText({ configured: true, complete: false, covered_from: 1794839700 }),
    '我的成交：正在补历史，已到 2026-11-16 14:35 UTC');
  assert.equal(fillsStamp(1794000900), '2026-11-06 21:35');
  // A store with nothing to point at yet (the first sync failed, or it has no fills) still says a backfill is running.
  assert.equal(fillsProgressText({ configured: true, complete: false, covered_from: null }), FILLS_BACKFILLING_EMPTY);
  assert.equal(fillsProgressText({ configured: true, complete: false }), FILLS_BACKFILLING_EMPTY);
  // Nothing is missing (or the answer is unconfigured / from a backend that has no store yet): no line at all.
  assert.equal(fillsProgressText({ configured: true, complete: true, covered_from: 1794839700 }), '');
  assert.equal(fillsProgressText({ configured: true, fills: [] }), '');
  assert.equal(fillsProgressText({ configured: false, fills: [], complete: false }), '');
  assert.equal(fillsProgressText(null), '');
  // A stamp that is not a time is not turned into 1970.
  assert.equal(fillsStamp(0), '');
  assert.equal(fillsStamp('yesterday'), '');
  assert.equal(fillsStamp(null), '');
  // The error of a refused request is a separate field, not the progress line (the page shows it instead).
  assert.equal(fillsProgressText({ configured: true, complete: false, covered_from: 1794839700,
    error: 'Deepcoin 请求失败（HTTP 429），稍后再试' }), '我的成交：正在补历史，已到 2026-11-16 14:35 UTC');
});

// --- 只传新增 (T-61) -----------------------------------------------------------------------------------------------

test('the range the page already has is its oldest and newest fill, and nothing when it has none', () => {
  assert.deepEqual(fillsHave(FILLS), { from: 1794839700, to: 1794840300 });
  // A page without fills (the first read, or just after switching instrument) has no range to name.
  assert.equal(fillsHave([]), null);
  assert.equal(fillsHave(null), null);
  // A row that is not a fill never moves an edge.
  assert.deepEqual(fillsHave([{ time: 'x' }, { time: 0 }, null, { time: 1794839700 }]),
    { from: 1794839700, to: 1794839700 });
});

test('the identity of a fill is its trade id, or its own numbers when the venue sent none', () => {
  assert.equal(fillKey(FILLS[0]), '9001');
  assert.equal(fillKey({ ...FILLS[0], tradeId: '' }), '7001|1794839700|64320.5|200');
  assert.equal(fillKey({ ...FILLS[0], tradeId: '' }), fillKey({ ...FILLS[0], tradeId: '' }));
});

test('an increment is merged into what is drawn: one row per fill, oldest first, never older than the window', () => {
  const backfilled = { ...FILLS[0], tradeId: '8900', time: 1794839650 };
  const rows = mergeFillRows(FILLS, [
    { ...FILLS[2] }, // an overlap edge the backend re-sends
    backfilled, // history the backfill just pulled
    { ...FILLS[1], fee: 0.05 }, // the same fill again, with a corrected fee
  ], 1794839600);
  assert.deepEqual(rows.map(fill => fill.tradeId), ['8900', '9001', '9002', '9003']);
  assert.equal(rows.find(fill => fill.tradeId === '9002').fee, 0.05);
  // A fill older than the window start cannot be drawn, so it is not kept (the page would show a mark off-screen).
  assert.deepEqual(mergeFillRows(FILLS, [backfilled], 1794839700).map(fill => fill.tradeId), ['9001', '9002', '9003']);
  // Without a window start (no begin yet) nothing is cut.
  assert.equal(mergeFillRows([], FILLS).length, 3);
  // The same increment twice is the same list: a re-sent page does not double a marker.
  const once = mergeFillRows(FILLS, [backfilled], 1794839600);
  assert.deepEqual(mergeFillRows(once, [backfilled], 1794839600), once);
  // Rows without trade ids still de-duplicate by their own numbers, and junk is dropped.
  const anonymous = { ...FILLS[0], tradeId: '' };
  assert.equal(mergeFillRows([anonymous], [{ ...anonymous }]).length, 1);
  assert.deepEqual(mergeFillRows(null, [null, 'nope', { time: 1794839700, price: 0, size: 1 }]), []);
});

test('the second read sends the range it already has; a first read and a switch send none', () => {
  assert.deepEqual(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', 1794835200, null, fillsHave(FILLS)),
    { market: 'swap', symbol: 'BTC-USDT', begin: 1794835200, have_from: 1794839700, have_to: 1794840300 });
  // The first read of a page, and the read after switching instrument / market, have no fills yet (`fillRows` is
  // reset when the instrument changes): the whole window is asked for, so nothing is missing between fills.
  assert.deepEqual(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', 1794835200, null, fillsHave([])),
    { market: 'swap', symbol: 'BTC-USDT', begin: 1794835200 });
  // A have range that is half given / impossible is left out instead of being sent (the route refuses half a range).
  for (const have of [{ from: 1794839700 }, { to: 1794840300 }, { from: 0, to: 1794840300 },
    { from: 1794840300, to: 1794839700 }, { from: 'x', to: 1794840300 }]) {
    assert.deepEqual(fillsRequest(BINANCE_SOURCE, 'swap', 'BTCUSDT', 1794835200, null, have),
      { market: 'swap', symbol: 'BTC-USDT', begin: 1794835200 });
  }
});

// --- 实时推送 (T-63) -----------------------------------------------------------------------------------------------

test('the history poll is now the 60-second fallback and the push has its own route', () => {
  assert.equal(FILLS_POLL_MS, 60000);
  assert.equal(FILLS_WAIT_ENDPOINT, '/review/market/fills/wait');
});

test('the wait asks for the perpetual only, and from the counter the page already has', () => {
  assert.deepEqual(fillsWaitBody(BINANCE_SOURCE, 'swap', 'BTCUSDT', 7),
    { market: 'swap', symbol: 'BTC-USDT', seq: 7 });
  assert.deepEqual(fillsWaitBody(OKX_SOURCE, 'swap', 'ETH-USDT-SWAP', 0),
    { market: 'swap', symbol: 'ETH-USDT', seq: 0 });
  // A first wait (nothing drawn yet) asks from 0; junk / negative / fractional counters do not travel as-is.
  assert.deepEqual(fillsWaitBody(DEEPCOIN_SOURCE, 'swap', 'BTC-USDT', null),
    { market: 'swap', symbol: 'BTC-USDT', seq: 0 });
  assert.deepEqual(fillsWaitBody(DEEPCOIN_SOURCE, 'swap', 'BTC-USDT', -4),
    { market: 'swap', symbol: 'BTC-USDT', seq: 0 });
  assert.deepEqual(fillsWaitBody(DEEPCOIN_SOURCE, 'swap', 'BTC-USDT', 3.9),
    { market: 'swap', symbol: 'BTC-USDT', seq: 3 });
  assert.deepEqual(fillsWaitBody(DEEPCOIN_SOURCE, 'swap', 'BTC-USDT', 'x'),
    { market: 'swap', symbol: 'BTC-USDT', seq: 0 });
  // Spot has no private push and the yields have no fills at all: no wait request.
  assert.equal(fillsWaitBody(BINANCE_SOURCE, 'spot', 'BTCUSDT', 0), null);
  assert.equal(fillsWaitBody(YIELD_SOURCE, null, 'US10Y', 0), null);
});

test('a failed wait is retried after 2 / 5 / 10 seconds and then every 10', () => {
  assert.deepEqual(FILLS_WAIT_BACKOFF, [2000, 5000, 10000]);
  assert.deepEqual([0, 1, 2, 3, 9].map(fillsWaitBackoff), [2000, 5000, 10000, 10000, 10000]);
  // A negative / non-numeric failure count is the first failure.
  assert.equal(fillsWaitBackoff(-1), 2000);
  assert.equal(fillsWaitBackoff('x'), 2000);
});

test('a wait answer is merged into the drawn rows and its counter is what the next wait asks from', () => {
  const pushed = { ...FILLS[2], time: 1794840360, tradeId: '9004' };
  const answer = { seq: 12, stream: { state: 'live' },
    fills: [pushed, { ...FILLS[1] }, { ...FILLS[0], tradeId: '8999', time: 1794839600 }] };
  const merged = applyFillsWait(FILLS, answer, 1794839700);
  // The new fill is added once, the repeated one is not doubled, and nothing older than the window start is kept.
  assert.deepEqual(merged.rows.map(fill => fill.tradeId), ['9001', '9002', '9003', '9004']);
  assert.equal(merged.seq, 12);
  // A heartbeat answer (no fills, same seq) leaves the rows exactly as they were.
  assert.deepEqual(applyFillsWait(FILLS, { seq: 12, fills: [] }, 1794839700).rows, mergeFillRows(FILLS, []));
  // The counter falls back to 0 for an answer without one / a negative one; junk fills are dropped.
  assert.equal(fillsWaitSeq({}), 0);
  assert.equal(fillsWaitSeq({ seq: -2 }), 0);
  assert.equal(fillsWaitSeq({ seq: 'yesterday' }), 0);
  assert.equal(fillsWaitSeq({ seq: 4 }), 4);
  assert.deepEqual(applyFillsWait([], { seq: 1, fills: [null, 'nope'] }, null).rows, []);
});

test('the status line names the push state after the backfill text', () => {
  const backfill = fillsProgressText({ configured: true, complete: false, covered_from: 1794839700 });
  assert.equal(fillsStatusLine(backfill, { state: 'live' }), `${backfill} · 成交实时：已连接`);
  // Reconnecting is said the same whether the worker is still connecting or has already lost its socket.
  assert.equal(fillsStreamText({ state: 'connecting' }), '成交实时：重连中');
  assert.equal(fillsStreamText({ state: 'reconnecting' }), '成交实时：重连中');
  assert.equal(fillsStreamText({ state: 'off' }), '成交实时：未连接');
  // Nothing to say (an old backend, or a page that is not waiting) is no segment at all.
  assert.equal(fillsStreamText(null), '');
  assert.equal(fillsStreamText({}), '');
  assert.equal(fillsStreamText({ state: 'weird' }), '');
  assert.equal(FILLS_STREAM_TEXT.live, '成交实时：已连接');
  // The whole line: either half may be missing, and both missing is the empty line that clears it.
  assert.equal(fillsStatusLine('', { state: 'live' }), '成交实时：已连接');
  assert.equal(fillsStatusLine(backfill, null), backfill);
  assert.equal(fillsStatusLine('', null), '');
});
