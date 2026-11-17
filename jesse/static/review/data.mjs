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

// Links the time axes of several charts. Peers follow WHERE a chart looks (time position) but each chart keeps
// its own zoom (how many seconds it shows), so zooming one timeframe does not resize the candles of the others.
// Views in the same group (a main chart and its indicator panes, via groupOf) share the exact range so they stay
// aligned. set(range) gives every chart exactly that range (a new window choice / a fresh build);
// set(range, { keepSpan: true, at }) moves every chart so the moment at fraction `at` of `range` sits at the
// same fraction of its own span (selecting a trade/signal keeps each chart's zoom).
// rightPad: empty bars a follower may show right of its newest bar (the market page keeps 4, see showNewest).
export function linkTimeRanges(panels, onChange = () => {}, groupOf = panel => panel, { rightPad = 4 } = {}) {
  let active = null;
  const spans = new Map(); // group -> seconds that group shows (set by set() and by the user's own zoom)
  const valid = range => range && typeof range.from === 'number' && typeof range.to === 'number' && range.to > range.from;
  function place(panel, range, at) {
    const width = range.to - range.from;
    const span = spans.get(groupOf(panel)) ?? width;
    const anchor = range.from + width * at;
    panel.chart.timeScale().setVisibleRange({ from: anchor - span * at, to: anchor - span * at + span });
  }
  // Dragging or wheel-zooming one chart moves the others by bars, not by seconds: each peer keeps exactly the
  // number of bars it shows (its candle width never changes, 2026-11-15) and only scrolls. The moment that lines up
  // is the one under the pointer: the wheel zooms around the pointer, so that moment stays put on the zoomed chart
  // and the other charts do not move at all; a drag carries it along with the pointer and the others follow. A peer
  // puts that moment at the same fraction of its own width. Needs candles (`panel.candles` + `panel.interval`
  // minutes, or the same on `panel.panel`); without them, place() by seconds as before.
  const ownerOf = panel => (panel.candles ? panel : panel.panel);
  const stepOf = panel => (ownerOf(panel)?.interval ?? 0) * 60;
  // Bar position (fractional, may lie past either end) of a moment, and the moment of a bar position.
  function indexAt(panel, time) {
    const candles = ownerOf(panel)?.candles, step = stepOf(panel);
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles[mid].time <= time) lo = mid; else hi = mid - 1; }
    return lo + (time - candles[lo].time) / step;
  }
  function timeAt(panel, logical) {
    const candles = ownerOf(panel)?.candles, step = stepOf(panel);
    const i = Math.max(0, Math.min(candles.length - 1, Math.floor(logical)));
    return candles[i].time + (logical - i) * step;
  }
  const usable = panel => ownerOf(panel)?.candles?.length && stepOf(panel) && panel.chart.timeScale().getVisibleLogicalRange;
  let pointerX = null; // px from the left of the active chart, while the pointer is on it
  // The moment to line up and where it sits (0 left … 1 right) on the active chart, or null.
  function anchorOf(panel) {
    if (!usable(panel)) return null;
    const scale = panel.chart.timeScale();
    const width = scale.width?.() ?? 0;
    const current = scale.getVisibleLogicalRange();
    if (!current) return null;
    if (Number.isFinite(pointerX) && width > 0 && pointerX >= 0 && pointerX <= width) {
      const logical = scale.coordinateToLogical?.(pointerX);
      if (Number.isFinite(logical)) return { time: timeAt(panel, logical), at: pointerX / width };
    }
    return { time: timeAt(panel, (current.from + current.to) / 2), at: 0.5 };
  }
  function follow(peer, anchor) {
    if (!anchor || !usable(peer)) return false;
    const scale = peer.chart.timeScale();
    const current = scale.getVisibleLogicalRange();
    if (!current) return false;
    const index = indexAt(peer, anchor.time), width = current.to - current.from;
    // A follower never scrolls past its own newest bar plus the right pad (2026-11-17): dragging a higher timeframe
    // in its empty future space puts a moment hours ahead under the pointer, and lining that moment up would push a
    // lower timeframe's every bar off its left edge. It stops with its newest bars on screen instead.
    const newest = ownerOf(peer).candles.length + rightPad;
    let from = index - width * anchor.at;
    const maxTo = Math.max(newest, current.to);
    if (from + width > maxTo) from = maxTo - width;
    scale.setVisibleLogicalRange({ from, to: from + width });
    return true;
  }
  for (const panel of panels) panel.chart.timeScale().subscribeVisibleTimeRangeChange(range => {
    // The second argument is the range only when a user gesture on this panel caused it.
    onChange(panel, panel === active ? range : null);
    // The chart emits after drawing, outside the setVisibleRange call stack.
    // Only a panel activated by a real pointer/wheel gesture may drive peers;
    // their rounded, asynchronous programmatic updates never feed back.
    if (panel !== active || !valid(range)) return;
    const group = groupOf(panel);
    spans.set(group, range.to - range.from);
    const anchor = anchorOf(panel);
    for (const peer of panels) {
      if (peer === panel) continue;
      if (groupOf(peer) === group) peer.chart.timeScale().setVisibleRange(range);
      else if (!follow(peer, anchor)) place(peer, range, 0.5);
    }
  });
  return {
    // x: the pointer's px from the chart's left edge (pointerdown / wheel / move while pressed), so a gesture lines
    // the charts up at the moment under the pointer; omitted = the middle of the chart.
    activate(panel, x = null) { active = panel; pointerX = x; },
    pointer(panel, x) { if (panel === active) pointerX = x; },
    set(range, { keepSpan = false, at = 0.5 } = {}) {
      active = null;
      if (!valid(range)) return;
      // A chart the user has not zoomed yet takes this range's span (also on the first, keepSpan, placement).
      for (const panel of panels) if (!keepSpan || !spans.has(groupOf(panel))) spans.set(groupOf(panel), range.to - range.from);
      for (const panel of panels) place(panel, range, at);
    },
  };
}
