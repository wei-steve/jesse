import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { titleMinutes, rideSeries, mergeRides, buildRides, maText, filterRides, neighbour, signalStatus, valueAt, closedIndex, rideSpan, rideAnnotations } from '../jesse/static/review/rides.mjs';

const real = JSON.parse(readFileSync(new URL('./fixtures/review-ride-extra-charts.json', import.meta.url), 'utf8'));
const line = pairs => ({ data: pairs.map(([time, value]) => ({ time, value })) });
const series = (title, pairs, touches = []) => rideSeries({ ride: { [title]: line(pairs) }, ride_touches: { [title]: line(touches) } })[0];

test('timeframe titles are parsed to minutes, not hard-coded', () => {
  assert.equal(titleMinutes('15m'), 15);
  assert.equal(titleMinutes('1h'), 60);
  assert.equal(titleMinutes('4h'), 240);
  assert.equal(titleMinutes('1D'), 1440);
  for (const bad of ['', 'x', '0m', '1.5h', null, 'ride']) assert.equal(titleMinutes(bad), null);
});

test('rideSeries keeps valid timeframes, longest first, and ignores unknown titles', () => {
  const got = rideSeries({ ride: { '3m': line([[0, 5]]), '1h': line([[0, 7]]), junk: line([[0, 1]]), '5m': { data: [] } } });
  assert.deepEqual(got.map(s => s.title), ['1h', '3m']);
  assert.deepEqual(rideSeries({}), []);
  assert.deepEqual(rideSeries(undefined), []);
});

test('same-direction values merge into one interval; period changes do not split it', () => {
  // 3m: up MA10 at 0, up MA20 at 600, none at 1200, down MA5 at 1500 until the end.
  const s = series('3m', [[0, 10], [600, 20], [1200, 0], [1500, -5]], [[0, 2], [600, 4], [1200, 0], [1500, 3]]);
  const rides = mergeRides(s, 3600);
  assert.equal(rides.length, 2);
  assert.deepEqual(rides[0], { tf: '3m', minutes: 3, dir: 1, start: 0, end: 1200, ended: true,
    segments: [{ time: 0, period: 10 }, { time: 600, period: 20 }], periods: [10, 20], maxTouches: 4, bars: 7 });
  assert.equal(maText(rides[0].periods), 'MA10→MA20');
  assert.equal(rides[1].dir, -1);
  assert.equal(rides[1].start, 1500);
  assert.equal(rides[1].end, 3600);
  assert.equal(rides[1].ended, false);
  assert.equal(rides[1].maxTouches, 3);
});

test('a reversal ends the interval and starts the opposite one at the same point', () => {
  const rides = mergeRides(series('5m', [[0, 7], [300, -7], [900, 0]]), 5000);
  assert.deepEqual(rides.map(r => [r.dir, r.start, r.end, r.ended]), [[1, 0, 300, true], [-1, 300, 900, true]]);
});

test('repeated points with the same value and zero-only series give no extra intervals', () => {
  assert.equal(mergeRides(series('5m', [[0, 0], [300, 0]]), 1000).length, 0);
  const rides = mergeRides(series('5m', [[0, 7], [300, 7], [600, 7], [900, 0]]), 1000);
  assert.equal(rides.length, 1);
  assert.deepEqual(rides[0].periods, [7]);
});

test('an interval running to the end uses endTime, and is never shorter than one minute', () => {
  assert.equal(mergeRides(series('1h', [[100, 20]]), 7300)[0].end, 7300);
  assert.equal(mergeRides(series('1h', [[100, 20]]), undefined)[0].end, 160);
  assert.equal(mergeRides(series('1h', [[100, 20]]), 10)[0].end, 160);
});

test('bar count follows the timeframe length and is at least 1', () => {
  assert.equal(mergeRides(series('15m', [[0, 5], [900 * 4, 0]]), 1)[0].bars, 4);
  assert.equal(mergeRides(series('1h', [[0, 5], [60, 0]]), 1)[0].bars, 1);
});

test('buildRides orders by start time across timeframes; filter and neighbours', () => {
  const rides = buildRides({ ride: { '1h': line([[300, 20], [3900, 0]]), '3m': line([[60, -5], [200, 0]]), '5m': line([[300, 7], [600, 0]]) } }, 9999);
  assert.deepEqual(rides.map(r => `${r.tf}@${r.start}`), ['3m@60', '1h@300', '5m@300']);
  const only = filterRides(rides, new Set(['1h', '5m']));
  assert.deepEqual(only.map(r => r.tf), ['1h', '5m']);
  assert.equal(filterRides(rides, null), rides);
  assert.equal(neighbour(only, only[0], 1), only[1]);
  assert.equal(neighbour(only, only[1], 1), null);
  assert.equal(neighbour(only, only[0], -1), null);
  // a ride that is filtered out: nearest by start time
  assert.equal(neighbour(only, rides[0], 1), only[0]);
  assert.equal(neighbour(only, rides[0], -1), null);
  assert.equal(neighbour(only, rides[2], -1), only[0]);
  assert.equal(neighbour(only, null, 1), null);
});

test('status line lists every timeframe and gives the advice', () => {
  const list = rideSeries({ ride: { '1h': line([[0, 20]]), '15m': line([[0, 5], [500, 0]]), '5m': line([[0, 10]]), '3m': line([[0, -5]]) } });
  let s = signalStatus(list, 100);
  assert.equal(s.text, '1h ↑MA20 · 15m ↑MA5 · 5m ↑MA10 · 3m ↓MA5');
  assert.equal(s.advice, '1h、15m、5m 向上 → 不宜做空；3m 向下 → 不宜做多');
  s = signalStatus(list, 600);
  assert.equal(s.text, '1h ↑MA20 · 15m — · 5m ↑MA10 · 3m ↓MA5');
  assert.equal(s.advice, '1h、5m 向上 → 不宜做空；3m 向下 → 不宜做多');
  s = signalStatus(rideSeries({ ride: { '1h': line([[0, 20]]), '5m': line([[0, 0]]) } }), 10);
  assert.equal(s.text, '1h ↑MA20 · 5m —');
  assert.equal(s.advice, '1h 向上 → 不宜做空');
  s = signalStatus(rideSeries({ ride: { '1h': line([[100, 20]]) } }), 10);
  assert.equal(s.text, '1h —');
  assert.equal(s.advice, '');
  assert.equal(signalStatus(rideSeries({ ride: { '3m': line([[0, -5]]) } }), 0).advice, '3m 向下 → 不宜做多');
});

test('valueAt is a step lookup', () => {
  const p = [{ time: 10, value: 5 }, { time: 20, value: 0 }];
  assert.equal(valueAt(p, 5), 0);
  assert.equal(valueAt(p, 10), 5);
  assert.equal(valueAt(p, 19), 5);
  assert.equal(valueAt(p, 20), 0);
});

const bars = (minutes, count, first = 0) => Array.from({ length: count }, (_, i) => ({ time: first + i * minutes * 60, close: 100 + i }));

test('a value known at t+60 lands on the last bar closed by then', () => {
  const c = bars(5, 10);                       // bars open at 0, 300, 600 ...
  assert.equal(closedIndex(c, 5, 240), -1);    // first bar closes at 300
  assert.equal(closedIndex(c, 5, 300), 0);
  assert.equal(closedIndex(c, 5, 599), 0);
  assert.equal(closedIndex(c, 5, 600), 1);
  // 1m point at 240 (the last minute of bar 0) is known at 300 -> bar 0
  const ride = { minutes: 5, start: 240, end: 840, ended: true };
  assert.deepEqual(rideSpan(c, ride), { first: 0, last: 1 });
});

test('an ended interval stops before the bar that no longer shows the ride; an open one runs to the end', () => {
  const c = bars(3, 10);
  assert.deepEqual(rideSpan(c, { minutes: 3, start: 120, end: 120 + 6 * 60, ended: true }), { first: 0, last: 1 });
  assert.deepEqual(rideSpan(c, { minutes: 3, start: 120, end: 400, ended: false }), { first: 0, last: 9 });
  assert.equal(rideSpan(c, { minutes: 3, start: 0, end: 100, ended: true }), null);
  assert.deepEqual(rideSpan(c, { minutes: 3, start: 120, end: 121, ended: true }), { first: 0, last: 0 });
});

test('annotations: one marker per interval, the ridden SMA changes with the period, gaps break the line', () => {
  const c = bars(5, 20);
  const rides = mergeRides(series('5m', [[240, 10], [1140, 20], [1740, 0], [2640, -5], [3240, 0]]), 6000);
  const smaFor = period => new Map(c.map(bar => [bar.time, period * 1000 + bar.time / 300]));
  const { markers, lines } = rideAnnotations(c, rides, smaFor);
  assert.deepEqual(markers.map(m => [m.time, m.text, m.position, m.shape, m.color]), [
    [0, 'MA10↑', 'belowBar', 'arrowUp', '#16a082'],
    [2400, 'MA5↓', 'aboveBar', 'arrowDown', '#dd6070'],
  ]);
  // up: bars 0..4 (start 240 -> bar 0; ends at 1740 -> bar closed by 1800 is #5, so last = 4); no padding points
  assert.equal(lines.up.length, 1);
  assert.deepEqual(lines.up[0].map(p => p.time), [0, 300, 600, 900, 1200]);
  assert.equal(lines.up[0][0].value, 10000);       // MA10 before the change
  assert.equal(lines.up[0][2].value, 10000 + 2);   // bar 2 closes at 900, value of 1140 not yet known
  assert.equal(lines.up[0][3].value, 20000 + 3);   // bar 3 closes at 1200 (known at 1140) -> MA20
  assert.equal(lines.down.length, 1);
  assert.deepEqual(lines.down[0].map(p => p.time), [2400, 2700]);
  assert.equal(lines.down[0][0].value, 5000 + 8);
});

test('every interval is its own line (the chart joins consecutive points of one series)', () => {
  const c = bars(5, 30);
  // two up intervals separated by a gap of several bars, then a down one
  const rides = mergeRides(series('5m', [[240, 10], [1440, 0], [3240, 10], [4440, 0], [5640, -5], [6840, 0]]), 9000);
  const { lines } = rideAnnotations(c, rides, () => new Map(c.map(b => [b.time, b.close])));
  assert.equal(lines.up.length, 2);
  assert.ok(lines.up[0].at(-1).time < lines.up[1][0].time);
  assert.equal(lines.down.length, 1);
  for (const data of [...lines.up, ...lines.down]) assert.ok(data.every(p => Number.isFinite(p.value)));
});

test('annotations skip bars without an SMA value (warm-up) instead of drawing zeros', () => {
  const c = bars(5, 6);
  const rides = mergeRides(series('5m', [[240, 10]]), 3000);
  const { lines, markers } = rideAnnotations(c, rides, () => new Map([[c[2].time, 7]]));
  assert.equal(markers.length, 1);
  assert.deepEqual(lines.up, []);               // a single drawable bar draws nothing
  const two = rideAnnotations(c, rides, () => new Map([[c[2].time, 7], [c[3].time, 8]]));
  assert.deepEqual(two.lines.up, [[{ time: c[2].time, value: 7 }, { time: c[3].time, value: 8 }]]);
});

test('real data (BTC 2026-10-13..): 4 timeframes, alternating-free intervals, sensible bars', () => {
  const rides = buildRides(real, 1791849600 + 3 * 86400);
  assert.ok(rides.length > 50);
  assert.deepEqual([...new Set(rides.map(r => r.tf))].sort(), ['15m', '1h', '3m', '5m']);
  for (const tf of ['1h', '15m', '5m', '3m']) {
    const mine = rides.filter(r => r.tf === tf);
    for (let i = 0; i < mine.length; i++) {
      assert.ok(mine[i].end > mine[i].start && mine[i].bars >= 1 && mine[i].periods.length >= 1);
      if (i) assert.ok(mine[i].start >= mine[i - 1].end, 'intervals of one timeframe never overlap');
      if (i && mine[i].start === mine[i - 1].end) assert.notEqual(mine[i].dir, mine[i - 1].dir);
    }
  }
  const first1h = rides.find(r => r.tf === '1h');
  assert.deepEqual([first1h.dir, first1h.start, first1h.end, first1h.periods], [1, 1791881940, 1791889140, [7]]);
  assert.equal(first1h.bars, 2);
  assert.equal(first1h.maxTouches, 2);
});

test('joinRideLines puts every interval in one series and hides the joining segments', async () => {
  const { joinRideLines, HIDDEN } = await import('../jesse/static/review/rides.mjs');
  const lines = { up: [[{ time: 0, value: 1 }, { time: 60, value: 2 }], [{ time: 600, value: 5 }, { time: 660, value: 6 }]],
    down: [[{ time: 300, value: 3 }, { time: 360, value: 4 }], [{ time: 660, value: 9 }, { time: 720, value: 8 }]] };
  const got = joinRideLines(lines, { up: 'U', down: 'D' });
  assert.deepEqual(got.map(p => p.time), [0, 60, 300, 360, 600, 660, 720]);   // strictly increasing, duplicate 660 dropped
  assert.deepEqual(got.map(p => p.color), ['U', HIDDEN, 'D', HIDDEN, 'U', HIDDEN, HIDDEN]);   // a segment takes its starting point's colour
  assert.deepEqual(joinRideLines({ up: [], down: [] }, { up: 'U', down: 'D' }), []);
});
