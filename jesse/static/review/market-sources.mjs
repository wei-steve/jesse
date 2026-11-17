import { calculateIndicator, formingTail, tailBars } from './indicators.mjs?v=20261117b';
// The 看行情 page's sources (market.mjs): an exchange-level list (Binance / OKX / Deepcoin) plus the US treasury
// yields, each with the contract / spot sub-markets it has, the instruments it defaults to, the exchange-side bar
// spelling of every timeframe, the CNBC chart range of a yield panel, and the interval mapping of the Jesse proxy that
// serves the data the browser cannot read. No DOM, no fetch: tests/review-market-sources.test.mjs runs every function
// here with node.
//
// Binance, OKX and CNBC are CORS-open and read by the browser itself; Deepcoin is not, so its candles and tickers come
// from Jesse (`POST /review/market/candles`, `POST /review/market/tickers`, see jesse/services/market_sources.py). The
// backend's us-yields branch (Yahoo / FRED) is kept as a spare: the page reads CNBC since T-55.

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

// TradingView-style codes, the ones the owner named, and the code CNBC spells the same maturity with (T-55). The value
// of every series IS the yield in percent (4.95 means 4.95%), which is why a change is written +0.03 and never as a
// percentage of a percentage. All six are read from CNBC's Tradeweb feed: its `1D` chart is the current session at one
// minute resolution, so every maturity has an intraday series (before T-55 the 2 and the 20 year only had FRED's
// daily one).
export const YIELD_INSTRUMENTS = [
  { symbol: 'US03M', cnbc: 'US3M', name: '13周' },
  { symbol: 'US02Y', cnbc: 'US2Y', name: '2年' },
  { symbol: 'US05Y', cnbc: 'US5Y', name: '5年' },
  { symbol: 'US10Y', cnbc: 'US10Y', name: '10年' },
  { symbol: 'US20Y', cnbc: 'US20Y', name: '20年' },
  { symbol: 'US30Y', cnbc: 'US30Y', name: '30年' },
];
export const YIELD_SYMBOLS = YIELD_INSTRUMENTS.map(instrument => instrument.symbol);
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

/** A yield code as CNBC spells it (`US02Y` -> `US2Y`), or '' when it is not one of the six. */
export function cnbcSymbolOf(input) {
  const code = normalizeYieldSymbol(input);
  return YIELD_INSTRUMENTS.find(entry => entry.symbol === code)?.cnbc ?? '';
}

/**
 * What CNBC is asked for to draw a panel: the chart range, the width in minutes of one of that range's bars, and the
 * bucket the panel draws (aggregateCandles counts minutes). 1m / 3m come from `1D`'s one-minute series (about a day of
 * the current session), the rest of the intraday panels from `5D`'s five-minute series (about 10 days), 1D from `6M`'s
 * daily series (about three years).
 */
const YIELD_SERIES = {
  '1m': { range: '1D', base: 1, aggregate: 1 },
  '3m': { range: '1D', base: 1, aggregate: 3 },
  '5m': { range: '5D', base: 5, aggregate: 1 },
  '15m': { range: '5D', base: 5, aggregate: 15 },
  '30m': { range: '5D', base: 5, aggregate: 30 },
  '1h': { range: '5D', base: 5, aggregate: 60 },
  '4h': { range: '5D', base: 5, aggregate: 240 },
  '1D': { range: '6M', base: 1440, aggregate: 1 },
};

/** The chart range, source bar width and panel bucket of `timeframe` (an unknown timeframe draws the 1m series). */
export function yieldRequest(timeframe) {
  const series = YIELD_SERIES[timeframe] ?? YIELD_SERIES['1m'];
  return { ...series, timeframe: String(timeframe ?? '') };
}

/** The range the 15-second poll reads: the current session's one-minute bars, whatever the panels show. */
export const YIELD_POLL_RANGE = '1D';

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

/** A value from an API answer: null / '' / a boolean are not the number 0, so they come back NaN and get dropped. */
const numeric = value => (value === null || value === undefined || value === '' || typeof value === 'boolean')
  ? NaN : Number(value);

/** Bars by open time, oldest first, later lists winning on a shared time. market-data.mjs has mergeCandles, but that
 * module imports this one: this file stays importable on its own. */
function byTime(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const bar of Array.isArray(list) ? list : []) {
      if (Number.isFinite(bar?.time)) map.set(bar.time, bar);
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/**
 * CNBC's chart answer as the candles the charts draw: `{barData:{priceBars:[{open,high,low,close,tradeTimeinMills}]}}`,
 * oldest first, every number a string. The strings become numbers, the millisecond stamps seconds, and a row that is not
 * a sane OHLC bar is dropped (an unknown symbol answers `{status:'ERROR'}` with no bars at all).
 */
export function parseCnbcBars(payload) {
  const rows = Array.isArray(payload?.barData?.priceBars) ? payload.barData.priceBars : [];
  const bars = [];
  for (const row of rows) {
    const time = Math.trunc(numeric(row?.tradeTimeinMills) / 1000);
    const [open, high, low, close] = ['open', 'high', 'low', 'close'].map(key => numeric(row?.[key]));
    if (![time, open, high, low, close].every(Number.isFinite) || time <= 0) continue;
    // The yield series carry no volume; a bar is not dropped over it.
    const volume = numeric(row?.volume);
    bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 });
  }
  return byTime([bars]);
}

/**
 * CNBC's quote answer (`FormattedQuoteResult.FormattedQuote[]`, one object when a single symbol was asked) as one row
 * per yield the page knows: `{symbol, price, change}`. The codes come back CNBC-spelled (`US2Y`), so they are mapped
 * back to the page's own (`US02Y`); `change` is already in percentage points (`-0.026` = -2.6 basis points) and a
 * missing one (a closed instrument) is null instead of 0.
 */
export function parseCnbcQuote(payload) {
  const raw = payload?.FormattedQuoteResult?.FormattedQuote;
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  const quotes = [];
  for (const row of rows) {
    const code = String(row?.symbol ?? '').trim().toUpperCase();
    const symbol = YIELD_INSTRUMENTS.find(entry => entry.cnbc === code)?.symbol;
    const price = numeric(String(row?.last ?? '').replace('%', ''));
    if (!symbol || !Number.isFinite(price) || price <= 0) continue;
    const change = numeric(String(row?.change ?? '').replace('%', ''));
    quotes.push({ symbol, price, change: Number.isFinite(change) ? change : null });
  }
  return quotes;
}

/**
 * The 15-second poll's one-minute bars merged into one panel's source series; `base` is the width in minutes of that
 * series' own bars (1 for the 1m / 3m panels, 5 for the ones drawn from `5D`). The polled minutes replace everything
 * from the first bucket they cover, so the newest bars become minute-accurate; the buckets follow the series' own grid
 * — CNBC's 5m bars start at :01, not :00, and a UTC-aligned bucket would draw the same minutes twice.
 */
export function mergeYieldBars(series, base, polled) {
  const bars = (Array.isArray(series) ? series : []).filter(bar => Number.isFinite(bar?.time));
  const minutes = (Array.isArray(polled) ? polled : [])
    .filter(bar => Number.isFinite(bar?.time) && Number.isFinite(bar?.close))
    .sort((a, b) => a.time - b.time);
  if (!minutes.length) return bars;
  const baseMinutes = Number.isFinite(base) && base > 0 ? Math.trunc(base) : 1;
  const width = baseMinutes * 60;
  const offset = bars.length ? ((bars[0].time % width) + width) % width : 0;
  const grid = time => Math.floor((time - offset) / width) * width + offset;
  // aggregateCandles buckets on a UTC-aligned grid, so shift by the series' own offset and shift back.
  const buckets = aggregateCandles(minutes.map(bar => ({ ...bar, time: bar.time - offset })), baseMinutes)
    .map(bar => ({ ...bar, time: bar.time + offset }));
  return byTime([bars.filter(bar => bar.time < grid(minutes[0].time)), buckets]);
}

/**
 * The daily panel during the session: CNBC publishes its daily series a session late, so the newest polled minute
 * extends the last bar (its close, and its high / low when the minute goes past them), and a minute of a later session
 * than that bar starts the session's own bar. The 05:00 UTC stamp CNBC opens its daily bars with is read off the series
 * instead of being hardcoded.
 */
export function mergeYieldDailyClose(daily, minute) {
  const bars = (Array.isArray(daily) ? daily : []).filter(bar => Number.isFinite(bar?.time));
  if (!Number.isFinite(minute?.time) || !Number.isFinite(minute?.close)) return bars;
  const width = 1440 * 60;
  const close = minute.close;
  const open = Number.isFinite(minute.open) ? minute.open : close;
  const last = bars.at(-1);
  if (!last) {
    return [{ time: Math.floor(minute.time / width) * width, open, high: close, low: close, close, volume: 0 }];
  }
  const offset = ((last.time % width) + width) % width;
  const sessionOf = time => Math.floor((time - offset) / width) * width + offset;
  if (sessionOf(minute.time) <= last.time) {
    return [...bars.slice(0, -1), { ...last, high: Math.max(last.high, close), low: Math.min(last.low, close),
      close }];
  }
  return [...bars, { time: sessionOf(minute.time), open, high: close, low: close, close, volume: 0 }];
}

/**
 * `POST /review/market/candles` answer -> what the charts draw: sane candles (UTC seconds, o/h/l/c finite) plus the
 * provider and its note, which the page writes under every chart (the proxied data is delayed, and the page has to say
 * so). Used by Deepcoin; the treasury yields read CNBC directly (parseCnbcBars) since T-55.
 */
export function parseMarketCandles(payload) {
  const rows = Array.isArray(payload?.candles) ? payload.candles : [];
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

/** A change in percentage points: `+0.03` / `-0.12` / '' — never `+3.00%` (a yield is a percentage already). */
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
