import { calculateIndicator, formingTail, tailBars } from './indicators.mjs?v=20261116g';
// The 看行情 page's sources (market.mjs): which venue the candles come from, the US treasury yield instruments and
// the interval mapping of the Jesse proxy that serves them. No DOM, no fetch: tests/review-market-sources.test.mjs
// runs every function here with node.
//
// Binance perpetual futures and Binance spot are read by the browser itself (both are CORS-open); Yahoo and FRED are
// not, so the yields come from `POST /review/market/candles` (jesse/services/market_sources.py).

export const PERP_SOURCE = 'binance-perp';
export const SPOT_SOURCE = 'binance-spot';
export const YIELD_SOURCE = 'us-yields';
export const DEFAULT_SOURCE = PERP_SOURCE;

// The dropdown at the top of the page, in the order it is shown.
export const MARKET_SOURCES = [
  { id: PERP_SOURCE, label: '币安永续', exchange: 'Binance Perpetual Futures', defaultSymbol: 'BTCUSDT' },
  { id: SPOT_SOURCE, label: '币安现货', exchange: 'Binance Spot', defaultSymbol: 'BTCUSDT' },
  { id: YIELD_SOURCE, label: '美债收益率', exchange: null, defaultSymbol: 'US10Y' },
];

const sourceOf = id => MARKET_SOURCES.find(source => source.id === id) ?? null;

/** A saved / typed source id, or the default when it names nothing this page can draw. */
export function restoreSource(serialized) {
  const raw = String(serialized ?? '').trim().replace(/^"|"$/g, '');
  return sourceOf(raw) ? raw : DEFAULT_SOURCE;
}

export const sourceLabel = id => sourceOf(id)?.label ?? id;
export const defaultSymbolOf = id => sourceOf(id)?.defaultSymbol ?? 'BTCUSDT';

/** The live-price module's exchange name of a source: '' for a source without websockets (the yields). */
export const exchangeOf = id => sourceOf(id)?.exchange ?? '';

export const isYieldSource = id => id === YIELD_SOURCE;

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
  return { closed, provider: typeof payload?.provider === 'string' ? payload.provider : '',
    note: typeof payload?.note === 'string' ? payload.note : '', delayed: payload?.delayed === true,
    dailyOnly: payload?.daily_only === true };
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
