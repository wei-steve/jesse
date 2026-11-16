import { calculateIndicator, formingTail, tailBars } from './indicators.mjs?v=20261116h';
// The 看行情 page's sources (market.mjs): an exchange-level list (Binance / OKX / Deepcoin) plus the US treasury
// yields, each with the contract / spot sub-markets it has, the instruments it defaults to, the exchange-side bar
// spelling of every timeframe, and the interval mapping of the Jesse proxy that serves the data the browser cannot
// read. No DOM, no fetch: tests/review-market-sources.test.mjs runs every function here with node.
//
// Binance and OKX are CORS-open and read by the browser itself; Deepcoin and Yahoo / FRED are not, so they come from
// Jesse (`POST /review/market/candles`, `POST /review/market/tickers`, see jesse/services/market_sources.py).

export const BINANCE_SOURCE = 'binance';
export const OKX_SOURCE = 'okx';
export const DEEPCOIN_SOURCE = 'deepcoin';
export const YIELD_SOURCE = 'us-yields';
export const DEFAULT_SOURCE = BINANCE_SOURCE;
export const DEFAULT_MARKET = 'swap';

// 「合约 | 现货」 is a sub-tab of the product list, not a source of its own (T-54).
export const MARKETS = [{ id: 'swap', label: '合约' }, { id: 'spot', label: '现货' }];
export const MARKET_IDS = MARKETS.map(market => market.id);
/** 合约 / 现货: the label the product list's sub-tab and the watchlist tag write. */
export const marketLabel = id => MARKETS.find(entry => entry.id === id)?.label ?? '';

// The dropdown at the top of the page, in the order it is shown. `exchanges` names the venue in `live-price.mjs`'s
// stream table (Binance only: OKX and Deepcoin have their own socket envelopes, see market.mjs).
export const MARKET_SOURCES = [
  { id: BINANCE_SOURCE, label: 'Binance', markets: MARKET_IDS,
    defaultSymbols: { swap: 'BTCUSDT', spot: 'BTCUSDT' },
    exchanges: { swap: 'Binance Perpetual Futures', spot: 'Binance Spot' } },
  { id: OKX_SOURCE, label: 'OKX', markets: MARKET_IDS,
    defaultSymbols: { swap: 'BTC-USDT-SWAP', spot: 'BTC-USDT' }, exchanges: {} },
  { id: DEEPCOIN_SOURCE, label: 'Deepcoin', markets: MARKET_IDS,
    defaultSymbols: { swap: 'BTC-USDT-SWAP', spot: 'BTC-USDT' }, exchanges: {} },
  { id: YIELD_SOURCE, label: '美债收益率', markets: [],
    defaultSymbols: {}, exchanges: {} },
];

const sourceOf = id => MARKET_SOURCES.find(source => source.id === id) ?? null;

// Before T-54 the dropdown held the venue instead of the exchange: 币安永续 / 币安现货 were two sources. A saved
// value (and every saved watchlist row) in that shape still opens, as the Binance market it named.
const LEGACY_SOURCES = {
  'binance-perp': { source: BINANCE_SOURCE, market: 'swap' },
  'binance-spot': { source: BINANCE_SOURCE, market: 'spot' },
  [YIELD_SOURCE]: { source: YIELD_SOURCE, market: null },
};

/** A saved / typed source id (legacy venue ids included) as `{source, market}`, or null when it names nothing. */
export function migrateSource(serialized) {
  const raw = String(serialized ?? '').trim().replace(/^"|"$/g, '');
  const legacy = LEGACY_SOURCES[raw];
  if (legacy) return { ...legacy };
  return sourceOf(raw) ? { source: raw, market: marketsOf(raw)[0] ?? null } : null;
}

/** A saved / typed source id, or the default when it names nothing this page can draw. */
export function restoreSource(serialized) {
  return migrateSource(serialized)?.source ?? DEFAULT_SOURCE;
}

export const sourceLabel = id => sourceOf(id)?.label ?? id;
export const marketsOf = id => sourceOf(id)?.markets ?? [];
export const hasMarkets = id => marketsOf(id).length > 0;
export const isYieldSource = id => id === YIELD_SOURCE;

/** `market` when that source has it (the yields have none: null), otherwise the source's first market. */
export const normalizeMarket = (id, market) => {
  const markets = marketsOf(id);
  return markets.includes(market) ? market : (markets[0] ?? null);
};

/** The instrument the page switches to when the source (or the sub-market) changes. */
export function defaultSymbolOf(id, market = null) {
  if (isYieldSource(id)) return DEFAULT_YIELD_SYMBOL;
  const symbols = sourceOf(id)?.defaultSymbols ?? {};
  return symbols[market] ?? symbols[marketsOf(id)[0]] ?? DEFAULT_SYMBOL_FALLBACK;
}
const DEFAULT_SYMBOL_FALLBACK = 'BTCUSDT';

/** The live-price module's exchange name of a source / market: '' when it has no Binance-style stream. */
export const exchangeOf = (id, market = null) => sourceOf(id)?.exchanges?.[market] ?? '';

// --- Symbols ------------------------------------------------------------------------------------------------------
// Binance spells a pair BTCUSDT, OKX and Deepcoin BTC-USDT (spot) / BTC-USDT-SWAP (perpetual). One normalizer per
// family keeps a saved or typed value usable and keeps the REST whitelist on the backend happy.

/** `btc`, `BTCUSDT`, `btc-usdt`, `BTC/USDT` -> `BTCUSDT`; '' for anything that cannot be a USDT pair. */
export function normalizeSymbol(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  // The quote currency is implied: a base alone is completed, a full pair is kept as typed.
  const pair = raw.endsWith('USDT') ? raw : `${raw}USDT`;
  // 2–16 characters of base ("1000PEPEUSDT" is a real contract) plus USDT.
  return /^[A-Z0-9]{2,16}USDT$/.test(pair) ? pair : '';
}

/** `btc` / `BTC-USDT` / `BTC-USDT-SWAP` -> the instId of that market: `BTC-USDT-SWAP` or `BTC-USDT`. */
export function normalizeInstId(market, input) {
  const raw = String(input ?? '').toUpperCase().replace(/[\s/]/g, '-').replace(/^-+|-+$/g, '');
  if (!raw) return '';
  const base = raw
    .replace(/-SWAP$/, '')
    .replace(/-USDT$/, '')
    .replace(/USDT$/, '')
    .replace(/-+/g, '');
  // Same base rule as Binance's, and `USDT` alone is the quote of nothing.
  if (!/^[A-Z0-9]{2,16}$/.test(base) || base === 'USDT') return '';
  return market === 'spot' ? `${base}-USDT` : `${base}-USDT-SWAP`;
}

/** A typed / saved instrument of one source (and market) in the shape that source's API wants, or ''. */
export function symbolOf(source, market, input) {
  if (isYieldSource(source)) return normalizeYieldSymbol(input);
  if (source === BINANCE_SOURCE) return normalizeSymbol(input);
  if (source === OKX_SOURCE || source === DEEPCOIN_SOURCE) return normalizeInstId(market, input);
  return '';
}

/** The name a list row shows: `BTC` for every exchange symbol, the code itself for a yield (US10Y). */
export function instrumentName(source, symbol) {
  const text = String(symbol ?? '');
  if (source === YIELD_SOURCE) return text;
  if (source === BINANCE_SOURCE) return text.replace(/USDT$/, '');
  return text.replace(/-USDT(-SWAP)?$/, '') || text;
}

// --- Bars ---------------------------------------------------------------------------------------------------------
// The bar spelling of each panel timeframe per exchange. Binance's is in market-data.mjs (it already had it), and its
// daily interval is the only one that differs (1d). OKX and Deepcoin both say 1H / 4H in upper case, and OKX's daily
// bar must be `1Dutc` (plain `1D` opens at the exchange's UTC+8 midnight).
export const BARS = {
  [OKX_SOURCE]: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1D': '1Dutc' },
  [DEEPCOIN_SOURCE]: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1D': '1D' },
};

/**
 * What to ask `source` for to draw `timeframe`, and how much of it has to be bucketed here. Deepcoin has no 3m bar
 * (checked 2026-11-16: `1m 5m 15m 30m 1H 4H 12H 1D 1W 1M 1Y`), so that one panel asks for 1m and buckets three, the
 * way the treasury 3m panel already works.
 */
export function candleRequest(source, timeframe) {
  const bars = BARS[source];
  if (!bars) return { interval: String(timeframe ?? ''), aggregate: 1 };
  if (bars[timeframe]) return { interval: bars[timeframe], aggregate: 1 };
  return timeframe === '3m' ? { interval: bars['1m'], aggregate: 3 } : { interval: bars['1m'], aggregate: 1 };
}

// --- Yields -------------------------------------------------------------------------------------------------------

// TradingView-style codes, the ones the owner named. The value of every series IS the yield in percent (4.95 means
// 4.95%), which is why a change is written +0.03 and never as a percentage of a percentage.
export const YIELD_INSTRUMENTS = [
  { symbol: 'US03M', name: '13周' },
  { symbol: 'US02Y', name: '2年' },
  { symbol: 'US05Y', name: '5年' },
  { symbol: 'US10Y', name: '10年' },
  { symbol: 'US20Y', name: '20年' },
  { symbol: 'US30Y', name: '30年' },
];
export const YIELD_SYMBOLS = YIELD_INSTRUMENTS.map(instrument => instrument.symbol);
// There is no Cboe yield index for the 2 and the 20 year, so those two only exist as FRED's daily series.
export const DAILY_ONLY_YIELDS = ['US02Y', 'US20Y'];
// The four the owner had on screen: seeded into the watchlist once (see withDefaultYields), then theirs to manage.
export const DEFAULT_YIELD_SYMBOLS = ['US02Y', 'US10Y', 'US20Y', 'US30Y'];
export const DEFAULT_YIELD_SYMBOL = 'US10Y';

/** `us10y` / `10y` / `US10Y` -> `US10Y`; anything else -> '' (the page asks for a whitelisted code only). */
export function normalizeYieldSymbol(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  const code = raw.startsWith('US') ? raw : `US${raw}`;
  return YIELD_SYMBOLS.includes(code) ? code : '';
}

export const isDailyOnlyYield = symbol => DAILY_ONLY_YIELDS.includes(normalizeYieldSymbol(symbol));

/**
 * What the proxy is asked for to draw `timeframe` of `symbol`, and how the answer is turned into that timeframe.
 * 3m and 4h exist only as aggregations (Yahoo has no bond data for them); the FRED-only symbols have nothing but
 * their daily series, so every panel of them asks for 1D and the small timeframes show a hint instead of a chart.
 */
export function yieldRequest(symbol, timeframe) {
  const dailyOnly = isDailyOnlyYield(symbol);
  const interval = dailyOnly ? '1D' : { '3m': '1m', '4h': '1h' }[timeframe] ?? String(timeframe ?? '');
  const aggregates = { '3m': 3, '4h': 4 }[timeframe] ?? 1;
  return { interval, aggregate: dailyOnly ? 1 : aggregates, dailyOnly, timeframe };
}

/** The range asked for by the 60-second poll: only the newest bars, the loaded history stays where it is. Keyed by
 * the interval actually requested (yieldRequest), not the panel's timeframe: a 4h panel asks Yahoo for 1h, whose
 * shortest range is 1mo, and a FRED symbol asks for 1D on every panel (2026-11-16, '5d' for 4h was refused). */
export const POLL_RANGES = { '1m': '1d', '5m': '5d', '15m': '5d', '30m': '5d', '1h': '1mo', '1D': '1mo' };
export const pollRangeOf = (timeframe, symbol = '') => POLL_RANGES[yieldRequest(symbol, timeframe).interval] ?? '1mo';

/**
 * Candles of `minutes`-minute buckets, aligned to UTC, from a 1m or 1h series. A bond session is not 24 hours, so a
 * bucket keeps however many bars it has (one 15m bar of a short session) instead of demanding a full bucket the way
 * the backtest aggregation does: the exchange's own 15m bars would also be short there.
 */
export function aggregateCandles(source, minutes) {
  if (!Number.isInteger(minutes) || minutes < 1) return [];
  if (minutes === 1) return [...(Array.isArray(source) ? source : [])];
  const width = minutes * 60;
  const buckets = new Map();
  for (const candle of Array.isArray(source) ? source : []) {
    if (!Number.isFinite(candle?.time) || !Number.isFinite(candle.close)) continue;
    const start = Math.floor(candle.time / width) * width;
    const bucket = buckets.get(start);
    if (!bucket) {
      buckets.set(start, { time: start, open: candle.open, high: candle.high, low: candle.low,
        close: candle.close, volume: Number.isFinite(candle.volume) ? candle.volume : 0 });
      continue;
    }
    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    bucket.close = candle.close;
    bucket.volume += Number.isFinite(candle.volume) ? candle.volume : 0;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/**
 * `POST /review/market/candles` answer -> what the charts draw: sane candles (UTC seconds, o/h/l/c finite) plus the
 * provider and its note, which the page writes under every chart (the data is delayed, and one of the providers
 * only has daily bars: the picture has to say so).
 */
export function parseMarketCandles(payload) {
  const rows = Array.isArray(payload?.candles) ? payload.candles : [];
  // A JSON null / '' is not zero: `Number(null)` would draw a bar at 0 and `Number('x')` a NaN, so both are dropped
  // here instead of at the chart.
  const numeric = value => (value === null || value === undefined || value === '' || typeof value === 'boolean')
    ? NaN : Number(value);
  const closed = [];
  for (const row of rows) {
    const [time, open, high, low, close] = ['time', 'open', 'high', 'low', 'close'].map(key => numeric(row?.[key]));
    if (![time, open, high, low, close].every(Number.isFinite) || time <= 0) continue;
    const volume = numeric(row?.volume);
    closed.push({ time: Math.trunc(time), open, high, low, close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 });
  }
  const forming = cryptoRow(payload?.forming);
  return { closed, forming, provider: typeof payload?.provider === 'string' ? payload.provider : '',
    note: typeof payload?.note === 'string' ? payload.note : '', delayed: payload?.delayed === true,
    dailyOnly: payload?.daily_only === true };
}

/** One deepcoin / proxy forming bar (`{time, open, high, low, close, volume}`), or null. */
function cryptoRow(row) {
  if (!row || typeof row !== 'object') return null;
  const [time, open, high, low, close] = ['time', 'open', 'high', 'low', 'close'].map(key => Number(row[key]));
  if (![time, open, high, low, close].every(Number.isFinite) || time <= 0) return null;
  const volume = Number(row.volume);
  return { time: Math.trunc(time), open, high, low, close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 };
}

/**
 * The watchlist row of a yield series: the newest value and its change against the previous bar, in percentage
 * points (a yield is a percentage already, so +0.03 is 3 basis points and not 0.03%).
 */
export function yieldQuote(candles) {
  const list = (Array.isArray(candles) ? candles : []).filter(candle => Number.isFinite(candle?.close))
    .sort((a, b) => a.time - b.time);
  if (!list.length) return null;
  const last = list.at(-1);
  const previous = list.length > 1 ? list.at(-2) : null;
  return { price: last.close, change: previous ? last.close - previous.close : null, time: last.time };
}

/** A change in percentage points: `+0.03` / `-0.12` / '' — never `+3.00%` (see yieldQuote). */
export const signedPoints = change => Number.isFinite(change)
  ? `${change >= 0 ? '+' : '-'}${Math.abs(change).toFixed(2)}` : '';

/**
 * Indicators of a market that is not open around the clock (the treasury yields close every night and weekend).
 * calculateIndicator starts afresh at every gap — right for crypto, where a gap is missing data — which left the MA /
 * BOLL lines of 1h and 4h yields as short broken pieces (2026-11-16). Here the bars are numbered as if consecutive,
 * the way trading apps treat a session market, and each point gets its real bar's time back.
 */
export function sessionIndicator(candles, config, interval) {
  const step = interval * 60;
  const bars = Array.isArray(candles) ? candles : [];
  const result = calculateIndicator(bars.map((c, i) => ({ ...c, time: i * step })), config, interval);
  return { ...result, series: result.series.map(line => ({ ...line,
    data: line.data.map(point => ({ ...point, time: bars[point.time / step].time })) })) };
}

/** formingTail for a session market: the bar after the last closed one, wherever the clock gap between them. */
export function sessionTail(candles, forming, config, interval) {
  const step = interval * 60;
  const bars = Array.isArray(candles) ? candles : [];
  const window = bars.slice(Math.max(0, bars.length - tailBars(config)));
  const renumbered = window.map((c, i) => ({ ...c, time: i * step }));
  return formingTail(renumbered, { ...forming, time: window.length * step }, config, interval)
    .map(({ line, point }) => ({ line, point: point ? { ...point, time: forming.time } : null }));
}
