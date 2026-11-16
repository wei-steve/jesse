import test from 'node:test';
import assert from 'node:assert/strict';
import { barKey } from '../jesse/static/review/labels.mjs';
import { barSnapshot } from '../jesse/static/review/finder-data.mjs';
import { noteExchange, noteSymbol, noteIdentity, noteTargetOf, splitBarKey, barNoteKey, barNoteBody,
  rememberNote, barsFor, noteMarkers, noteTimeText, noteWhere, noteDigest, noteSummary, noteRowsFrom,
  filterNoteRows, sessionSnapshot, snapshotOf, CHOSEN_NOTE_COLOR, NOTE_DIGEST } from '../jesse/static/review/bar-notes.mjs';

// ---- Naming: one candle is one note on both pages ---------------------------
// The factor finder's spelling of an instrument is the shared one (its exchange box holds these names).
test('noteExchange / noteSymbol name an instrument the finder\'s way', () => {
  assert.equal(noteExchange('binance', 'swap'), 'Binance Perpetual Futures');
  assert.equal(noteExchange('binance', 'spot'), 'Binance Spot');
  assert.equal(noteExchange('okx', 'swap'), 'OKX Perpetual');
  assert.equal(noteExchange('okx', 'spot'), 'OKX Spot');
  assert.equal(noteExchange('deepcoin', 'swap'), 'Deepcoin Perpetual');
  assert.equal(noteExchange('deepcoin', 'spot'), 'Deepcoin Spot');
  assert.equal(noteExchange('us-yields', null), 'US Treasury Yields');
  // A source with no such market, an unknown source and nothing at all name nothing.
  assert.equal(noteExchange('us-yields', 'swap'), 'US Treasury Yields');
  assert.equal(noteExchange('binance', 'margin'), '');
  assert.equal(noteExchange('nonsense', 'swap'), '');

  // Every venue spells a pair BTC-USDT, whatever its API calls it.
  assert.equal(noteSymbol('binance', 'BTCUSDT'), 'BTC-USDT');
  assert.equal(noteSymbol('binance', 'BTC-USDT'), 'BTC-USDT');
  assert.equal(noteSymbol('binance', '1000PEPEUSDT'), '1000PEPE-USDT');
  assert.equal(noteSymbol('okx', 'BTC-USDT-SWAP'), 'BTC-USDT');
  assert.equal(noteSymbol('deepcoin', 'eth-usdt'), 'ETH-USDT');
  assert.equal(noteSymbol('us-yields', 'us02y'), 'US02Y');
  assert.equal(noteSymbol('us-yields', 'US30Y'), 'US30Y');
  // The quote currency alone is the pair of nothing; an empty box names nothing.
  assert.equal(noteSymbol('binance', 'USDT'), '');
  assert.equal(noteSymbol('okx', ''), '');
  assert.equal(noteSymbol('us-yields', 'GOLD'), '');
});

test('noteIdentity + barNoteKey build the key the finder builds for the same candle', () => {
  const form = noteIdentity('binance', 'swap', 'BTCUSDT');
  assert.deepEqual(form, { exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT' });
  // The finder keys a candle from its own exchange / symbol boxes; the same instrument must reach the same key.
  const finderForm = { factor: 'ma_pullback', exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT' };
  assert.equal(barNoteKey(form, '15m', 1763000000), barKey(finderForm, '15m', 1763000000));
  assert.equal(barNoteKey(form, '15m', 1763000000), 'bar|Binance Perpetual Futures|BTC-USDT|15m|1763000000');
  // Another market / timeframe / candle (and every other source) is a different note.
  assert.notEqual(barNoteKey(noteIdentity('binance', 'spot', 'BTCUSDT'), '15m', 1763000000), barNoteKey(form, '15m', 1763000000));
  assert.notEqual(barNoteKey(noteIdentity('okx', 'swap', 'BTC-USDT-SWAP'), '15m', 1763000000), barNoteKey(form, '15m', 1763000000));
  assert.notEqual(barNoteKey(form, '5m', 1763000000), barNoteKey(form, '15m', 1763000000));
  // The yields use their own code, not a pair.
  assert.equal(barNoteKey(noteIdentity('us-yields', null, 'US02Y'), '1D', 1763000000),
    'bar|US Treasury Yields|US02Y|1D|1763000000');
});

test('noteTargetOf turns a stored note back into the page state that draws it', () => {
  assert.deepEqual(noteTargetOf('Binance Perpetual Futures', 'BTC-USDT'), { source: 'binance', market: 'swap', symbol: 'BTCUSDT' });
  assert.deepEqual(noteTargetOf('Binance Spot', 'BTC-USDT'), { source: 'binance', market: 'spot', symbol: 'BTCUSDT' });
  assert.deepEqual(noteTargetOf('OKX Perpetual', 'BTC-USDT'), { source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' });
  assert.deepEqual(noteTargetOf('OKX Spot', 'BTC-USDT'), { source: 'okx', market: 'spot', symbol: 'BTC-USDT' });
  assert.deepEqual(noteTargetOf('Deepcoin Perpetual', 'ETH-USDT'), { source: 'deepcoin', market: 'swap', symbol: 'ETH-USDT-SWAP' });
  assert.deepEqual(noteTargetOf('US Treasury Yields', 'US10Y'), { source: 'us-yields', market: null, symbol: 'US10Y' });
  // A note of another broker (the finder's exchange box takes anything), a broken symbol or a hand-edited line: no target.
  assert.equal(noteTargetOf('Bybit Perpetual', 'BTC-USDT'), null);
  assert.equal(noteTargetOf('US Treasury Yields', 'GOLD'), null);
  assert.equal(noteTargetOf('', 'BTC-USDT'), null);
  assert.equal(noteTargetOf('Binance Spot', ''), null);
});

test('splitBarKey reads a candle key and refuses anything else', () => {
  assert.deepEqual(splitBarKey('bar|Binance Spot|BTC-USDT|3m|1763000000'),
    { exchange: 'Binance Spot', symbol: 'BTC-USDT', tf: '3m', time: 1763000000 });
  // A signal key, a short line, another kind and a non-numeric time are not candle notes.
  assert.equal(splitBarKey('ma_pullback|Binance Perpetual Futures|BTC-USDT|15m|1763000000|-1'), null);
  assert.equal(splitBarKey('bar|Binance Spot|BTC-USDT|3m'), null);
  assert.equal(splitBarKey('note|Binance Spot|BTC-USDT|3m|1763000000'), null);
  assert.equal(splitBarKey('bar|Binance Spot|BTC-USDT|3m|later'), null);
  assert.equal(splitBarKey(undefined), null);
});

// ---- Saving ----------------------------------------------------------------
test('barNoteBody is the POST /review/label row, with the snapshot and whatever the page adds', () => {
  const form = noteIdentity('okx', 'spot', 'BTC-USDT');
  const body = barNoteBody({ form, tf: '15m', time: 1763000000, text: '这里放量' });
  assert.deepEqual(body, { key: 'bar|OKX Spot|BTC-USDT|15m|1763000000', kind: 'bar', note: '这里放量',
    exchange: 'OKX Spot', symbol: 'BTC-USDT', tf: '15m', time: 1763000000 });
  // No snapshot (a candle the page has no numbers for) leaves the field out instead of sending null.
  assert.ok(!('bar' in body));
  const withBar = barNoteBody({ form, tf: '15m', time: 1763000000, text: '', bar: { forming: true }, extra: { signal: 'x' } });
  assert.equal(withBar.note, '');
  assert.deepEqual(withBar.bar, { forming: true });
  assert.equal(withBar.signal, 'x');
  // An empty text is still a row: it is the "delete this note" row of the file.
  assert.equal(withBar.kind, 'bar');
});

test('rememberNote keeps the local state in step with the file', () => {
  const key = barNoteKey(noteIdentity('binance', 'swap', 'BTCUSDT'), '15m', 1763000000);
  const saved = rememberNote({}, key, '想法', '15m', 1763000000);
  assert.deepEqual(saved, { [key]: { note: '想法', tf: '15m', time: 1763000000 } });
  // The old object is not mutated (the page reassigns), and an empty text removes the note.
  assert.deepEqual(rememberNote(saved, key, '改过', '15m', 1763000000)[key], { note: '改过', tf: '15m', time: 1763000000 });
  assert.deepEqual(rememberNote(saved, key, '', '15m', 1763000000), {});
  assert.deepEqual(rememberNote(undefined, key, '', '15m', 1763000000), {});
});

test('barsFor keeps only the notes of the instrument on screen', () => {
  const btc = barNoteKey(noteIdentity('binance', 'swap', 'BTCUSDT'), '15m', 1763000000);
  const btc5 = barNoteKey(noteIdentity('binance', 'swap', 'BTCUSDT'), '5m', 1763000000);
  const spot = barNoteKey(noteIdentity('binance', 'spot', 'BTCUSDT'), '15m', 1763000000);
  const okx = barNoteKey(noteIdentity('okx', 'swap', 'BTC-USDT-SWAP'), '15m', 1763000000);
  const bars = { [btc]: { note: '甲', tf: '15m', time: 1763000000 }, [btc5]: { note: '乙', tf: '5m', time: 1763000000 },
    [spot]: { note: '丙', tf: '15m', time: 1763000000 }, [okx]: { note: '丁', tf: '15m', time: 1763000000 } };
  assert.deepEqual(Object.keys(barsFor(bars, noteIdentity('binance', 'swap', 'BTCUSDT'))).sort(), [btc, btc5].sort());
  assert.deepEqual(Object.keys(barsFor(bars, noteIdentity('binance', 'spot', 'BTCUSDT'))), [spot]);
  // A Map of the same shape works, and nothing on screen means nothing to draw.
  assert.equal(Object.keys(barsFor(new Map(Object.entries(bars)), noteIdentity('okx', 'swap', 'BTC-USDT-SWAP'))).length, 1);
  assert.deepEqual(barsFor({}, noteIdentity('deepcoin', 'swap', 'BTC-USDT-SWAP')), {});
  assert.deepEqual(barsFor(null, noteIdentity('binance', 'swap', 'BTCUSDT')), {});
});

// ---- Markers ---------------------------------------------------------------
test('noteMarkers draws the purple 「注」 of this chart, the chosen one amber and bigger', () => {
  const form = noteIdentity('binance', 'swap', 'BTCUSDT');
  const bars = {
    [barNoteKey(form, '15m', 1763000000)]: { note: '甲', tf: '15m', time: 1763000000 },
    [barNoteKey(form, '15m', 1763000180)]: { note: '乙', tf: '15m', time: 1763000180 },
    [barNoteKey(form, '5m', 1763000000)]: { note: '丙', tf: '5m', time: 1763000000 },
  };
  const markers = noteMarkers(bars, '15m');
  assert.deepEqual(markers.map(marker => marker.time), [1763000000, 1763000180]);
  assert.deepEqual(markers[0], { bar: true, time: 1763000000, position: 'aboveBar', shape: 'square',
    color: '#7c3aed', text: '注' });
  // The row a 备注 click jumped to: amber, size 2, an arrow in the text; the others are untouched.
  const chosen = noteMarkers(bars, '15m', () => true, 1763000180);
  assert.equal(chosen[0].color, '#7c3aed');
  assert.deepEqual(chosen[1], { bar: true, time: 1763000180, position: 'aboveBar', shape: 'square',
    color: CHOSEN_NOTE_COLOR, size: 2, text: '▶注' });
  assert.equal(CHOSEN_NOTE_COLOR, '#f59e0b');
  // Only candles the chart draws, and a chosen candle with no note marks nothing.
  assert.deepEqual(noteMarkers(bars, '15m', time => time === 1763000180).map(marker => marker.time), [1763000180]);
  assert.deepEqual(noteMarkers(bars, '15m', () => true, 1763000500).map(marker => marker.color), ['#7c3aed', '#7c3aed']);
  assert.deepEqual(noteMarkers(bars, '1h'), []);
});

// ---- The 备注 list ---------------------------------------------------------
const btcForm = noteIdentity('binance', 'swap', 'BTCUSDT');
const noteBars = {
  // 1763000000 = 2026-11-13 02:13:20 UTC.
  [barNoteKey(btcForm, '15m', 1763000000)]: { note: '  这里放量\n第二行  ', tf: '15m', time: 1763000000 },
  [barNoteKey(btcForm, '5m', 1763000600)]: { note: '五分钟的想法', tf: '5m', time: 1763000600 },
  [barNoteKey(noteIdentity('okx', 'swap', 'BTC-USDT-SWAP'), '1h', 1763001200)]: { note: 'OKX 上看', tf: '1h', time: 1763001200 },
  [barNoteKey(noteIdentity('us-yields', null, 'US02Y'), '1D', 1762990000)]: { note: '两年期见顶', tf: '1D', time: 1762990000 },
  // A finder note of a broker the market page cannot open, and a signal key that is not a candle note at all.
  'bar|Bybit Perpetual|BTC-USDT|15m|1763001800': { note: '别处写的', tf: '15m', time: 1763001800 },
  'ma_pullback|Binance Perpetual Futures|BTC-USDT|15m|1763000000|-1': { note: '信号的备注' },
};

test('noteRowsFrom lists every candle note, newest candle first, and resolves its page target', () => {
  const rows = noteRowsFrom(noteBars);
  assert.deepEqual(rows.map(row => row.time), [1763001800, 1763001200, 1763000600, 1763000000, 1762990000]);
  // The source / instrument come from the key (the answer carries only note / tf / time per key).
  const okx = rows.find(row => row.symbol === 'BTC-USDT' && row.exchange === 'OKX Perpetual');
  assert.deepEqual(okx.target, { source: 'okx', market: 'swap', symbol: 'BTC-USDT-SWAP' });
  assert.equal(okx.tf, '1h');
  // A broker the market page has no source for is still listed, just not jumpable.
  assert.equal(rows.find(row => row.exchange === 'Bybit Perpetual').target, null);
  // The yields row resolves to its own source and keeps its code.
  assert.deepEqual(rows.find(row => row.symbol === 'US02Y').target, { source: 'us-yields', market: null, symbol: 'US02Y' });
  // The note text is kept whole here; the row shortens it when it is drawn.
  assert.equal(rows.find(row => row.time === 1763000000).note, '  这里放量\n第二行  ');
  // An empty note (deleted) and an entry with no text never come back; a Map answer works too.
  assert.deepEqual(noteRowsFrom({ [barNoteKey(btcForm, '15m', 1763000000)]: { note: '', tf: '15m', time: 1763000000 } }), []);
  assert.equal(noteRowsFrom(new Map(Object.entries(noteBars))).length, 5);
  assert.deepEqual(noteRowsFrom(undefined), []);
});

test('noteSummary / noteWhere / noteDigest are the line the 备注 list draws', () => {
  const rows = noteRowsFrom(noteBars);
  const btc = rows.find(row => row.time === 1763000000);
  assert.equal(noteWhere(btc), 'Binance 合约');
  assert.equal(noteSummary(btc), 'BTC-USDT · Binance 合约 · 15m · 11-13 02:13 UTC · 这里放量 第二行');
  assert.equal(noteSummary(rows.find(row => row.symbol === 'US02Y')), 'US02Y · 美债收益率 · 1D · 11-12 23:26 UTC · 两年期见顶');
  // A source the page cannot open falls back to the stored exchange name.
  assert.equal(noteWhere(rows.find(row => row.exchange === 'Bybit Perpetual')), 'Bybit Perpetual');
  // 40 characters, then an ellipsis; the newlines become single spaces so one note stays one row.
  assert.equal(NOTE_DIGEST, 40);
  assert.equal(noteDigest('一'.repeat(40)), '一'.repeat(40));
  assert.equal(noteDigest('一'.repeat(41)), `${'一'.repeat(40)}…`);
  assert.equal(noteDigest('  a\n\n b  '), 'a b');
  assert.equal(noteDigest(undefined), '');
  assert.equal(noteTimeText(1763000000), '11-13 02:13');
  assert.equal(noteTimeText(undefined), '');
});

test('filterNoteRows searches the note, the instrument, the timeframe and the source', () => {
  const rows = noteRowsFrom(noteBars);
  const keys = (query) => filterNoteRows(rows, query).map(row => row.symbol);
  assert.deepEqual(keys(''), rows.map(row => row.symbol));
  assert.deepEqual(keys('   '), rows.map(row => row.symbol));
  assert.deepEqual(keys('放量'), ['BTC-USDT']);
  assert.deepEqual(keys('us02y'), ['US02Y']);
  assert.deepEqual(keys('1D'), ['US02Y']);
  assert.deepEqual(keys('okx'), ['BTC-USDT']);
  assert.deepEqual(keys('合约'), ['BTC-USDT', 'BTC-USDT', 'BTC-USDT']);
  assert.deepEqual(keys('nothing here'), []);
  assert.deepEqual(filterNoteRows(undefined, 'x'), []);
});

// ---- The snapshot a note carries -------------------------------------------
const candle = (time, close, spread = 1) => ({ time, open: close, high: close + spread, low: close - spread, close });

test('snapshotOf is the finder\'s barSnapshot for a 24-hour market', () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(1763000000 + i * 900, 100 + i));
  const time = candles[20].time;
  assert.deepEqual(snapshotOf(candles, time, 15), barSnapshot(candles, time, 15));
  assert.deepEqual(snapshotOf(candles, time, 15, false), barSnapshot(candles, time, 15));
  // A time that is not a candle has nothing to note.
  assert.equal(snapshotOf(candles, 1763000000 + 1, 15), null);
  assert.deepEqual(Object.keys(snapshotOf(candles, time, 15)),
    ['open', 'high', 'low', 'close', 'ma5', 'ma10', 'atr', 'bollUpper', 'bollMid', 'bollLower']);
});

test('sessionSnapshot counts a session market\'s windows over consecutive bars', () => {
  // 1h bars, then a three-day gap (the weekend), then the next session: only four bars have closed after the gap,
  // so the finder's SMA (which starts afresh at a gap) has no MA5 yet.
  const first = Array.from({ length: 40 }, (_, i) => candle(1763000000 + i * 3600, 100 + i));
  const last = first.at(-1).time;
  const second = Array.from({ length: 4 }, (_, i) => candle(last + 3 * 86400 + (i + 1) * 3600, 500 + i));
  const candles = [...first, ...second];
  const time = second.at(-1).time;
  assert.equal(barSnapshot(candles, time, 60).ma5, null);
  assert.equal(barSnapshot(candles, time, 60).ma10, null);
  // Session windows: the average of the last five closes in the series (three from before the gap + two after).
  const closes = candles.map(candleOf => candleOf.close);
  const session = sessionSnapshot(candles, time);
  assert.equal(session.ma5, closes.slice(-5).reduce((total, close) => total + close, 0) / 5);
  assert.equal(session.ma10, closes.slice(-10).reduce((total, close) => total + close, 0) / 10);
  // BOLL and ATR are already computed bar by bar, so the two snapshots agree there (the gap is a real overnight move).
  assert.deepEqual([session.atr, session.bollUpper, session.bollMid, session.bollLower],
    [barSnapshot(candles, time, 60).atr, barSnapshot(candles, time, 60).bollUpper,
      barSnapshot(candles, time, 60).bollMid, barSnapshot(candles, time, 60).bollLower]);
  // Without a gap the session snapshot is the finder's one: same numbers, same shape.
  const smooth = Array.from({ length: 30 }, (_, i) => candle(1763000000 + i * 3600, 100 + i));
  assert.deepEqual(sessionSnapshot(smooth, smooth[25].time), barSnapshot(smooth, smooth[25].time, 60));
  // A window that is not complete is null, never a made-up number, and a missing candle gives nothing.
  const short = Array.from({ length: 3 }, (_, i) => candle(1763000000 + i * 3600, 100 + i));
  assert.deepEqual([sessionSnapshot(short, short[2].time).ma5, sessionSnapshot(short, short[2].time).ma10,
    sessionSnapshot(short, short[2].time).bollMid, sessionSnapshot(short, short[2].time).atr], [null, null, null, null]);
  assert.equal(sessionSnapshot(short, 123), null);
  // snapshotOf(session) is exactly sessionSnapshot, whatever the interval says.
  assert.deepEqual(snapshotOf(smooth, smooth[25].time, 60, true), sessionSnapshot(smooth, smooth[25].time));
});
