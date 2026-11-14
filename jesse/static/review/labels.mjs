// Signal labels of the factor finder: two marks per signal (trend judgement and limit order) plus one note, the
// effective state per key and the counts / filters shown above the list. Pure functions, no DOM
// (tests/review-labels.test.mjs). The rows themselves live in the project file
// storage/labels/finder-labels.jsonl and are written / read by POST /review/label and POST /review/labels.

export const MARK_KINDS = ['trend', 'order'];
export const MARKS = new Set(['good', 'bad', 'clear']);
// What a mark looks like in the list: the kind is prefixed so 势✓ and 挂✓ cannot be confused at a glance.
export const MARK_TEXT = {
  trend: { good: '势✓', bad: '势✗' },
  order: { good: '挂✓', bad: '挂✗' },
};
export const KIND_TEXT = { trend: '趋势', order: '挂单' };

// A note on one candle of any timeframe (not on a signal). The timeframe is part of the key because the same clock
// time is a different candle on another timeframe: a 3m note must never land on the 15m bar. The page sends this
// key, the backend stores it, and `bar|exchange|symbol|tf|time` is what POST /review/labels groups by.
export const barKey = (form, tf, time) => ['bar', form?.exchange, form?.symbol, tf, time].join('|');

// How a noted candle looks on the chart: a purple square above the bar with 「注」. Purple is used by nothing else
// on these charts (entries are dark green/red, the selected signal amber), so a note cannot be mistaken for a signal.
export const BAR_NOTE_COLOR = '#7c3aed';
export const BAR_NOTE_TEXT = '注';

// The identity of one signal: `factor|exchange|symbol|tf|start|dir`, the format the backend documents. Two marks
// of "the same signal" must land on the same key; another factor, exchange or symbol must not inherit the marks.
export const labelKey = (form, ride) =>
  [form?.factor, form?.exchange, form?.symbol, ride?.tf, ride?.start, ride?.dir].join('|');

const entryOfLabel = (labels, key) => {
  if (!labels || !key) return null;
  return (labels instanceof Map ? labels.get(key) : labels[key]) ?? null;
};

// One mark of a signal ('good' / 'bad'), or null when it is not marked. Accepts the server's
// `{ key: { trend, order, note } }` object or a Map of the same shape.
export function markOf(labels, key, kind = 'trend') {
  const value = entryOfLabel(labels, key)?.[kind];
  return value === 'good' || value === 'bad' ? value : null;
}

export const noteOf = (labels, key) => entryOfLabel(labels, key)?.note ?? '';

// The two marks and the note of a signal, always the same shape, so callers never need a null check.
export function entryOf(labels, key) {
  return { trend: markOf(labels, key, 'trend'), order: markOf(labels, key, 'order'), note: noteOf(labels, key) };
}

// The two marks are reviewed independently: the note box and the list only care whether a signal has any mark.
export const isUnmarked = entry => !entry.trend && !entry.order;
export const bothMarked = entry => !!entry.trend && !!entry.order;

// Rows of the label file (oldest first) → Map of key → { trend, order, note }, the same answer POST
// /review/labels gives. The last row of a kind wins, a `clear` row removes that kind, and a row without a kind
// is a trend mark (that is all that existed before the split). Used by the tests and by anything that reads the
// file directly.
export function latestLabels(rows) {
  const latest = new Map();
  for (const row of rows ?? []) {
    if (!row?.key) continue;
    const kind = row.kind === 'note' ? 'note' : MARK_KINDS.includes(row.kind) ? row.kind : 'trend';
    const entry = latest.get(row.key) ?? { trend: null, order: null, note: '' };
    if (kind === 'note') entry.note = row.note ?? '';
    else {
      if (MARKS.has(row.label)) entry[kind] = row.label === 'clear' ? null : row.label;
      if (row.note) entry.note = row.note;
    }
    if (entry.trend || entry.order || entry.note) latest.set(row.key, entry);
    else latest.delete(row.key);
  }
  return latest;
}

// How many of the listed signals are marked good / bad per kind, and how many have no mark at all (neither kind).
// `keyOf` reads the key of a signal; the finder puts it on the ride itself (ride.key), so the two-argument call
// works there.
export function labelCounts(rides, labels, keyOf = ride => ride.key) {
  const counts = { trend: { good: 0, bad: 0 }, order: { good: 0, bad: 0 }, unlabeled: 0 };
  for (const ride of rides ?? []) {
    const entry = entryOf(labels, keyOf(ride));
    for (const kind of MARK_KINDS) if (entry[kind]) counts[kind][entry[kind]] += 1;
    if (isUnmarked(entry)) counts.unlabeled += 1;
  }
  return counts;
}

// The line above the list: `趋势 好 x / 坏 y · 挂单 好 x / 坏 y · 未标 z`.
export function countsText(counts) {
  const parts = MARK_KINDS.map(kind => `${KIND_TEXT[kind]} 好 ${counts[kind].good} / 坏 ${counts[kind].bad}`);
  return `${parts.join(' · ')} · 未标 ${counts.unlabeled}`;
}

// One filter id per button above the list. "未标" is no mark of either kind, "都好" is both kinds good, and the two
// bad filters find the signals whose trend judgement / limit order was wrong.
export const LABEL_FILTERS = [['all', '全部'], ['unlabeled', '未标'], ['trendBad', '趋势坏'],
  ['orderBad', '挂单坏'], ['bothGood', '都好']];

const PASSES = {
  unlabeled: entry => isUnmarked(entry),
  trendBad: entry => entry.trend === 'bad',
  orderBad: entry => entry.order === 'bad',
  bothGood: entry => bothMarked(entry) && entry.trend === 'good' && entry.order === 'good',
};

// Does a signal pass the current label filter? `label` is the filter id ('all' shows everything).
export function filterByLabel(rides, labels, label, keyOf = ride => ride.key) {
  if (!label || label === 'all') return rides;
  const passes = PASSES[label];
  if (!passes) return rides;
  return rides.filter(ride => passes(entryOf(labels, keyOf(ride))));
}

// ---- Candle notes -----------------------------------------------------------
// `kind=bar` rows of the same file: the note on one candle of one timeframe. The backend answers them as
// `bars: { key: { note, tf, time } }`, separate from the signal marks, and the page draws a marker per noted candle
// on its own timeframe's chart.

// Rows of the label file (oldest first) → Map of key → { note, tf, time }, the same answer POST /review/labels gives
// in `bars`. The last row of a key wins and an empty note is the deleted note (it does not come back).
export function latestBars(rows) {
  const latest = new Map();
  for (const row of rows ?? []) {
    if (row?.kind !== 'bar' || !row.key) continue;
    const note = row.note ?? '';
    if (note) latest.set(row.key, { note, tf: row.tf ?? null, time: row.time ?? null });
    else latest.delete(row.key);
  }
  return latest;
}

const barEntryOf = (bars, key) => {
  if (!bars || !key) return null;
  return (bars instanceof Map ? bars.get(key) : bars[key]) ?? null;
};

// The note written on that candle, '' when there is none (or when it was deleted).
export const barNoteOf = (bars, key) => barEntryOf(bars, key)?.note ?? '';

// The title of the note box: `10-27 08:36 UTC · 3m`, the same stamp the list uses, plus the timeframe.
export const barLabel = (time, tf) =>
  `${new Date(time * 1000).toISOString().replace('T', ' ').slice(5, 16)} UTC · ${tf}`;

// The purple 「注」 squares for one chart: only notes of that chart's own timeframe whose candle is inside the drawn
// range (`has(time)`), so a 3m note is not drawn on the 15m chart and a note outside the range draws nothing.
export function barMarkers(bars, tf, has = () => true) {
  const entries = bars instanceof Map ? bars.values() : Object.values(bars ?? {});
  const markers = [];
  for (const entry of entries) {
    if (!entry?.note || entry.tf !== tf) continue;
    const time = Number(entry.time);
    if (!Number.isFinite(time) || !has(time)) continue;
    markers.push({ bar: true, time, position: 'aboveBar', shape: 'square', color: BAR_NOTE_COLOR, text: BAR_NOTE_TEXT });
  }
  return markers.sort((a, b) => a.time - b.time);
}
