// Pure review calculations: timestamps are UTC seconds, except Jesse trade/order
// timestamps which are explicitly converted from milliseconds at the boundary.
export function aggregateCandles(source, interval) {
  if (!Number.isInteger(interval) || interval < 1) throw new Error('Invalid interval');
  const sorted = source.map(c => ({ ...c })).sort((a, b) => a.time - b.time);
  const buckets = new Map();
  let previous;
  for (const c of sorted) {
    if (!['time', 'open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(c[k]))) {
      throw new Error('Candle values must be finite');
    }
    if (c.time % 60) throw new Error('Expected UTC minute-aligned candles');
    if (c.time === previous) throw new Error('Duplicate candle timestamp');
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close) || c.volume < 0) {
      throw new Error('Invalid OHLC/volume');
    }
    previous = c.time;
    const start = Math.floor(c.time / (interval * 60)) * interval * 60;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(c);
  }
  const candles = [];
  let omittedBuckets = 0;
  for (const [time, bars] of buckets) {
    // Missing minutes and partial edges must not become believable full candles.
    if (bars.length !== interval || bars.some((c, i) => c.time !== time + i * 60)) {
      omittedBuckets++;
      continue;
    }
    candles.push({ time, open: bars[0].open, high: Math.max(...bars.map(c => c.high)),
      low: Math.min(...bars.map(c => c.low)), close: bars.at(-1).close,
      volume: bars.reduce((n, c) => n + c.volume, 0) });
  }
  return { candles, omittedBuckets };
}

export function sma(candles, period = 5, interval = 1) {
  const result = [];
  let window = [], previous;
  for (const c of candles) {
    // A missing candle makes a consecutive-period SMA unavailable until rewarmed.
    if (previous !== undefined && c.time !== previous + interval * 60) {
      window = [];
      if (result.length) result.push({ time: c.time });
    }
    previous = c.time;
    window.push(c.close);
    if (window.length > period) window.shift();
    if (window.length === period) result.push({ time: c.time, value: window.reduce((a, b) => a + b) / period });
  }
  return result;
}

export function lastClosedCandle(candles, interval, asOf) {
  let found = null;
  for (const c of candles) {
    if (c.time + interval * 60 > asOf) break;
    found = c;
  }
  return found;
}

export function contextAt(points, asOf, sourceInterval = 1) {
  let value = null;
  for (const point of points) {
    if (point.time + sourceInterval * 60 > asOf) break;
    if (Number.isFinite(point.value)) value = point.value;
  }
  return value;
}

export function executionMarkers(trades, candles, interval) {
  const available = new Set(candles.map(c => c.time));
  const markers = [];
  for (const trade of trades) {
    const isLong = trade.type === 'long';
    // Use actual fills, including partial fills; trade average prices are not
    // substitutes for an execution record. Pending/cancelled orders are omitted.
    for (const order of trade.orders ?? []) {
      if (order.status !== 'EXECUTED' || !Number.isFinite(order.executed_at)) continue;
      const time = Math.floor(order.executed_at / 1000 / (interval * 60)) * interval * 60;
      if (!available.has(time)) continue;
      const buy = order.side === 'buy';
      const action = order.reduce_only ? (isLong ? '平多' : '平空') : (isLong ? '开多' : '开空');
      markers.push({ time, position: buy ? 'belowBar' : 'aboveBar',
        color: order.reduce_only ? '#60748b' : '#2164d5',
        shape: buy ? 'arrowUp' : 'arrowDown', text: `${action} ${order.price.toFixed(2)}` });
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

export function centeredRange(anchor, seconds) {
  // Three quarters before the selected event leave room to inspect its setup.
  return { from: anchor - seconds * 0.75, to: anchor + seconds * 0.25 };
}

export function contextPointsFor(charts) {
  return [...(charts?.extra_charts?.['MA5 context']?.['Selected minutes']?.data ?? [])]
    .sort((a, b) => a.time - b.time);
}

export function linkTimeRanges(panels, onChange = () => {}) {
  let active = null;
  function apply(range, source) {
    if (!range || typeof range.from !== 'number' || typeof range.to !== 'number') return;
    for (const panel of panels) {
      if (panel !== source) panel.chart.timeScale().setVisibleRange(range);
    }
  }
  for (const panel of panels) panel.chart.timeScale().subscribeVisibleTimeRangeChange(range => {
    onChange(panel);
    // The chart emits after drawing, outside the setVisibleRange call stack.
    // Only a panel activated by a real pointer/wheel gesture may drive peers;
    // their rounded, asynchronous programmatic updates never feed back.
    if (panel === active) apply(range, panel);
  });
  return {
    activate(panel) { active = panel; },
    set(range) { active = null; apply(range, null); },
  };
}
