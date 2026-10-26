import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeInfoIndex, tradeConditions, entrySummary, entryLines, exitLines, exitReasonText } from '../jesse/static/review/tradeinfo.mjs';
import { restorePreferences } from '../jesse/static/review/settings.mjs';

const T0 = 1_700_000_040;           // UTC seconds, minute aligned
const T1 = T0 + 600;
const series = points => ({ data: points.map(([time, value]) => ({ time, value })) });
const charts = { extra_charts: { trade_info: {
  entry_side: series([[T0, 1]]), entry_trend_tf: series([[T0, 15]]), entry_exec_tf: series([[T0, 3]]),
  entry_ma_period: series([[T0, 20]]), entry_ma_value: series([[T0, 81600.123]]),
  entry_limit_price: series([[T0, 81500]]), entry_offset_atr: series([[T0, 0.1]]),
  entry_atr: series([[T0, 120.456]]), entry_trend_er: series([[T0, 0.62]]),
  entry_filter_1h: series([[T0, -1]]), entry_order_created: series([[T0, T0 - 180]]), entry_stop: series([[T0, 80000]]),
  exit_reason: series([[T1, 1]]), exit_trigger_price: series([[T1, 82000]]), exit_bb_upper: series([[T1, 82000.5]]),
} } };
// opened_at/closed_at are candle close times in ms: point time + 60 s.
const trade = { type: 'long', opened_at: (T0 + 60) * 1000, closed_at: (T1 + 60) * 1000 };

test('matches points at opened_at/closed_at minus 60 s, falling back to the same minute', () => {
  const { entry, exit } = tradeConditions(tradeInfoIndex(charts), trade);
  assert.equal(entry.entry_exec_tf, 3);
  assert.equal(exit.exit_reason, 1);
  assert.equal(entry.exit_reason, undefined);
  const other = tradeConditions(tradeInfoIndex(charts), { ...trade, opened_at: (T0 + 180) * 1000, closed_at: (T1 + 180) * 1000 });
  assert.equal(other.entry, null);
  assert.equal(other.exit, null);
  // Fallback: no point at -60 s, but one in the same minute as the timestamp.
  const same = tradeConditions(tradeInfoIndex(charts), { ...trade, opened_at: (T0 + 17) * 1000, closed_at: (T1 + 3) * 1000 });
  assert.equal(same.entry.entry_exec_tf, 3);
  assert.equal(same.exit.exit_reason, 1);
});

test('summary and entry lines use plain Chinese with 2 decimals; missing values are skipped', () => {
  const { entry } = tradeConditions(tradeInfoIndex(charts), trade);
  assert.equal(entrySummary(entry), '15m 判断 · 3m 入场 · SMA20');
  const rows = Object.fromEntries(entryLines(entry).map(r => [r.label, r.text]));
  assert.equal(rows['方向'], '做多');
  assert.equal(rows['趋势周期'], '15 分钟判断趋势');
  assert.equal(rows['入场周期'], '3 分钟找入场');
  assert.equal(rows['沿着的均线'], 'SMA20 = 81,600.12');
  assert.equal(rows['挂单'], '挂单价 81,500.00 · 均线外 0.10 ATR');
  assert.equal(rows['ATR'], '120.46');
  assert.equal(rows['趋势强度'], '效率比 0.62');      // ADX and stack not recorded
  assert.equal(rows['1h 过滤'], '偏空');
  assert.equal(rows['紧急止损价'], '80,000.00');
  assert.equal(rows['挂单创建'], '11-14 22:12:00 UTC'); // T0 - 180 + 60 s, same as the order created_at
  assert.deepEqual(entryLines({ entry_atr: 5 }), [{ label: 'ATR', text: '5.00' }]);
  assert.equal(entrySummary({ entry_exec_tf: 60 }), '1h 入场');
});

test('exit lines: reason by direction, only recorded prices shown', () => {
  const { exit } = tradeConditions(tradeInfoIndex(charts), trade);
  assert.deepEqual(exitLines(exit, trade), [
    { label: '原因', text: '碰布林上轨止盈' }, { label: '触发价位', text: '82,000.00' },
    { label: '布林上轨', text: '82,000.50' }]);
  assert.equal(exitReasonText(1, false), '碰布林下轨止盈');
  assert.equal(exitReasonText(2, true), '收盘跌破均线离场');
  assert.equal(exitReasonText(2, false), '收盘升破均线离场');
  assert.equal(exitReasonText(3), '紧急止损');
  assert.match(exitReasonText(4), /立即止盈/);
  assert.match(exitReasonText(9), /其他/);
  assert.match(exitReasonText(42), /其他/);
  assert.equal(exitLines(null, trade).length, 0);
});

test('old backtests without trade_info (or with junk) give empty results', () => {
  for (const c of [undefined, null, {}, { extra_charts: {} }, { extra_charts: { 'MA5 context': {} } },
    { extra_charts: { trade_info: {} } }, { extra_charts: { trade_info: { entry_side: { data: [{ time: 'x', value: 1 }, { time: T0, value: NaN }] } } } }]) {
    const index = tradeInfoIndex(c);
    assert.equal(index.empty, true);
    assert.deepEqual(tradeConditions(index, trade), { entry: null, exit: null });
  }
  assert.deepEqual(tradeConditions(tradeInfoIndex(charts), {}), { entry: null, exit: null });
  assert.equal(entrySummary(null), '');
});

test('showConditions defaults to expanded and survives old saved data', () => {
  assert.equal(restorePreferences(null).showConditions, true);
  assert.equal(restorePreferences(JSON.stringify({ version: 1 })).showConditions, true);
  assert.equal(restorePreferences(JSON.stringify({ version: 1, showConditions: false })).showConditions, false);
});
