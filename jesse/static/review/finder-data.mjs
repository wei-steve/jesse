// Pure helpers of the factor finder page (finder.mjs): request building, saved form, and turning the
// `/factors/run` answer into the same step series the signal mode of the review page uses (rides.mjs).
// Nothing here knows what a factor does; the page only draws the numbers the factor file returns.
import { timeframeMinutes } from './settings.mjs?v=20261028e';

export const FORM_KEY = 'jesse.finder.form.v1';
export const RECENT_DAYS = [1, 3, 7, 14, 30, 90, 180, 365];
export const WINDOWS = [[21600, '6 小时'], [43200, '12 小时'], [86400, '24 小时'], [259200, '3 天'], [604800, '7 天']];
const pad = n => String(n).padStart(2, '0');

export function defaultForm() {
  return { exchange: 'Binance Perpetual Futures', symbol: 'BTC-USDT', rangeMode: 'recent', recentDays: 7,
    start: '', finish: '', factor: '', params: {}, timeframes: {}, overlay: false, window: 86400 };
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
  return {
    exchange: text(value.exchange, base.exchange), symbol: text(value.symbol, base.symbol),
    rangeMode: value.rangeMode === 'custom' ? 'custom' : 'recent',
    recentDays: RECENT_DAYS.includes(value.recentDays) ? value.recentDays : base.recentDays,
    start: text(value.start, ''), finish: text(value.finish, ''), factor: text(value.factor, ''),
    params, timeframes, overlay: value.overlay === true,
    window: WINDOWS.some(([seconds]) => seconds === value.window) ? value.window : base.window,
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
export function importStartDate(nowMs) {
  const d = new Date(nowMs - 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

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
