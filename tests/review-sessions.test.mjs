import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, canSelect, listRequest, normalizeSessions, mergePages, hasMore, sessionTitle, sessionRow, formatHolding, sessionFromSearch, searchForSession, statusText } from '../jesse/static/review/sessions.mjs';

const ID = '4d04c6c0-2e23-4b33-9e9f-909a4f6e2265';
const full = { id: ID, status: 'finished', title: null, net_profit_percentage: -13.2629,
  state: { form: { start_date: '2026-10-17', finish_date: '2026-10-24', routes: [{ strategy: 'MA5TrendRiderV1' }] } } };

test('only finished sessions are selectable', () => {
  assert.equal(canSelect({ status: 'finished' }), true);
  for (const status of ['running', 'stopped', 'cancelled', undefined]) assert.equal(canSelect({ status }), false);
  assert.equal(canSelect(null), false);
});

test('list request carries limit, offset and trimmed title_search only when non-empty', () => {
  assert.deepEqual(listRequest('  ma5 ', 100), { limit: PAGE_SIZE, offset: 100, title_search: 'ma5' });
  assert.deepEqual(listRequest('   '), { limit: PAGE_SIZE, offset: 0 });
  assert.deepEqual(listRequest(undefined, 0, 20), { limit: 20, offset: 0 });
});

test('rows without an id are dropped and pages merge without duplicates', () => {
  assert.deepEqual(normalizeSessions([null, {}, { id: 'a' }, 5]), [{ id: 'a' }]);
  assert.deepEqual(normalizeSessions(undefined), []);
  const merged = mergePages([{ id: 'a', n: 1 }, { id: 'b' }], [{ id: 'b', n: 2 }, { id: 'c' }]);
  assert.deepEqual(merged.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(merged[1].n, undefined);
});

test('a full page means more may be available', () => {
  assert.equal(hasMore(new Array(100).fill({})), true);
  assert.equal(hasMore(new Array(99).fill({})), false);
  assert.equal(hasMore(undefined), false);
});

test('title falls back to strategy name, then short id', () => {
  assert.equal(sessionTitle({ ...full, title: ' 我的回测 ' }), '我的回测');
  assert.equal(sessionTitle(full), 'MA5TrendRiderV1');
  assert.equal(sessionTitle({ id: ID }), '4d04c6c0');
});

test('row shows only the fields that exist', () => {
  assert.deepEqual(sessionRow(full), { id: ID, title: 'MA5TrendRiderV1', range: '2026-10-17 — 2026-10-24', status: '已完成',
    selectable: true, trades: null, profit: '-13.26%', profitSign: 'negative' });
  const bare = sessionRow({ id: ID, status: 'running', net_profit_percentage: null });
  assert.equal(bare.range, null); assert.equal(bare.profit, null); assert.equal(bare.profitSign, null);
  assert.equal(bare.selectable, false); assert.equal(bare.status, '运行中');
  assert.equal(sessionRow({ ...full, net_profit_percentage: 4.5 }).profit, '+4.50%');
  assert.equal(sessionRow({ ...full, trade_count: 12 }).trades, '12 笔');
  assert.equal(statusText('weird'), 'weird');
});

test('holding time: minutes up to 60, hours and minutes beyond', () => {
  assert.equal(formatHolding(600), '10 分钟');
  assert.equal(formatHolding(0), '0 分钟');
  assert.equal(formatHolding(3600), '60 分钟');
  assert.equal(formatHolding(3600 + 30), '1 小时 1 分钟');
  assert.equal(formatHolding(182 * 60), '3 小时 2 分钟');
  assert.equal(formatHolding(7200), '2 小时 0 分钟');
  assert.equal(formatHolding(NaN), null);
  assert.equal(formatHolding(undefined), null);
});

test('session id is read from and written to the query string', () => {
  assert.equal(sessionFromSearch(`?session=${ID}`), ID);
  assert.equal(sessionFromSearch('?session=nope'), null);
  assert.equal(sessionFromSearch(''), null);
  assert.equal(searchForSession('?foo=1&session=x', ID), `?foo=1&session=${ID}`);
  assert.equal(searchForSession('', ID), `?session=${ID}`);
});
