import test from 'node:test';
import assert from 'node:assert/strict';
import { labelKey, labelCounts, markOf, noteOf, entryOf, latestLabels, filterByLabel, countsText,
  LABEL_FILTERS, MARK_TEXT, barKey, barNoteOf, barLabel, barMarkers, latestBars,
  BAR_NOTE_COLOR } from '../jesse/static/review/labels.mjs';

const form = { factor: 'ma_pullback', exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT' };
const ride = { tf: '15m', start: 1763000000, dir: -1 };
const key = ride => labelKey(form, ride);

test('labelKey is factor|exchange|symbol|tf|start|dir', () => {
  assert.equal(labelKey(form, ride), 'ma_pullback|Binance Perpetual Futures|BTC-USDT|15m|1763000000|-1');
  // Anything that makes it a different signal changes the key.
  const variants = [
    { tf: '5m' }, { start: ride.start + 60 }, { dir: 1 },
  ];
  for (const change of variants) assert.notEqual(labelKey(form, { ...ride, ...change }), labelKey(form, ride));
  assert.notEqual(labelKey({ ...form, symbol: 'ETH-USDT' }, ride), labelKey(form, ride));
  assert.notEqual(labelKey({ ...form, factor: 'other' }, ride), labelKey(form, ride));
  // Missing pieces still give a stable key instead of throwing.
  assert.equal(labelKey({}, {}), '|||||');
});

test('markOf / noteOf / entryOf read the two marks and the note', () => {
  const labels = { a: { trend: 'good', order: 'bad', note: '挂单太远' } };
  assert.equal(markOf(labels, 'a', 'trend'), 'good');
  assert.equal(markOf(labels, 'a', 'order'), 'bad');
  assert.equal(markOf(labels, 'a'), 'good');
  assert.equal(noteOf(labels, 'a'), '挂单太远');
  assert.deepEqual(entryOf(labels, 'a'), { trend: 'good', order: 'bad', note: '挂单太远' });
  // A plain object, a Map, a missing key, nothing at all: same shape out, no null check needed by callers.
  assert.deepEqual(entryOf(new Map([['a', { trend: 'bad', order: null, note: '' }]]), 'a'), { trend: 'bad', order: null, note: '' });
  assert.deepEqual(entryOf(labels, 'b'), { trend: null, order: null, note: '' });
  assert.deepEqual(entryOf(null, 'a'), { trend: null, order: null, note: '' });
  // Old answers (one `label` per key) are not marks any more: the page reads the split fields only.
  assert.equal(markOf({ a: { label: 'good' } }, 'a'), null);
});

test('MARK_TEXT tells the two kinds apart', () => {
  assert.equal(MARK_TEXT.trend.good, '势✓');
  assert.equal(MARK_TEXT.trend.bad, '势✗');
  assert.equal(MARK_TEXT.order.good, '挂✓');
  assert.equal(MARK_TEXT.order.bad, '挂✗');
});

test('labelCounts splits the visible list into trend / order marks and unlabeled', () => {
  const rows = [ride, { tf: '5m', start: 1763000300, dir: 1 }, { tf: '3m', start: 1763000600, dir: 1 },
    { tf: '1m', start: 1763000900, dir: -1 }];
  // The finder puts the key on the ride (ride.key), so the two-argument call is what the page uses.
  const labelled = rows.map(r => ({ ...r, key: key(r) }));
  const labels = {
    [key(rows[0])]: { trend: 'good', order: 'bad', note: '回踩到位' },
    [key(rows[1])]: { trend: 'bad', order: null, note: '' },
    [key(rows[2])]: { trend: null, order: 'good', note: '' },
  };
  assert.deepEqual(labelCounts(labelled, labels), {
    trend: { good: 1, bad: 1 }, order: { good: 1, bad: 1 }, unlabeled: 1 });
  // No marks at all, and an empty list.
  assert.deepEqual(labelCounts(labelled, {}), {
    trend: { good: 0, bad: 0 }, order: { good: 0, bad: 0 }, unlabeled: 4 });
  assert.deepEqual(labelCounts([], labels), {
    trend: { good: 0, bad: 0 }, order: { good: 0, bad: 0 }, unlabeled: 0 });
  // A keyOf lets a caller count rides that carry no key of their own.
  assert.deepEqual(labelCounts(rows, labels, key), {
    trend: { good: 1, bad: 1 }, order: { good: 1, bad: 1 }, unlabeled: 1 });
  // A note alone is still "unlabeled": the filter is about the two marks.
  assert.deepEqual(labelCounts([labelled[0]], { [key(rows[0])]: { trend: null, order: null, note: '看看' } }),
    { trend: { good: 0, bad: 0 }, order: { good: 0, bad: 0 }, unlabeled: 1 });
});

test('countsText is the line above the list', () => {
  assert.equal(countsText({ trend: { good: 2, bad: 1 }, order: { good: 0, bad: 3 }, unlabeled: 4 }),
    '趋势 好 2 / 坏 1 · 挂单 好 0 / 坏 3 · 未标 4');
});

test('latestLabels mirrors the server: last row of a kind wins, clears drop it, no kind = trend', () => {
  const rows = [
    { key: 'a', label: 'good', note: '旧' },                    // before the split: a trend mark
    { key: 'a', label: 'bad', note: '新' },                     // …and a newer trend mark
    { key: 'a', kind: 'order', label: 'good', note: '' },
    { key: 'b', kind: 'order', label: 'bad', note: '' },
    { key: 'b', kind: 'order', label: 'clear', note: '' },       // only the order mark goes
    { key: 'b', kind: 'trend', label: 'good', note: '备注' },
    { key: 'b', kind: 'note', note: '改了备注' },                 // note rows replace the note only
    { key: 'c', kind: 'note', note: '只有备注' },
    { key: 'd', kind: 'trend', label: 'clear', note: '' },
    { key: 'd', kind: 'note', note: '' },
  ];
  const latest = latestLabels(rows);
  assert.deepEqual([...latest], [
    ['a', { trend: 'bad', order: 'good', note: '新' }],
    ['b', { trend: 'good', order: null, note: '改了备注' }],
    ['c', { trend: null, order: null, note: '只有备注' }],
  ]);
  // A row without a key (a hand-edited line) is skipped; an unknown label is not a mark; nothing is nothing.
  assert.deepEqual([...latestLabels([{ label: 'good' }, { key: 'e', label: 'maybe' }])], []);
  assert.deepEqual([...latestLabels(undefined)], []);
});

test('filterByLabel narrows the list to the chosen mark', () => {
  const rows = [
    { key: 'a', tf: '15m' }, { key: 'b', tf: '5m' }, { key: 'c', tf: '3m' }, { key: 'd', tf: '1m' },
  ];
  const labels = {
    a: { trend: 'good', order: 'good', note: '' },   // 都好
    b: { trend: 'bad', order: 'good', note: '' },    // 趋势坏
    c: { trend: 'good', order: 'bad', note: '' },    // 挂单坏
    d: { trend: null, order: null, note: '只看一眼' },
  };
  const tfs = (filter) => filterByLabel(rows, labels, filter).map(r => r.tf);
  assert.deepEqual(tfs('all'), ['15m', '5m', '3m', '1m']);
  assert.deepEqual(tfs('unlabeled'), ['1m']);
  assert.deepEqual(tfs('trendBad'), ['5m']);
  assert.deepEqual(tfs('orderBad'), ['3m']);
  assert.deepEqual(tfs('bothGood'), ['15m']);
  // The ids the buttons use all exist, and an unknown filter shows everything.
  assert.deepEqual(LABEL_FILTERS.map(([id]) => id), ['all', 'unlabeled', 'trendBad', 'orderBad', 'bothGood']);
  assert.deepEqual(tfs('nonsense'), ['15m', '5m', '3m', '1m']);
});

// ---- Candle notes -----------------------------------------------------------
// A note on one candle of one timeframe, stored as a `kind=bar` row and answered by POST /review/labels in `bars`.
const barForm = { exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT' };
const barKeyOf = (tf, time) => barKey(barForm, tf, time);

test('barKey is bar|exchange|symbol|tf|time', () => {
  assert.equal(barKey(barForm, '3m', 1763000000), 'bar|Binance Perpetual Futures|BTC-USDT|3m|1763000000');
  // The timeframe is part of the identity: the same clock time is another candle on another chart.
  assert.notEqual(barKey(barForm, '15m', 1763000000), barKey(barForm, '3m', 1763000000));
  assert.notEqual(barKey({ ...barForm, symbol: 'ETH-USDT' }, '3m', 1763000000), barKey(barForm, '3m', 1763000000));
  assert.notEqual(barKey(barForm, '3m', 1763000180), barKey(barForm, '3m', 1763000000));
  // Missing pieces still give a stable key instead of throwing.
  assert.equal(barKey({}, undefined, undefined), 'bar||||');
});

test('latestBars mirrors the server: last row per candle wins, an empty note deletes it', () => {
  const key = barKeyOf('3m', 1763000000);
  const other = barKeyOf('15m', 1763000000);
  const rows = [
    { key, kind: 'bar', note: '第一版', tf: '3m', time: 1763000000 },
    { key, kind: 'bar', note: '改过', tf: '3m', time: 1763000000 },
    { key: other, kind: 'bar', note: '15m 的看法', tf: '15m', time: 1763000000 },
    // Signal marks in the same file are not candle notes.
    { key: 'ma_pullback|Binance Perpetual Futures|BTC-USDT|15m|1763000000|-1', kind: 'trend', label: 'good' },
    { key: 'ma_pullback|Binance Perpetual Futures|BTC-USDT|15m|1763000000|-1', kind: 'note', note: '信号的备注' },
    // A hand-edited line without a key, and a deleted candle note (empty text) that must not come back.
    { kind: 'bar', note: '没有 key' },
    { key: key, kind: 'bar', note: '' },
  ];
  assert.deepEqual([...latestBars(rows)], [[other, { note: '15m 的看法', tf: '15m', time: 1763000000 }]]);
  assert.deepEqual([...latestBars(undefined)], []);
});

test('barNoteOf / barLabel read one candle and stamp its title', () => {
  const key = barKeyOf('3m', 1763000000);
  const bars = { [key]: { note: '这里放量', tf: '3m', time: 1763000000 } };
  assert.equal(barNoteOf(bars, key), '这里放量');
  // A Map of the same shape, a key that was never noted, a deleted note, nothing at all: '' and no null check.
  assert.equal(barNoteOf(new Map([[key, { note: '来自 Map', tf: '3m', time: 1763000000 }]]), key), '来自 Map');
  assert.equal(barNoteOf(bars, barKeyOf('15m', 1763000000)), '');
  assert.equal(barNoteOf(bars, ''), '');
  assert.equal(barNoteOf(null, key), '');
  // 1763000000 = 2026-11-13 02:13:20 UTC; the title keeps minutes and adds the timeframe.
  assert.equal(barLabel(1763000000, '3m'), '11-13 02:13 UTC · 3m');
});

test('barMarkers draws only the notes of this chart\'s timeframe, inside the range', () => {
  const bars = {
    [barKeyOf('3m', 1763000000)]: { note: '3m 的', tf: '3m', time: 1763000000 },
    [barKeyOf('3m', 1763000180)]: { note: '3m 另一根', tf: '3m', time: 1763000180 },
    [barKeyOf('15m', 1763000000)]: { note: '15m 的', tf: '15m', time: 1763000000 },
  };
  const inRange = time => time === 1763000000;
  assert.deepEqual(barMarkers(bars, '3m', inRange), [
    { bar: true, time: 1763000000, position: 'aboveBar', shape: 'square', color: '#7c3aed', text: '注' },
  ]);
  // Without a range filter (a chart with every candle) both 3m notes appear, still none of the 15m one.
  assert.deepEqual(barMarkers(bars, '3m').map(marker => marker.time), [1763000000, 1763000180]);
  // Another chart never inherits them, and an empty / missing answer draws nothing.
  assert.deepEqual(barMarkers(bars, '15m').map(marker => marker.time), [1763000000]);
  assert.deepEqual(barMarkers({}, '3m'), []);
  // A Map works too, and a note with no text (deleted) is never drawn.
  assert.equal(barMarkers(new Map([[barKeyOf('1h', 1763000000), { note: '1h 的', tf: '1h', time: 1763000000 }]]), '1h').length, 1);
  assert.deepEqual(barMarkers({ [barKeyOf('3m', 1763000000)]: { note: '', tf: '3m', time: 1763000000 } }, '3m'), []);
  assert.equal(BAR_NOTE_COLOR, '#7c3aed');
});
