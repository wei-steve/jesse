// Pure helpers for the per-trade entry/exit conditions that a strategy records in
// chart_data.strategy_charts.extra_charts.trade_info (one series per field, one
// point per event on the 1m candle where the event happened; values are numbers).
// A point's time is the opening time of the 1m candle; the trade's opened_at / closed_at is that
// candle's close time in ms, so the point is at (ms / 1000 - 60). If that exact second has no
// point, the point in the same UTC minute as the trade timestamp is used.
const minuteOf = seconds => Math.floor(seconds / 60);
const finite = value => Number.isFinite(value);

export function tradeInfoIndex(charts) {
  const series = charts?.extra_charts?.trade_info;
  const byMinute = new Map(), byTime = new Map();
  if (!series || typeof series !== 'object') return { byMinute, byTime, empty: true };
  for (const [name, line] of Object.entries(series)) {
    const data = Array.isArray(line?.data) ? line.data : [];
    for (const point of data) {
      if (!finite(point?.time) || !finite(point?.value)) continue;
      const minute = minuteOf(point.time);
      if (!byTime.has(point.time)) byTime.set(point.time, {});
      byTime.get(point.time)[name] = point.value;
      if (!byMinute.has(minute)) byMinute.set(minute, {});
      byMinute.get(minute)[name] = point.value;
    }
  }
  return { byMinute, byTime, empty: byMinute.size === 0 };
}

// Trade timestamps are milliseconds. Returns null when nothing is recorded at that minute
// or the minute holds no field of the wanted kind (entry_* / exit_*).
function infoAt(index, ms, prefix) {
  if (!index || !finite(ms)) return null;
  const pick = all => {
    const picked = {};
    for (const [name, value] of Object.entries(all ?? {})) if (name.startsWith(prefix)) picked[name] = value;
    return Object.keys(picked).length ? picked : null;
  };
  return pick(index.byTime.get(Math.round(ms / 1000) - 60)) ?? pick(index.byMinute.get(minuteOf(ms / 1000)));
}

export function tradeConditions(index, trade) {
  return {
    entry: infoAt(index, trade?.opened_at, 'entry_'),
    exit: infoAt(index, trade?.closed_at, 'exit_'),
  };
}

const fixed = value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utc = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 19) + ' UTC';
const tfText = minutes => minutes === 1440 ? '1D' : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

// Short text for the top line, e.g. "15m 判断 · 3m 入场 · SMA20". Empty string when unknown.
export function entrySummary(entry) {
  if (!entry) return '';
  const parts = [];
  if (finite(entry.entry_trend_tf)) parts.push(`${tfText(entry.entry_trend_tf)} 判断`);
  if (finite(entry.entry_exec_tf)) parts.push(`${tfText(entry.entry_exec_tf)} 入场`);
  if (finite(entry.entry_ma_period)) parts.push(`SMA${entry.entry_ma_period}`);
  return parts.join(' · ');
}

// Plain-Chinese rows [{ label, text }]; fields that were not recorded are skipped.
export function entryLines(entry) {
  if (!entry) return [];
  const rows = [];
  const add = (label, text) => { if (text) rows.push({ label, text }); };
  if (finite(entry.entry_side)) add('方向', entry.entry_side > 0 ? '做多' : entry.entry_side < 0 ? '做空' : '');
  if (finite(entry.entry_trend_tf)) add('趋势周期', `${entry.entry_trend_tf} 分钟判断趋势`);
  if (finite(entry.entry_exec_tf)) add('入场周期', `${entry.entry_exec_tf} 分钟找入场`);
  if (finite(entry.entry_ma_period) || finite(entry.entry_ma_value)) {
    const name = finite(entry.entry_ma_period) ? `SMA${entry.entry_ma_period}` : '均线';
    add('沿着的均线', finite(entry.entry_ma_value) ? `${name} = ${fixed(entry.entry_ma_value)}` : name);
  }
  if (finite(entry.entry_limit_price) || finite(entry.entry_offset_atr)) {
    const parts = [];
    if (finite(entry.entry_limit_price)) parts.push(`挂单价 ${fixed(entry.entry_limit_price)}`);
    if (finite(entry.entry_offset_atr)) parts.push(`均线外 ${fixed(entry.entry_offset_atr)} ATR`);
    add('挂单', parts.join(' · '));
  }
  if (finite(entry.entry_atr)) add('ATR', fixed(entry.entry_atr));
  const strength = [];
  if (finite(entry.entry_trend_er)) strength.push(`效率比 ${fixed(entry.entry_trend_er)}`);
  if (finite(entry.entry_trend_adx)) strength.push(`ADX ${fixed(entry.entry_trend_adx)}`);
  if (finite(entry.entry_trend_stack)) strength.push(`均线排列 ${fixed(entry.entry_trend_stack)}`);
  add('趋势强度', strength.join(' · '));
  if (finite(entry.entry_filter_1h)) {
    add('1h 过滤', entry.entry_filter_1h > 0 ? '偏多' : entry.entry_filter_1h < 0 ? '偏空' : '中性');
  }
  if (finite(entry.entry_order_created)) add('挂单创建', utc(entry.entry_order_created));
  if (finite(entry.entry_stop)) add('紧急止损价', fixed(entry.entry_stop));
  return rows;
}

export function exitReasonText(code, isLong) {
  switch (code) {
    case 1: return isLong === undefined ? '碰布林外轨止盈' : isLong ? '碰布林上轨止盈' : '碰布林下轨止盈';
    case 2: return isLong === undefined ? '收盘穿过均线离场' : isLong ? '收盘跌破均线离场' : '收盘升破均线离场';
    case 3: return '紧急止损';
    case 4: return '成交时已在外轨外，立即止盈';
    default: return '其他（例如回测结束强平）';
  }
}

export function exitLines(exit, trade) {
  if (!exit) return [];
  const isLong = trade?.type === 'long' ? true : trade?.type === 'short' ? false : undefined;
  const rows = [{ label: '原因', text: exitReasonText(exit.exit_reason, isLong) }];
  const add = (label, value) => { if (finite(value)) rows.push({ label, text: fixed(value) }); };
  add('触发价位', exit.exit_trigger_price);
  add('当时均线', exit.exit_ma_value);
  add('布林上轨', exit.exit_bb_upper);
  add('布林下轨', exit.exit_bb_lower);
  add('收盘价', exit.exit_close);
  return rows;
}
