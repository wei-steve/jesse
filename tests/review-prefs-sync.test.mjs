import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createPrefsSaver, isPrefKey, isPrefValue, localPrefs, mergePrefs, patchStorage,
  MAX_VALUE_BYTES, SAVE_DEBOUNCE_MS, TOKEN_KEY } from '../jesse/static/review/prefs-sync.mjs';

// --- What counts as a setting --------------------------------------------------------------------------------------

test('only jesse. keys of the server rule are settings', () => {
  for (const key of ['jesse.review.display.v1', 'jesse.market.watchlist.v1', 'jesse.market.viewBars',
    'jesse.finder.form.v1', 'jesse.labels.book', 'jesse.a', `jesse.${'x'.repeat(80)}`]) {
    assert.equal(isPrefKey(key), true, key);
  }
  // The dashboard token and anything that is not a `jesse.` key is never synced.
  for (const key of [TOKEN_KEY, 'main', '', 'jesse', 'jesse.', `jesse.${'x'.repeat(81)}`, 'jesse/../x',
    'jesse.a b', 'Jesse.a', null, undefined, 5]) {
    assert.equal(isPrefKey(key), false, String(key));
  }
});

test('a value is a string of at most 256 KB of UTF-8', () => {
  assert.equal(isPrefValue('{"version":1}'), true);
  assert.equal(isPrefValue(''), true);
  assert.equal(isPrefValue('x'.repeat(MAX_VALUE_BYTES)), true);
  assert.equal(isPrefValue('x'.repeat(MAX_VALUE_BYTES + 1)), false);
  // A Chinese character is three bytes: 90000 of them are past the byte limit while being fewer than 262144
  // characters, so the check must count bytes like the server does.
  assert.equal(isPrefValue('字'.repeat(MAX_VALUE_BYTES / 3 + 1)), false);
  assert.equal(isPrefValue(5), false);
  assert.equal(isPrefValue(null), false);
});

// --- The merge ----------------------------------------------------------------------------------------------------

test('the server wins for the keys it has, and the page keys around it are left alone', () => {
  const { write, upload } = mergePrefs(
    { 'jesse.review.display.v1': '{"server":1}', 'jesse.market.watchlist.v1': '["ETHUSDT"]' },
    [['jesse.review.display.v1', '{"browser":1}'], ['main', '{"authToken":"t"}'], ['theme', 'dark']],
  );
  // The server's copy of a key both sides have goes into localStorage; the browser's copy is not uploaded back.
  assert.deepEqual(write, { 'jesse.review.display.v1': '{"server":1}', 'jesse.market.watchlist.v1': '["ETHUSDT"]' });
  assert.deepEqual(upload, {});
});

test('a browser that already had settings uploads the keys the server does not have', () => {
  const { write, upload } = mergePrefs(
    { 'jesse.review.display.v1': '{"server":1}' },
    [['jesse.review.display.v1', '{"browser":1}'], ['jesse.market.viewBars', '{"15m":200}'],
      ['jesse.finder.form.v1', '{"factor":"x"}'], ['main', '{"authToken":"t"}'], ['something.else', '1']],
  );
  assert.deepEqual(write, { 'jesse.review.display.v1': '{"server":1}' });
  // Only `jesse.` keys the server does not have (and never `main` / other keys).
  assert.deepEqual(upload, { 'jesse.market.viewBars': '{"15m":200}', 'jesse.finder.form.v1': '{"factor":"x"}' });
});

test('an empty or broken server answer is no server settings at all', () => {
  const entries = [['jesse.labels.book', 'trend'], [TOKEN_KEY, '{"authToken":"t"}']];
  for (const server of [undefined, null, {}, [], 'nonsense', 5]) {
    const { write, upload } = mergePrefs(server, entries);
    assert.deepEqual(write, {}, String(server));
    // Everything this browser has is uploaded, so the first open seeds the server.
    assert.deepEqual(upload, { 'jesse.labels.book': 'trend' }, String(server));
  }
});

test('an unusable server entry is dropped and the browser copy fills it in', () => {
  const { write, upload } = mergePrefs(
    { 'jesse.a': 5, 'jesse.b': 'x'.repeat(MAX_VALUE_BYTES + 1), 'main': 'secret', 'jesse.c': 'server' },
    [['jesse.a', 'local-a'], ['jesse.b', 'local-b'], ['jesse.c', 'local-c'], [`jesse.${'y'.repeat(81)}`, 'junk']],
  );
  assert.deepEqual(write, { 'jesse.c': 'server' });
  assert.deepEqual(upload, { 'jesse.a': 'local-a', 'jesse.b': 'local-b' });
});

test('localPrefs reads the jesse. keys of a storage, pairs only', () => {
  const storage = fakeStorage({ 'jesse.a': '1', main: '{"authToken":"t"}', 'jesse.b': '2', theme: 'dark' });
  assert.deepEqual(localPrefs(storage).sort(), [['jesse.a', '1'], ['jesse.b', '2']]);
  // A browser that refuses storage (or an unreadable one) simply has nothing to upload.
  const broken = { get length() { throw new Error('denied'); }, key() { throw new Error('denied'); },
    getItem() { throw new Error('denied'); } };
  assert.deepEqual(localPrefs(broken), []);
});

// --- The debounced batch ------------------------------------------------------------------------------------------

test('writes are collected and sent as one batch after the page stops writing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent = [];
    const saver = createPrefsSaver({ send: (items, options) => sent.push({ items, keepalive: options.keepalive }) });
    saver.change('jesse.review.display.v1', '{"version":1}');
    saver.change('jesse.market.watchlist.v1', '["BTCUSDT"]');
    saver.change('jesse.labels.book', 'trend');
    // Nothing is sent while the page may still be writing.
    mock.timers.tick(SAVE_DEBOUNCE_MS - 1);
    assert.deepEqual(sent, []);
    assert.equal(saver.pending().size, 3);
    mock.timers.tick(1);
    assert.deepEqual(sent, [{ items: { 'jesse.review.display.v1': '{"version":1}',
      'jesse.market.watchlist.v1': '["BTCUSDT"]', 'jesse.labels.book': 'trend' }, keepalive: false }]);
    assert.equal(saver.pending().size, 0);
    // A later change starts a new batch, and the last value of a key wins.
    saver.change('jesse.labels.book', 'candles');
    mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.deepEqual(sent[1], { items: { 'jesse.labels.book': 'candles' }, keepalive: false });
  } finally {
    mock.timers.reset();
  }
});

test('a removal travels as null, and only jesse. keys are recorded', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent = [];
    const saver = createPrefsSaver({ send: items => sent.push(items) });
    saver.change('main', '{"authToken":"t"}');
    saver.change('jesse.big', 'x'.repeat(MAX_VALUE_BYTES + 1));
    saver.change('jesse.market.watchlist.v1', null);
    mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.deepEqual(sent, [{ 'jesse.market.watchlist.v1': null }]);
  } finally {
    mock.timers.reset();
  }
});

test('leaving the page sends the waiting batch at once, keeping the request alive', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent = [];
    const saver = createPrefsSaver({ send: (items, options) => sent.push({ items, keepalive: options.keepalive }) });
    saver.change('jesse.finder.form.v1', '{"live":true}');
    // `pagehide` / a hidden tab cannot wait for the debounce: flush right away with keepalive.
    saver.flush({ keepalive: true });
    assert.deepEqual(sent, [{ items: { 'jesse.finder.form.v1': '{"live":true}' }, keepalive: true }]);
    // The debounce timer that was still running sends nothing a second time.
    mock.timers.tick(SAVE_DEBOUNCE_MS);
    assert.equal(sent.length, 1);
    // An empty flush is not a request.
    saver.flush({ keepalive: true });
    assert.equal(sent.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a failing send is logged, not thrown into the page', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const warn = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const saver = createPrefsSaver({ send: () => { throw new Error('离线'); } });
    saver.change('jesse.labels.book', 'candles');
    assert.doesNotThrow(() => mock.timers.tick(SAVE_DEBOUNCE_MS));
    // One console line, nothing else: a settings mirror must never interrupt the page.
    assert.equal(lines.length, 1);
    assert.match(lines[0], /设置同步失败/);
  } finally {
    console.warn = warn;
    mock.timers.reset();
  }
});

// --- The write interception ---------------------------------------------------------------------------------------

test('interception reports only jesse. keys, and only on the page storage', () => {
  const page = fakeStorage();
  const other = fakeStorage();
  const changes = [];
  const restore = patchStorage(Object.getPrototypeOf(page), {
    onChange: (key, value) => changes.push([key, value]),
    isTarget: instance => instance === page,
  });
  try {
    page.setItem('jesse.review.display.v1', '{"version":1}');
    page.setItem('main', '{"authToken":"t"}');
    page.setItem('theme', 'dark');
    page.setItem(`jesse.${'x'.repeat(81)}`, 'too long');
    other.setItem('jesse.labels.book', 'candles');
    page.removeItem('jesse.labels.book');
    // The writes themselves still work exactly like before.
    assert.equal(page.getItem('jesse.review.display.v1'), '{"version":1}');
    assert.equal(page.getItem('main'), '{"authToken":"t"}');
    assert.equal(page.getItem('jesse.labels.book'), null);
    assert.equal(other.getItem('jesse.labels.book'), 'candles');
    // sessionStorage / another storage shares the prototype but is not the page storage.
    assert.deepEqual(changes, [['jesse.review.display.v1', '{"version":1}'], ['jesse.labels.book', null]]);
  } finally {
    restore();
  }
  // Restored: nothing is reported any more.
  page.setItem('jesse.a', '1');
  assert.equal(changes.length, 2);
});

test('a value is stored as its string form, and a quota error is not reported as a change', () => {
  const page = fakeStorage();
  const changes = [];
  const restore = patchStorage(Object.getPrototypeOf(page), {
    onChange: (key, value) => changes.push([key, value]), isTarget: instance => instance === page,
  });
  try {
    page.setItem('jesse.market.viewBars', { '15m': 200 });
    assert.equal(page.getItem('jesse.market.viewBars'), '[object Object]');
    assert.deepEqual(changes, [['jesse.market.viewBars', '[object Object]']]);
    // A full storage throws from the real setItem: the setting was not saved, so it must not be uploaded either.
    page.full = true;
    assert.throws(() => page.setItem('jesse.market.watchlist.v1', '[]'));
    assert.equal(changes.length, 1);
  } finally {
    restore();
  }
});

/** A Storage-shaped object: the methods live on the prototype, like the browser's Storage. */
class FakeStorage {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.full = false;
  }
  get length() { return this.entries.size; }
  key(index) { return [...this.entries.keys()][index] ?? null; }
  getItem(key) { return this.entries.has(key) ? this.entries.get(key) : null; }
  setItem(key, value) {
    if (this.full) throw new Error('QuotaExceededError');
    this.entries.set(key, String(value));
  }
  removeItem(key) { this.entries.delete(key); }
}

function fakeStorage(entries) {
  return new FakeStorage(entries);
}
