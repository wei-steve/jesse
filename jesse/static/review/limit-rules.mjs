// Limit-order rules of the factor finder: where a signal's order sits, which candle fills it, and what the trade
// would have done afterwards. Pure functions only (the page passes its candles in); no DOM, no imports, so
// tests/review-limit-rules.test.mjs can drive every rule.
//
// Conventions:
//   j    index of the SIGNAL bar: the bar whose close the factor value is known at (the bar with the arrow)
//   dir  +1 long, -1 short
//   The order is placed when the signal bar closes, so the earliest bar that can fill it is j + 1. It then stays
//   in force while the trend marker it belongs to lasts (see simulateOrder). Prices are that timeframe's own
//   candle values.

export const LIMIT_RULES = [
  { id: 'open', label: '下一根开盘（市价）' },
  { id: 'close', label: '信号 K 线收盘价' },
  { id: 'close_atr', label: '收盘价往回让 x·ATR' },
  { id: 'mid', label: '信号 K 线中点' },
  { id: 'retrace', label: '回撤 y 倍振幅' },
  { id: 'sma5', label: 'SMA5 预估值' },
  { id: 'sma10', label: 'SMA10 预估值' },
];

// Defaults of the page's "挂单" controls (finder.html); also the fallback when a stored value is not a number.
// Default rule: projected SMA5 (2026-11-12, the user: "挂单至少要靠近ma5附近" — the next-bar open after a big
// signal bar sits at the Bollinger band, i.e. a chase).
export const LIMIT_DEFAULTS = { rule: 'sma5', x: 0.25, y: 0.382, k: 1, r: 2, hold: 48 };
// The owner's Deepcoin fees after the 90% rebate (jesse-project CLAUDE.md: maker 0.02% / taker 0.06%): a resting
// limit (entry, take-profit) pays maker, anything that takes liquidity (stop, time exit, a fill at the open) pays
// taker. Every R below is net of both legs (2026-11-13, the owner: "必须真实反映出我们的策略在真实交易里的效果").
export const FEES = { maker: 0.00002, taker: 0.00006 };

const finite = n => typeof n === 'number' && Number.isFinite(n);
const number = (value, fallback) => finite(value) ? value : fallback;
const candle = (candles, i) => Array.isArray(candles) && i >= 0 && i < candles.length ? candles[i] : null;

// ATR(14) with Wilder smoothing, the same convention as the review page's ATR indicator: the first value (bar
// 14) is the mean of the true ranges of bars 1..14, then atr[i] = (atr[i-1]·13 + tr[i]) / 14. Bar 0 has no true
// range; bars before 14 have no ATR. Entries are null where the value is unknown.
export function atr14(candles) {
  const bars = Array.isArray(candles) ? candles : [];
  const out = new Array(bars.length).fill(null);
  let total = 0, previous = null;
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i], before = bars[i - 1];
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - before.close), Math.abs(bar.low - before.close));
    // A malformed candle (missing OHLC) ends the series instead of writing NaN downstream.
    if (!Number.isFinite(tr)) return out;
    if (i < 14) { total += tr; continue; }
    if (i === 14) { total += tr; previous = total / 14; out[i] = previous; continue; }
    previous = (previous * 13 + tr) / 14;
    out[i] = previous;
  }
  return out;
}

// SMA of closes ending at bar `end` (inclusive); null when the window is not complete.
function smaAt(bars, period, end) {
  if (end + 1 < period) return null;
  let total = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const close = bars[i]?.close;
    if (!Number.isFinite(close)) return null;
    total += close;
  }
  return total / period;
}

// Limit price of one signal, or null when the rule needs data that is not there (warm-up, no next bar).
// opts: { x, y } for close_atr / retrace; opts.atr may carry a precomputed atr14(candles) (the page computes
// it once per chart instead of once per signal).
export function limitOrder(candles, j, dir, ruleId, opts = {}) {
  const bars = Array.isArray(candles) ? candles : [];
  const bar = candle(bars, j);
  const side = Math.sign(dir);
  if (!bar || !side) return null;
  const x = number(opts.x, LIMIT_DEFAULTS.x), y = number(opts.y, LIMIT_DEFAULTS.y);
  let price;
  switch (ruleId) {
    case 'open': {
      const next = candle(bars, j + 1);
      if (!next || !Number.isFinite(next.open)) return null;
      price = next.open;
      break;
    }
    case 'close':
      price = bar.close;
      break;
    case 'close_atr': {
      const atr = (Array.isArray(opts.atr) ? opts.atr : atr14(bars))[j];
      if (!Number.isFinite(atr) || !Number.isFinite(bar.close)) return null;
      price = bar.close - side * x * atr;
      break;
    }
    case 'mid':
      price = (bar.high + bar.low) / 2;
      break;
    case 'retrace':
      if (!Number.isFinite(bar.close) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) return null;
      price = bar.close - side * y * (bar.high - bar.low);
      break;
    case 'sma5':
    case 'sma10': {
      // The next bar's SMA if price stays put: ma[j] + (ma[j] - ma[j-1]). A slope estimate, not a promise.
      const period = ruleId === 'sma5' ? 5 : 10;
      const now = smaAt(bars, period, j), before = smaAt(bars, period, j - 1);
      if (now === null || before === null) return null;
      price = now + (now - before);
      break;
    }
    default:
      return null;
  }
  return Number.isFinite(price) ? { price } : null;
}

// Nothing happened yet: no bar, no levels, no result.
const NO_LEVELS = { fillIndex: null, fillPrice: null, exitIndex: null, exitPrice: null, R: null, stop: null, target: null, reason: null };

// Outcome of a trade that was filled at `price` on bar `fillIndex`, with the ATR that was known when the price
// was set. `out` carries the order-specific fields (waitBars / gapBars / path) into every result. null when the
// ATR cannot size a stop. Stop = price - dir·k·ATR; target = price + dir·r·(k·ATR).
function tradeResult(bars, side, fillIndex, price, atr, opts, out) {
  const k = Math.max(0, number(opts.k, LIMIT_DEFAULTS.k));
  const r = number(opts.r, LIMIT_DEFAULTS.r);
  const hold = Math.max(1, Math.round(number(opts.hold, LIMIT_DEFAULTS.hold)));
  const risk = k * atr;
  if (!(risk > 0)) return null;
  const stop = price - side * risk;
  const target = price + side * r * risk;
  const levels = { ...out, fillIndex, fillPrice: price, stop, target };
  const maker = number(opts.makerFee, FEES.maker), taker = number(opts.takerFee, FEES.taker);
  const entryFee = (out.gapFill || out.market ? taker : maker) * price;
  // R after fees: gross move over the risk, minus both legs' fees in the same unit.
  const close = (index, exitPrice, reason) => {
    const grossR = side * (exitPrice - price) / risk;
    const feeR = (entryFee + (reason === 'target' ? maker : taker) * exitPrice) / risk;
    return { ...levels, status: 'filled', exitIndex: index, exitPrice, reason, grossR, feeR, R: grossR - feeR };
  };
  for (let index = fillIndex, held = 1; ; index++, held++) {
    const bar = candle(bars, index);
    if (!bar) return { ...levels, exitIndex: null, exitPrice: null, R: null, status: 'open', reason: 'open' };
    // A bar that touches both levels counts as the stop: the intrabar path is unknown, so assume the worse one.
    // A later bar that OPENS past the stop exits at that open (a stop-market order fills there, not at the stop).
    if (side > 0 ? bar.low <= stop : bar.high >= stop) {
      const gapped = held > 1 && Number.isFinite(bar.open) && (side > 0 ? bar.open < stop : bar.open > stop);
      return close(index, gapped ? bar.open : stop, 'stop');
    }
    // The fill bar only checks the stop: it may have touched the target before the fill, which the candles
    // cannot show (conservative, as asked). The take-profit is a resting limit: like the entry it needs price to
    // trade THROUGH it (a touch may leave it unfilled in the queue).
    if (held > 1 && (side > 0 ? bar.high > target : bar.low < target)) return close(index, target, 'target');
    // `hold` bars were given to the trade and none of the two levels was hit: close it at this bar's close.
    if (held >= hold) {
      if (!Number.isFinite(bar.close)) return { ...levels, exitIndex: null, exitPrice: null, R: null, status: 'open', reason: 'open' };
      return close(index, bar.close, 'time');
    }
  }
}

// Where the order of a signal sat and what it did. The order is placed at the close of the signal bar and stays
// in force until the trend marker it belongs to disappears: at every bar's close the price is re-computed with
// the same rule (`limitOrder(candles, i, …)`), and that price is what bar i + 1 can fill. The user's example
// (3m BTC, 2026-10-27 06:48 short at the SMA5 estimate 79639.5): the next bar's high stopped $1.3 short, and the
// order was cancelled — although 07:06 traded through it.
//   opts.lastIndex  index of the trend's last bar (rideSpan(candles, ride).last); defaults to the last candle
//   opts.ended      whether the trend marker is already gone. An ended trend cancels the order at lastIndex + 1:
//                   lastIndex closed while the trend was still there, so it keeps the order alive for that bar,
//                   and that bar's close has no trend left. A trend still running keeps the order to the data end.
// A bar that OPENS at or past the limit price fills at its open (`gapFill`: the order would have been placed
// below the market for a short / above it for a long, i.e. a taker fill at a price at least as good as the limit).
// Until 2026-11-13 such a bar was skipped; the user pointed at BTC 3m 10-27 06:30 (short, limit 79712.5, the bar
// opened 79724.5 and rose) and asked why it did not fill — with their 0.006% taker fee it is a real entry.
// `gapBars` stays (0 or 1) so the info line can say 开盘成交.
// Returns
//   { status, fillIndex, fillPrice, exitIndex, exitPrice, R, stop, target, reason, waitBars, gapBars, path }
// status: 'filled'   filled and closed; `reason` is 'stop', 'target' or 'time'
//         'open'     filled, but the candles end before the trade is over
//         'unfilled' the trend ended and no bar up to the cancel bar traded at the limit
//         'waiting'  the data ends while the order is still in force and no bar traded at the limit
// `waitBars` counts the bars the order waited for (a fill on bar b waited b - j bars). `path` is
// [{ index, price }]: one entry per bar whose close set the price, so drawing index -> index+1 gives the
// staircase the page shows. The market rule ('open', next open) has no gap test and no waiting.
export function simulateOrder(candles, j, dir, ruleId, opts = {}) {
  const bars = Array.isArray(candles) ? candles : [];
  const side = Math.sign(dir);
  if (!candle(bars, j) || !side) return null;
  const atr = Array.isArray(opts.atr) ? opts.atr : atr14(bars);
  const lastBar = bars.length - 1;
  const lastIndex = Number.isInteger(opts.lastIndex) ? Math.min(opts.lastIndex, lastBar) : lastBar;
  if (opts.market === true || ruleId === 'open') {
    const next = candle(bars, j + 1);
    if (!Number.isFinite(next?.open)) return null;
    return tradeResult(bars, side, j + 1, next.open, atr[j], opts,
      { waitBars: 1, gapBars: 0, market: true, path: [{ index: j, price: next.open }] });
  }
  // The order is cancelled when the trend is known to be over; an unfilled order then stops waiting.
  const cancelBar = opts.ended === true ? lastIndex + 1 : Infinity;
  const path = [];
  let gapBars = 0;
  for (let i = j, end = Math.min(cancelBar - 1, lastBar - 1); i <= end; i++) {
    const order = limitOrder(bars, i, side, ruleId, { ...opts, atr });
    // The rule has no price for this bar (warm-up, malformed data): there is nothing to be filled either.
    if (!order) continue;
    const bar = bars[i + 1], price = order.price;
    path.push({ index: i, price });
    if (Number.isFinite(bar.open) && (side > 0 ? bar.open <= price : bar.open >= price)) {
      gapBars++;
      return tradeResult(bars, side, i + 1, bar.open, atr[i], opts, { waitBars: i + 1 - j, gapBars, gapFill: true, path });
    }
    if (!(side > 0 ? bar.low < price : bar.high > price)) continue;
    return tradeResult(bars, side, i + 1, price, atr[i], opts, { waitBars: i + 1 - j, gapBars, path });
  }
  // An ended trend whose last bar is the last candle has no cancel bar yet: the order is still alive.
  const status = cancelBar <= lastBar ? 'unfilled' : 'waiting';
  return { ...NO_LEVELS, status, waitBars: Math.max(0, Math.min(cancelBar, lastBar) - j), gapBars, path };
}

// Totals of a timeframe's orders. `filled` counts trades that were filled (closed or still running), because
// the fill rate is about getting in; wins / win rate / avgR / sumR only use closed trades, so an unfinished
// trade never inflates or dilutes them. Orders still waiting for a fill (the data ends before the trend does)
// are left out of the fill rate: nothing has been decided for them yet, so they would only drag it down.
export function summarize(results) {
  const list = (Array.isArray(results) ? results : []).filter(Boolean);
  const filled = list.filter(item => item.status === 'filled' || item.status === 'open').length;
  const closed = list.filter(item => item.status === 'filled');
  const wins = closed.filter(item => item.R > 0).length;
  const sumR = closed.reduce((total, item) => total + item.R, 0);
  const marks = list.length;
  const waiting = list.filter(item => item.status === 'waiting').length;
  const decided = marks - waiting;
  return { marks, filled, waiting, unfilled: list.filter(item => item.status === 'unfilled').length,
    fillRate: decided ? filled / decided : 0, wins,
    winRate: closed.length ? wins / closed.length : 0,
    avgR: closed.length ? sumR / closed.length : 0, sumR };
}
