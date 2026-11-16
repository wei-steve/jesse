// Pure helpers of the market page (market.mjs): the Binance request URLs, REST rows -> candles, the merge that keeps
// loaded history while refreshing, the `@miniTicker` quotes of the watchlist, and what localStorage holds.
// No DOM, no fetch, no websocket: tests/review-market-data.test.mjs runs every function in this file with node.
import { DEFAULT_SOURCE, SPOT_SOURCE, YIELD_SOURCE, DEFAULT_YIELD_SYMBOLS, DEFAULT_YIELD_SYMBOL, MARKET_SOURCES,
  normalizeYieldSymbol, isYieldSource } from './market-sources.mjs?v=20261116g';

// Binance USDTⓈ-M futures, public and CORS-open (`access-control-allow-origin: *`), so the browser talks to the
// exchange directly: any USDT perpetual can be watched, nothing has to be imported into Jesse's database and no
// Jesse endpoint is involved. Spot is the same API on the other host (api.binance.com, `v3` instead of `fapi/v1`).
const KLINE_API = 'https://fapi.binance.com/fapi/v1/klines';
const SPOT_KLINE_API = 'https://api.binance.com/api/v3/klines';
// `@miniTicker` exists on both markets, on different hosts: the rows of each source come from its own venue.
const QUOTE_STREAMS = {
  'Binance Perpetual Futures': 'wss://fstream.binance.com/market/stream?streams=',
  'Binance Spot': 'wss://stream.binance.com:9443/stream?streams=',
};
const DEFAULT_QUOTE_EXCHANGE = 'Binance Perpetual Futures';

// One REST page is the exchange's maximum of 1000 bars ("limit"). 5000 bars per timeframe is the most this page
// keeps: earlier pages are only requested while a chart is under it, and a live catch-up keeps the newest bars.
export const KLINE_LIMIT = 1000;
export const MAX_BARS = 5000;

export const MARKET_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];
export const DEFAULT_TIMEFRAMES = ['4h', '1h', '15m', '5m'];
// One entry per watchlist row, with the source it belongs to; the yields are seeded once by the page (the four the
// owner had on screen), after that the list is only what he saved.
export const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT']
  .map(symbol => ({ source: DEFAULT_SOURCE, symbol }));
export const MAX_WATCHLIST = 20;
export const DEFAULT_SYMBOL = 'BTCUSDT';
// One key per saved choice; the market page has its own namespace so it never collides with the finder's form.
// `symbol` holds the whole selection (`{source, symbol}`), `source` the dropdown on its own, `yields` remembers that
// the four default yields were added once (so deleting them keeps them deleted).
export const MARKET_KEYS = { symbol: 'jesse.market.symbol.v1', source: 'jesse.market.source.v1',
  watchlist: 'jesse.market.watchlist.v1', timeframes: 'jesse.market.timeframes.v1',
  yieldSeed: 'jesse.market.yields.v1' };

// Binance spells the daily interval in lower case; every other timeframe of this page is the same in both.
const INTERVALS = { '1D': '1d' };
const MINUTES = { m: 1, h: 60, D: 1440 };

const minutesOf = timeframe => {
  const match = /^(\d+)(m|h|D)$/.exec(timeframe ?? '');
  return match ? Number(match[1]) * MINUTES[match[2]] : 0;
};

/**
 * What the owner typed -> the exchange's symbol: `btc`, `btc-usdt`, ` BTCUSDT ` and `btc/usdt` all become
 * `BTCUSDT`. Anything that cannot be a USDT perpetual gives '' (the page shows a hint instead of requesting it).
 */
export function normalizeSymbol(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  // The quote currency is implied: a base alone is completed, a full pair is kept as typed.
  const pair = raw.endsWith('USDT') ? raw : `${raw}USDT`;
  // 2–16 characters of base ("1000PEPEUSDT" is a real contract) plus USDT.
  return /^[A-Z0-9]{2,16}USDT$/.test(pair) ? pair : '';
}

/**
 * The klines request of one timeframe. `endTime` (milliseconds) asks for the page ending at that bar, which is how
 * earlier history is pulled; without it the newest bars come back.
 */
export function klinesUrl(symbol, timeframe, { limit = KLINE_LIMIT, endTime = null } = {}) {
  return `${KLINE_API}?${klineParams(symbol, timeframe, limit, endTime)}`;
}

/** The same page on `api.binance.com` (spot). Same rows, same interval spelling, other host. */
export function spotKlinesUrl(symbol, timeframe, { limit = KLINE_LIMIT, endTime = null } = {}) {
  return `${SPOT_KLINE_API}?${klineParams(symbol, timeframe, limit, endTime)}`;
}

function klineParams(symbol, timeframe, limit, endTime) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol),
    interval: INTERVALS[timeframe] ?? String(timeframe ?? ''), limit: String(limit) });
  if (Number.isFinite(endTime)) params.set('endTime', String(Math.trunc(endTime)));
  return params;
}

/**
 * The REST URL of one source's klines page, or null for a source the browser cannot read (the yields go through
 * `POST /review/market/candles`). Everything else about the two Binance sources is identical.
 */
export function klinesUrlFor(source, symbol, timeframe, options = {}) {
  if (isYieldSource(source)) return null;
  return source === SPOT_SOURCE ? spotKlinesUrl(symbol, timeframe, options) : klinesUrl(symbol, timeframe, options);
}

/** `endTime` of the page before the oldest loaded bar: the REST filter is inclusive, so one millisecond earlier. */
export const endTimeBefore = earliestSeconds => Math.round(earliestSeconds * 1000) - 1;

/**
 * One REST row (`[openTimeMs, "o", "h", "l", "c", "v", closeTimeMs, …]`) as the candle the chart draws, or null for
 * a row that is not a sane OHLC bar. The last row of a klines answer is the bar the exchange is still building (its
 * close time is in the future): it is split off as `forming`, which is display only and never counted as closed.
 */
function rowCandle(row) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const time = Math.floor(Number(row[0]) / 1000);
  const [open, high, low, close] = row.slice(1, 5).map(Number);
  if (![time, open, high, low, close].every(Number.isFinite) || time <= 0) return null;
  if (open <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  const volume = Number(row[5]);
  return { time, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 };
}

export function parseKlines(rows, nowMs = Date.now()) {
  const closed = [];
  let forming = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const candle = rowCandle(row);
    if (!candle) continue;
    if (Number(Number(row[6])) > nowMs) forming = candle;
    else closed.push(candle);
  }
  return { closed: mergeCandles(closed), forming };
}

/**
 * Candles by open time, oldest first, later lists winning on a shared time: an older history page plus the newest
 * bars a refresh returned in one array, without duplicates and without a second copy of a bar that closed meanwhile.
 */
export function mergeCandles(...lists) {
  const byTime = new Map();
  for (const list of lists) {
    for (const candle of Array.isArray(list) ? list : []) {
      if (Number.isFinite(candle?.time)) byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * One `@miniTicker` message (combined stream: `{stream, data:{…}}`) as the watchlist row shows it: the last price and
 * the 24-hour change computed from the open (`(c - o) / o`), the pair of numbers the exchange itself puts in the
 * message. Null for anything else (a kline message, a malformed price).
 */
export function parseMiniTicker(message) {
  const data = message?.data ?? message;
  const symbol = String(data?.s ?? '').toUpperCase();
  const close = Number(data?.c);
  const open = Number(data?.o);
  if (!symbol || !Number.isFinite(close) || close <= 0) return null;
  return { symbol, price: close, change: Number.isFinite(open) && open > 0 ? (close - open) / open : null };
}

/** One combined miniTicker stream for a watchlist of one venue (the exchange allows several streams per socket). */
export function miniTickerStreamUrl(symbols, exchange = DEFAULT_QUOTE_EXCHANGE) {
  const base = QUOTE_STREAMS[exchange];
  const pairs = [...new Set((Array.isArray(symbols) ? symbols : []).map(normalizeSymbol).filter(Boolean))];
  return base && pairs.length ? `${base}${pairs.map(pair => `${pair.toLowerCase()}@miniTicker`).join('/')}` : null;
}

/**
 * A watchlist row: `{source, symbol}`. A bare string is the pre-T-53 format (there was only one source then), so a
 * saved list keeps working; `symbol` is normalized per source (a pair for Binance, US03M…US30Y for the yields).
 */
export function watchItem(value) {
  // Only strings and objects: a number in a hand-edited file is junk, not a pair. `normalizeSymbol` would turn
  // `42` into `42USDT` (a real base name looks like that).
  if (typeof value === 'string') {
    const symbol = normalizeSymbol(value);
    return symbol ? { source: DEFAULT_SOURCE, symbol } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const known = MARKET_SOURCES.some(source => source.id === value.source);
  if (!known) return null;
  if (isYieldSource(value.source)) {
    const symbol = normalizeYieldSymbol(value.symbol);
    return symbol ? { source: value.source, symbol } : null;
  }
  const symbol = normalizeSymbol(value.symbol);
  return symbol ? { source: value.source, symbol } : null;
}

/** One row's identity (`binance-perp|BTCUSDT`): the same pair on another source is another row. */
export const watchKey = item => `${item.source}|${item.symbol}`;

export const sameWatchItem = (a, b) => !!a && !!b && a.source === b.source && a.symbol === b.symbol;

/**
 * The saved watchlist. A broken or empty value falls back to the default list (an empty sidebar would look like the
 * page failed); entries are normalized and de-duplicated, so a hand-edited value still lands on real instruments.
 */
export function restoreWatchlist(serialized) {
  const fallback = DEFAULT_WATCHLIST.map(item => ({ ...item }));
  let value;
  try { value = JSON.parse(serialized); } catch { return fallback; }
  if (!Array.isArray(value)) return fallback;
  const list = [], seen = new Set();
  for (const raw of value) {
    const item = watchItem(raw);
    if (!item || seen.has(watchKey(item))) continue;
    seen.add(watchKey(item));
    list.push(item);
  }
  return list.length ? list.slice(0, MAX_WATCHLIST) : fallback;
}

/** The four default yields, appended to a list that does not have them yet (the page does this once). */
export function withDefaultYields(list) {
  let next = Array.isArray(list) ? [...list] : [];
  for (const symbol of DEFAULT_YIELD_SYMBOLS) {
    const item = { source: YIELD_SOURCE, symbol };
    if (next.some(existing => sameWatchItem(existing, item))) continue;
    next.push(item);
  }
  return next.slice(0, MAX_WATCHLIST);
}

export function addToWatchlist(list, input) {
  const current = Array.isArray(list) ? [...list] : [];
  const item = watchItem(input);
  if (!item || current.some(existing => sameWatchItem(existing, item))) return current;
  return [...current, item].slice(0, MAX_WATCHLIST);
}

export function removeFromWatchlist(list, input) {
  const item = watchItem(input);
  return (Array.isArray(list) ? list : []).filter(existing => !sameWatchItem(existing, item));
}

/**
 * The last chart on screen (`{source, symbol}`). Before T-53 the value was a bare pair string and there was one
 * source; that still restores, as a Binance perpetual.
 */
export function restoreSelection(serialized) {
  let value;
  try { value = JSON.parse(serialized); } catch { value = serialized; }
  const item = watchItem(value);
  if (item) return item;
  return { source: DEFAULT_SOURCE, symbol: DEFAULT_SYMBOL };
}

/** A source's default instrument (the page switches to it when the dropdown changes the source). */
export const defaultSymbolFor = source => (isYieldSource(source) ? DEFAULT_YIELD_SYMBOL
  : MARKET_SOURCES.find(entry => entry.id === source)?.defaultSymbol ?? DEFAULT_SYMBOL);

/** Only the timeframes this page can draw, smallest first (the same order the checkbox row uses). */
export function orderTimeframes(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(tf => MARKET_TIMEFRAMES.includes(tf)))]
    .sort((a, b) => minutesOf(a) - minutesOf(b));
}

/** The checked timeframes; nothing selected (or a broken value) means the default 4h / 1h / 15m / 5m. */
export function restoreTimeframes(serialized) {
  let value;
  try { value = JSON.parse(serialized); } catch { return [...DEFAULT_TIMEFRAMES]; }
  const list = orderTimeframes(value);
  return list.length ? list : [...DEFAULT_TIMEFRAMES];
}

/**
 * A visible window after `added` bars were prepended: bar positions are indices, so every index moves right by the
 * number of new bars — that is what keeps the picture from jumping when an earlier page lands.
 */
export const shiftLogical = (range, added) => (range ? { from: range.from + added, to: range.to + added } : null);
