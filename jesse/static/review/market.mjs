// Market page: a clean multi-timeframe chart screen (「看行情」), with no signals, orders, labels or backtest
// content. The candles of the two Binance sources come straight from the exchange's public REST API in the browser —
// nothing is imported into Jesse's database — and its public websockets keep them live: the forming bar, the last
// price, and the watchlist's 24h quotes. The US treasury yields are the one source the browser cannot read itself
// (Yahoo and FRED send no CORS headers), so they come from Jesse's own proxy (`POST /review/market/candles`) and are
// polled every minute instead of pushed.
// The chart behaviour (range linking, price zoom, snapshots) and the overlays (the review page's display settings)
// are reused from the review/finder modules instead of being reimplemented.
import { t as createChart } from './lightweight-charts.mjs?v=20261116e';
import { linkTimeRanges } from './data.mjs?v=20261116e';
import { enablePriceZoom } from './pricezoom.mjs?v=20261116e';
import { STORAGE_KEY, INDICATORS, timeframeLabel, timeframeMinutes, restorePreferences } from './settings.mjs?v=20261116e';
import { calculateIndicator, formingTail } from './indicators.mjs?v=20261116e';
import { klineStreamUrl, streamUrl, openTicker, openKlines, openMessages } from './live-price.mjs?v=20261116e';
import { addSnapshotButton, addMaximizeButton, captureCard, openAnnotator, screenshotSaver, utcStamp } from './snapshot.mjs?v=20261116e';
import { CHART_HEIGHT_KEY, CHART_HEIGHTS, DEFAULT_CHART_HEIGHT, FIT_CHART_HEIGHT, chartHeightOf } from './finder-data.mjs?v=20261116e';
import { MARKET_SOURCES, PERP_SOURCE, SPOT_SOURCE, YIELD_SOURCE, sourceLabel, exchangeOf, restoreSource,
  YIELD_INSTRUMENTS, DEFAULT_YIELD_SYMBOL, normalizeYieldSymbol, yieldRequest, pollRangeOf, aggregateCandles,
  parseMarketCandles, yieldQuote, signedPoints } from './market-sources.mjs?v=20261116e';
import { MARKET_KEYS, MARKET_TIMEFRAMES, KLINE_LIMIT, MAX_BARS, MAX_WATCHLIST, normalizeSymbol, klinesUrlFor,
  endTimeBefore, parseKlines, mergeCandles, parseMiniTicker, miniTickerStreamUrl, restoreWatchlist, addToWatchlist,
  removeFromWatchlist, restoreTimeframes, shiftLogical, restoreSelection, defaultSymbolFor, watchItem, watchKey,
  sameWatchItem, withDefaultYields } from './market-data.mjs?v=20261116e';

const $ = id => document.getElementById(id);
const UP = '#16a082', DOWN = '#dd6070', SCALE_WIDTH = 72;
// Same light red as the finder's live price line (虚线, 轴标「实时」).
const LIVE_PRICE = '#f19aa4';
// Bars on screen when the page opens. Each chart keeps its own number of bars, which is what the bar-based range
// linking needs: 4h and 5m cannot share one clock window (a 4h window of 200 bars is 33 days, which 5m cannot cover
// inside the 5000-bar cap).
const VIEW_BARS = 180, RIGHT_PAD = 4;
// Left of this logical position the chart is close enough to its oldest bar to pull the page before it.
const EARLIER_TRIGGER = 50;
// The forming bar's indicator tail: kline pushes arrive several times a second, and redrawing every overlay line that
// often costs more than it shows (the same 500ms the finder uses).
const TAIL_MS = 500;
// Coming back to a hidden tab refetches the newest bars when it was away longer than this (the sockets may have been
// cut, and a missing bar breaks the overlay lines).
const HIDDEN_REFRESH_MS = 60000;
// A yield is not pushed anywhere, so the page asks Jesse for the newest bars this often (and only while visible).
const POLL_MS = 60000;

const fmtPrice = value => Number.isFinite(value)
  ? value.toLocaleString('en-US', { minimumFractionDigits: value >= 1 ? 2 : 0, maximumFractionDigits: value >= 1 ? 2 : 6 })
  : '—';
const signedPercent = change => Number.isFinite(change)
  ? `${change >= 0 ? '+' : '-'}${(Math.abs(change) * 100).toFixed(2)}%` : '';
// A yield is a percentage already: 4.02 → 4.021 (three decimals, like the Cboe / FRED series).
const fmtYield = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 16);
const candleOf = ({ time, open, high, low, close }) => ({ time, open, high, low, close });

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* still works for this page */ } };

const saved = restoreSelection(read(MARKET_KEYS.symbol));
// The dropdown is its own saved choice; when it disagrees with the saved chart, the dropdown wins and the chart falls
// back to that source's default instrument.
let source = restoreSource(read(MARKET_KEYS.source) ?? saved.source);
let symbol = source === saved.source ? saved.symbol : defaultSymbolFor(source);
let watchlist = restoreWatchlist(read(MARKET_KEYS.watchlist));
// The four yields of the owner's screenshot join the list once, and the flag makes deleting them stick.
if (!read(MARKET_KEYS.yieldSeed)) {
  watchlist = withDefaultYields(watchlist);
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  write(MARKET_KEYS.yieldSeed, '1');
}
let timeframes = restoreTimeframes(read(MARKET_KEYS.timeframes));
let panels = [], pointerPanel = null, rangeLink = null, syncing = false;
// Every rebuild (source / symbol / timeframe change) bumps this: answers and socket events of an older build are dropped.
let loadVersion = 0;
// Keyed by `watchKey` ({source, symbol}): the same pair can be a row on two venues.
let quotes = new Map(), livePrice = null, hiddenAt = 0;
let yieldFetchedAt = 0, pollTimer = null, pollBusy = false, pollError = false;
let stopKlineStream = null, stopPriceStream = null;
let klineUrl = null, priceUrl = null;
let klineState = '', priceState = '';
const quoteSockets = new Map();
const watchRows = new Map();

function status(message, error = false) {
  const box = $('status');
  box.hidden = !message;
  box.classList.toggle('error', error);
  box.textContent = message;
}

// One POST to Jesse, only used by the snapshot saver. The charts themselves need no login; saving a screenshot to
// the machine running `jesse run` does, and the token is read exactly like the finder does it.
async function post(path, body = {}) {
  const token = tokenOf();
  if (!token) throw new Error('保存截图需要先在同一地址的 Jesse 页面登录，再刷新此页。');
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(body), credentials: 'same-origin' });
  if (response.status === 401) throw new Error('登录已失效：请在同一地址的 Jesse 页面重新登录，再刷新此页。');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? data.detail ?? `Jesse 请求失败（HTTP ${response.status}）`);
  return data;
}

const tokenOf = () => {
  try { return JSON.parse(localStorage.getItem('main') ?? '{}').authToken ?? null; } catch { return null; }
};

// The US treasury yields: Jesse reads Yahoo / FRED and answers with candles, because neither source allows a
// cross-origin read. The route sits behind the review login, so without a token nothing can be drawn.
async function postMarket(body) {
  const token = tokenOf();
  if (!token) throw new Error('美债数据要先在同一地址的 Jesse 页面登录，再刷新此页（币安行情不需要登录）。');
  const response = await fetch('/review/market/candles', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify(body),
    credentials: 'same-origin' });
  if (response.status === 401) throw new Error('登录已失效：请在同一地址的 Jesse 页面重新登录，再刷新此页。');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? data.detail ?? `Jesse 请求失败（HTTP ${response.status}）`);
  return data;
}

function saveSelection() {
  write(MARKET_KEYS.symbol, JSON.stringify({ source, symbol }));
  write(MARKET_KEYS.source, source);
}

// ---- Clock ------------------------------------------------------------------
// The header shows both clocks, so a screenshot from another continent still says what 「现在」 was.
function paintClock() {
  const now = new Date();
  $('m-clock').textContent = `${now.toISOString().slice(11, 19)} UTC · 本地 ${now.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

// ---- Charts ----------------------------------------------------------------
function newChart(host) {
  return createChart(host, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#72819a', fontSize: 10 },
    grid: { vertLines: { color: '#f2f5fa' }, horzLines: { color: '#f2f5fa' } },
    rightPriceScale: { borderColor: '#edf0f5', minimumWidth: SCALE_WIDTH, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#edf0f5', minBarSpacing: 0.05 },
    localization: { locale: 'zh-CN', timeFormatter: time => `${new Date(time * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC` },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    // Normal (0) not the default Magnet: the vertical line still snaps to bars, the horizontal one follows the
    // mouse so any price level can be read off the scale.
    crosshair: { mode: 0 },
  });
}

const readPreferences = () => {
  try { return restorePreferences(localStorage.getItem(STORAGE_KEY)); } catch { return restorePreferences(null); }
};

// Main-chart indicators of the review page's display settings (MA 均线组 / SMA / EMA / BOLL), calculated over the
// whole loaded history like the finder does. Sub-chart indicators (成交量 / MACD) are not drawn: the finder draws no
// secondary panes either.
function drawOverlay(panel) {
  clearOverlay(panel);
  const preferences = readPreferences();
  for (const config of preferences.indicators) {
    if (INDICATORS[config.type].pane !== 'main') continue;
    const series = [];
    for (const line of calculateIndicator(panel.candles, config, panel.interval).series) {
      const created = panel.chart.addLineSeries({ color: line.color, lineWidth: 1.5, lineStyle: line.dashed ? 2 : 0,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      created.setData(line.data);
      panel.overlaySeries.push(created);
      series.push(created);
    }
    panel.overlayGroups.push({ config, series });
  }
}

function clearOverlay(panel) {
  for (const series of panel.overlaySeries ?? []) { try { panel.chart.removeSeries(series); } catch { /* chart rebuilt */ } }
  panel.overlaySeries = [];
  panel.overlayGroups = [];
}

// The last point of every overlaid line for `bar` — the forming bar while it moves, or the bar that just closed
// (formingTail appends its second argument to a copy of the closed bars, so the caller passes the bars before it).
function paintIndicatorTail(panel, bar) {
  const closed = panel.candles;
  const before = closed.at(-1)?.time === bar.time ? closed.slice(0, -1) : closed;
  for (const group of panel.overlayGroups) {
    let tail;
    try { tail = formingTail(before, bar, group.config, panel.interval); } catch { continue; }
    tail.forEach(({ point }, i) => {
      if (!point) return;
      try { group.series[i]?.update(point); } catch { /* chart rebuilt */ }
    });
  }
}

function scheduleTail(panel) {
  if (panel.tailTimer) return;
  panel.tailTimer = setTimeout(() => {
    panel.tailTimer = null;
    if (panel.forming) paintIndicatorTail(panel, panel.forming);
  }, TAIL_MS);
}

// Draws or moves the forming bar of one chart. `series.update()` alone: the library keeps a chart that shows its
// newest bar glued to the right edge, at the same candle width. Never set a visible range per tick — that clipped
// past the newest bar and widened the candles on every tick (T-51, see finder.mjs paintForming).
function paintForming(panel, candle) {
  if (!panel || !candle || panel.empty) return;
  const lastClosed = panel.candles.at(-1)?.time ?? -Infinity;
  if (!(candle.time > lastClosed)) return;
  const previous = panel.forming;
  if (previous && candle.time < previous.time) return;
  // The bar that just closed is closed data now: keep it even if the stream's own `closed` message never arrives.
  if (previous && candle.time > previous.time) appendClosed(panel, candleOf(previous));
  panel.forming = candle;
  try { panel.series.update(candleOf(candle)); } catch { return; /* chart rebuilt */ }
  scheduleTail(panel);
}

// The exchange finished a bar: it joins the closed candles (the charts' own data) and its indicator points are
// computed once, so the overlay lines reach it.
function appendClosed(panel, candle) {
  const lastClosed = panel.candles.at(-1)?.time ?? -Infinity;
  if (!(candle.time > lastClosed)) return;
  if (panel.forming && panel.forming.time === candle.time) {
    clearTimeout(panel.tailTimer); panel.tailTimer = null; panel.forming = null;
  }
  panel.candles.push(candle);
  panel.closes.set(candle.time, candle.close);
  panel.byTime.set(candle.time, candle);
  try { panel.series.update(candleOf(candle)); } catch { return; /* chart rebuilt */ }
  paintIndicatorTail(panel, candle);
  paintMeta(panel);
}

const visibleLogical = panel => {
  try {
    const range = panel.chart.timeScale().getVisibleLogicalRange();
    return range && Number.isFinite(range.from) && Number.isFinite(range.to) ? range : null;
  } catch { return null; }
};

// The newest bars fill the chart at first, right edge on the last candle (so the library keeps it glued there).
function showNewest(panel) {
  const count = panel.candles.length;
  if (!count) return;
  panel.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, count - VIEW_BARS), to: count + RIGHT_PAD });
}

function makePanel(tf, answer) {
  const interval = timeframeMinutes(tf);
  const card = document.createElement('article');
  card.className = 'chart-card'; card.dataset.interval = interval;
  card.innerHTML = '<div class="chart-head"><h3></h3></div><div class="chart-host"></div><div class="chart-meta"></div>';
  card.querySelector('h3').textContent = timeframeLabel(interval);
  $('charts').append(card);
  const host = card.querySelector('.chart-host');
  const panel = { tf, interval, card, host, empty: false, note: answer.note ?? '',
    candles: answer.closed, closes: new Map(answer.closed.map(candle => [candle.time, candle.close])),
    byTime: new Map(answer.closed.map(candle => [candle.time, candle])),
    overlaySeries: [], overlayGroups: [], forming: answer.forming, tailTimer: null,
    // The yields arrive in one answer at the upstream's maximum range: there is no earlier page to ask for.
    loadingEarlier: false, noMore: source === YIELD_SOURCE, sized: false };
  if (answer.hint || !answer.closed.length) {
    card.classList.add('empty');
    host.textContent = answer.hint || `${timeframeLabel(interval)} 周期没有拿到 K 线，稍后刷新试试。`;
    panel.empty = true;
    paintMeta(panel);
    return panel;
  }
  panel.chart = newChart(host);
  panel.series = panel.chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    borderVisible: false, lastValueVisible: false, priceLineVisible: false });
  panel.series.setData(panel.candles);
  enablePriceZoom(panel.chart, panel.series, host);
  drawOverlay(panel);
  if (panel.forming) { try { panel.series.update(candleOf(panel.forming)); } catch { /* chart not ready */ } paintIndicatorTail(panel, panel.forming); }
  paintMeta(panel);
  addSnapshotButton(card, () => snapshotPanel(panel));
  addMaximizeButton(card);
  // The pointer's x goes along, so the other charts line up at the moment under it (see linkTimeRanges).
  const pointerX = event => event.clientX - host.getBoundingClientRect().left;
  for (const name of ['pointerdown', 'wheel']) host.addEventListener(name, event => rangeLink?.activate(panel, pointerX(event)), { capture: true, passive: true });
  host.addEventListener('pointermove', event => {
    pointerPanel = panel;
    if (event.buttons) rangeLink?.pointer(panel, pointerX(event));
  }, { passive: true });
  host.addEventListener('pointerleave', () => {
    if (pointerPanel !== panel) return;
    pointerPanel = null;
    paintMeta(panel);
  });
  panel.chart.subscribeCrosshairMove(event => syncCrosshair(panel, typeof event.time === 'number' ? event.time : null,
    event.point ? panel.series.coordinateToPrice(event.point.y) : null));
  // Dragged to the left edge: pull the page of bars before the oldest one. `sized` guards the first, unsized layout,
  // which reports a range from bar 0 and would fetch history nobody asked for.
  panel.chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (!panel.sized || !range || range.from >= EARLIER_TRIGGER) return;
    loadEarlier(panel);
  });
  // A chart given its window before it had a size shows the wrong span: apply it once it is sized.
  const size = () => {
    if (panel.sized || !host.clientWidth) return;
    panel.sized = true;
    showNewest(panel);
  };
  size();
  if (!panel.sized) {
    panel.observer = new ResizeObserver(size);
    panel.observer.observe(host);
  }
  return panel;
}

function destroyPanels() {
  for (const panel of panels) {
    clearTimeout(panel.tailTimer);
    panel.observer?.disconnect();
    try { panel.chart?.remove(); } catch { /* already gone */ }
  }
  panels = []; pointerPanel = null; $('charts').replaceChildren();
}

// The candle under the pointer (or the newest one) in words, under the chart.
function paintMeta(panel, time = null) {
  const box = panel.card.querySelector('.chart-meta');
  const note = panel.note ? ` · ${panel.note}` : '';
  if (panel.empty || !panel.candles.length) { box.textContent = panel.note; return; }
  const candle = time === null ? null : panel.byTime.get(time) ?? (panel.forming?.time === time ? panel.forming : null);
  if (!candle) {
    const last = panel.forming ?? panel.candles.at(-1);
    box.textContent = `${panel.candles.length.toLocaleString()} 根 K 线 · 最新 ${stamp(last.time)} UTC · 收 ${fmtPrice(last.close)}`
      + (panel.forming ? '（形成中）' : '') + note;
    return;
  }
  const change = candle.open > 0 ? (candle.close - candle.open) / candle.open : null;
  box.textContent = `${stamp(candle.time)} UTC${panel.forming?.time === candle.time ? '（形成中）' : ''}`
    + ` · 开 ${fmtPrice(candle.open)} · 高 ${fmtPrice(candle.high)} · 低 ${fmtPrice(candle.low)} · 收 ${fmtPrice(candle.close)}`
    + (Number.isFinite(change) ? ` · ${signedPercent(change)}` : '') + note;
}

// `price` is the price under the pointer: every other chart puts its horizontal line at that same price, and falls
// back to its own bar's close when unknown. Only the chart under the mouse drives the others.
function syncCrosshair(source, time, price = null) {
  if (syncing || source.empty) return;
  if (pointerPanel && source !== pointerPanel) return;
  syncing = true;
  try {
    paintMeta(source, time);
    for (const panel of panels) {
      if (panel === source || panel.empty) continue;
      const step = panel.interval * 60;
      const t = time === null ? null : Math.floor(time / step) * step;
      const close = t === null ? undefined : panel.closes.get(t);
      const value = Number.isFinite(price) ? price : close;
      if (Number.isFinite(close) && Number.isFinite(value)) panel.chart.setCrosshairPosition(value, t, panel.series);
      else panel.chart.clearCrosshairPosition();
    }
  } finally { syncing = false; }
}

// ---- Snapshots -------------------------------------------------------------
function snapshotPanel(panel) {
  if (panel.empty || !panel.chart) return;
  const label = `market-${timeframeLabel(panel.interval)}`;
  const canvas = captureCard(panel.card, [panel.chart], { title: timeframeLabel(panel.interval),
    subtitle: `${symbol} · ${sourceLabel(source)} · ${utcStamp()} UTC` });
  openAnnotator(canvas, { onSave: screenshotSaver(post, label), fileLabel: label });
}

// ---- Data ------------------------------------------------------------------
// One page of candles of one source. Binance answers in one REST page (fapi for the perpetual, api/v3 for spot); the
// US treasury yields come from Jesse's proxy, which reads Yahoo / FRED and hands back the series the panel needs
// (3m is three 1m bars, 4h is four 1h bars, aggregated here so both pages agree on the buckets).
async function fetchCandles(sourceId, symbolName, tf, options = {}) {
  if (sourceId === YIELD_SOURCE) {
    const request = yieldRequest(symbolName, tf);
    const answer = await postMarket({ source: YIELD_SOURCE, symbol: symbolName, interval: request.interval,
      ...(options.range ? { range: options.range } : {}) });
    const parsed = parseMarketCandles(answer);
    const closed = request.aggregate > 1 ? aggregateCandles(parsed.closed, request.aggregate) : parsed.closed;
    return { closed, forming: null, note: parsed.note, dailyOnly: request.dailyOnly || parsed.dailyOnly };
  }
  const response = await fetch(klinesUrlFor(sourceId, symbolName, tf, options));
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`${sourceLabel(sourceId)}没有「${symbolName}」这个交易对。输入 btc、BTCUSDT 或 BTC-USDT 都可以。`);
    }
    if (response.status === 451 || response.status === 403) {
      throw new Error(`币安拒绝了这次请求（HTTP ${response.status}），这个网络所在地区可能被限制。`);
    }
    throw new Error(`币安 K 线请求失败（HTTP ${response.status}），稍后再试。`);
  }
  return { ...parseKlines(await response.json(), Date.now()), note: '' };
}

// A panel of a FRED-only yield has no small-timeframe series to draw: it says so instead of faking a flat chart.
// Everything else is capped at MAX_BARS like the Binance panels.
const panelAnswer = (tf, answer) => (answer.dailyOnly && tf !== '1D')
  ? { ...answer, closed: [], hint: `${symbol} 这个品种只有日线（FRED 官方数据），1D 图正常显示。` }
  : { ...answer, closed: answer.closed.length > MAX_BARS ? answer.closed.slice(-MAX_BARS) : answer.closed };

// Replaces a panel's candles without moving what the owner is looking at: the visible window is shifted by the
// number of bars that came in before the bar it started on (prepended history), so nothing jumps.
function setBars(panel, next) {
  if (panel.empty) return;
  const capped = next.length > MAX_BARS ? next.slice(next.length - MAX_BARS) : next;
  const logical = visibleLogical(panel);
  const first = panel.candles[0]?.time;
  panel.candles = capped;
  panel.closes = new Map(capped.map(candle => [candle.time, candle.close]));
  panel.byTime = new Map(capped.map(candle => [candle.time, candle]));
  panel.series.setData(panel.candles);
  drawOverlay(panel);
  const lastClosed = panel.candles.at(-1)?.time ?? -Infinity;
  if (panel.forming && panel.forming.time <= lastClosed) {
    clearTimeout(panel.tailTimer); panel.tailTimer = null; panel.forming = null;
  }
  if (panel.forming) {
    try { panel.series.update(candleOf(panel.forming)); } catch { /* chart rebuilt */ }
    paintIndicatorTail(panel, panel.forming);
  }
  paintMeta(panel);
  if (!logical || !Number.isFinite(first)) return;
  const index = panel.candles.findIndex(candle => candle.time === first);
  // -1: the old oldest bar fell off the front (the MAX_BARS cap), so every index moved left by the trimmed bars.
  const shift = index >= 0 ? index : -(next.length - capped.length);
  if (shift) panel.chart.timeScale().setVisibleLogicalRange(shiftLogical(logical, shift));
}

// One page of older bars for a chart dragged to its left edge. The limit keeps a timeframe at most MAX_BARS bars.
async function loadEarlier(panel) {
  if (panel.empty || panel.loadingEarlier || panel.noMore || panel.candles.length >= MAX_BARS) return;
  const version = loadVersion;
  panel.loadingEarlier = true;
  try {
    const limit = Math.min(KLINE_LIMIT, MAX_BARS - panel.candles.length);
    const { closed } = await fetchCandles(source, symbol, panel.tf, { limit, endTime: endTimeBefore(panel.candles[0].time) });
    if (version !== loadVersion || panel.empty) return;
    if (!closed.length) { panel.noMore = true; return; /* the contract's listing is the end of the history */ }
    const next = mergeCandles(panel.candles, closed);
    if (next.length === panel.candles.length) { panel.noMore = true; return; }
    setBars(panel, next);
  } catch {
    // A failed page just leaves the history as it was; the next drag towards the left tries again.
  } finally { panel.loadingEarlier = false; }
}

// The newest bars of one timeframe, merged into what is already loaded (by open time, newest wins). A poll asks the
// yields for the newest bars only, so a reload of the whole chart history is not needed.
async function refreshPanel(panel, version, { poll = false } = {}) {
  if (panel.empty) return;
  try {
    const query = poll ? { range: pollRangeOf(panel.tf) } : { limit: KLINE_LIMIT };
    const { closed, forming } = await fetchCandles(source, symbol, panel.tf, query);
    if (version !== loadVersion || !closed.length) return;
    setBars(panel, mergeCandles(panel.candles, closed));
    // The REST answer's forming bar is a snapshot of the same bar the stream is drawing: only replace ours with a
    // newer one, never move it backwards.
    if (forming && (!panel.forming || forming.time > panel.forming.time)) paintForming(panel, forming);
  } catch (error) {
    // A poll reports the failure (the header says so); the socket keeps pushing, so a failed catch-up is otherwise
    // just a page of bars that did not arrive.
    if (poll) throw error;
  }
}

async function refreshAll() {
  const version = loadVersion;
  await Promise.all(panels.map(panel => refreshPanel(panel, version)));
}

// ---- Building --------------------------------------------------------------
// Builds every checked timeframe from freshly fetched candles. Only a symbol / timeframe change (and the first
// draw) goes through here: live updates change the charts in place.
async function render() {
  const version = ++loadVersion;
  const ordered = [...timeframes].sort((a, b) => (timeframeMinutes(b) ?? 0) - (timeframeMinutes(a) ?? 0));
  status(`正在读取 ${symbol} 的 K 线…`);
  let answers;
  try { answers = await Promise.all(ordered.map(tf => fetchCandles(source, symbol, tf, { limit: KLINE_LIMIT }))); }
  catch (error) { if (version === loadVersion) status(error.message, true); return; }
  if (version !== loadVersion) return;
  destroyPanels();
  panels = ordered.map((tf, i) => makePanel(tf, panelAnswer(tf, answers[i])));
  rangeLink = linkTimeRanges(panels.filter(panel => !panel.empty));
  status('');
  // The sockets (or, for a yield, the poll's own line) own the light red line, so the stream state is settled first.
  syncStreams();
  if (source === YIELD_SOURCE) paintYieldPrice(); else paintLivePrice();
  if (panels[0]) paintMeta(panels[0]);
  paintLastPrice();
}

// Switches the whole page to another instrument. One cheap request first: a typo must be reported instead of wiping
// the charts that are on screen. Returns false when the instrument could not be read.
async function openSymbol(input) {
  const next = source === YIELD_SOURCE ? normalizeYieldSymbol(input) : normalizeSymbol(input);
  if (!next) {
    status(source === YIELD_SOURCE
      ? '请选一个美债品种：US03M / US02Y / US05Y / US10Y / US20Y / US30Y。'
      : '请输入币种，例如 btc、BTCUSDT、BTC-USDT。', true);
    return false;
  }
  const version = ++loadVersion;
  try {
    await fetchCandles(source, next, timeframes[0],
      source === YIELD_SOURCE ? { range: pollRangeOf(timeframes[0]) } : { limit: 5 });
  } catch (error) { if (version === loadVersion) status(error.message, true); return false; }
  if (version !== loadVersion) return false;
  if (next === symbol) { paintSymbolBox(); await render(); return true; }
  symbol = next;
  saveSelection();
  paintSymbolBox();
  livePrice = null;
  paintWatchlist(); paintLastPrice();
  await render();
  return true;
}

// ---- Sources ---------------------------------------------------------------
// The dropdown (or a watchlist row of another source) switches the whole page. It probes the new source first, like a
// typed symbol: the yields need a Jesse login, and a refused source must leave the charts that are on screen alone.
async function switchSource(next) {
  if (!MARKET_SOURCES.some(entry => entry.id === next) || next === source) return;
  // The first row of that source the owner kept, otherwise its default instrument.
  const nextSymbol = watchlist.find(item => item.source === next)?.symbol ?? defaultSymbolFor(next);
  const version = ++loadVersion;
  try {
    await fetchCandles(next, nextSymbol, timeframes[0],
      next === YIELD_SOURCE ? { range: pollRangeOf(timeframes[0]) } : { limit: 5 });
  } catch (error) {
    if (version === loadVersion) { status(error.message, true); paintSource(); }
    return;
  }
  if (version !== loadVersion) return;
  source = next;
  symbol = nextSymbol;
  livePrice = null; yieldFetchedAt = 0;
  saveSelection();
  paintSource(); paintWatchlist(); paintLastPrice();
  syncPolling();
  await render();
}

function paintSource() {
  const select = $('m-source');
  select.replaceChildren(...MARKET_SOURCES.map(entry => {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.label;
    return option;
  }));
  select.value = source;
  select.onchange = () => switchSource(select.value);
  paintSymbolBox();
}

// The symbol control follows the source: a text box for a Binance pair, the six whitelisted codes for the yields
// (the upstream has nothing else, so typing is pointless there).
function paintSymbolBox() {
  const select = $('m-yield'), input = $('m-symbol');
  const yields = source === YIELD_SOURCE;
  input.hidden = yields;
  $('m-yield-label').hidden = !yields;
  if (!yields) { input.value = symbol; return; }
  select.replaceChildren(...YIELD_INSTRUMENTS.map(({ symbol: code, name }) => {
    const option = document.createElement('option'); option.value = code; option.textContent = `${code}（${name}）`;
    return option;
  }));
  select.value = normalizeYieldSymbol(symbol) || DEFAULT_YIELD_SYMBOL;
  select.onchange = () => openSymbol(select.value);
}

// ---- Watchlist -------------------------------------------------------------
const rowLabel = item => (item.source === YIELD_SOURCE ? item.symbol : item.symbol.replace(/USDT$/, ''));

function paintWatchlist() {
  watchRows.clear();
  const box = $('watchlist');
  // Only a mixed list needs the venue tag: with one source the whole sidebar is that source.
  const mixed = new Set(watchlist.map(item => item.source)).size > 1;
  box.replaceChildren(...watchlist.map(item => {
    const row = document.createElement('div');
    row.className = 'watch-row';
    row.dataset.source = item.source;
    row.setAttribute('aria-pressed', String(item.source === source && item.symbol === symbol));
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'watch-main';
    button.setAttribute('aria-label', `看 ${item.symbol}（${sourceLabel(item.source)}）的行情`);
    const name = document.createElement('strong');
    name.textContent = rowLabel(item);
    if (mixed) {
      const tag = document.createElement('span');
      tag.className = 'watch-tag';
      // Short enough for the narrow sidebar: 永续 / 现货 / 美债.
      tag.textContent = item.source === YIELD_SOURCE ? '美债' : sourceLabel(item.source).replace('币安', '');
      name.append(tag);
    }
    const quote = document.createElement('span');
    quote.className = 'watch-quote';
    const price = document.createElement('span'); price.className = 'watch-last';
    const change = document.createElement('span'); change.className = 'watch-change';
    quote.append(price, change);
    button.append(name, quote);
    button.onclick = () => openWatch(item);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'watch-del'; remove.textContent = '×';
    remove.setAttribute('aria-label', `把 ${item.symbol}（${sourceLabel(item.source)}）从自选里删掉`);
    remove.onclick = event => { event.stopPropagation(); dropWatch(item); };
    row.append(button, remove);
    watchRows.set(watchKey(item), { row, price, change, item });
    return row;
  }));
  paintQuotes();
}

function paintQuotes() {
  for (const [key, parts] of watchRows) {
    const quote = quotes.get(key);
    const yields = parts.item.source === YIELD_SOURCE;
    parts.price.textContent = quote && Number.isFinite(quote.price)
      ? (yields ? fmtYield(quote.price) : fmtPrice(quote.price)) : '—';
    // A yield's change is in percentage points (+0.03), a pair's is a percentage of its open (+1.20%).
    parts.change.textContent = quote && Number.isFinite(quote.change)
      ? (yields ? signedPoints(quote.change) : signedPercent(quote.change)) : '';
    // 涨绿跌红, like every other page of the review extension.
    parts.change.className = `watch-change${quote?.change > 0 ? ' up' : quote?.change < 0 ? ' down' : ''}`;
  }
  paintLastPrice();
}

async function openWatch(item) {
  const previous = source;
  if (item.source !== previous) { source = item.source; livePrice = null; yieldFetchedAt = 0; paintSource(); }
  const opened = await openSymbol(item.symbol);
  if (!opened && source !== previous) { source = previous; paintSource(); }
  syncStreams(); syncPolling();
}

function addWatch() {
  const item = watchItem({ source, symbol });
  if (!item) return;
  if (watchlist.some(existing => sameWatchItem(existing, item))) return;
  if (watchlist.length >= MAX_WATCHLIST) { status(`自选最多 ${MAX_WATCHLIST} 个，先删掉一个再加。`, true); return; }
  watchlist = addToWatchlist(watchlist, item);
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  paintWatchlist();
  syncStreams(); syncPolling();
}

function dropWatch(item) {
  watchlist = removeFromWatchlist(watchlist, item);
  if (!watchlist.length) { watchlist = restoreWatchlist(null); status('自选不能全删光，已恢复默认列表。', true); }
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  const keys = new Set(watchlist.map(watchKey));
  quotes = new Map([...quotes].filter(([key]) => keys.has(key)));
  paintWatchlist();
  syncStreams(); syncPolling();
}

function paintLastPrice() {
  const quote = quotes.get(watchKey({ source, symbol }));
  const drawn = panels.filter(panel => !panel.empty).at(-1)?.candles.at(-1)?.close;
  const price = Number.isFinite(livePrice) ? livePrice : quote?.price ?? drawn;
  if (source === YIELD_SOURCE) {
    $('m-last').textContent = Number.isFinite(price)
      ? `${symbol} 最新 ${fmtYield(price)}${Number.isFinite(quote?.change) ? ` · 今天 ${signedPoints(quote.change)}` : ''}`
      : symbol;
    return;
  }
  $('m-last').textContent = Number.isFinite(price)
    ? `${symbol} 最新 ${fmtPrice(price)}${Number.isFinite(quote?.change) ? ` · 24h ${signedPercent(quote.change)}` : ''}`
    : symbol;
}

// ---- Live streams ----------------------------------------------------------
// The last traded price as a light red dashed line with an axis label on every chart (the finder's own line).
function paintLivePrice() {
  const title = source === YIELD_SOURCE ? '最新' : '实时';
  for (const panel of panels) {
    if (panel.empty || !panel.series) continue;
    if (livePrice === null) {
      if (panel.livePriceLine) { try { panel.series.removePriceLine(panel.livePriceLine); } catch { /* chart rebuilt */ } }
      panel.livePriceLine = null;
      continue;
    }
    const options = { price: livePrice, color: LIVE_PRICE, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title };
    if (panel.livePriceLine) panel.livePriceLine.applyOptions(options);
    else panel.livePriceLine = panel.series.createPriceLine(options);
  }
}

// A yield has no websocket: the line is the newest close the poll brought back, and the header says how old it is.
function paintYieldPrice() {
  const last = panels.filter(panel => !panel.empty).at(-1)?.candles.at(-1);
  // A daily-only instrument with no 1D panel on screen has no candle to read: the watchlist's own value is the newest
  // number there is, so the line and the stamp come from that instead.
  const quote = quotes.get(watchKey({ source, symbol }));
  livePrice = last ? last.close : quote?.price ?? null;
  yieldFetchedAt = last ? last.time : (quote?.time ?? 0);
  paintLivePrice();
  paintLastPrice();
  // The header's 「最新 …」 is this function's stamp, so it repaints the note with the numbers it just read.
  paintLiveNote();
}

const quotesReconnecting = () => [...quoteSockets.values()].some(socket => socket.state === 'reconnecting');

function paintLiveNote() {
  const note = $('m-live-note');
  if (source === YIELD_SOURCE) {
    // No websocket: the newest close the poll brought back, and how often that happens.
    const fresh = yieldFetchedAt ? `最新 ${stamp(yieldFetchedAt)} UTC` : '等待第一次轮询';
    note.hidden = false;
    note.textContent = `${fresh} · ${pollError ? '轮询失败，稍后重试' : '每 60 秒轮询 Jesse（美债没有实时推送）'}`;
    return;
  }
  const parts = [];
  if (priceState === 'reconnecting') parts.push('实时价格重连中');
  if (klineState === 'reconnecting') parts.push('形成中的 K 线重连中');
  if (quotesReconnecting()) parts.push('自选报价重连中');
  note.hidden = false;
  note.textContent = parts.length ? parts.join(' · ') : (livePrice === null ? '等待第一次推送' : '实时');
}

// One socket per job: the forming bar + the bar that just closed, the last traded price, and the watchlist's quotes.
function syncStreams() {
  // The yields are not pushed anywhere: every Binance socket is stopped and the poll keeps the charts fresh.
  const exchange = exchangeOf(source);
  const klines = exchange ? klineStreamUrl(exchange, symbol, timeframes) : null;
  if (klines !== klineUrl) {
    stopKlineStream?.(); stopKlineStream = null;
    klineUrl = klines; klineState = '';
    if (klines) stopKlineStream = openKlines(klines, { onKline, onState: onKlineState });
  }
  const price = exchange ? streamUrl(exchange, symbol) : null;
  if (price !== priceUrl) {
    stopPriceStream?.(); stopPriceStream = null;
    priceUrl = price; priceState = ''; livePrice = null;
    paintLivePrice(); paintLastPrice();
    if (price) {
      stopPriceStream = openTicker(price, {
        onPrice: next => { const first = livePrice === null; livePrice = next; paintLivePrice(); paintLastPrice(); if (first) paintLiveNote(); },
        onState: state => { priceState = state; paintLiveNote(); },
      });
    }
  }
  syncQuoteStreams();
  paintLiveNote();
}

// The watchlist's `@miniTicker` quotes, one socket per venue: the stream lives on both Binance markets, on two hosts,
// and a row belongs to the venue of its source. The yield rows have no stream and come from the poll instead.
function syncQuoteStreams() {
  const wanted = new Map();
  for (const item of [...watchlist, { source, symbol }]) {
    const exchange = exchangeOf(item.source);
    if (!exchange) continue;
    if (!wanted.has(exchange)) wanted.set(exchange, []);
    wanted.get(exchange).push(item.symbol);
  }
  const urls = new Map([...wanted].map(([exchange, symbols]) => [exchange, miniTickerStreamUrl(symbols, exchange)]));
  for (const [exchange, socket] of [...quoteSockets]) {
    if (urls.get(exchange) === socket.url) continue;
    socket.stop?.();
    quoteSockets.delete(exchange);
  }
  for (const [exchange, url] of urls) {
    if (!url || quoteSockets.has(exchange)) continue;
    const venue = exchange === exchangeOf(SPOT_SOURCE) ? SPOT_SOURCE : PERP_SOURCE;
    const socket = { url, state: '', stop: null };
    socket.stop = openMessages(url, {
      onMessage: message => onQuoteMessage(message, venue),
      onState: state => { socket.state = state; paintLiveNote(); },
    });
    quoteSockets.set(exchange, socket);
  }
  paintLiveNote();
}

function onKline(candle) {
  const panel = panels.find(item => !item.empty && item.tf === candle.tf);
  if (!panel) return;
  if (!candle.closed) { paintForming(panel, candle); return; }
  const lastClosed = panel.candles.at(-1)?.time ?? -Infinity;
  // A gap (a bar or more never arrived) is not worth patching by hand: refetch the page and merge it.
  if (candle.time > lastClosed + panel.interval * 60) { paintForming(panel, candle); refreshPanel(panel, loadVersion); return; }
  appendClosed(panel, candle);
}

function onKlineState(state) {
  const dropped = klineState === 'reconnecting';
  klineState = state;
  paintLiveNote();
  // A dropped socket means bars may have been missed, and a single missing bar breaks the overlay lines (that is how
  // the missing Bollinger band looked). Catch up once it is back.
  if (state === 'connected' && dropped) refreshAll();
}

function onQuoteMessage(message, venue) {
  const quote = parseMiniTicker(message);
  if (!quote) return;
  quotes.set(watchKey({ source: venue, symbol: quote.symbol }), quote);
  paintQuotes();
}

// ---- Polling (the yields) --------------------------------------------------
// Every 60 seconds ask Jesse for the newest bars of the panels on screen and for the value of every yield row in the
// watchlist. A hidden page does not poll (a background tab would keep asking for nothing) and coming back polls once.
const yieldRows = () => watchlist.filter(item => item.source === YIELD_SOURCE);

function syncPolling() {
  const wanted = source === YIELD_SOURCE || yieldRows().length > 0;
  if (wanted && !pollTimer) pollTimer = setInterval(pollYields, POLL_MS);
  if (!wanted && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (wanted) pollYields();
}

async function pollYields() {
  if (document.hidden || pollBusy) return;
  pollBusy = true;
  const version = loadVersion;
  try {
    await Promise.all([
      ...(source === YIELD_SOURCE
        ? panels.filter(panel => !panel.empty).map(panel => refreshPanel(panel, version, { poll: true })) : []),
      ...yieldRows().map(item => refreshYieldQuote(item.symbol)),
    ]);
    pollError = false;
  } catch { pollError = true; }
  finally {
    pollBusy = false;
    if (source === YIELD_SOURCE && version === loadVersion) paintYieldPrice();
    paintLiveNote();
  }
}

// The watchlist value of one yield row: the daily series is enough, a change is against yesterday's close. The
// failure goes to the poll, which reports it in the header instead of leaving a row that silently never updates.
async function refreshYieldQuote(symbolName) {
  const { closed } = await fetchCandles(YIELD_SOURCE, symbolName, '1D', { range: '1mo' });
  const quote = yieldQuote(closed);
  if (!quote) return;
  quotes.set(watchKey({ source: YIELD_SOURCE, symbol: symbolName }), quote);
  paintQuotes();
}

// ---- Controls --------------------------------------------------------------
function paintTimeframes() {
  const box = $('m-timeframes');
  box.replaceChildren(...MARKET_TIMEFRAMES.map(tf => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = tf; input.checked = timeframes.includes(tf);
    input.setAttribute('aria-label', `${tf} 周期`);
    input.onchange = () => {
      const checked = [...box.querySelectorAll('input:checked')].map(item => item.value);
      // At least one chart: unchecking the last one keeps it on and says why.
      if (!checked.length) { input.checked = true; status('至少要留一个周期。', true); return; }
      timeframes = checked;
      write(MARKET_KEYS.timeframes, JSON.stringify(timeframes));
      status('');
      render();
    };
    label.append(input, document.createTextNode(tf));
    return label;
  }));
}

const applyHeight = px => {
  document.documentElement.dataset.chartH = String(px);
  document.documentElement.style.setProperty('--chart-h', px ? `${px}px` : FIT_CHART_HEIGHT);
};

function paintHeight() {
  let px = DEFAULT_CHART_HEIGHT;
  try { px = chartHeightOf(localStorage.getItem(CHART_HEIGHT_KEY)); } catch { /* 适应屏幕 */ }
  const select = $('m-height');
  select.replaceChildren(...CHART_HEIGHTS.map(([height, label]) => {
    const option = document.createElement('option'); option.value = String(height); option.textContent = label; return option;
  }));
  select.value = String(px);
  applyHeight(px);
  select.onchange = () => {
    const height = Number(select.value);
    applyHeight(height);
    try { localStorage.setItem(CHART_HEIGHT_KEY, String(height)); } catch { /* this page only */ }
  };
}

function onVisibility() {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // The sockets keep the newest bars, but a background tab may have been cut or throttled long enough to leave a
  // hole: refetch the newest bars of every timeframe when it was away for over a minute. The yields are polled
  // anyway; coming back asks once immediately.
  if (away > HIDDEN_REFRESH_MS) {
    if (source === YIELD_SOURCE) pollYields();
    else refreshAll();
  }
}

function start() {
  paintClock();
  setInterval(paintClock, 1000);
  paintSource(); paintTimeframes(); paintHeight(); paintWatchlist();
  $('m-form').onsubmit = event => {
    event.preventDefault();
    openSymbol(source === YIELD_SOURCE ? $('m-yield').value : $('m-symbol').value);
  };
  $('m-add').onclick = () => {
    if (source === YIELD_SOURCE && !normalizeYieldSymbol(symbol)) {
      status('请先选一个美债品种。', true);
      return;
    }
    if (source !== YIELD_SOURCE && !normalizeSymbol(symbol)) {
      status('请输入币种，例如 btc、BTCUSDT、BTC-USDT。', true);
      return;
    }
    status('');
    addWatch();
  };
  document.addEventListener('visibilitychange', onVisibility);
  render();
  syncPolling();
}

start();
