// Live price for the finder: the browser subscribes to the exchange's public trade stream (no key, no account,
// nothing is sent but the symbol) and the page draws the last traded price as a thin line on every chart. It never
// touches the candles: the charts still show closed bars only, so signals stay the same as in the backtest.

// Public trade streams of the exchanges the finder reads candles from. Deepcoin (where the owner trades) is not
// listed: the candles in the database come from Binance, and a price from another venue would not match them.
const STREAMS = {
  // USDⓈ-M market streams moved under /market (checked 2026-11-16: the bare /ws path still accepts the connection but
  // sends nothing).
  'Binance Perpetual Futures': symbol => `wss://fstream.binance.com/market/ws/${symbol}@aggTrade`,
  'Binance Spot': symbol => `wss://stream.binance.com:9443/ws/${symbol}@aggTrade`,
};

// The stream URL for a finder exchange + symbol ("BTC-USDT" → btcusdt), or null when there is none.
export function streamUrl(exchange, symbol) {
  const make = STREAMS[exchange];
  const pair = String(symbol ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return make && pair ? make(pair) : null;
}

// The price of one aggTrade message (`p` is a decimal string), or null for anything else.
export function tradePrice(message) {
  const price = Number(message?.p);
  return message?.e === 'aggTrade' && Number.isFinite(price) && price > 0 ? price : null;
}

// Retry delay after the n-th dropped connection in a row: 1s, 2s, 4s … capped at 30s.
export const reconnectDelay = attempt => Math.min(30000, 1000 * 2 ** Math.max(0, attempt));

// Opens the stream and calls onPrice(price) at most every `throttleMs` with the newest price, onState(text) on
// connect / drop. Returns stop(). Reconnects by itself until stopped.
// A socket that stays open but goes quiet for `silenceMs` (a moved endpoint does exactly that) is closed and reopened.
export function openTicker(url, { onPrice, onState, throttleMs = 250, silenceMs = 20000 }) {
  let socket = null, stopped = false, attempt = 0, retry = null, timer = null, latest = null, watchdog = null;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { try { socket?.close(); } catch { /* reopened below */ } }, silenceMs);
  };
  const flush = () => { timer = null; if (latest !== null && !stopped) onPrice(latest); };
  const connect = () => {
    socket = new WebSocket(url);
    arm();
    socket.onopen = () => onState?.('connected');
    socket.onmessage = event => {
      attempt = 0; arm();
      let price = null;
      try { price = tradePrice(JSON.parse(event.data)); } catch { /* not JSON */ }
      if (price === null) return;
      latest = price;
      // Trades arrive many times a second; redrawing every chart that often costs more than it shows.
      if (!timer) timer = setTimeout(flush, throttleMs);
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
    stopped = true; clearTimeout(retry); clearTimeout(timer); clearTimeout(watchdog);
    try { socket?.close(); } catch { /* already closed */ }
  };
}
