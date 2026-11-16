// Pure helpers of the market page (market.mjs): the exchange request URLs of Binance / OKX / Deepcoin, REST rows ->
// candles, the product list (`tickers`) of each venue, the merge that keeps loaded history while refreshing, the
// `@miniTicker` quotes of the watchlist, and what localStorage holds.
// No DOM, no fetch, no websocket: tests/review-market-data.test.mjs runs every function in this file with node.
import { BINANCE_SOURCE, DEFAULT_MARKET, DEFAULT_SOURCE, DEFAULT_YIELD_SYMBOLS, OKX_SOURCE, YIELD_SOURCE, MARKETS,
  aggregateCandles, candleRequest, defaultSymbolOf, migrateSource, normalizeMarket, normalizeSymbol,
  symbolOf } from './market-sources.mjs?v=20261116l';

// Binance USDTⓈ-M futures, public and CORS-open (`access-control-allow-origin: *`), so the browser talks to the
// exchange directly: any USDT perpetual can be watched, nothing has to be imported into Jesse's database and no
// Jesse endpoint is involved. Spot is the same API on the other host (api.binance.com, `v3` instead of `fapi/v1`).
const KLINE_API = 'https://fapi.binance.com/fapi/v1/klines';
const SPOT_KLINE_API = 'https://api.binance.com/api/v3/klines';
// OKX answers with CORS echoing the origin, so it is read directly too. `candles` serves the newest 1440 bars of a
// timeframe at most 300 at a time; anything older comes from `history-candles` (100 at a time).
const OKX_API = 'https://www.okx.com/api/v5/market';
export const OKX_LIMIT = 300;
export const OKX_HISTORY_LIMIT = 100;

// CNBC is CORS-open too (`access-control-allow-origin: *`), so the treasury yields are read straight from the browser
// (T-55): its chart endpoint serves `1D` (one-minute bars of the current session) through `6M` (daily, about three
// years) of the Tradeweb feed, and its quote endpoint takes every maturity of the list in one request.
const CNBC_CHART_API = 'https://ts-api.cnbc.com/harmony/app/charts';
const CNBC_QUOTE_API = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';

/** The CNBC chart request of one range (`1D` / `5D` / `6M`) of one maturity, in CNBC's spelling (`US2Y`). */
export const cnbcChartUrl = (cnbcSymbol, range) => `${CNBC_CHART_API}/${encodeURIComponent(String(range ?? '1D'))}.json`
  + `?symbol=${encodeURIComponent(String(cnbcSymbol ?? ''))}`;

/** One CNBC quote request for every yield on screen (`['US2Y', 'US10Y']`), the codes joined with `|`. */
export const cnbcQuoteUrl = codes => {
  const list = (Array.isArray(codes) ? codes : []).map(code => String(code ?? '').trim()).filter(Boolean);
  if (!list.length) return null;
  return `${CNBC_QUOTE_API}?symbols=${encodeURIComponent(list.join('|'))}`
    + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
};

// Deepcoin does not send CORS headers: its candles and tickers go through Jesse (see market.mjs).
export const PROXY_CANDLES = '/review/market/candles';
export const PROXY_TICKERS = '/review/market/tickers';

// `@miniTicker` exists on both Binance markets, on different hosts: the rows of each source come from its own venue.
const QUOTE_STREAMS = {
  'Binance Perpetual Futures': 'wss://fstream.binance.com/market/stream?streams=',
  'Binance Spot': 'wss://stream.binance.com:9443/stream?streams=',
};
const DEFAULT_QUOTE_EXCHANGE = 'Binance Perpetual Futures';

// One REST page is the exchange's maximum for that venue ("limit"). 5000 bars per timeframe is the most this page
// keeps: earlier pages are only requested while a chart is under it, and a live catch-up keeps the newest bars.
export const KLINE_LIMIT = 1000;
export const MAX_BARS = 5000;
/** The page size one request may ask of `source` (`OKX_LIMIT` for OKX, 1000 elsewhere). */
export const pageSizeOf = source => (source === OKX_SOURCE ? OKX_LIMIT : KLINE_LIMIT);
/** Rows the product list draws at first; 「显示更多」 adds another page. */
export const PRODUCT_PAGE = 200;

export const MARKET_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'];
export const DEFAULT_TIMEFRAMES = ['4h', '1h', '15m', '5m'];
// One entry per watchlist row, with the source and market it belongs to; the yields are seeded once by the page (the
// four the owner had on screen), after that the list is only what he saved.
export const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT']
  .map(symbol => ({ source: DEFAULT_SOURCE, market: DEFAULT_MARKET, symbol }));
export const MAX_WATCHLIST = 20;
export const DEFAULT_SYMBOL = 'BTCUSDT';
// One key per saved choice; the market page has its own namespace so it never collides with the finder's form.
// `symbol` holds the whole selection (`{source, market, symbol}`), `source` the dropdown on its own, `yields` remembers
// that the four default yields were added once (so deleting them keeps them deleted), `aside` which of the two left
// column tabs was last open, `listMarket` the contract / spot sub-tab of the product list.
export const MARKET_KEYS = { symbol: 'jesse.market.symbol.v1', source: 'jesse.market.source.v1',
  watchlist: 'jesse.market.watchlist.v1', timeframes: 'jesse.market.timeframes.v1',
  yieldSeed: 'jesse.market.yields.v1', aside: 'jesse.market.asidetab.v1', listMarket: 'jesse.market.listmarket.v1' };

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
 * The OKX candles request of one timeframe: the newest page from `candles`, an older one from `history-candles`
 * (`after` = strictly older than that bar, which is what `before` means here). The interval is the display spelling
 * (`1h` -> `1H`, `1D` -> `1Dutc`), see candleRequest in market-sources.mjs.
 */
export function okxCandlesUrl(instId, timeframe, { limit = OKX_LIMIT, before = null } = {}) {
  const interval = candleRequest(OKX_SOURCE, timeframe).interval;
  const path = Number.isFinite(before) ? 'history-candles' : 'candles';
  const size = Number.isFinite(before) ? Math.min(limit, OKX_HISTORY_LIMIT) : Math.min(limit, OKX_LIMIT);
  const params = new URLSearchParams({ instId: String(instId ?? ''), bar: interval, limit: String(size) });
  if (Number.isFinite(before)) params.set('after', String(Math.round(before * 1000)));
  return `${OKX_API}/${path}?${params}`;
}

/** `endTime` of the page before the oldest loaded bar: the REST filter is inclusive, so one millisecond earlier. */
export const endTimeBefore = earliestSeconds => Math.round(earliestSeconds * 1000) - 1;

/**
 * The REST URL of one source's klines page, or null when that source has no exchange URL the browser could read:
 * Deepcoin goes through `POST /review/market/candles`, and the treasury yields come from CNBC (`cnbcChartUrl`).
 */
export function klinesUrlFor(source, market, symbol, timeframe, options = {}) {
  if (source === BINANCE_SOURCE) {
    return market === 'spot' ? spotKlinesUrl(symbol, timeframe, options) : klinesUrl(symbol, timeframe, options);
  }
  if (source === OKX_SOURCE) return okxCandlesUrl(symbol, timeframe, options);
  return null;
}

/** The product list request of one venue: Binance's whole 24h ticker array, OKX's per-market ticker array, or null.
 * The yields have no product list of their own: their six rows are quoted by `cnbcQuoteUrl`. */
export function tickersUrlFor(source, market) {
  if (source === BINANCE_SOURCE) {
    return market === 'spot' ? 'https://api.binance.com/api/v3/ticker/24hr' : 'https://fapi.binance.com/fapi/v1/ticker/24hr';
  }
  if (source === OKX_SOURCE) return `${OKX_API}/tickers?${new URLSearchParams({ instType: market === 'spot' ? 'SPOT' : 'SWAP' })}`;
  return null;
}

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
 * OKX's candles answer (`{code:'0', data:[[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm], …]}`, newest first) as the
 * charts draw it: oldest first, and the newest row as `forming` while `confirm` is 0 (the bar OKX is still building).
 * Only the newest row can be unconfirmed, so a 0 further down the list is treated as a closed bar.
 */
export function parseOkxCandles(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (String(payload?.code ?? '0') !== '0') return { closed: [], forming: null };
  const candles = [];
  for (const row of rows) {
    const candle = rowCandle(row);
    if (!candle) continue;
    candles.push({ candle, unconfirmed: row[8] === '0' || row[8] === 0 });
  }
  // OKX sends newest first; mergeCandles sorts and de-duplicates, so the order of the answer does not matter.
  const newest = candles[0];
  const closed = candles.filter((entry, index) => !(index === 0 && newest?.unconfirmed));
  return { closed: mergeCandles(closed.map(entry => entry.candle)),
    forming: newest?.unconfirmed ? newest.candle : null };
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
 * The forming bar of a bucketed panel (Deepcoin's 3m, built from 1m bars): the 1m bars of the bucket the forming bar
 * belongs to, plus the forming bar itself. `closed` loses that half-built bucket — it is not a closed bar yet.
 */
export function aggregateAnswer(closed, forming, minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return { closed: Array.isArray(closed) ? closed : [], forming };
  if (minutes === 1) return { closed: Array.isArray(closed) ? closed : [], forming };
  const width = minutes * 60;
  const buckets = aggregateCandles([...(Array.isArray(closed) ? closed : []),
    ...(forming ? [forming] : [])], minutes);
  const formingStart = forming ? Math.floor(forming.time / width) * width : null;
  return { closed: buckets.filter(bucket => bucket.time !== formingStart), forming:
    formingStart === null ? null : buckets.find(bucket => bucket.time === formingStart) ?? forming };
}
// --- Product list -------------------------------------------------------------------------------------------------
// The left column's second tab: every USDT product of a venue, biggest 24h turnover first.

const finite = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

/** A ticker row as the list draws it; `change` is relative (0.012 = +1.2%), null without an open price. */
const tickerRow = (symbol, last, open, quoteVolume) => {
  if (!symbol || !Number.isFinite(last) || last <= 0) return null;
  return { symbol: String(symbol).toUpperCase(), last,
    change: Number.isFinite(open) && open > 0 ? (last - open) / open : null,
    quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0 };
};

/**
 * One venue's ticker answer as `[{symbol, last, change, quoteVolume}]`, USDT pairs only, biggest turnover first.
 * Binance answers the whole array (1.9 MB on spot) with `lastPrice` / `openPrice` / `quoteVolume`; OKX and Deepcoin
 * answer `{code:'0', data:[{instId, last, open24h, volCcy24h}]}` per market, and both list non-USDT pairs too.
 */
export function tickerRows(source, market, payload) {
  const rows = [];
  if (source === BINANCE_SOURCE) {
    for (const entry of Array.isArray(payload) ? payload : []) {
      const symbol = String(entry?.symbol ?? '').toUpperCase();
      if (!symbol.endsWith('USDT')) continue;
      const row = tickerRow(symbol, finite(entry?.lastPrice), finite(entry?.openPrice), finite(entry?.quoteVolume));
      if (row) rows.push(row);
    }
  } else {
    const swap = market !== 'spot';
    for (const entry of Array.isArray(payload?.data) ? payload.data : []) {
      const symbol = String(entry?.instId ?? '').toUpperCase();
      // `BTC-USDT-SWAP` is a perpetual, `BTC-USDT` the spot pair; the venue lists USD / USDC pairs next to them.
      if (swap ? !symbol.endsWith('-USDT-SWAP') : !(symbol.endsWith('-USDT'))) continue;
      const row = tickerRow(symbol, finite(entry?.last), finite(entry?.open24h), finite(entry?.volCcy24h));
      if (row) rows.push(row);
    }
  }
  return orderProducts(rows);
}

/** Biggest 24h turnover first, ties by name: the owner scans from the top of the list. */
export function orderProducts(rows) {
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => (b.quoteVolume - a.quoteVolume) || String(a.symbol).localeCompare(String(b.symbol)));
}

/** The rows whose symbol matches what was typed (`sol` -> SOLUSDT / SOL-USDT / SOL-USDT-SWAP), in list order. */
export function filterProducts(rows, query) {
  const wanted = String(query ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!wanted) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(row => String(row?.symbol ?? '').replace(/[^A-Z0-9]/g, '')
    .includes(wanted));
}

/**
 * `POST /review/market/tickers` answer (Deepcoin: Jesse reads the venue because it sends no CORS headers) as the same
 * `[{symbol, last, change, quoteVolume}]` the direct venues produce.
 */
export function proxyTickerRows(payload) {
  const rows = [];
  for (const entry of Array.isArray(payload?.tickers) ? payload.tickers : []) {
    const row = tickerRow(String(entry?.symbol ?? '').toUpperCase(), finite(entry?.last), finite(entry?.open24h),
      finite(entry?.quoteVolume24h));
    if (row) rows.push(row);
  }
  return orderProducts(rows);
}

// --- Watchlist quotes ---------------------------------------------------------------------------------------------

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

// --- Saved choices ------------------------------------------------------------------------------------------------

/**
 * A watchlist row: `{source, market, symbol}`. A bare string is the pre-T-53 format (there was only one source
 * then) and `binance-perp` / `binance-spot` are the pre-T-54 sources: both still restore. `symbol` is normalized per
 * source (a pair for an exchange, US03M…US30Y for the yields).
 */
export function watchItem(value) {
  // Only strings and objects: a number in a hand-edited file is junk, not a pair. `normalizeSymbol` would turn
  // `42` into `42USDT` (a real base name looks like that).
  if (typeof value === 'string') {
    const symbol = normalizeSymbol(value);
    return symbol ? { source: DEFAULT_SOURCE, market: DEFAULT_MARKET, symbol } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const migrated = migrateSource(value.source);
  if (!migrated) return null;
  const source = migrated.source;
  const market = normalizeMarket(source, value.market ?? migrated.market);
  const symbol = symbolOf(source, market, value.symbol);
  return symbol ? { source, market, symbol } : null;
}

/** One row's identity (`binance|swap|BTCUSDT`): the same pair on another market or venue is another row. */
export const watchKey = item => `${item.source}|${item.market ?? ''}|${item.symbol}`;

export const sameWatchItem = (a, b) => !!a && !!b && a.source === b.source && a.symbol === b.symbol
  && (a.market ?? null) === (b.market ?? null);

/** Compare a watchlist row with the chart's selection (`{source, market, symbol}`). */
export const isSelected = (item, source, market, symbol) => item.source === source && item.symbol === symbol
  && (item.market ?? null) === (market ?? null);

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
    const item = { source: YIELD_SOURCE, market: null, symbol };
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

/** The watchlist with the row at `from` moved to index `to` (the owner's own order, dragged by the handle). */
export function moveWatchItem(list, from, to) {
  const current = Array.isArray(list) ? [...list] : [];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= current.length || from === to) return current;
  const [item] = current.splice(from, 1);
  current.splice(Math.max(0, Math.min(current.length, to)), 0, item);
  return current;
}

export function removeFromWatchlist(list, input) {
  const item = watchItem(input);
  return (Array.isArray(list) ? list : []).filter(existing => !sameWatchItem(existing, item));
}

/**
 * The last chart on screen (`{source, market, symbol}`). Before T-53 the value was a bare pair string and there was
 * one source; before T-54 the source named a venue (`binance-perp`). Both still restore.
 */
export function restoreSelection(serialized) {
  let value;
  try { value = JSON.parse(serialized); } catch { value = serialized; }
  const item = watchItem(value);
  if (item) return item;
  return { source: DEFAULT_SOURCE, market: DEFAULT_MARKET, symbol: DEFAULT_SYMBOL };
}

/** A source's (and market's) default instrument, in that source's symbol shape. */
export const defaultSymbolFor = (source, market = null) => {
  const wanted = normalizeMarket(source, market);
  return symbolOf(source, wanted, defaultSymbolOf(source, wanted)) || DEFAULT_SYMBOL;
};

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

/** `watch` / `products` / `notes`: which of the left column's tabs was open. */
export const restoreAsideTab = serialized => {
  const raw = String(serialized ?? '').trim();
  return raw === 'products' || raw === 'notes' ? raw : 'watch';
};
/** The product list's contract / spot sub-tab; a source without markets has none (null). */
export function restoreListMarket(serialized) {
  const raw = String(serialized ?? '').trim();
  return MARKETS.some(market => market.id === raw) ? raw : null;
}

/**
 * A visible window after `added` bars were prepended: bar positions are indices, so every index moves right by the
 * number of new bars — that is what keeps the picture from jumping when an earlier page lands.
 */
export const shiftLogical = (range, added) => (range ? { from: range.from + added, to: range.to + added } : null);
