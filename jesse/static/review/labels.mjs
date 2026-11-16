// Signal labels of the factor finder: two marks per signal (trend judgement and limit order) plus one note, the
// effective state per key and the counts / filters shown above the list. Pure functions, no DOM
// (tests/review-labels.test.mjs). The rows themselves live in the project's `storage/labels/<本名>.jsonl` and are
// written / read by POST /review/label and POST /review/labels; `finder-labels` (DEFAULT_BOOK) is the default book.

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

// ---- Label books ------------------------------------------------------------
// The marks of one notebook: `storage/labels/<book>.jsonl` on the server. Several notebooks in the project mean a new
// question starts clean instead of piling up next to last week's marks. `finder-labels` is the default and the file
// every page wrote before books existed, so old marks keep working. Both pages keep the open book in one localStorage
// key, so switching on one page switches the other; the row itself is written by POST /review/label with `book`.
export const DEFAULT_BOOK = 'finder-labels';
export const BOOK_STORAGE_KEY = 'jesse.labels.book';
export const BOOK_MAX = 40;
// A plain file name: letters, digits, `_`, `-` and CJK (the server allows a Chinese name too). No `/`, `.` or space, so
// a name can never climb out of storage/labels/; the length is the server's 1–40 characters.
export const BOOK_NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$/;

export const validBookName = name => typeof name === 'string' && BOOK_NAME_RE.test(name);

// The book a stored / typed value names. A hand-edited localStorage entry (or an old build's junk) must not break the
// page: anything the server would refuse falls back to the default book.
export const bookName = value => (validBookName(value) ? value : DEFAULT_BOOK);

/**
 * The book the page may use. `books` is the server's answer (POST /review/label-books); a stored book that is no
 * longer on the server falls back to the default — `missing` names it, so the page can say so instead of quietly
 * showing another notebook's marks.
 */
export function resolveBook(books, stored) {
  const names = (books ?? []).map(book => book?.name).filter(validBookName);
  const wanted = bookName(stored);
  if (!names.length || names.includes(wanted)) return { name: wanted, missing: '' };
  const name = names.includes(DEFAULT_BOOK) ? DEFAULT_BOOK : names[0];
  // Only a real book name the server lost is worth reporting; a junk stored value simply is the default book.
  return { name, missing: validBookName(stored) ? wanted : '' };
}

/** The open book of this browser. A browser that refuses localStorage (or no storage at all) uses the default. */
export function readBook(store) {
  try {
    return bookName(store?.getItem?.(BOOK_STORAGE_KEY) ?? '');
  } catch { return DEFAULT_BOOK; }
}

/** Remember the open book; returns false when the browser refused (the page still uses it for this session). */
export function writeBook(store, name) {
  try {
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(BOOK_STORAGE_KEY, bookName(name));
    return true;
  } catch { return false; }
}

/** `{ ...body, book }` for POST /review/label and POST /review/labels. */
export const withBook = (body, name) => ({ ...(body ?? {}), book: bookName(name) });

/** `趋势本（12 条）`: one row of the 备注本 dropdown. */
export const bookOptionText = book => `${book?.name ?? ''}（${Number(book?.rows ?? 0)} 条）`;

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
