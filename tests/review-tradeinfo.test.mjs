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

test('top-down fields: top direction row, summary prefix, hour names', () => {
  const T = 1_700_000_040;
  const s = points => ({ data: points.map(([time, value]) => ({ time, value })) });
  const c = { extra_charts: { trade_info: {
    entry_top_tf: s([[T, 240]]), entry_top_dir: s([[T, 1]]), entry_top_stack: s([[T, 0.75]]),
    entry_trend_tf: s([[T, 60]]), entry_exec_tf: s([[T, 15]]), entry_ma_period: s([[T, 20]]),
  } } };
  const { entry } = tradeConditions(tradeInfoIndex(c), { opened_at: (T + 60) * 1000 });
  assert.equal(entrySummary(entry), '4h 定方向 · 1h 判断 · 15m 入场 · SMA20');
  const rows = entryLines(entry);
  assert.deepEqual(rows.slice(0, 3).map(r => r.label), ['顶层方向', '趋势周期', '入场周期']);
  assert.equal(rows[0].text, '4 小时定方向：多（均线排列 0.75）');
  assert.equal(rows[1].text, '1 小时判断趋势');
  assert.equal(rows[2].text, '15 分钟找入场');
  assert.equal(entryLines({ entry_top_tf: 240, entry_top_dir: -1 })[0].text, '4 小时定方向：空');
  assert.equal(entrySummary({ entry_trend_tf: 240 }), '4h 判断');
  assert.equal(entrySummary({ entry_trend_tf: 90 }), '90m 判断');
});

test('without top fields nothing about the top level is shown', () => {
  const entry = { entry_side: 1, entry_trend_tf: 15, entry_exec_tf: 3 };
  assert.ok(!entryLines(entry).some(r => r.label === '顶层方向'));
  assert.equal(entrySummary(entry), '15m 判断 · 3m 入场');
});

test('head-on MA and pin fields: entry rows, direction wording, hidden when absent', () => {
  const long = { entry_side: 1, entry_headon_tf: 240, entry_headon_period: 100, entry_headon_value: 80852.4, entry_pin_tf: 60 };
  const rows = Object.fromEntries(entryLines(long).map(r => [r.label, r.text]));
  assert.equal(rows['迎头均线'], '4 小时 SMA100 = 80,852.40（上方，向下压）');
  assert.equal(rows['插针判断'], '1 小时');
  const short = Object.fromEntries(entryLines({ ...long, entry_side: -1, entry_pin_tf: 15 }).map(r => [r.label, r.text]));
  assert.equal(short['迎头均线'], '4 小时 SMA100 = 80,852.40（下方，向上托）');
  assert.equal(short['插针判断'], '15 分钟');
  const noSide = Object.fromEntries(entryLines({ entry_headon_tf: 60, entry_headon_period: 20, entry_headon_value: 5 }).map(r => [r.label, r.text]));
  assert.equal(noSide['迎头均线'], '1 小时 SMA20 = 5.00');
  for (const side of [1, -1]) {
    const absent = Object.fromEntries(entryLines({ entry_side: side, entry_headon_tf: 240 }).map(r => [r.label, r.text]));
    assert.equal(absent['迎头均线'], '4 小时：入场时没有迎头均线');
  }
  const none = entryLines({ entry_side: 1, entry_atr: 5 }).map(r => r.label);
  assert.ok(!none.includes('迎头均线') && !none.includes('插针判断'));
});

test('exit reasons 5 and 6 with head-on value and pin candle prices', () => {
  assert.equal(exitReasonText(5, true), '触及迎头均线止盈');
  assert.equal(exitReasonText(5, false), '触及迎头均线止盈');
  assert.equal(exitReasonText(6, true), '插针冲出布林上轨后离场');
  assert.equal(exitReasonText(6, false), '插针冲出布林下轨后离场');
  assert.match(exitReasonText(6), /插针冲出布林外轨/);
  assert.deepEqual(exitLines({ exit_reason: 5, exit_trigger_price: 80852.4, exit_headon_value: 80852.4 }, { type: 'long' }), [
    { label: '原因', text: '触及迎头均线止盈' }, { label: '触发价位', text: '80,852.40' }, { label: '迎头均线', text: '80,852.40' }]);
  assert.deepEqual(exitLines({ exit_reason: 6, exit_trigger_price: 82000, exit_pin_high: 82500, exit_pin_low: 81900 }, { type: 'short' }), [
    { label: '原因', text: '插针冲出布林下轨后离场' }, { label: '触发价位', text: '82,000.00' },
    { label: '插针最高价', text: '82,500.00' }, { label: '插针最低价', text: '81,900.00' }]);
  assert.ok(!exitLines({ exit_reason: 1 }, { type: 'long' }).some(r => r.label === '迎头均线'));
});
