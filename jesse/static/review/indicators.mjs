import { validateIndicator, INDICATORS } from './settings.mjs?v=20261028d';

// EMA starts from the first close, as in the installed Jesse Rust kernel.
// RSI and ATR use Wilder smoothing; MACD histogram is DIF−DEA, not 2×.
function ema(values, period) {
  let previous = values[0];
  return values.map((v, i) => previous = i ? previous + 2 / (period + 1) * (v - previous) : v);
}

function rolling(values, period, fn) {
  return values.map((_, i) => i + 1 < period ? null : fn(values.slice(i + 1 - period, i + 1)));
}

function segmentValues(bars, config) {
  const close = bars.map(c => c.close);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  switch (config.type) {
    case 'MAGROUP': return config.lines.filter(l => l.enabled)
      .map(l => config.mode === 'EMA' ? ema(close, l.period) : rolling(close, l.period, mean));
    case 'SMA': return [rolling(close, config.period, mean)];
    case 'EMA': return [ema(close, config.period)];
    case 'BOLL': {
      const mid = rolling(close, config.period, mean);
      const deviations = rolling(close, config.period, xs => {
        const average = mean(xs);
        return Math.sqrt(mean(xs.map(x => (x - average) ** 2)));
      });
      return [mid.map((v, i) => v === null ? null : v + config.deviation * deviations[i]), mid,
        mid.map((v, i) => v === null ? null : v - config.deviation * deviations[i])];
    }
    case 'RSI': {
      let gain = 0, loss = 0;
      return [close.map((v, i) => {
        if (!i) return null;
        const up = Math.max(v - close[i - 1], 0), down = Math.max(close[i - 1] - v, 0);
        if (i <= config.period) { gain += up / config.period; loss += down / config.period; }
        else { gain = (gain * (config.period - 1) + up) / config.period; loss = (loss * (config.period - 1) + down) / config.period; }
        if (i < config.period) return null;
        return loss === 0 ? 100 : 100 * gain / (gain + loss);
      })];
    }
    case 'ATR': {
      let average = 0;
      return [bars.map((c, i) => {
        const tr = i ? Math.max(c.high - c.low, Math.abs(c.high - bars[i - 1].close), Math.abs(c.low - bars[i - 1].close)) : c.high - c.low;
        average = i < config.period ? average + tr / config.period : (average * (config.period - 1) + tr) / config.period;
        return i + 1 < config.period ? null : average;
      })];
    }
    case 'MACD': {
      const fast = ema(close, config.fast), slow = ema(close, config.slow);
      const diff = close.map((_, i) => fast[i] - slow[i]);
      const signal = ema(diff, config.signal);
      return [diff, signal, diff.map((v, i) => v - signal[i])];
    }
    case 'VOLUME': return [bars.map(c => c.volume)];
  }
}

export function indicatorTitle(input) {
  const config = validateIndicator(input);
  if (config.type === 'MAGROUP') return `${config.mode === 'EMA' ? 'EMA' : 'MA'}(${config.lines.filter(l => l.enabled).map(l => l.period).join(',')})`;
  return config.type === 'VOLUME' ? '成交量' : `${config.type}(${Object.keys(INDICATORS[config.type].defaults).map(k => config[k]).join(',')})`;
}

export function calculateIndicator(candles, input, interval) {
  const config = validateIndicator(input);
  const enabled = config.type === 'MAGROUP' ? config.lines.filter(l => l.enabled) : [];
  const names = config.type === 'MAGROUP' ? enabled.map(l => `${config.mode}${l.period}`) : config.type === 'BOLL' ? ['上轨', '中轨', '下轨'] : config.type === 'MACD' ? ['DIF', 'DEA', '柱 DIF−DEA'] : [indicatorTitle(config)];
  const series = names.map((name, i) => ({ name,
    kind: config.type === 'VOLUME' || (config.type === 'MACD' && i === 2) ? 'histogram' : 'line',
    color: config.type === 'MAGROUP' ? enabled[i].color : config.color,
    dashed: config.type === 'BOLL' && i === 1, data: [] }));
  let segment = [];
  function flush() {
    if (!segment.length) return;
    const values = segmentValues(segment, config);
    series.forEach((line, i) => segment.forEach((c, j) => {
      const v = values[i][j];
      line.data.push(v === null || !Number.isFinite(v) ? { time: c.time } : { time: c.time, value: v });
    }));
    segment = [];
  }
  for (const candle of candles) {
    if (segment.length && candle.time !== segment.at(-1).time + interval * 60) flush();
    segment.push(candle);
  }
  flush();
  return { title: indicatorTitle(config), group: config.type === 'MAGROUP' ? { mode: config.mode, periods: enabled.map(l => l.period) } : undefined, pane: INDICATORS[config.type].pane,
    thresholds: config.type === 'RSI' ? [30, 70] : config.type === 'MACD' ? [0] : [], series };
}
