// The owner's own fills at their own prices (T-62): one small mark per order, on the candle it traded in, at the order's
// size-weighted average price. The arrows of market-fills.mjs can only sit under / over a candle, so a 4h chart of a
// day full of 分仓 orders stacked arrow labels until the candles were hidden (2026-11-17: "只有一个箭头标记，有什么办法
// 能在具体价位体现？"). This module draws the marks inside the plot as a Lightweight Charts series primitive, so they sit
// *on* the price and never move the candles, and the page shows them only for the timeframes the owner turns on
// (1m / 3m / 5m / 15m / 30m by default; 1h / 4h / 1D start off because they get dense).
//
// Pure functions plus one primitive class: the grouping (orderMarks), the switch state (readFillPrices / fillPricesOn)
// and the canvas drawing (drawFillPrices) are tested by tests/review-fill-prices.test.mjs with fake data and a fake
// 2D context; market.mjs owns the buttons, the localStorage key and the primitive's data.
import { BUY_MARKER_COLOR, SELL_MARKER_COLOR, fillMarkers, fmtFillNumber } from './market-fills.mjs?v=20261117m';

// Per-timeframe switches, `{tf: true|false}` (T-62). A `jesse.*` key, so prefs-sync.mjs mirrors it into
// storage/review-prefs.json like every other setting (T-58).
export const FILL_PRICES_KEY = 'jesse.market.fillPrices.v1';
// A mark is about 3.5 CSS pixels across (triangles a little larger), so it is noticeable without covering a wick.
export const FILL_PRICE_RADIUS = 3.5;
export const FILL_PRICE_LINE = 1.5;
export const FILL_PRICE_ALPHA = 0.85;
// The line under the chart lists this many orders of one candle, then says how many it left out.
export const FILL_PRICE_MAX_ORDERS = 6;
// 买类 (开多 / 平空) green, 卖类 (开空 / 平多) red: the same two colours as the candles and the arrows.
export const FILL_PRICE_BUY_COLOR = BUY_MARKER_COLOR;
export const FILL_PRICE_SELL_COLOR = SELL_MARKER_COLOR;

/** Minutes of a timeframe label (`'15m'`, `'4h'`, `'1D'`), null for anything else. */
export function tfMinutes(tf) {
  const match = /^(\d{1,4})([mhD])$/.exec(String(tf ?? ''));
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  return match[2] === 'D' ? count * 1440 : match[2] === 'h' ? count * 60 : count;
}

/**
 * Whether a timeframe starts with the 价位 marks on: the quiet ones (1m up to 30m) yes, the coarse ones (1h / 4h / 1D)
 * no — the owner's own complaint was that a 4h chart of many 分仓 orders became unreadable. An unknown label is off.
 */
export const fillPricesDefault = tf => {
  const minutes = tfMinutes(tf);
  return minutes !== null && minutes <= 30;
};

/**
 * The stored switches as `{tf: boolean}`. Hand-edited / older values must not break the page: anything that is not JSON,
 * not an object, not a known timeframe label or not a boolean is dropped (and then takes the default).
 */
export function readFillPrices(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const state = {};
  for (const [tf, value] of Object.entries(parsed)) {
    if (tfMinutes(tf) === null || typeof value !== 'boolean') continue;
    state[tf] = value;
  }
  return state;
}

/** Whether one chart's timeframe shows its 价位 marks: its saved switch, or the default when it was never touched. */
export function fillPricesOn(state, tf) {
  const saved = state?.[tf];
  return typeof saved === 'boolean' ? saved : fillPricesDefault(tf);
}

/** The switch after one click: that timeframe flipped, every other one kept (a new object, the page stores it). */
export function toggleFillPrices(state, tf) {
  const next = state && typeof state === 'object' && !Array.isArray(state) ? { ...state } : {};
  next[tf] = !fillPricesOn(next, tf);
  return next;
}

/** Both switches at once: 我的成交 must be on, and this timeframe's 价位 switch too, for the marks to be drawn. */
export const fillPriceMarksOn = (fillsOn, state, tf) => Boolean(fillsOn) && fillPricesOn(state, tf);

// 方向 + 开平 as the marks read it. `open` is what decides a filled triangle (开) or a hollow circle (平); `kind` is the
// trade's own direction and decides colour and which way the triangle points.
const ORDERS = [
  { side: 'buy', posSide: 'long', id: 'open-long', label: '开多', kind: 'buy', open: true },
  { side: 'sell', posSide: 'long', id: 'close-long', label: '平多', kind: 'sell', open: false },
  { side: 'sell', posSide: 'short', id: 'open-short', label: '开空', kind: 'sell', open: true },
  { side: 'buy', posSide: 'short', id: 'close-short', label: '平空', kind: 'buy', open: false },
];
// A spot fill (or a venue that sends no posSide) has nothing to open or close against: buy is 开, sell is 平.
const PLAIN_ORDERS = {
  buy: { id: 'open', label: '开', kind: 'buy', open: true },
  sell: { id: 'close', label: '平', kind: 'sell', open: false },
};

/** `{id, label, kind, open}` of one fill, or null when its side is neither buy nor sell. */
export function orderAction(fill) {
  const side = String(fill?.side ?? '').toLowerCase();
  const posSide = String(fill?.posSide ?? '').toLowerCase();
  const match = ORDERS.find(order => order.side === side && order.posSide === posSide) ?? PLAIN_ORDERS[side];
  return match ? { id: match.id, label: match.label, kind: match.kind, open: match.open } : null;
}

/**
 * The owner's fills of one chart as one mark per order: `[{time, price, action: {id, label, kind}, open, count, size,
 * fee, feeCcy, ordId}]`, oldest candle first (the order the fills arrived in inside one candle).
 *
 * The grouping key is the candle's open time plus the order id — Deepcoin splits one entry into several fills, and those
 * are one order, one mark at their size-weighted average price. A venue without order ids groups by action and price
 * instead, so two market buys at different prices stay two marks. `time` is the candle's open time, i.e. the mark is
 * drawn in the middle of that candle. `open` is 开多 / 开空 (buy+long, sell+short); everything else closes.
 */
export function orderMarks(fills, interval) {
  const minutes = Number(interval);
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const width = Math.trunc(minutes) * 60;
  const groups = new Map();
  for (const fill of Array.isArray(fills) ? fills : []) {
    const time = Number(fill?.time), price = Number(fill?.price), size = Number(fill?.size);
    if (![time, price, size].every(Number.isFinite) || time <= 0 || price <= 0 || size <= 0) continue;
    const action = orderAction(fill);
    if (!action) continue;
    const bar = Math.floor(time / width) * width;
    const ordId = String(fill?.ordId ?? '');
    const key = `${bar}|${ordId ? `ord:${ordId}` : `${action.id}|${price}`}`;
    let group = groups.get(key);
    if (!group) {
      group = { time: bar, notional: 0, size: 0, count: 0, fee: 0, feeCcy: '',
        action: { id: action.id, label: action.label, kind: action.kind }, open: action.open, ordId };
      groups.set(key, group);
    }
    group.count += 1;
    group.size += size;
    group.notional += price * size;
    const fee = Number(fill?.fee);
    if (Number.isFinite(fee)) group.fee += fee;
    if (!group.feeCcy && fill?.feeCcy) group.feeCcy = String(fill.feeCcy).toUpperCase();
  }
  // A stable sort keeps the fills' own order inside one candle (the oldest order first).
  return [...groups.values()]
    .map(({ notional, ...mark }) => ({ ...mark, price: notional / mark.size }))
    .sort((a, b) => a.time - b.time);
}

/** One order in words, the way the line under the chart reads it: 「开多 64,320.5 ×300（3 笔）」. */
export function orderMarkText(mark) {
  const label = mark?.action?.label ?? '';
  const count = Number(mark?.count) || 0;
  return `${label} ${fmtFillNumber(Number(mark?.price))} ×${fmtFillNumber(Number(mark?.size))}`
    + (count > 1 ? `（${count} 笔）` : '');
}

/**
 * The orders of one candle in one line (each its own phrase, joined by ` · `): at most `limit` of them, then
 * 「…另 N 个订单」 for the rest — a busy 1m candle must not push the candle's own numbers out of the line.
 */
export function orderMarksText(marks, limit = FILL_PRICE_MAX_ORDERS) {
  const list = Array.isArray(marks) ? marks : [];
  if (!list.length) return '';
  const max = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : FILL_PRICE_MAX_ORDERS;
  const shown = list.slice(0, max).map(orderMarkText);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} · …另 ${rest} 个订单` : shown.join(' · ');
}

/**
 * The fill arrows a chart draws: none at all while 我的成交 is off, and none on a chart that draws the 价位 marks (the
 * orders would be said twice, and one arrow per side cannot show a price anyway). The purple 「注」 is drawn by the page
 * separately and is never affected.
 */
export function fillArrowMarkers(buckets, has = () => true, options = {}, { on = true, pricesOn = false } = {}) {
  if (!on || pricesOn) return [];
  return fillMarkers(buckets, has, options);
}

/**
 * Where one mark goes, in the bitmap pixels the target draws in: `{x, y, ratio}` or null when the mark has no place on
 * screen (a time the chart does not have — an off-history candle — or a price the scale cannot map; both are the
 * library's null). `timeToCoordinate` / `priceToCoordinate` answer in CSS pixels, so the ratios of the target multiply
 * them; `ratio` is the average of the two, which scales the mark's own size with the device pixel ratio.
 */
export function fillPricePoint(mark, { timeToCoordinate, priceToCoordinate,
  horizontalPixelRatio = 1, verticalPixelRatio = 1 } = {}) {
  const time = Number(mark?.time), price = Number(mark?.price);
  if (!Number.isFinite(time) || !Number.isFinite(price)) return null;
  let rawX, rawY;
  try { rawX = timeToCoordinate?.(time); } catch { return null; }
  try { rawY = priceToCoordinate?.(price); } catch { return null; }
  // The library answers null for a time / price it cannot place: Number(null) would be 0, i.e. a mark in the corner.
  if (rawX === null || rawX === undefined || rawY === null || rawY === undefined) return null;
  const x = Number(rawX), y = Number(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const h = Number(horizontalPixelRatio) > 0 ? Number(horizontalPixelRatio) : 1;
  const v = Number(verticalPixelRatio) > 0 ? Number(verticalPixelRatio) : 1;
  return { x: x * h, y: y * v, ratio: (h + v) / 2 };
}

/**
 * Draws the marks of one chart onto a context that is already in bitmap pixels (the target's
 * `useBitmapCoordinateSpace`). 开 = a small filled triangle (a buy points up, a sell down), 平 = a hollow circle; the
 * colour follows the trade's direction. Returns how many marks were drawn (a mark with no coordinate is skipped, not
 * drawn at the edge of the chart).
 */
export function drawFillPrices(ctx, marks, view = {}, { radius = FILL_PRICE_RADIUS, alpha = FILL_PRICE_ALPHA } = {}) {
  if (!ctx) return 0;
  let drawn = 0;
  for (const mark of Array.isArray(marks) ? marks : []) {
    const point = fillPricePoint(mark, view);
    if (!point) continue;
    const sell = mark?.action?.kind === 'sell';
    const size = radius * point.ratio;
    ctx.save?.();
    ctx.globalAlpha = alpha;
    if (mark?.open) {
      // Apex away from the price (up for a buy, down for a sell) so the triangle's flat base sits at the price itself.
      const tip = sell ? point.y + size * 1.2 : point.y - size * 1.2;
      const base = sell ? point.y - size * 0.8 : point.y + size * 0.8;
      ctx.beginPath();
      ctx.moveTo(point.x, tip);
      ctx.lineTo(point.x - size, base);
      ctx.lineTo(point.x + size, base);
      ctx.closePath();
      ctx.fillStyle = sell ? FILL_PRICE_SELL_COLOR : FILL_PRICE_BUY_COLOR;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
      ctx.strokeStyle = sell ? FILL_PRICE_SELL_COLOR : FILL_PRICE_BUY_COLOR;
      ctx.lineWidth = FILL_PRICE_LINE * point.ratio;
      ctx.stroke();
    }
    ctx.restore?.();
    drawn += 1;
  }
  return drawn;
}

/**
 * A Lightweight Charts series primitive (attached with `series.attachPrimitive`) that draws the 价位 marks of its chart.
 * The library calls `paneViews()` every frame and re-draws on pan / zoom itself, so the page only hands it new marks
 * (`setMarks`, which asks for one redraw) and detaches it with the panel (`detachPrimitive`).
 */
export class FillPricesPrimitive {
  constructor(marks = []) {
    this.marksList = Array.isArray(marks) ? marks : [];
    this.chart = null;
    this.series = null;
    this.requestRedraw = null;
    // One view array, kept by identity: the library caches the mapped renderers on it, a new array each frame would
    // rebuild them on every redraw.
    this.views = [{
      zOrder: () => 'normal',
      renderer: () => ({ draw: target => this.draw(target) }),
    }];
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

  /** The marks to draw now; a redraw is requested only when there is a chart to redraw. */
  setMarks(marks) {
    this.marksList = Array.isArray(marks) ? marks : [];
    this.requestRedraw?.();
  }

  marks() { return this.marksList; }

  paneViews() { return this.views; }

  draw(target) {
    if (!this.chart || !this.series || !this.marksList.length || typeof target?.useBitmapCoordinateSpace !== 'function') return;
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
      drawFillPrices(context, this.marksList, {
        timeToCoordinate: time => this.timeOf(time),
        priceToCoordinate: price => this.priceOf(price),
        horizontalPixelRatio, verticalPixelRatio,
      });
    });
  }

  // The chart may be gone between a redraw being asked for and this frame: a removed chart is a skipped mark, never an
  // exception inside the library's paint loop.
  timeOf(time) {
    try { return this.chart.timeScale().timeToCoordinate(time); } catch { return null; }
  }

  priceOf(price) {
    try { return this.series.priceToCoordinate(price); } catch { return null; }
  }
}
