// Signal labels of the factor finder: one key per signal, the effective mark per key and the counts shown above
// the list. Pure functions, no DOM (tests/review-labels.test.mjs). The rows themselves live in the project file
// storage/labels/finder-labels.jsonl and are written / read by POST /review/label and POST /review/labels.

export const LABELS = new Set(['good', 'bad', 'clear']);
export const LABEL_TEXT = { good: '✓', bad: '✗' };

// The identity of one signal: `factor|exchange|symbol|tf|start|dir`, the format the backend documents. Two marks
// of "the same signal" must land on the same key; another factor, exchange or symbol must not inherit the marks.
export const labelKey = (form, ride) =>
  [form?.factor, form?.exchange, form?.symbol, ride?.tf, ride?.start, ride?.dir].join('|');

// Effective mark lookup over either the server's `{ key: { label, note } }` object or a Map of the same shape.
// `clear` is not a mark: it removes one, so it reads as unlabeled.
export function labelOf(labels, key) {
  if (!labels || !key) return null;
  const entry = labels instanceof Map ? labels.get(key) : labels[key];
  return entry?.label === 'good' || entry?.label === 'bad' ? entry : null;
}

// Rows of the label file (oldest first) → Map of key → mark. The last row of a key wins; a `clear` row removes
// the key. Used by the tests and by anything that reads the file directly; the page gets the same answer from
// POST /review/labels.
export function latestLabels(rows) {
  const latest = new Map();
  for (const row of rows ?? []) {
    if (!row?.key) continue;
    if (row.label === 'clear') latest.delete(row.key);
    else if (row.label === 'good' || row.label === 'bad') latest.set(row.key, { label: row.label, note: row.note ?? '' });
  }
  return latest;
}

// How many of the listed signals are marked good / bad / not marked at all. `keyOf` reads the key of a signal;
// the finder puts it on the ride itself (ride.key), so the two-argument call works there.
export function labelCounts(rides, labels, keyOf = ride => ride.key) {
  const counts = { good: 0, bad: 0, unlabeled: 0 };
  for (const ride of rides ?? []) {
    const entry = labelOf(labels, keyOf(ride));
    counts[entry?.label ?? 'unlabeled'] += 1;
  }
  return counts;
}

// One filter id per button above the list: everything, only unmarked signals, only good, only bad.
export const LABEL_FILTERS = [['all', '全部'], ['unlabeled', '未标'], ['good', '好'], ['bad', '坏']];

// Does a signal pass the current label filter? `label` is the filter id ('all' shows everything).
export function filterByLabel(rides, labels, label, keyOf = ride => ride.key) {
  if (!label || label === 'all') return rides;
  return rides.filter(ride => (labelOf(labels, keyOf(ride))?.label ?? 'unlabeled') === label);
}
