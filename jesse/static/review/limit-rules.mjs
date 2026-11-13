// Limit-order rules of the factor finder: where a signal's order sits, whether the next candle fills it, and
// what the trade would have done afterwards. Pure functions only (the page passes its candles in); no DOM, no
// imports, so tests/review-limit-rules.test.mjs can drive every rule.
//
// Conventions:
//   j    index of the SIGNAL bar: the bar whose close the factor value is known at (the bar with the arrow)
//   dir  +1 long, -1 short
//   The order can only be filled by the bar after the signal bar (j + 1), because the signal is unknown until
//   the signal bar closes. Prices are that timeframe's own candle values.

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
const NO_LEVELS = { fillIndex: null, exitIndex: null, exitPrice: null, R: null, stop: null, target: null, reason: null };

// Fill and outcome of an order whose limit price is `price`. Returns
//   { status, fillIndex, exitIndex, exitPrice, R, stop, target, reason }
// status: 'gap'      the next bar opens at or past the limit -> not counted as a fill (the open would have been
//                    a better market entry; the user asked for it to be reported separately, 2026-11-12)
//         'unfilled' the next bar never traded at the limit
//         'filled'   filled and closed; `reason` is 'stop', 'target' or 'time'
//         'open'     filled, but the candles end before the trade is over
// `stop`/`target` are returned for the info line (they are not in the user's wording but the page shows them).
// Stop = price - dir·k·ATR[j]; target = price + dir·r·|price - stop|. opts: { k (1), r (2), hold (48),
// ruleId/market } — the 'open' rule is a market order, so it ignores the gap test.
export function simulateOrder(candles, j, dir, price, opts = {}) {
  const bars = Array.isArray(candles) ? candles : [];
  const side = Math.sign(dir);
  const next = candle(bars, j + 1);
  const atr = (Array.isArray(opts.atr) ? opts.atr : atr14(bars))[j];
  if (!side || !next || !Number.isFinite(price) || !Number.isFinite(atr)) return null;
  const market = opts.market === true || opts.ruleId === 'open';
  if (!market) {
    if (Number.isFinite(next.open) && (side > 0 ? next.open <= price : next.open >= price)) return { ...NO_LEVELS, status: 'gap' };
    const touched = side > 0 ? next.low < price : next.high > price;
    if (!touched) return { ...NO_LEVELS, status: 'unfilled' };
  }
  const k = Math.max(0, number(opts.k, LIMIT_DEFAULTS.k));
  const r = number(opts.r, LIMIT_DEFAULTS.r);
  const hold = Math.max(1, Math.round(number(opts.hold, LIMIT_DEFAULTS.hold)));
  // A zero ATR cannot size a stop, so the trade cannot be simulated either.
  const risk = k * atr;
  if (!(risk > 0)) return null;
  const stop = price - side * risk;
  const target = price + side * r * risk;
  const fillIndex = j + 1;
  const levels = { fillIndex, stop, target };
  for (let index = fillIndex, held = 1; ; index++, held++) {
    const bar = candle(bars, index);
    if (!bar) return { ...levels, exitIndex: null, exitPrice: null, R: null, status: 'open', reason: 'open' };
    // A bar that touches both levels counts as the stop: the intrabar path is unknown, so assume the worse one.
    if (side > 0 ? bar.low <= stop : bar.high >= stop) {
      return { ...levels, status: 'filled', exitIndex: index, exitPrice: stop, reason: 'stop', R: side * (stop - price) / risk };
    }
    // The fill bar only checks the stop: it may have touched the target before the fill, which the candles
    // cannot show (conservative, as asked).
    if (held > 1 && (side > 0 ? bar.high >= target : bar.low <= target)) {
      return { ...levels, status: 'filled', exitIndex: index, exitPrice: target, reason: 'target', R: side * (target - price) / risk };
    }
    // `hold` bars were given to the trade and none of the two levels was hit: close it at this bar's close.
    if (held >= hold) {
      if (!Number.isFinite(bar.close)) return { ...levels, exitIndex: null, exitPrice: null, R: null, status: 'open', reason: 'open' };
      return { ...levels, status: 'filled', exitIndex: index, exitPrice: bar.close, reason: 'time', R: side * (bar.close - price) / risk };
    }
  }
}

// Totals of a timeframe's orders. `filled` counts trades that were filled (closed or still running), because
// the fill rate is about getting in; wins / win rate / avgR / sumR only use closed trades, so an unfinished
// trade never inflates or dilutes them.
export function summarize(results) {
  const list = (Array.isArray(results) ? results : []).filter(Boolean);
  const filled = list.filter(item => item.status === 'filled' || item.status === 'open').length;
  const closed = list.filter(item => item.status === 'filled');
  const wins = closed.filter(item => item.R > 0).length;
  const sumR = closed.reduce((total, item) => total + item.R, 0);
  const marks = list.length;
  return { marks, filled, gap: list.filter(item => item.status === 'gap').length,
    unfilled: list.filter(item => item.status === 'unfilled').length,
    fillRate: marks ? filled / marks : 0, wins,
    winRate: closed.length ? wins / closed.length : 0,
    avgR: closed.length ? sumR / closed.length : 0, sumR };
}
