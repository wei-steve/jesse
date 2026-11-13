import test from 'node:test';
import assert from 'node:assert/strict';
import { labelKey, labelCounts, markOf, noteOf, entryOf, latestLabels, filterByLabel, countsText,
  LABEL_FILTERS, MARK_TEXT } from '../jesse/static/review/labels.mjs';

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
