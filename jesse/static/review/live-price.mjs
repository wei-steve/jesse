// Live price and live klines for the finder: the browser subscribes to the exchange's public trade and kline streams
// (no key, no account, nothing is sent but the symbol) and the page draws the last traded price as a thin line and the
// bar that is still forming as the rightmost candle. Neither touches panel.candles: signals, limit orders, marks and
// the status bar keep reading closed bars only, so they stay the same as in the backtest.

// Public streams of the exchanges the finder reads candles from. Deepcoin (where the owner trades) is not listed: the
// candles in the database come from Binance, and a price from another venue would not match them.
const STREAMS = {
  // USDⓈ-M market streams moved under /market (checked 2026-11-16: the bare /ws path still accepts the connection but
  // sends nothing). Combined kline subscriptions (`?streams=a/b/…`) live under /stream on both markets.
  'Binance Perpetual Futures': {
    trade: symbol => `wss://fstream.binance.com/market/ws/${symbol}@aggTrade`,
    kline: streams => `wss://fstream.binance.com/market/stream?streams=${streams}`,
  },
  'Binance Spot': {
    trade: symbol => `wss://stream.binance.com:9443/ws/${symbol}@aggTrade`,
    kline: streams => `wss://stream.binance.com:9443/stream?streams=${streams}`,
  },
};

// The timeframes Binance pushes candlesticks for, in the finder's own labels. "1D" is Binance's lowercase "1d"; the
// other finder choices (45m, 3h, 6h…) have no stream, so those charts simply get no forming bar.
const KLINE_INTERVALS = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1D': '1d',
};
const FINDER_LABELS = new Map(Object.entries(KLINE_INTERVALS).map(([label, interval]) => [interval, label]));

// "BTC-USDT" → btcusdt: the form is a pair, the stream wants the concatenation.
const pairOf = symbol => String(symbol ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

// The stream URL for a finder exchange + symbol ("BTC-USDT" → btcusdt), or null when there is none.
export function streamUrl(exchange, symbol) {
  const make = STREAMS[exchange]?.trade;
  const pair = pairOf(symbol);
  return make && pair ? make(pair) : null;
}

// The Binance interval of one finder timeframe label (accepts "1d" too), or null when Binance has no stream for it.
export function klineInterval(timeframe) {
  const label = String(timeframe ?? '').replace(/^(\d+)d$/, '$1D');
  return KLINE_INTERVALS[label] ?? null;
}

// One combined kline stream for every timeframe that has one: `…/stream?streams=<pair>@kline_3m/<pair>@kline_1h`.
// Null when the exchange / symbol has no stream or none of `timeframes` is supported (nothing to subscribe to).
export function klineStreamUrl(exchange, symbol, timeframes) {
  const make = STREAMS[exchange]?.kline;
  const pair = pairOf(symbol);
  if (!make || !pair) return null;
  const intervals = [...new Set((Array.isArray(timeframes) ? timeframes : []).map(klineInterval).filter(Boolean))];
  return intervals.length ? make(intervals.map(interval => `${pair}@kline_${interval}`).join('/')) : null;
}

// The price of one aggTrade message (`p` is a decimal string), or null for anything else.
export function tradePrice(message) {
  const price = Number(message?.p);
  return message?.e === 'aggTrade' && Number.isFinite(price) && price > 0 ? price : null;
}

// One kline message of the combined stream (`{stream, data:{k:{t,o,h,l,c,v,x}}}`) as the candle the chart draws:
// `time` is the bar's open in UTC seconds, `closed` says whether the exchange is done with it. Null for anything that
// is not a full, sane kline of a timeframe we subscribed to (the stream name carries the interval).
export function klineCandle(message) {
  const interval = /@kline_([a-z0-9]+)$/.exec(String(message?.stream ?? ''))?.[1];
  const tf = FINDER_LABELS.get(interval);
  const k = message?.data?.k;
  if (!tf || !k) return null;
  const [milliseconds, open, high, low, close] = ['t', 'o', 'h', 'l', 'c'].map(key => Number(k[key]));
  if (![milliseconds, open, high, low, close].every(value => Number.isFinite(value) && value > 0)) return null;
  const volume = Number(k.v);
  return { tf, time: Math.floor(milliseconds / 1000), open, high, low, close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0, closed: k.x === true };
}

// Retry delay after the n-th dropped connection in a row: 1s, 2s, 4s … capped at 30s.
export const reconnectDelay = attempt => Math.min(30000, 1000 * 2 ** Math.max(0, attempt));

// One websocket with the retry / silence policy both streams share: exponential backoff after a drop, and a socket
// that stays open but goes quiet for `silenceMs` (a moved endpoint does exactly that) is closed and reopened. Returns
// stop(); it reconnects by itself until stopped.
function openSocket(url, { onMessage, onState, silenceMs = 20000 }) {
  let socket = null, stopped = false, attempt = 0, retry = null, watchdog = null;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { try { socket?.close(); } catch { /* reopened below */ } }, silenceMs);
  };
  const connect = () => {
    socket = new WebSocket(url);
    arm();
    socket.onopen = () => onState?.('connected');
    socket.onmessage = event => {
      attempt = 0; arm();
      let message;
      try { message = JSON.parse(event.data); } catch { return; /* not JSON */ }
      onMessage(message);
    };
    socket.onclose = () => {
      clearTimeout(watchdog);
      if (stopped) return;
      onState?.('reconnecting');
      retry = setTimeout(connect, reconnectDelay(attempt++));
    };
    socket.onerror = () => { try { socket.close(); } catch { /* closing anyway */ } };
  };
  connect();
  return () => {
    stopped = true; clearTimeout(retry); clearTimeout(watchdog);
    try { socket?.close(); } catch { /* already closed */ }
  };
}

// Opens the trade stream and calls onPrice(price) at most every `throttleMs` with the newest price, onState(text) on
// connect / drop. Returns stop().
export function openTicker(url, { onPrice, onState, throttleMs = 250, silenceMs = 20000 }) {
  let timer = null, latest = null, active = true;
  const flush = () => { timer = null; if (latest !== null && active) onPrice(latest); };
  const stop = openSocket(url, {
    silenceMs, onState,
    onMessage: message => {
      const price = tradePrice(message);
      if (price === null) return;
      latest = price;
      // Trades arrive many times a second; redrawing every chart that often costs more than it shows.
      if (!timer) timer = setTimeout(flush, throttleMs);
    },
  });
  return () => { active = false; clearTimeout(timer); stop(); };
}

// Opens the combined kline stream and calls onKline(candle) for every bar the exchange pushes (forming and closed),
// onState(text) on connect / drop. Returns stop(). The caller decides what to draw; unparsable messages are dropped
// here so nothing downstream has to re-check them.
export function openKlines(url, { onKline, onState, silenceMs = 20000 }) {
  return openSocket(url, {
    silenceMs, onState,
    onMessage: message => { const candle = klineCandle(message); if (candle) onKline(candle); },
  });
}

// The same retry / silence policy for a stream whose messages the caller parses itself (the market page's
// `<pair>@miniTicker` quotes). onMessage gets every message that parsed as JSON. Returns stop().
export function openMessages(url, { onMessage, onState, silenceMs = 20000 }) {
  return openSocket(url, { onMessage, onState, silenceMs });
}
