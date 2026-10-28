// Pure helpers for "signal mode": a backtest that trades nothing and only writes, per timeframe, a step
// series `extra_charts.ride` (+N riding up along SMA N, -N down, 0 none) and `extra_charts.ride_touches`
// (pullback count, display only). No rule is hard-coded here; the page just draws what the series say.
// Point time is a 1m candle OPEN time (seconds); the value is known at time + 60.

const UNIT_MINUTES = { m: 1, h: 60, d: 1440, w: 10080 };

// "15m" -> 15, "1h" -> 60. Anything else is not a timeframe series and is ignored.
export function titleMinutes(title) {
  const match = /^(\d+)([mhdw])$/i.exec(String(title ?? '').trim());
  const minutes = match ? Number(match[1]) * UNIT_MINUTES[match[2].toLowerCase()] : NaN;
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

const finite = n => typeof n === 'number' && Number.isFinite(n);

function pointsOf(line) {
  const byTime = new Map();
  for (const p of Array.isArray(line?.data) ? line.data : []) if (finite(p?.time) && finite(p?.value)) byTime.set(p.time, p.value);
  return [...byTime].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

// One entry per timeframe title found in extra_charts.ride, longest timeframe first.
export function rideSeries(extraCharts) {
  const rideLines = extraCharts?.ride, touchLines = extraCharts?.ride_touches;
  if (!rideLines || typeof rideLines !== 'object') return [];
  const result = [];
  for (const [title, line] of Object.entries(rideLines)) {
    const minutes = titleMinutes(title);
    const points = pointsOf(line);
    if (minutes === null || !points.length) continue;
    result.push({ title, minutes, points, touches: pointsOf(touchLines?.[title]) });
  }
  return result.sort((a, b) => b.minutes - a.minutes);
}

// Index of the last element with time <= t (binary search), or -1.
function lastAtOrBefore(points, t) {
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Step value in force at time t (0 before the first point).
export function valueAt(points, t) {
  const i = lastAtOrBefore(points, t);
  return i < 0 ? 0 : points[i].value;
}

// Merges consecutive same-direction non-zero values of one timeframe into riding intervals
// [start, end). A change of SMA period inside the same direction does NOT split the interval; the periods
// used are kept in order (`segments`, `periods`). The interval ends at the next point that is 0 or of the
// opposite direction (`ended` true), or at `endTime` (the end of the backtest) if the value never changes
// again (`ended` false). `bars` counts timeframe bars (at least 1, rounded).
export function mergeRides(series, endTime) {
  const out = [];
  let run = null;
  const close = (end, ended) => {
    const touches = series.touches;
    let max = 0;
    const from = Math.max(0, lastAtOrBefore(touches, run.start)), to = lastAtOrBefore(touches, end - 1);
    for (let i = from; i <= to; i++) if (touches[i].time <= end - 1 && touches[i].value > max) max = touches[i].value;
    out.push({ tf: series.title, minutes: series.minutes, dir: run.dir, start: run.start, end, ended,
      segments: run.segments, periods: run.segments.map(s => s.period), maxTouches: max,
      bars: Math.max(1, Math.round((end - run.start) / (series.minutes * 60))) });
    run = null;
  };
  for (const { time, value } of series.points) {
    const dir = Math.sign(value);
    if (run && run.dir !== dir) close(time, true);
    if (!dir) continue;
    const period = Math.abs(value);
    if (!run) run = { dir, start: time, segments: [{ time, period }] };
    else if (run.segments.at(-1).period !== period) run.segments.push({ time, period });
  }
  if (run) close(Math.max(endTime ?? 0, run.start + 60), false);
  return out;
}

// All intervals of all timeframes, ordered by start time (ties: longer timeframe first).
export function buildRides(extraCharts, endTime) {
  const rides = rideSeries(extraCharts).flatMap(series => mergeRides(series, endTime));
  return rides.sort((a, b) => a.start - b.start || b.minutes - a.minutes);
}

// "MA10→MA20"; a repeated period is not repeated.
export const maText = periods => periods.map(p => `MA${p}`).join('→');
export const arrow = dir => dir > 0 ? '↑' : '↓';

// Duration for the list, e.g. "12 根".
export const barsText = ride => `${ride.bars} 根`;

// Which timeframes are shown in the list (a Set of titles; null = all).
export function filterRides(rides, shown) {
  return shown ? rides.filter(r => shown.has(r.tf)) : rides;
}

// Previous/next ride in a (filtered, start-ordered) list. When `current` is not in the list (it was filtered
// out) the neighbour is the nearest ride after/before its start time. null at the ends.
export function neighbour(rides, current, step) {
  const i = rides.indexOf(current);
  if (i >= 0) return rides[i + step] ?? null;
  if (!current) return null;
  if (step > 0) return rides.find(r => r.start > current.start) ?? null;
  return rides.findLast(r => r.start < current.start) ?? null;
}

// Status of every timeframe at time t (1m open seconds): "1h ↑MA20 · 15m — · ...", plus advice that names
// the timeframes behind it: "1h、5m 向上 → 不宜做空；3m 向下 → 不宜做多" (list order = series order).
export function signalStatus(seriesList, t) {
  const upTfs = [], downTfs = [];
  const parts = seriesList.map(series => {
    const value = valueAt(series.points, t);
    if (value > 0) upTfs.push(series.title); else if (value < 0) downTfs.push(series.title);
    return `${series.title} ${value ? `${arrow(value)}MA${Math.abs(value)}` : '—'}`;
  });
  const advice = [upTfs.length && `${upTfs.join('、')} 向上 → 不宜做空`, downTfs.length && `${downTfs.join('、')} 向下 → 不宜做多`]
    .filter(Boolean).join('；');
  return { text: parts.join(' · '), advice, up: upTfs.length > 0, down: downTfs.length > 0 };
}

// Candle index (in a time-sorted candle array of `minutes`-minute bars) of the last bar closed at or before
// `asOf`; -1 if none.
export function closedIndex(candles, minutes, asOf) {
  let lo = 0, hi = candles.length - 1, found = -1;
  const span = minutes * 60;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + span <= asOf) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Where an interval lands on this timeframe's candles. The value written at 1m open time t is known at
// t + 60, so the first riding bar is the last bar closed by then. An interval that ended (value 0 or
// reversed) at time e stops before the bar closed by e + 60, because that bar no longer shows the ride;
// one running to the end of the backtest covers the last candle. Returns null when no bar is involved.
export function rideSpan(candles, ride) {
  const first = closedIndex(candles, ride.minutes, ride.start + 60);
  if (first < 0) return null;
  const last = ride.ended ? Math.max(first, closedIndex(candles, ride.minutes, ride.end + 60) - 1) : candles.length - 1;
  return { first, last: Math.max(first, last) };
}

// Chart annotations of the rides of ONE timeframe (`rides` must all be of that timeframe) on its candles.
//  markers: one per interval, at its first bar ("MA10↑" green below, "MA10↓" red above).
//  lines:   { up: [[...], ...], down: [[...], ...] } one line-series data array PER INTERVAL. The charting
//           library connects consecutive points of a series (a whitespace point does not break the line), so
//           intervals must be separate series to stay apart. Each bar carries the SMA of the period in force
//           when that bar closed (it changes with the periods); bars without an SMA value (warm-up) are left
//           out; an interval with fewer than two drawable bars has no line. `smaFor(period)` returns
//           Map(time -> value) for that period.
export function rideAnnotations(candles, rides, smaFor) {
  const markers = [], lines = { up: [], down: [] };
  for (const ride of rides) {
    const span = rideSpan(candles, ride);
    if (!span) continue;
    const up = ride.dir > 0;
    markers.push({ time: candles[span.first].time, position: up ? 'belowBar' : 'aboveBar',
      color: up ? '#16a082' : '#dd6070', shape: up ? 'arrowUp' : 'arrowDown', text: `MA${ride.periods[0]}${arrow(ride.dir)}` });
    const data = [];
    let seg = 0;
    for (let i = span.first; i <= span.last; i++) {
      const known = candles[i].time + ride.minutes * 60 - 60;
      while (seg + 1 < ride.segments.length && ride.segments[seg + 1].time <= known) seg++;
      const value = smaFor(ride.segments[seg].period).get(candles[i].time);
      if (Number.isFinite(value)) data.push({ time: candles[i].time, value });
    }
    if (data.length >= 2) (up ? lines.up : lines.down).push(data);
  }
  return { markers: markers.sort((a, b) => a.time - b.time), lines };
}

// All ride lines of one chart as ONE line series. A chart with one series per interval froze the page on long
// ranges (tens of thousands of series), and this chart library joins every pair of consecutive points of a
// series. So the intervals are concatenated and the joining segment is hidden: in the bundled Lightweight
// Charts v4 the segment from a point to the next one is drawn with the STARTING point's `color` (checked by
// sampling canvas pixels on 2026-10-28), so the last point of every interval is made transparent. Points with
// a time not after the previous one are dropped (the library needs strictly increasing times).
export const HIDDEN = 'rgba(0,0,0,0)';
export function joinRideLines(lines, colors) {
  const parts = [...lines.up.map(data => [data, colors.up]), ...lines.down.map(data => [data, colors.down])]
    .sort((a, b) => a[0][0].time - b[0][0].time);
  const out = [];
  let last = -Infinity;
  for (const [data, color] of parts) {
    let kept = 0;
    for (const p of data) {
      if (p.time <= last) continue;
      out.push({ time: p.time, value: p.value, color });
      kept++; last = p.time;
    }
    // the segment leaving this interval's last point goes to the next interval: hide it
    if (kept) out[out.length - 1].color = HIDDEN;
  }
  return out;
}
