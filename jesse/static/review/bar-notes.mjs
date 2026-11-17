// Candle notes, shared by the factor finder (finder.mjs) and the market page (market.mjs): double-click a candle,
// write one line of your own thoughts, and it is stored as a `kind=bar` row of the same project file as the signal
// marks (`storage/labels/<备注本>.jsonl`, written / read by POST /review/label and POST /review/labels). Claude
// reads that file directly, so the page only has to write it.
//
// One candle is one note across both pages: the key is `bar|exchange|symbol|tf|time` (labels.mjs), and both pages
// name the exchange and the symbol the same way (the finder's spelling, e.g. `Binance Perpetual Futures` + `BTC-USDT`),
// so a 15m note written on 看行情 shows up on the finder's 15m chart of the same candle.
//
// Pure functions (naming, keys, the 备注 list, the candle snapshot) plus the one-line box every chart uses, so the two
// pages cannot drift apart; tests/review-bar-notes.test.mjs runs all of it with node.
import { barKey, barLabel, barMarkers, barNoteOf, BAR_NOTE_COLOR, BAR_NOTE_TEXT, BOOK_MAX, bookName, bookOptionText,
  validBookName } from './labels.mjs?v=20261117e';
import { barSnapshot } from './finder-data.mjs?v=20261117e';
import { atr14 } from './limit-rules.mjs?v=20261117e';
import { BINANCE_SOURCE, DEEPCOIN_SOURCE, OKX_SOURCE, YIELD_SOURCE, marketLabel, normalizeYieldSymbol,
  sourceLabel } from './market-sources.mjs?v=20261117e';

// The single-candle readers of labels.mjs, re-exported so a page imports the note helpers from one place.
export { barLabel, barNoteOf, BAR_NOTE_COLOR, BAR_NOTE_TEXT };

// The exchange column of a candle note per source / market, and the reverse (the 备注 list jumps to the page state
// that draws the row). OKX and Deepcoin are spelled here rather than read from MARKET_SOURCES: the finder's exchange
// box holds these names, so they are the shared names of the two pages, not exchange ids of the live stream table.
// The yields have no market, so their one exchange name is `exchange` instead of an `exchanges` map.
export const NOTE_VENUES = [
  { source: BINANCE_SOURCE, exchanges: { swap: 'Binance Perpetual Futures', spot: 'Binance Spot' } },
  { source: OKX_SOURCE, exchanges: { swap: 'OKX Perpetual', spot: 'OKX Spot' } },
  { source: DEEPCOIN_SOURCE, exchanges: { swap: 'Deepcoin Perpetual', spot: 'Deepcoin Spot' } },
  { source: YIELD_SOURCE, exchanges: {}, exchange: 'US Treasury Yields' },
];
/** The exchange a note of this source / market is stored under, '' when the source has no such market. */
export function noteExchange(source, market = null) {
  const venue = NOTE_VENUES.find(entry => entry.source === source);
  if (!venue) return '';
  if (venue.exchange) return venue.exchange;
  return venue.exchanges[market] ?? '';
}

/** `BTCUSDT` / `BTC-USDT` / `BTC-USDT-SWAP` / `us10y` -> the symbol the notes are stored under (`BTC-USDT`, `US10Y`). */
export function noteSymbol(source, symbol) {
  if (source === YIELD_SOURCE) return normalizeYieldSymbol(symbol);
  const base = String(symbol ?? '').toUpperCase().replace(/[\s/_]/g, '-')
    .replace(/-USDT(-SWAP)?$/, '').replace(/USDT$/, '').replace(/-/g, '');
  return /^[A-Z0-9]{2,16}$/.test(base) ? `${base}-USDT` : '';
}

/** The `{ exchange, symbol }` a note's key carries for this instrument (the form barKey expects). */
export const noteIdentity = (source, market = null, symbol = '') =>
  ({ exchange: noteExchange(source, market), symbol: noteSymbol(source, symbol) });

// The spelling the page itself needs to draw that instrument: Binance's own pair, the instId of the other two.
const pageSymbol = (source, market, symbol) => {
  const base = String(symbol ?? '').toUpperCase().replace(/-USDT(-SWAP)?$/, '').replace(/USDT$/, '');
  if (!base) return '';
  if (source === BINANCE_SOURCE) return `${base}USDT`;
  return market === 'spot' ? `${base}-USDT` : `${base}-USDT-SWAP`;
};

/** The page state (`{ source, market, symbol }`) a stored note belongs to, or null for an exchange / symbol the
 *  market page cannot open (a finder note of another broker, a hand-edited line). */
export function noteTargetOf(exchange, symbol) {
  const name = String(exchange ?? '').trim(), code = String(symbol ?? '').trim().toUpperCase();
  if (!name || !code) return null;
  for (const venue of NOTE_VENUES) {
    if (venue.exchange) {
      if (venue.exchange !== name) continue;
      const yieldCode = normalizeYieldSymbol(code);
      return yieldCode ? { source: venue.source, market: null, symbol: yieldCode } : null;
    }
    for (const [market, exchangeName] of Object.entries(venue.exchanges)) {
      if (exchangeName !== name) continue;
      const target = pageSymbol(venue.source, market, code);
      return target ? { source: venue.source, market, symbol: target } : null;
    }
  }
  return null;
}

// ---- Keys, one candle -------------------------------------------------------
/** `bar|exchange|symbol|tf|time` of one candle (labels.mjs owns the format; every page builds it here). */
export const barNoteKey = (form, tf, time) => barKey(form, tf, time);

/** The parts of a candle note key, or null for anything that is not one (`bar|exchange|symbol|tf|time`). */
export function splitBarKey(key) {
  const parts = String(key ?? '').split('|');
  if (parts.length !== 5 || parts[0] !== 'bar') return null;
  const time = Number(parts[4]);
  if (!Number.isFinite(time)) return null;
  return { exchange: parts[1], symbol: parts[2], tf: parts[3], time };
}

/** The body of POST /review/label for one candle note. An empty `text` is the explicit "delete this note" row.
 *  `book` is the 备注本 the note goes into (labels.mjs's DEFAULT_BOOK when the page has none). */
export function barNoteBody({ form, tf, time, text, bar = null, book = null, extra = {} }) {
  return { key: barKey(form, tf, time), kind: 'bar', note: text, exchange: form?.exchange, symbol: form?.symbol,
    tf, time, ...(book ? { book: bookName(book) } : {}), ...(bar ? { bar } : {}), ...extra };
}

/** The local state after saving one note: the note box shows it at once, without a second read of the file. */
export function rememberNote(bars, key, note, tf, time) {
  const next = { ...(bars ?? {}) };
  if (note) next[key] = { note, tf, time };
  else delete next[key];
  return next;
}

/** The candle notes of one instrument (`bars` of POST /review/labels, keyed by `bar|exchange|symbol|tf|time`). */
export function barsFor(bars, form) {
  const entries = bars instanceof Map ? [...bars] : Object.entries(bars ?? {});
  const kept = {};
  for (const [key, entry] of entries) {
    const parts = splitBarKey(key);
    if (!parts || parts.exchange !== form?.exchange || parts.symbol !== form?.symbol) continue;
    kept[key] = entry;
  }
  return kept;
}

// ---- Markers ----------------------------------------------------------------
// Amber for the candle the 备注 list jumped to, the same colour the finder recolours its selected signal with.
export const CHOSEN_NOTE_COLOR = '#f59e0b';

/** The purple 「注」 squares of one chart, the jumped-to note bigger and amber (labels.mjs draws the squares). */
export function noteMarkers(bars, tf, has = () => true, chosenTime = null) {
  const markers = barMarkers(bars, tf, has);
  if (!Number.isFinite(chosenTime)) return markers;
  return markers.map(marker => (marker.time === chosenTime
    ? { ...marker, color: CHOSEN_NOTE_COLOR, size: 2, text: `▶${BAR_NOTE_TEXT}` } : marker));
}

// ---- The 备注 list ----------------------------------------------------------
/** `11-13 02:13` of a candle's open time (UTC), like the finder's list stamps. */
export const noteTimeText = time => (Number.isFinite(Number(time))
  ? new Date(Number(time) * 1000).toISOString().replace('T', ' ').slice(5, 16) : '');

/** `Binance 合约` / `美债收益率`, or the stored exchange when the page has no such source. */
export const noteWhere = row => (row?.target
  ? [sourceLabel(row.target.source), row.target.market ? marketLabel(row.target.market) : ''].filter(Boolean).join(' ')
  : String(row?.exchange ?? ''));

export const NOTE_DIGEST = 40;

/** The first 40 characters of a note on one line: enough to recognise it, short enough for the narrow column. */
export function noteDigest(note, limit = NOTE_DIGEST) {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** `BTC-USDT · Binance 合约 · 15m · 11-13 02:13 UTC · 前 40 字`: one line of the 备注 list. */
export const noteSummary = row =>
  `${row.symbol} · ${noteWhere(row)} · ${row.tf} · ${noteTimeText(row.time)} UTC · ${noteDigest(row.note)}`;

/**
 * Every candle note of the file, newest candle first. The answer carries no `saved_at` (POST /review/labels answers
 * only `{ note, tf, time }` per key), so "newest" is the candle's own open time — the stamp the row shows.
 */
export function noteRowsFrom(bars) {
  const entries = bars instanceof Map ? [...bars] : Object.entries(bars ?? {});
  const rows = [];
  for (const [key, entry] of entries) {
    const parts = splitBarKey(key);
    if (!parts || !entry?.note) continue;
    const time = Number.isFinite(Number(entry.time)) ? Number(entry.time) : parts.time;
    rows.push({ key, exchange: parts.exchange, symbol: parts.symbol,
      tf: typeof entry.tf === 'string' && entry.tf ? entry.tf : parts.tf, time, note: String(entry.note),
      target: noteTargetOf(parts.exchange, parts.symbol) });
  }
  return rows.sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
}

/** The rows whose note, symbol, timeframe or source contains `query` (empty query: every row). */
export function filterNoteRows(rows, query) {
  const list = rows ?? [];
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return list;
  return list.filter(row => [row.note, row.symbol, row.exchange, row.tf, noteWhere(row)]
    .some(value => String(value ?? '').toLowerCase().includes(needle)));
}

// ---- The candle's numbers ---------------------------------------------------
const round6 = value => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null);
const meanOf = values => (values.length && values.every(Number.isFinite)
  ? values.reduce((total, value) => total + value, 0) / values.length : null);

/**
 * The same numbers as finder-data.mjs's barSnapshot (OHLC, MA5, MA10, ATR, BOLL 20/2) for a market that is not open
 * around the clock (the treasury yields): every window counts the bars as if consecutive, the way a trading app
 * treats a session market, instead of starting afresh after the night / weekend gap. ATR is already computed bar by
 * bar (Wilder) and the gap is a real overnight move, so it is the same number here. A field whose window is not
 * complete is null, never a made-up value.
 */
export function sessionSnapshot(candles, time) {
  const bars = Array.isArray(candles) ? candles : [];
  const index = bars.findIndex(bar => bar.time === time);
  if (index < 0) return null;
  const closes = bars.slice(0, index + 1).map(bar => bar.close);
  const smaAt = period => (index + 1 >= period ? round6(meanOf(closes.slice(-period))) : null);
  const window = closes.slice(-20);
  const mid = window.length === 20 ? meanOf(window) : null;
  const sd = mid === null ? null : Math.sqrt(window.reduce((total, close) => total + (close - mid) ** 2, 0) / 20);
  const candle = bars[index];
  return { open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    ma5: smaAt(5), ma10: smaAt(10), atr: round6(atr14(bars)[index]),
    bollUpper: sd === null ? null : round6(mid + 2 * sd), bollMid: mid === null ? null : round6(mid),
    bollLower: sd === null ? null : round6(mid - 2 * sd) };
}

/** The snapshot a note carries: finder-data.mjs's for a 24-hour market, `sessionSnapshot` for a session market. */
export const snapshotOf = (candles, time, interval = 1, session = false) =>
  (session ? sessionSnapshot(candles, time) : barSnapshot(candles, time, interval));

// ---- The one-line box -------------------------------------------------------
export const BAR_NOTE_MAX = 500;
export const BAR_NOTE_PLACEHOLDER = '对这根 K 线的看法：回车保存，空着回车删除，Esc 取消';

/**
 * The note box at the top of a chart card: one line, hidden until a candle is double-clicked. Enter (with or without
 * Ctrl / ⌘) saves, Esc leaves without saving, an empty line is the explicit "delete this note". `show` fills the
 * title (the candle's stamp) and the note it already has; both pages hand it the callbacks that save / close.
 */
export function createBarNoteBox({ submit, close } = {}) {
  const row = document.createElement('div');
  row.className = 'bar-note-row';
  row.hidden = true;
  row.innerHTML = '<strong class="bar-note-title"></strong>'
    + `<input class="bar-note-input" maxlength="${BAR_NOTE_MAX}" placeholder="${BAR_NOTE_PLACEHOLDER}" aria-label="对这根 K 线的看法">`
    + '<span class="bar-note-hint"></span>';
  const input = row.querySelector('.bar-note-input');
  const title = row.querySelector('.bar-note-title');
  const hint = row.querySelector('.bar-note-hint');
  input.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); submit?.(); }
    else if (event.key === 'Escape') { event.preventDefault(); close?.(); }
  };
  return {
    row, input, title, hint,
    get open() { return !row.hidden; },
    show(text, value = '') {
      title.textContent = text; hint.textContent = ''; input.value = value;
      row.hidden = false; input.focus(); input.select();
    },
    hide() { row.hidden = true; input.value = ''; },
    /** What the box holds: trimmed and capped, so a pasted essay cannot exceed what the server keeps. */
    value: () => input.value.trim().slice(0, BAR_NOTE_MAX),
    say: message => { hint.textContent = message; },
  };
}

// ---- The 备注本 picker -------------------------------------------------------
/**
 * 「备注本：[下拉] [新建]」, the same control above the finder's label counts and above the market page's 备注 search.
 * The page owns the data: it hands the server's list (POST /review/label-books) and the open book to `setBooks`, and
 * gets `change(name)` when another book is picked and `create(name)` when a new name is typed and Enter is pressed.
 * 新建 opens a row inside the page (never window.prompt) — Enter creates and switches, Esc closes it, and a bad or
 * taken name is refused here with a Chinese line beside the box. There is no delete / rename, on purpose.
 */
export function createBookPicker({ change, create } = {}) {
  const row = document.createElement('div');
  row.className = 'book-picker';
  row.innerHTML = '<span class="book-title">备注本</span>'
    + '<select class="book-select" aria-label="备注本"></select>'
    + '<button type="button" class="book-new">新建</button>'
    + `<input class="book-input" maxlength="${BOOK_MAX}" aria-label="新备注本的名字" placeholder="名字，回车新建" hidden>`
    + '<span class="book-hint" role="status"></span>'
    + '<span class="book-note"></span>';
  const select = row.querySelector('.book-select');
  const newButton = row.querySelector('.book-new');
  const input = row.querySelector('.book-input');
  const hint = row.querySelector('.book-hint');
  const notice = row.querySelector('.book-note');
  let books = [], current = '';

  const say = message => { hint.textContent = message ?? ''; };
  const hideForm = () => { input.hidden = true; input.value = ''; say(''); };

  select.onchange = () => {
    hideForm();
    const next = bookName(select.value);
    const before = current;
    current = next;
    if (next !== before) change?.(next);
  };
  newButton.onclick = () => { input.hidden = false; input.value = ''; say(''); input.focus(); };
  input.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); hideForm(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = input.value.trim().slice(0, BOOK_MAX);
    if (!name) { say('名字不能为空'); return; }
    if (!validBookName(name)) { say('名字只能用中英文、数字、_ 和 -（1–40 字，不能有 / . 空格）'); return; }
    if (books.some(book => book.name === name)) { say(`备注本「${name}」已存在`); return; }
    say('');
    create?.(name);
  };

  return {
    row, select, input,
    say,
    /** The line under the picker that stays until it changes: e.g. "那个本不在了，已回到默认本". */
    note: message => { notice.textContent = message ?? ''; },
    hideForm,
    value: () => select.value,
    /** Draw the server's books, one row per book (`名字（N 条）`), with `open` selected. */
    setBooks(next, open = current) {
      books = (next ?? []).filter(book => validBookName(book?.name));
      current = bookName(open);
      const options = books.map(book => {
        const option = document.createElement('option');
        option.value = book.name; option.textContent = bookOptionText(book);
        return option;
      });
      // A book the server did not list (an empty answer, a read that failed) still has to be selectable: the page must
      // never show book A while saving into book B.
      if (!books.some(book => book.name === current)) {
        const option = document.createElement('option');
        option.value = current; option.textContent = bookOptionText({ name: current, rows: 0 });
        options.unshift(option);
      }
      select.replaceChildren(...options);
      select.value = current;
    },
  };
}
