import test from 'node:test';
import assert from 'node:assert/strict';
import { labelKey, labelCounts, labelOf, latestLabels, filterByLabel } from '../jesse/static/review/labels.mjs';

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

test('labelCounts splits the visible list into good / bad / unlabeled', () => {
  const rows = [ride, { tf: '5m', start: 1763000300, dir: 1 }, { tf: '3m', start: 1763000600, dir: 1 }];
  // The finder puts the key on the ride (ride.key), so the two-argument call is what the page uses.
  const labelled = rows.map(r => ({ ...r, key: key(r) }));
  const labels = { [key(rows[0])]: { label: 'good', note: '回踩到位' }, [key(rows[1])]: { label: 'bad', note: '' } };
  assert.deepEqual(labelCounts(labelled, labels), { good: 1, bad: 1, unlabeled: 1 });
  // No marks at all, and an empty list.
  assert.deepEqual(labelCounts(labelled, {}), { good: 0, bad: 0, unlabeled: 3 });
  assert.deepEqual(labelCounts([], labels), { good: 0, bad: 0, unlabeled: 0 });
  // A keyOf lets a caller count rides that carry no key of their own.
  assert.deepEqual(labelCounts(rows, labels, key), { good: 1, bad: 1, unlabeled: 1 });
  // `clear` is not a mark, so such a row counts as unlabeled.
  assert.deepEqual(labelCounts([labelled[0]], { [key(rows[0])]: { label: 'clear' } }), { good: 0, bad: 0, unlabeled: 1 });
});

test('labelOf reads a plain object or a Map and ignores clears', () => {
  const labels = { a: { label: 'good', note: 'x' } };
  assert.deepEqual(labelOf(labels, 'a'), { label: 'good', note: 'x' });
  assert.equal(labelOf(labels, 'b'), null);
  assert.deepEqual(labelOf(new Map([['a', { label: 'bad', note: '' }]]), 'a'), { label: 'bad', note: '' });
  assert.equal(labelOf({ a: { label: 'clear' } }, 'a'), null);
  assert.equal(labelOf(null, 'a'), null);
});

test('latestLabels keeps the last row per key and drops cleared ones', () => {
  const rows = [
    { key: 'a', label: 'good', note: '旧' }, { key: 'b', label: 'bad' },
    { key: 'a', label: 'bad', note: '新' }, { key: 'b', label: 'clear' },
  ];
  const latest = latestLabels(rows);
  assert.deepEqual([...latest], [['a', { label: 'bad', note: '新' }]]);
  // A row without a key (a hand-edited line) is skipped; an unknown label is not a mark.
  assert.deepEqual([...latestLabels([{ label: 'good' }, { key: 'c', label: 'maybe' }])], []);
  assert.deepEqual([...latestLabels(undefined)], []);
});

test('filterByLabel narrows the list to the chosen mark', () => {
  const rows = [{ ...ride, key: key(ride) }, { tf: '5m', start: 1763000300, dir: 1, key: 'other' }];
  const labels = { [key(ride)]: { label: 'good', note: '' } };
  assert.equal(filterByLabel(rows, labels, 'all', key).length, 2);
  assert.deepEqual(filterByLabel(rows, labels, 'good', key).map(r => r.tf), ['15m']);
  assert.deepEqual(filterByLabel(rows, labels, 'unlabeled', key).map(r => r.tf), ['5m']);
  assert.deepEqual(filterByLabel(rows, labels, 'bad', key), []);
});
