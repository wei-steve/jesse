// The owner's own Deepcoin fills, drawn on the 看行情 page (T-59): which of the chart's candles a 开多 / 平多 / 开空 /
// 平空 happened in, one arrow per direction per candle, and the numbers of that group under the chart.
//
// Pure functions only (no DOM, no fetch): the page owns the request and the markers, tests/review-market-fills.test.mjs
// runs every function here with node. The instrument mapping is the interesting part: the fills belong to the owner's
// Deepcoin account, but a BTC trade is the same trade whichever venue the chart is showing, so Binance's `BTCUSDT`,
// OKX's `BTC-USDT-SWAP` and Deepcoin's own ids all name the same `{market, symbol}` of the private endpoint.
import { BINANCE_SOURCE, DEEPCOIN_SOURCE, OKX_SOURCE } from './market-sources.mjs?v=20261117c';

// The 「我的成交」 checkbox: on unless the owner turned it off, so the markers are there when the keys are filled in.
export const FILLS_KEY = 'jesse.market.fills.v1';
// The page polls every 30 seconds; the backend answers two callers within 5 seconds from its store, so a second tab (or a
// window that just grew left) costs no request at the venue.
export const FILLS_POLL_MS = 30000;
export const FILLS_ENDPOINT = '/review/market/fills';
// Shown once in the page's status line when `.env.deepcoin` is missing / incomplete.
export const FILLS_NOT_CONFIGURED = '未配置 Deepcoin API：在 jesse-project/.env.deepcoin 填三项后刷新';
// Shown while the backend's store still walks into the past (T-60): the fills it already has are drawn, and the next
// 30-second poll continues where this one stopped. `<date>` is the oldest fill the store has, so the line says how far
// back the markers are trustworthy.
export const FILLS_BACKFILLING = '我的成交：正在补历史，已到 ';
export const FILLS_BACKFILLING_EMPTY = '我的成交：正在补历史…';
// 买绿卖红, the same two colours as the candles (market.mjs UP / DOWN): a buy arrow below the candle (green, up), a sell
// arrow above it (red, down), so a marker never sits on top of the candle's own body.
export const BUY_MARKER_COLOR = '#16a082';
export const SELL_MARKER_COLOR = '#dd6070';
const EXCHANGES = [BINANCE_SOURCE, OKX_SOURCE, DEEPCOIN_SOURCE];

/** `BTCUSDT` / `BTC-USDT` / `BTC-USDT-SWAP` -> `BTC`; '' for anything that cannot be a USDT pair. */
export function fillsBase(symbol) {
  const raw = String(symbol ?? '').toUpperCase().replace(/\s/g, '');
  const base = raw.replace(/-USDT(-SWAP)?$/, '').replace(/USDT$/, '');
  return /^[A-Z0-9]{2,16}$/.test(base) && base !== 'USDT' ? base : '';
}

/**
 * The private endpoint's instrument for a chart of `source` / `market` / `symbol`, or null when that chart has no
 * counterpart in the owner's account (the treasury yields: he does not trade them on Deepcoin).
 *
 * 合约 stays the perpetual (SWAP), 现货 the spot pair (SPOT): the same base coin on Binance or OKX maps to the Deepcoin
 * instrument of the same kind, which is what makes the markers visible on any of the three exchanges.
 */
export function fillsInstrument(source, market, symbol) {
  if (!EXCHANGES.includes(source)) return null;
  const base = fillsBase(symbol);
  if (!base) return null;
  const swap = market !== 'spot';
  return { market: swap ? 'swap' : 'spot', instType: swap ? 'SWAP' : 'SPOT', symbol: `${base}-USDT` };
}

/**
 * The body of `POST /review/market/fills` for one chart, or null for a chart with no counterpart. `begin` is the open
 * time (seconds) of the oldest candle the page has loaded — the fills before it could not be drawn; `end` is left out
 * unless the caller wants a closed window.
 *
 * `have` (T-61) is `{from, to}`, the range the page already has (`fillsHave`): sending it turns the answer into the
 * increment of that range. The first read of an instrument, or the read after switching to another one, has nothing to
 * send and asks for the whole window.
 */
export function fillsRequest(source, market, symbol, begin, end = null, have = null) {
  const instrument = fillsInstrument(source, market, symbol);
  const start = Math.floor(Number(begin));
  if (!instrument || !Number.isFinite(start) || start <= 0) return null;
  const stop = Math.floor(Number(end));
  const body = { market: instrument.market, symbol: instrument.symbol, begin: start,
    ...(Number.isFinite(stop) && stop >= start ? { end: stop } : {}) };
  const from = Math.floor(Number(have?.from));
  const to = Math.floor(Number(have?.to));
  // Both edges or neither: the route refuses half a range, and a page without fills has no range to name.
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from) {
    body.have_from = from;
    body.have_to = to;
  }
  return body;
}

/** The fills of one answer as sane fills, oldest first. A row without a price / size / time is dropped, not drawn. */
export function parseFills(payload) {
  const rows = Array.isArray(payload?.fills) ? payload.fills : [];
  const fills = [];
  for (const row of rows) {
    const time = Number(row?.time), price = Number(row?.price), size = Number(row?.size);
    if (![time, price, size].every(Number.isFinite) || time <= 0 || price <= 0 || size <= 0) continue;
    const side = String(row?.side ?? '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;
    const posSide = String(row?.posSide ?? '').toLowerCase();
    const fee = Number(row?.fee);
    fills.push({ time: Math.trunc(time), price, size, side, posSide: posSide === 'long' || posSide === 'short' ? posSide : '',
      execType: String(row?.execType ?? '').toUpperCase(), fee: Number.isFinite(fee) ? fee : 0,
      feeCcy: String(row?.feeCcy ?? '').toUpperCase(), ordId: String(row?.ordId ?? ''),
      tradeId: String(row?.tradeId ?? '') });
  }
  return fills.sort((a, b) => a.time - b.time || a.tradeId.localeCompare(b.tradeId));
}

/** Whether the answer says the project has the three credentials (an unconfigured project sends no fills at all). */
export const configuredOf = payload => payload?.configured === true;

/**
 * The oldest and newest second of the fills the page already drew, `{from, to}`, or null when it has none — which is
 * also the state after switching to another instrument, so that read asks for the whole window.
 */
export function fillsHave(fills) {
  let from = null, to = null;
  for (const fill of Array.isArray(fills) ? fills : []) {
    const time = Number(fill?.time);
    if (!Number.isFinite(time) || time <= 0) continue;
    if (from === null || time < from) from = time;
    if (to === null || time > to) to = time;
  }
  return from === null ? null : { from, to };
}

/**
 * The identity of one fill on the page: its trade id, or the row's own numbers when the answer has none (a venue
 * without trade ids). Two answers that overlap — the 2-minute edge the backend re-sends, a backfill that repeats a
 * page — must not draw the same trade twice.
 */
export function fillKey(fill) {
  const tradeId = String(fill?.tradeId ?? '');
  return tradeId || [fill?.ordId ?? '', fill?.time ?? '', fill?.price ?? '', fill?.size ?? ''].join('|');
}

/**
 * The page's fills after one answer (T-61): what it already had plus the increment, one row per fill, oldest first,
 * nothing older than the window's own start (`begin`, the left edge the markers could be drawn on). An incremental
 * answer is merged, never assigned: the rows it does not repeat are still on screen.
 */
export function mergeFillRows(rows, incoming, begin = null) {
  const start = Number(begin);
  const hasStart = begin !== null && begin !== undefined && Number.isFinite(start);
  const merged = new Map();
  for (const fill of [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const time = Number(fill?.time), price = Number(fill?.price), size = Number(fill?.size);
    if (![time, price, size].every(Number.isFinite) || time <= 0 || price <= 0 || size <= 0) continue;
    if (hasStart && time < Math.floor(start)) continue;
    merged.set(fillKey(fill), fill);
  }
  return [...merged.values()].sort((a, b) => a.time - b.time || fillKey(a).localeCompare(fillKey(b)));
}

/** UTC `2026-11-17 08:30` of a second stamp, the same shape the charts use for a candle time ('' when it is not one). */
export function fillsStamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The status line while the store still misses history, '' when it does not (`complete` is absent on an older backend,
 * which is not a reason to nag). `covered_from` is the oldest stored fill in seconds, so the line tells the owner how far
 * back the markers go; without it the line still says that a backfill is running.
 */
export function fillsProgressText(payload) {
  if (payload?.configured !== true || payload?.complete !== false) return '';
  const stamp = fillsStamp(payload.covered_from);
  return stamp ? `${FILLS_BACKFILLING}${stamp} UTC` : FILLS_BACKFILLING_EMPTY;
}

// 方向 + 开平 of one fill, in the order a bar lists its groups: 开多 / 平多 / 开空 / 平空, then a fill without posSide.
const ACTIONS = [
  { id: 'open-long', label: '开多', kind: 'buy', side: 'buy', posSide: 'long' },
  { id: 'close-long', label: '平多', kind: 'sell', side: 'sell', posSide: 'long' },
  { id: 'open-short', label: '开空', kind: 'sell', side: 'sell', posSide: 'short' },
  { id: 'close-short', label: '平空', kind: 'buy', side: 'buy', posSide: 'short' },
];
const PLAIN = { buy: { id: 'buy', label: '买', kind: 'buy' }, sell: { id: 'sell', label: '卖', kind: 'sell' } };
const actionOrder = id => {
  const index = ACTIONS.findIndex(action => action.id === id);
  return index >= 0 ? index : ACTIONS.length;
};

/**
 * What one fill did: `{id, label, kind}`. `kind` is the trade's own direction (buy / sell), which is what decides the
 * arrow's side and colour; `label` is what the marker and the line under the chart say.
 *
 * buy + long = 开多, sell + long = 平多, sell + short = 开空, buy + short = 平空. A fill without `posSide` (a spot
 * trade, or a venue that does not say) is only 买 / 卖.
 */
export function fillAction(fill) {
  const side = String(fill?.side ?? '').toLowerCase();
  const posSide = String(fill?.posSide ?? '').toLowerCase();
  const match = ACTIONS.find(action => action.side === side && action.posSide === posSide);
  if (match) return { id: match.id, label: match.label, kind: match.kind };
  return { ...(PLAIN[side] ?? { id: 'unknown', label: '', kind: 'buy' }) };
}

/** A size-weighted average (null when nothing was summed), which is what 均价 has to be for a group of fills. */
const average = (notional, size) => (size > 0 ? notional / size : null);

/**
 * The fills of one chart bucketed into its candles: `[{time, groups}]`, oldest candle first. Every fill lands in the
 * candle whose open time is `floor(time / (interval * 60))`, so a 15m chart says what happened inside that 15 minutes
 * and a 1m chart splits the same fills minute by minute.
 *
 * Fills of the same direction in the same candle are one group (one marker, one line under the chart): count, the
 * size-weighted average price, the summed size and fee, and the fee currency.
 */
export function bucketFills(fills, interval) {
  const minutes = Number(interval);
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const width = Math.trunc(minutes) * 60;
  const bars = new Map();
  for (const fill of Array.isArray(fills) ? fills : []) {
    const time = Number(fill?.time), price = Number(fill?.price), size = Number(fill?.size);
    if (![time, price, size].every(Number.isFinite) || time <= 0 || price <= 0 || size <= 0) continue;
    const bar = Math.floor(time / width) * width;
    let groups = bars.get(bar);
    if (!groups) { groups = new Map(); bars.set(bar, groups); }
    const action = fillAction(fill);
    const group = groups.get(action.id) ?? { ...action, count: 0, size: 0, notional: 0, fee: 0, feeCcy: '' };
    group.count += 1;
    group.size += size;
    group.notional += price * size;
    const fee = Number(fill?.fee);
    if (Number.isFinite(fee)) group.fee += fee;
    if (!group.feeCcy && fill?.feeCcy) group.feeCcy = String(fill.feeCcy).toUpperCase();
    groups.set(action.id, group);
  }
  return [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([time, groups]) => ({
    time,
    groups: [...groups.values()]
      .map(group => ({ ...group, price: average(group.notional, group.size) }))
      .sort((a, b) => actionOrder(a.id) - actionOrder(b.id)),
  }));
}

/** The markers of a bucket list: a buy-side group below the candle (green, up), a sell-side group above it (red, down). */
export function fillMarkers(buckets, has = () => true) {
  const markers = [];
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!Number.isFinite(bucket?.time) || !has(bucket.time)) continue;
    for (const group of bucket.groups ?? []) {
      const buy = group.kind === 'buy';
      markers.push({ time: bucket.time, position: buy ? 'belowBar' : 'aboveBar',
        color: buy ? BUY_MARKER_COLOR : SELL_MARKER_COLOR, shape: buy ? 'arrowUp' : 'arrowDown',
        text: group.label });
    }
  }
  return markers;
}

/**
 * Several marker lists as one, oldest first: the charts draw the purple 「注」 and these fills with one `setMarkers`
 * call, and a stable sort keeps each list's own order for markers of the same candle (a note and a fill on one candle
 * are both drawn — neither overwrites the other).
 */
export function mergeMarkers(...lists) {
  const markers = [];
  for (const list of lists) {
    for (const marker of Array.isArray(list) ? list : []) {
      if (Number.isFinite(marker?.time)) markers.push(marker);
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

/** `64,320.5` / `300` / `0.12`: thousands separated, no invented decimals and no trailing zeros. */
export const fmtFillNumber = value => (Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—');

/** One group in words, the way the line under the chart reads it: 「开多 2 笔 均价 64,320.5 数量 300 手续费 0.12 USDT」. */
export function fillGroupText(group) {
  const fee = `${fmtFillNumber(group?.fee)}${group?.feeCcy ? ` ${group.feeCcy}` : ''}`;
  return `${group?.label ?? ''} ${Number(group?.count) || 0} 笔 均价 ${fmtFillNumber(group?.price)}`
    + ` 数量 ${fmtFillNumber(group?.size)} 手续费 ${fee}`;
}

/** The groups of one candle in one line (each group its own sentence, joined by ` · `), '' when there are none. */
export const fillGroupsText = groups => (Array.isArray(groups) && groups.length
  ? groups.map(fillGroupText).join(' · ') : '');
