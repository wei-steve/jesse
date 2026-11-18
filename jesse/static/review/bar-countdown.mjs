// Current-candle close countdown (T-64): draws a small pill on the right price axis directly below the 「实时」
// price label on each market chart, showing how long remains until the UTC-aligned bar closes, updated every second.
//
// Pure functions (barRemaining, formatCountdown) plus one Lightweight Charts series primitive (CountdownPrimitive)
// tested in tests/review-bar-countdown.test.mjs.

// The 「实时」 price label is centered on the price coordinate and ~18px tall, so offsetting by 18 CSS pixels places
// the countdown pill flush underneath it without overlapping.
export const LABEL_OFFSET = 18;

const EMPTY_VIEWS = [];

/**
 * Whole seconds remaining until the current candle of `intervalMinutes` (shifted by `offsetSeconds`) closes at
 * `nowSeconds`. Returns a value in `1..intervalMinutes*60` (on an exact boundary, returns the full period), or null
 * for invalid inputs.
 */
export function barRemaining(intervalMinutes, nowSeconds, offsetSeconds = 0) {
  if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
  if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds) || nowSeconds < 0) return null;
  const offset = typeof offsetSeconds === 'number' && Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  const period = intervalMinutes * 60;
  const shifted = Math.floor(nowSeconds) + offset;
  return period - (((shifted % period) + period) % period);
}

/**
 * Formats a non-negative second count as `mm:ss` below 1 hour and `hh:mm:ss` from 1 hour up, zero-padded.
 * Non-finite or negative inputs return `''`.
 */
export function formatCountdown(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Lightweight Charts series primitive that renders the bar-close countdown on the price axis just below the live price
 * label. Kept as a separate primitive so `tick()` can request a redraw every second without touching series data or
 * price lines.
 */
export class CountdownPrimitive {
  constructor({ intervalMinutes, offsetSeconds = 0, color = '#f19aa4', now = () => Date.now() / 1000 } = {}) {
    this.intervalMinutes = intervalMinutes;
    this.offsetSeconds = typeof offsetSeconds === 'number' && Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
    this.color = color;
    this.now = typeof now === 'function' ? now : () => Date.now() / 1000;
    this.chart = null;
    this.series = null;
    this.requestRedraw = null;
    this.price = null;
    // Keep the exact same array instance across calls: Lightweight Charts caches axis view wrappers by array identity.
    const view = {
      coordinate: () => {
        const y = this.coord();
        return y === null ? null : y + LABEL_OFFSET;
      },
      text: () => formatCountdown(barRemaining(this.intervalMinutes, this.now(), this.offsetSeconds)),
      textColor: () => '#ffffff',
      backColor: () => this.color,
      visible: () => this.price !== null && this.series !== null && this.coord() !== null && view.text() !== '',
    };
    this.axisViews = [view];
  }

  attached({ chart, series, requestUpdate } = {}) {
    this.chart = chart ?? null;
    this.series = series ?? null;
    this.requestRedraw = typeof requestUpdate === 'function' ? requestUpdate : null;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestRedraw = null;
  }

  setPrice(price) {
    this.price = typeof price === 'number' && Number.isFinite(price) ? price : null;
    this.requestRedraw?.();
  }

  tick() {
    this.requestRedraw?.();
  }

  priceAxisViews() {
    return this.axisViews;
  }

  paneViews() {
    return EMPTY_VIEWS;
  }

  // The chart may be removed between a tick and the next paint frame; treat a throwing or null coordinate as hidden.
  coord() {
    if (!this.series || this.price === null) return null;
    let raw;
    try { raw = this.series.priceToCoordinate(this.price); } catch { return null; }
    if (raw === null || raw === undefined) return null;
    const y = Number(raw);
    return Number.isFinite(y) ? y : null;
  }
}
