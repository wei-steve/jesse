// Pure helpers of the factor finder page (finder.mjs): request building, saved form, and turning the
// `/factors/run` answer into the same step series the signal mode of the review page uses (rides.mjs).
// Nothing here knows what a factor does; the page only draws the numbers the factor file returns.
import { timeframeMinutes } from './settings.mjs?v=20261116j';
import { LIMIT_RULES, LIMIT_DEFAULTS, atr14 } from './limit-rules.mjs?v=20261116j';
import { sma } from './data.mjs?v=20261116j';

export const FORM_KEY = 'jesse.finder.form.v1';
// Chart height is a per-browser display choice, shared by the finder and the market page (one key, one list).
// "适应屏幕" (0) sizes the two chart rows to fill one screen: each card adds ~58px of title and footer around its
// chart and the rows are 12px apart, so 2 rows need 2h + ~135px; 170px leaves a small margin.
// v2 key: v1 saved the old 480px default, which hid the second row on laptops.
export const CHART_HEIGHT_KEY = 'jesse.finder.chartHeight.v2';
export const CHART_HEIGHTS = [[0, '适应屏幕'], [240, '矮'], [360, '中'], [480, '高'], [640, '很高']];
export const DEFAULT_CHART_HEIGHT = 0;
export const FIT_CHART_HEIGHT = 'max(200px, calc((100vh - 170px) / 2))';
// The height a saved value stands for; anything that is not one of the offered choices is 适应屏幕.
export const chartHeightOf = raw => {
  const value = Number(raw);
  return raw !== null && raw !== undefined && CHART_HEIGHTS.some(([px]) => px === value) ? value : DEFAULT_CHART_HEIGHT;
};
// 「实时」fires a few seconds after every UTC minute: by then the minute that just closed is in the database, and a
// delay computed from the clock (not a fixed 60s setInterval) never drifts.
export const LIVE_OFFSET_MS = 5000;
export const MINUTE_MS = 60000;
export const RECENT_DAYS = [1, 3, 7, 14, 30, 90, 180, 365];
export const WINDOWS = [[21600, '6 小时'], [43200, '12 小时'], [86400, '24 小时'], [259200, '3 天'], [604800, '7 天']];
const LIMIT_IDS = LIMIT_RULES.map(rule => rule.id);
const pad = n => String(n).padStart(2, '0');

export function defaultForm() {
  return { exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT', rangeMode: 'recent', recentDays: 7,
    start: '', finish: '', factor: '', params: {}, timeframes: {}, overlay: false, live: false, window: 86400,
    limit: { ...LIMIT_DEFAULTS } };
}

const text = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;

// Saved form from localStorage; anything invalid falls back to the default for that field.
export function restoreForm(serialized) {
  const base = defaultForm();
  let value;
  try { value = JSON.parse(serialized); } catch { return base; }
  if (!value || typeof value !== 'object') return base;
  const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const params = {};
  for (const [factor, values] of Object.entries(record(value.params))) {
    params[factor] = Object.fromEntries(Object.entries(record(values)).filter(([, v]) => Number.isFinite(v)));
  }
  const timeframes = {};
  for (const [factor, list] of Object.entries(record(value.timeframes))) {
    if (Array.isArray(list)) timeframes[factor] = list.filter(tf => timeframeMinutes(tf) !== null);
  }
  // "挂单" controls: an unknown rule id or a value that cannot size a stop falls back to the default; x and y
  // may be 0 (no allowance), hold is a whole number of bars, at least 1.
  const limit = record(value.limit);
  const num = (key) => Number.isFinite(limit[key]) ? limit[key] : base.limit[key];
  const above = (key, min) => Math.max(min, num(key));
  return {
    exchange: text(value.exchange, base.exchange), symbol: text(value.symbol, base.symbol),
    rangeMode: value.rangeMode === 'custom' ? 'custom' : 'recent',
    recentDays: RECENT_DAYS.includes(value.recentDays) ? value.recentDays : base.recentDays,
    start: text(value.start, ''), finish: text(value.finish, ''), factor: text(value.factor, ''),
    params, timeframes, overlay: value.overlay === true, live: value.live === true,
    window: WINDOWS.some(([seconds]) => seconds === value.window) ? value.window : base.window,
    limit: {
      // v2: the default moved from the next-bar open to SMA5; a form saved before that (no v) still holds the old
      // default, not a choice the user made, so it moves too.
      rule: limit.v === 2 && LIMIT_IDS.includes(limit.rule) ? limit.rule : base.limit.rule, v: 2,
      x: above('x', 0), y: above('y', 0),
      k: above('k', 0.01), r: above('r', 0.01),
      hold: Math.round(above('hold', 1)),
    },
  };
}

// "2026-10-27T08:30" typed in a datetime-local box means UTC on this page.
export const localToIso = value => /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value ?? '') ? `${value}:00Z` : null;
export const isoToLocal = ms => new Date(ms).toISOString().slice(0, 16);

// Value of a param box -> number within the factor's declared bounds (the server clamps again).
export function clampParam(spec, raw) {
  let value = Number(raw);
  if (raw === '' || raw === null || !Number.isFinite(value)) value = spec.default;
  if (Number.isFinite(spec.min) && value < spec.min) value = spec.min;
  if (Number.isFinite(spec.max) && value > spec.max) value = spec.max;
  return Number.isInteger(spec.default) ? Math.round(value) : value;
}

// Body of POST /factors/run. "recent" = the last N days up to the newest 1m candle (no finish).
export function runBody(form, factor, params, timeframes, nowMs) {
  const body = { factor, exchange: form.exchange, symbol: form.symbol, timeframes, params };
  if (form.rangeMode === 'recent') body.start = new Date(nowMs - form.recentDays * 86400000).toISOString();
  else {
    body.start = localToIso(form.start);
    if (form.finish) body.finish = localToIso(form.finish);
    if (!body.start) throw new Error('请填写开始时间（UTC）。');
    if (form.finish && !body.finish) throw new Error('结束时间格式不对。');
  }
  return body;
}

// POST /candles/import wants a date strictly before today: yesterday (UTC).
// The day the import starts from: yesterday, or the day of the newest candle already in the database when that is
// older — otherwise a database that is days behind would be left with a hole between its newest candle and yesterday
// (2026-11-15: the data stopped on 10-27 and 「更新到最新」/实时 only fetched the last day). `lastSeconds` optional.
// A random UUID v4 for an import job. crypto.randomUUID() exists only on secure pages (https or localhost): opened
// from another computer as http://<lan-ip>:9100 it is undefined, every live round threw before importing and the
// charts stopped at the last stored candle (2026-11-16). getRandomValues works on any page.
export function importId(random = crypto) {
  if (typeof random.randomUUID === 'function') return random.randomUUID();
  const b = random.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function importStartDate(nowMs, lastSeconds = null) {
  const yesterday = nowMs - 86400000;
  const from = Number.isFinite(lastSeconds) ? Math.min(yesterday, lastSeconds * 1000) : yesterday;
  const d = new Date(from);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Milliseconds until the next 「实时」trigger, strictly in (0, one minute]. Exactly on a trigger the next minute is
// meant, so two rounds never fire at the same instant.
export function nextTickDelay(nowMs, offsetMs = LIVE_OFFSET_MS) {
  if (!Number.isFinite(nowMs)) return offsetMs;
  const since = ((nowMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  return since < offsetMs ? offsetMs - since : MINUTE_MS - since + offsetMs;
}

// Keys of the signals in `newRides` that `oldRides` did not have. Those rows got a new signal in this round, so the
// list blinks them; nothing else about the answer is treated as an event.
export function newKeys(oldRides, newRides) {
  const before = new Set((oldRides ?? []).map(ride => ride?.key));
  return (newRides ?? []).filter(ride => ride?.key && !before.has(ride.key)).map(ride => ride.key);
}

// A chart whose right edge sits at (or past) its newest bar is glued to the newest candle: after an update it follows
// the new newest bar. One the owner dragged back into history stays where it is.
export function atRightEdge(range, lastTime, tolerance = 0) {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return false;
  if (!Number.isFinite(lastTime)) return false;
  return range.to >= lastTime - tolerance;
}

// Moves a visible range by `seconds`, keeping its width (the zoom the owner chose).
export const shiftRange = (range, seconds) => ({ from: range.from + seconds, to: range.to + seconds });

// The ride series (extra_charts format of rides.mjs) of a /factors/run answer. A bar's value is known when the
// bar closes, i.e. at its last 1m candle (open time = bar time + length - 60). Only changes are written.
export function rideExtra(timeframes) {
  const ride = {}, touches = {};
  for (const [tf, item] of Object.entries(timeframes ?? {})) {
    const minutes = timeframeMinutes(tf);
    if (minutes === null) continue;
    const known = (candle) => candle.time + minutes * 60 - 60;
    const points = [], touchPoints = [];
    let value, touch;
    item.candles.forEach((candle, i) => {
      if (item.value[i] !== value) { value = item.value[i]; points.push({ time: known(candle), value }); }
      const t = item.touches?.[i] ?? 0;
      if (t !== touch) { touch = t; touchPoints.push({ time: known(candle), value: t }); }
    });
    if (points.length) { ride[tf] = { data: points }; touches[tf] = { data: touchPoints }; }
  }
  return { ride, ride_touches: touches };
}

// Time (1m open seconds) of the "now" state: the newest 1m candle the database has.
export const latestStatusTime = result => result.last_candle_time;

// Import polling: 'running' keeps waiting; anything else ends.
export const importDone = status => status?.status !== 'running';

// Six decimals: price levels like 64010.2 are exact enough for reading, and a float sum never writes 64010.199999.
const round6 = value => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null);

// The numbers a candle note carries (the page double-clicks a bar, the reader of the label file sees these): OHLC,
// MA5, MA10, ATR(14) and BOLL(20, 2) as of that bar only, so the note still explains itself after the chart moved on.
// Conventions match the review page: Wilder ATR (the one the limit orders use) and the population standard deviation
// for BOLL. A field whose window is not complete is null, never a made-up number, and a time that is not one of the
// candles gives null (nothing to note).
export function barSnapshot(candles, time, interval = 1) {
  const bars = Array.isArray(candles) ? candles : [];
  const index = bars.findIndex(candle => candle.time === time);
  if (index < 0) return null;
  const candle = bars[index];
  const smaAt = period => {
    // Over the full series (gaps reset the window, as in the chart), then the last value at or before this bar.
    const point = sma(bars, period, interval).filter(p => p.time <= time).at(-1);
    return point?.time === time ? round6(point.value) : null;
  };
  const window = bars.slice(Math.max(0, index - 19), index + 1).map(bar => bar.close);
  const mid = window.length === 20 ? window.reduce((total, close) => total + close, 0) / 20 : null;
  const sd = mid === null ? null : Math.sqrt(window.reduce((total, close) => total + (close - mid) ** 2, 0) / 20);
  return { open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    ma5: smaAt(5), ma10: smaAt(10), atr: round6(atr14(bars)[index]),
    bollUpper: sd === null ? null : round6(mid + 2 * sd), bollMid: mid === null ? null : round6(mid),
    bollLower: sd === null ? null : round6(mid - 2 * sd) };
}
