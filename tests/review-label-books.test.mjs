import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOOK, BOOK_STORAGE_KEY, BOOK_MAX, validBookName, bookName, resolveBook, readBook, writeBook,
  withBook, bookOptionText } from '../jesse/static/review/labels.mjs';
import { barNoteBody } from '../jesse/static/review/bar-notes.mjs';

// ---- Names ------------------------------------------------------------------
// A 备注本 is one `<name>.jsonl` in the project's storage/labels/: the server validates the name with the same rule,
// because the name ends up as a file name.
test('validBookName accepts the names the server accepts, and nothing that could reach another folder', () => {
  for (const name of [DEFAULT_BOOK, 'a', '_', '-', 'ab_1-2', '趋势实验', '中文备注本', 'x'.repeat(BOOK_MAX)]) {
    assert.equal(validBookName(name), true, name);
  }
  // `/` and `.` would climb out of the folder, a space and `|` are not file-name parts of a book, and an empty name is
  // never a book (the page sends the default explicitly instead).
  for (const name of ['', ' ', '../x', 'a/b', 'a.b', 'a b', 'a|b', 'x'.repeat(BOOK_MAX + 1), 'a\tb', 'a\nb']) {
    assert.equal(validBookName(name), false, JSON.stringify(name));
  }
  // Anything that is not a string is not a name (a leftover localStorage value, a broken answer from the server).
  for (const value of [null, undefined, 42, {}, [], true]) assert.equal(validBookName(value), false);
});

test('bookName falls back to the default book instead of throwing', () => {
  assert.equal(bookName('趋势实验'), '趋势实验');
  assert.equal(bookName(DEFAULT_BOOK), DEFAULT_BOOK);
  assert.equal(bookName('../x'), DEFAULT_BOOK);
  assert.equal(bookName(''), DEFAULT_BOOK);
  assert.equal(bookName(null), DEFAULT_BOOK);
  assert.equal(bookName(undefined), DEFAULT_BOOK);
});

// ---- Which book a page may use ----------------------------------------------
test('resolveBook keeps the stored book while the server still lists it, and falls back with a reason', () => {
  const books = [{ name: DEFAULT_BOOK, rows: 3 }, { name: '趋势实验', rows: 12 }];
  assert.deepEqual(resolveBook(books, '趋势实验'), { name: '趋势实验', missing: '' });
  assert.deepEqual(resolveBook(books, DEFAULT_BOOK), { name: DEFAULT_BOOK, missing: '' });
  // The stored book is gone from the server: the default is used and the missing name is reported (not silently dropped).
  assert.deepEqual(resolveBook(books, 'removed'), { name: DEFAULT_BOOK, missing: 'removed' });
  // No default in the answer (a hand-made folder): the first listed book is the safe one.
  assert.deepEqual(resolveBook([{ name: 'only', rows: 1 }], 'removed'), { name: 'only', missing: 'removed' });
  // No answer at all (an old server, a failed list): keep what localStorage says instead of dropping the choice.
  assert.deepEqual(resolveBook([], 'mine'), { name: 'mine', missing: '' });
  assert.deepEqual(resolveBook(null, 'mine'), { name: 'mine', missing: '' });
  // A garbage stored value is the default book, not a "missing" book: nothing to warn about.
  assert.deepEqual(resolveBook(books, '../x'), { name: DEFAULT_BOOK, missing: '' });
  assert.deepEqual(resolveBook(books, null), { name: DEFAULT_BOOK, missing: '' });
  // Broken entries in the server's answer are skipped, so they can never be selected (and the fallback is listed).
  assert.deepEqual(resolveBook([{ name: '' }, { name: 'ok' }, null], ''), { name: 'ok', missing: '' });
});

// ---- localStorage -----------------------------------------------------------
// The open book is one key both pages read; a browser that refuses storage must not break the page.
const fakeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
};

test('readBook / writeBook share one key and heal a bad stored value', () => {
  const store = fakeStorage();
  assert.equal(readBook(store), DEFAULT_BOOK);
  assert.equal(writeBook(store, '趋势实验'), true);
  assert.equal(store.data.get(BOOK_STORAGE_KEY), '趋势实验');
  assert.equal(readBook(store), '趋势实验');
  // A hand-edited value the server would refuse reads as the default (and the page writes a good one back).
  const broken = fakeStorage({ [BOOK_STORAGE_KEY]: '../etc/passwd' });
  assert.equal(readBook(broken), DEFAULT_BOOK);
  assert.equal(writeBook(broken, '../etc/passwd'), true);
  assert.equal(readBook(broken), DEFAULT_BOOK);
  // No storage (or no methods on it) is the default book, and writing says it could not.
  assert.equal(readBook(undefined), DEFAULT_BOOK);
  assert.equal(readBook({}), DEFAULT_BOOK);
  assert.equal(writeBook(undefined, 'x'), false);
  assert.equal(writeBook({}, 'x'), false);
  // A browser that throws on access (disabled storage) is the same: default book, nothing thrown.
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readBook(throwing), DEFAULT_BOOK);
  assert.equal(writeBook(throwing, 'x'), false);
});

// ---- Requests ---------------------------------------------------------------
test('withBook puts the book on the request body, defaulting a missing / bad name', () => {
  assert.deepEqual(withBook({ factor: 'ma_pullback', symbol: 'BTC-USDT' }, '趋势实验'),
    { factor: 'ma_pullback', symbol: 'BTC-USDT', book: '趋势实验' });
  // POST /review/labels with no filter at all is still a valid body.
  assert.deepEqual(withBook({}, '趋势实验'), { book: '趋势实验' });
  // An unset / impossible book is the default, never a name the server would refuse.
  assert.deepEqual(withBook({}, undefined), { book: DEFAULT_BOOK });
  assert.deepEqual(withBook({}, 'a/b'), { book: DEFAULT_BOOK });
  assert.deepEqual(withBook(undefined, 'x'), { book: 'x' });
  // The body is not mutated: two pages can build their own request from the same object.
  const body = { factor: 'x' };
  withBook(body, 'y');
  assert.deepEqual(body, { factor: 'x' });
});

test('bookOptionText is the dropdown row `名字（N 条）`', () => {
  assert.equal(bookOptionText({ name: '趋势实验', rows: 12 }), '趋势实验（12 条）');
  assert.equal(bookOptionText({ name: DEFAULT_BOOK, rows: 0 }), 'finder-labels（0 条）');
  assert.equal(bookOptionText({ name: 'x' }), 'x（0 条）');
  assert.equal(bookOptionText(undefined), '（0 条）');
});

test('barNoteBody carries the book of the candle note', () => {
  const body = barNoteBody({ form: { exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT' }, tf: '3m',
    time: 1763000000, text: '这里放量', book: '趋势实验' });
  assert.equal(body.book, '趋势实验');
  assert.equal(body.kind, 'bar');
  // A page without a book (an older build) writes to the default by leaving the field out, exactly as before.
  assert.equal('book' in barNoteBody({ form: {}, tf: '3m', time: 1, text: 'x' }), false);
  // An impossible name never reaches the server.
  assert.equal(barNoteBody({ form: {}, tf: '3m', time: 1, text: 'x', book: 'a/b' }).book, DEFAULT_BOOK);
});
