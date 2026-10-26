export const STORAGE_KEY = 'jesse.review.display.v1';
export const TIMEFRAMES = [1, 3, 5, 15, 30, 45, 60, 120, 180, 240, 360, 480, 720, 1440];
export const INDICATORS = {
  SMA: { label: 'SMA 简单均线', pane: 'main', defaults: { period: 5 }, color: '#dd9a23' },
  EMA: { label: 'EMA 指数均线', pane: 'main', defaults: { period: 20 }, color: '#8b5dc8' },
  BOLL: { label: 'BOLL 布林带', pane: 'main', defaults: { period: 20, deviation: 2 }, color: '#5488c9' },
  RSI: { label: 'RSI 相对强弱', pane: 'extra', defaults: { period: 14 }, color: '#8b5dc8' },
  MACD: { label: 'MACD', pane: 'extra', defaults: { fast: 12, slow: 26, signal: 9 }, color: '#377cc6' },
  ATR: { label: 'ATR 平均真实波幅', pane: 'extra', defaults: { period: 14 }, color: '#da9441' },
  VOLUME: { label: '成交量', pane: 'extra', defaults: {}, color: '#16a082' },
};

export function timeframeLabel(minutes) {
  return minutes === 1440 ? '1D' : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function timeframeMinutes(value) {
  const match = /^(\d+)(m|h|D)$/.exec(value ?? '');
  if (!match) return null;
  const n = Number(match[1]) * ({ m: 1, h: 60, D: 1440 })[match[2]];
  return TIMEFRAMES.includes(n) ? n : null;
}

export function configuredIntervals(form, route) {
  return [...new Set([...(form.routes ?? []), ...(form.data_routes ?? [])]
    .filter(r => r.exchange === route.exchange && r.symbol === route.symbol)
    .map(r => timeframeMinutes(r.timeframe)).filter(n => n !== null))].sort((a, b) => a - b);
}

export function chooseIntervals(configured) {
  // Smallest timeframe first.
  return [...new Set(configured)].sort((a, b) => a - b);
}

export function validateIndicator(input) {
  const definition = Object.hasOwn(INDICATORS, input?.type ?? '') ? INDICATORS[input.type] : null;
  if (!definition) throw new Error('不支持的指标类型');
  const color = input.color ?? definition.color;
  if (typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color)) throw new Error('颜色必须是有效的十六进制颜色');
  const output = { type: input.type };
  for (const [key, fallback] of Object.entries(definition.defaults)) {
    const value = input[key] ?? fallback;
    if (!Number.isFinite(value) || value <= 0 || value > (key === 'deviation' ? 10 : 5000)
      || (key !== 'deviation' && !Number.isInteger(value))) throw new Error('周期必须为 1–5000 的整数；标准差倍数需大于 0 且不超过 10');
    output[key] = value;
  }
  if (output.type === 'MACD' && output.fast >= output.slow) throw new Error('MACD 快线周期必须小于慢线周期');
  output.color = color;
  return output;
}

export function restorePreferences(serialized) {
  const defaults = () => ({ version: 1, intervals: null, showPanes: true, indicators: [validateIndicator({ type: 'SMA' })] });
  try {
    const value = JSON.parse(serialized);
    if (value?.version !== 1) return defaults();
    const intervals = Array.isArray(value.intervals) && value.intervals.length > 0
      && value.intervals.every(n => TIMEFRAMES.includes(n))
      ? [...new Set(value.intervals)].sort((a, b) => a - b) : null;
    // Bound saved configurations to keep accidental huge storage values from
    // creating hundreds of expensive charts. The UI uses the same limit.
    const indicators = Array.isArray(value.indicators) && value.indicators.length <= 10
      ? value.indicators.map(validateIndicator) : defaults().indicators;
    // Sub-charts are shown unless the user switched them off.
    return { version: 1, intervals, showPanes: value.showPanes !== false, indicators };
  } catch { return defaults(); }
}
