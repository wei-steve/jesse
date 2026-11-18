// Live price and live klines for the finder: the browser subscribes to the exchange's public trade and kline streams
// (no key, no account, nothing is sent but the symbol) and the page draws the last traded price as a thin line and the
// bar that is still forming as the rightmost candle. Neither touches panel.candles: signals, limit orders, marks and
// the status bar keep reading closed bars only, so they stay the same as in the backtest.

// Public streams of the exchanges the finder reads candles from. Deepcoin (where the owner trades) is not listed: the
// candles in the database come from Binance, and a price from another venue would not match them. The market page's
// OKX / Deepcoin sockets are at the bottom of this file: their envelopes are their own, not Binance stream names.
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
// When `beijingDaily` is true (used by the market page, not the finder), 1D subscribes to `@kline_1d@+08:00` on spot
// and `@kline_8h` on perpetual futures (synthesized into Beijing 1D bars).
export function klineStreamUrl(exchange, symbol, timeframes, { beijingDaily = false } = {}) {
  const make = STREAMS[exchange]?.kline;
  const pair = pairOf(symbol);
  if (!make || !pair) return null;
  const streams = [];
  const seen = new Set();
  for (const tf of Array.isArray(timeframes) ? timeframes : []) {
    let stream = null;
    if (beijingDaily && tf === '1D') {
      if (exchange === 'Binance Spot') stream = `${pair}@kline_1d@+08:00`;
      else if (exchange === 'Binance Perpetual Futures') stream = `${pair}@kline_8h`;
    }
    if (!stream) {
      const interval = klineInterval(tf);
      if (interval) stream = `${pair}@kline_${interval}`;
    }
    if (stream && !seen.has(stream)) {
      seen.add(stream);
      streams.push(stream);
    }
  }
  return streams.length ? make(streams.join('/')) : null;
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
  const interval = /@kline_([a-z0-9]+)(?:@\+08:00)?$/.exec(String(message?.stream ?? ''))?.[1];
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
// `handshake()` returns the messages to send once connected (OKX / Deepcoin subscription frames), and `ping` a text
// frame resent every `pingMs`: OKX drops a connection that sends nothing for 30 seconds, Deepcoin wants `ping`.
function openSocket(url, { onMessage, onState, silenceMs = 20000, handshake = null, ping = null, pingMs = 25000 }) {
  let socket = null, stopped = false, attempt = 0, retry = null, watchdog = null, heartbeat = null;
  const send = message => { try { socket?.send(typeof message === 'string' ? message : JSON.stringify(message)); } catch { /* closed */ } };
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { try { socket?.close(); } catch { /* reopened below */ } }, silenceMs);
    clearInterval(heartbeat);
    if (ping) heartbeat = setInterval(() => send(ping), pingMs);
  };
  const connect = () => {
    socket = new WebSocket(url);
    arm();
    socket.onopen = () => {
      onState?.('connected');
      for (const message of handshake?.() ?? []) send(message);
    };
    socket.onmessage = event => {
      attempt = 0; arm();
      let message;
      try { message = JSON.parse(event.data); } catch { return; /* not JSON */ }
      onMessage(message);
    };
    socket.onclose = () => {
      clearTimeout(watchdog); clearInterval(heartbeat);
      if (stopped) return;
      onState?.('reconnecting');
      retry = setTimeout(connect, reconnectDelay(attempt++));
    };
    socket.onerror = () => { try { socket.close(); } catch { /* closing anyway */ } };
  };
  connect();
  return () => {
    stopped = true; clearTimeout(retry); clearTimeout(watchdog); clearInterval(heartbeat);
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

// ---- OKX ----------------------------------------------------------------------------------------------------------
// OKX has its own envelope: a JSON subscription frame on open, `{arg:{channel, instId}, data:[…]}` afterwards, and a
// text `ping` every 25 seconds the server answers with `pong` (a silent socket is dropped after 30). Candles come on
// the business channel, tickers on the public one; a websocket is not a cross-origin read, so the browser talks to
// OKX itself. All of this was checked against the live venue on 2026-11-16.
const OKX_WS = { business: 'wss://ws.okx.com/ws/v5/business', public: 'wss://ws.okx.com/ws/v5/public' };
// `1D` opens at OKX's UTC+8 midnight (16:00 UTC); `1Dutc` is the UTC day bar.
const OKX_CANDLE_CHANNELS = { '1m': 'candle1m', '3m': 'candle3m', '5m': 'candle5m', '15m': 'candle15m',
  '30m': 'candle30m', '1h': 'candle1H', '4h': 'candle4H', '1D': 'candle1D' };
const OKX_CHANNEL_LABELS = new Map(Object.entries(OKX_CANDLE_CHANNELS).map(([label, channel]) => [channel, label]));

/** The candle channel of one page timeframe, or null when OKX pushes none for it. */
export const okxCandleChannel = timeframe => OKX_CANDLE_CHANNELS[String(timeframe ?? '')] ?? null;

/** The channels to subscribe for a set of page timeframes (deduplicated, in the order given). */
export function okxCandleChannels(timeframes) {
  return [...new Set((Array.isArray(timeframes) ? timeframes : []).map(okxCandleChannel).filter(Boolean))];
}

/** One candle message of a subscribed channel as the chart's candle; `closed` is false while `confirm` is 0. */
export function okxCandle(message) {
  const tf = OKX_CHANNEL_LABELS.get(message?.arg?.channel);
  const row = Array.isArray(message?.data) ? message.data[0] : null;
  if (!tf || !Array.isArray(row) || row.length < 6) return null;
  const [milliseconds, open, high, low, close] = row.slice(0, 5).map(Number);
  if (![milliseconds, open, high, low, close].every(value => Number.isFinite(value) && value > 0)) return null;
  const volume = Number(row[5]);
  return { tf, time: Math.floor(milliseconds / 1000), open, high, low, close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0, closed: row[8] !== '0' && row[8] !== 0 };
}

/** One `tickers` message as a watchlist quote (`{symbol: instId, price, change}`), or null for anything else. */
export function okxTickerQuote(message) {
  if (message?.arg?.channel !== 'tickers') return null;
  const instId = message?.arg?.instId;
  const price = Number(message?.data?.[0]?.last);
  const open = Number(message?.data?.[0]?.open24h);
  if (!instId || !Number.isFinite(price) || price <= 0) return null;
  return { symbol: String(instId), price, change: Number.isFinite(open) && open > 0 ? (price - open) / open : null };
}

/** The last price of a `tickers` message, or null for anything else (OKX pushes one per trade burst). */
export const okxTickerPrice = message => okxTickerQuote(message)?.price ?? null;

/** The forming bar and the bar that just closed of every timeframe OKX pushes. Returns stop(). */
export function openOkxKlines(instId, timeframes, { onKline, onState, silenceMs = 20000 }) {
  const channels = okxCandleChannels(timeframes);
  if (!instId || !channels.length) return () => {};
  return openSocket(OKX_WS.business, {
    silenceMs, ping: 'ping', pingMs: 25000, onState,
    handshake: () => [JSON.stringify({ op: 'subscribe', args: channels.map(channel => ({ channel, instId })) })],
    onMessage: message => { const candle = okxCandle(message); if (candle) onKline(candle); },
  });
}

/** OKX's ticker channel: the last traded price of one instrument. Returns stop(). */
export function openOkxTicker(instId, { onPrice, onState, throttleMs = 250, silenceMs = 20000 }) {
  if (!instId) return () => {};
  let timer = null, latest = null, active = true;
  const flush = () => { timer = null; if (latest !== null && active) onPrice(latest); };
  const stop = openSocket(OKX_WS.public, {
    silenceMs, ping: 'ping', pingMs: 25000, onState,
    handshake: () => [JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId }] })],
    onMessage: message => {
      const price = okxTickerPrice(message);
      if (price === null) return;
      latest = price;
      if (!timer) timer = setTimeout(flush, throttleMs);
    },
  });
  return () => { active = false; clearTimeout(timer); stop(); };
}

/** The watchlist's OKX quotes: one socket carries every watched instrument (the subscription takes an args array). */
export function openOkxTickers(instIds, { onQuote, onState, throttleMs = 1000, silenceMs = 20000 }) {
  const ids = [...new Set((Array.isArray(instIds) ? instIds : []).filter(Boolean))];
  if (!ids.length) return () => {};
  let timer = null, latest = new Map(), active = true;
  const flush = () => {
    timer = null;
    if (!active) return;
    const pending = latest;
    latest = new Map();
    for (const quote of pending.values()) onQuote(quote);
  };
  const stop = openSocket(OKX_WS.public, {
    silenceMs, ping: 'ping', pingMs: 25000, onState,
    handshake: () => [JSON.stringify({ op: 'subscribe', args: ids.map(instId => ({ channel: 'tickers', instId })) })],
    onMessage: message => {
      const quote = okxTickerQuote(message);
      if (!quote) return;
      latest.set(quote.symbol, quote);
      if (!timer) timer = setTimeout(flush, throttleMs);
    },
  });
  return () => { active = false; clearTimeout(timer); stop(); };
}

// ---- Deepcoin -----------------------------------------------------------------------------------------------------
// Deepcoin's public socket is a topic bus, not a documented streaming API: subscribe with a `SendTopicAction` frame
// and it answers `{a:'PO', r:[{d:{…}}]}`. Topic 7 is the ticker of one instrument (`I: 'BTCUSDT'`, `N` = last price,
// `O` = the 24h open), topic 11 is a 1m K-line — the venue documents no other period, which is why the forming bar of
// every panel is polled from REST instead (see market.mjs) and only the price line comes from here. The instrument
// code drops the `-USDT-SWAP` suffix, and the venue must be kept alive with a text `ping` every 10 seconds. The spot
// endpoint has no ticker cluster at all ("subscription cluster does not exist", checked 2026-11-16).
const DEEPCOIN_WS = {
  swap: 'wss://stream.deepcoin.com/streamlet/trade/public/swap?platform=api',
  spot: 'wss://stream.deepcoin.com/streamlet/trade/public/spot?platform=api',
};

/** `BTC-USDT-SWAP` -> `BTCUSDT`: the instrument code the socket's topic filter uses. */
export const deepcoinWsFilter = symbol => `DeepCoin_${String(symbol ?? '').replace(/-SWAP$/, '').replace(/-/g, '')}`;

/** The subscription frame of the ticker topic (topic 7) of one instrument. */
export const deepcoinSubscription = symbol => ({
  SendTopicAction: { Action: '1', FilterValue: deepcoinWsFilter(symbol), LocalNo: 111, ResumeNo: -1, TopicID: '7' },
});

/** The last price of a `PO` ticker push (`r[0].d.N`), or null for any other message (the kline topic, the acks). */
export function deepcoinTickerPrice(message) {
  if (message?.a !== 'PO') return null;
  const price = Number(message?.r?.[0]?.d?.N);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Every ticker of a `PO` push as `{code, price, change}` (`code` = the socket's `BTCUSDT`). One socket carries several
 * instruments (one subscription frame each, its own LocalNo — checked 2026-11-17 with four swaps on one connection),
 * so a push says which one it is in `d.I`. `O` is the 24h open (equal to REST `open24h`), so `change` is the same
 * 24h figure as the REST list's.
 */
export function deepcoinTickerQuotes(message) {
  if (message?.a !== 'PO' || !Array.isArray(message?.r)) return [];
  const quotes = [];
  for (const row of message.r) {
    const data = row?.d ?? {};
    const code = String(data.I ?? '').toUpperCase();
    const price = Number(data.N), open = Number(data.O);
    if (!code || !Number.isFinite(price) || price <= 0) continue;
    quotes.push({ code, price, change: Number.isFinite(open) && open > 0 ? (price - open) / open : null });
  }
  return quotes;
}

/**
 * Deepcoin swap tickers of several instruments on one socket (the watchlist's Deepcoin rows), batched like OKX's:
 * `onQuote({symbol, price, change})` at most once a second per instrument. `symbols` are the watchlist's own names
 * (`BTC-USDT`); spot has no ticker cluster, so spot rows stay on the 10-second REST read.
 */
export function openDeepcoinTickers(symbols, { onQuote, onState, throttleMs = 1000, silenceMs = 30000 }) {
  const byCode = new Map();
  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    if (symbol) byCode.set(deepcoinWsFilter(symbol).replace(/^DeepCoin_/, ''), symbol);
  }
  if (!byCode.size) return () => {};
  let timer = null, latest = new Map(), active = true;
  const flush = () => {
    timer = null;
    if (!active) return;
    const pending = latest;
    latest = new Map();
    for (const quote of pending.values()) onQuote(quote);
  };
  const stop = openSocket(DEEPCOIN_WS.swap, {
    silenceMs, ping: 'ping', pingMs: 10000, onState,
    handshake: () => [...byCode.values()].map((symbol, index) => JSON.stringify({
      SendTopicAction: { ...deepcoinSubscription(symbol).SendTopicAction, LocalNo: 111 + index } })),
    onMessage: message => {
      for (const quote of deepcoinTickerQuotes(message)) {
        const symbol = byCode.get(quote.code);
        if (!symbol) continue;
        latest.set(symbol, { symbol, price: quote.price, change: quote.change });
      }
      if (latest.size && !timer) timer = setTimeout(flush, throttleMs);
    },
  });
  return () => { active = false; clearTimeout(timer); stop(); };
}

/** Deepcoin's ticker push for one instrument. Returns stop(); spot has no ticker cluster, so it never connects. */
export function openDeepcoinTicker(market, symbol, { onPrice, onState, throttleMs = 250, silenceMs = 30000 }) {
  // The spot endpoint has no ticker cluster, so a spot instrument simply gets no push (its price comes from the REST
  // poll the page runs for every Deepcoin panel).
  const url = market === 'spot' ? null : DEEPCOIN_WS.swap;
  if (!url || !symbol) return () => {};
  let timer = null, latest = null, active = true;
  const flush = () => { timer = null; if (latest !== null && active) onPrice(latest); };
  const stop = openSocket(url, {
    silenceMs, ping: 'ping', pingMs: 10000, onState,
    handshake: () => [JSON.stringify(deepcoinSubscription(symbol))],
    onMessage: message => {
      const price = deepcoinTickerPrice(message);
      if (price === null) return;
      latest = price;
      if (!timer) timer = setTimeout(flush, throttleMs);
    },
  });
  return () => { active = false; clearTimeout(timer); stop(); };
}
