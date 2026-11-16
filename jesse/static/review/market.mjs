// Market page: a clean multi-timeframe chart screen (「看行情」), with no signals, orders, labels or backtest
// content. Candles come straight from Binance's public USDT-M futures REST API in the browser — nothing is imported
// into Jesse's database and no Jesse endpoint is involved, so any USDT perpetual can be watched — and the exchange's
// public websockets keep them live: the forming bar, the last price, and the watchlist's 24h quotes.
// The chart behaviour (range linking, price zoom, snapshots) and the overlays (the review page's display settings)
// are reused from the review/finder modules instead of being reimplemented.
import { t as createChart } from './lightweight-charts.mjs?v=20261116d';
import { linkTimeRanges } from './data.mjs?v=20261116d';
import { enablePriceZoom } from './pricezoom.mjs?v=20261116d';
import { STORAGE_KEY, INDICATORS, timeframeLabel, timeframeMinutes, restorePreferences } from './settings.mjs?v=20261116d';
import { calculateIndicator, formingTail } from './indicators.mjs?v=20261116d';
import { klineStreamUrl, streamUrl, openTicker, openKlines, openMessages } from './live-price.mjs?v=20261116d';
import { addSnapshotButton, addMaximizeButton, captureCard, openAnnotator, screenshotSaver, utcStamp } from './snapshot.mjs?v=20261116d';
import { CHART_HEIGHT_KEY, CHART_HEIGHTS, DEFAULT_CHART_HEIGHT, FIT_CHART_HEIGHT, chartHeightOf } from './finder-data.mjs?v=20261116d';
import { MARKET_KEYS, MARKET_TIMEFRAMES, DEFAULT_SYMBOL, KLINE_LIMIT, MAX_BARS, MAX_WATCHLIST, normalizeSymbol,
  klinesUrl, endTimeBefore, parseKlines, mergeCandles, parseMiniTicker, miniTickerStreamUrl, restoreWatchlist,
  addToWatchlist, removeFromWatchlist, restoreTimeframes, shiftLogical } from './market-data.mjs?v=20261116d';

const $ = id => document.getElementById(id);
// The candles in the database come from Binance, so the live streams must be the same venue.
const EXCHANGE = 'Binance Perpetual Futures';
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

const fmtPrice = value => Number.isFinite(value)
  ? value.toLocaleString('en-US', { minimumFractionDigits: value >= 1 ? 2 : 0, maximumFractionDigits: value >= 1 ? 2 : 6 })
  : '—';
const signedPercent = change => Number.isFinite(change)
  ? `${change >= 0 ? '+' : '-'}${(Math.abs(change) * 100).toFixed(2)}%` : '';
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 16);
const candleOf = ({ time, open, high, low, close }) => ({ time, open, high, low, close });

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* still works for this page */ } };

let symbol = normalizeSymbol(read(MARKET_KEYS.symbol)) || DEFAULT_SYMBOL;
let watchlist = restoreWatchlist(read(MARKET_KEYS.watchlist));
let timeframes = restoreTimeframes(read(MARKET_KEYS.timeframes));
let panels = [], pointerPanel = null, rangeLink = null, syncing = false;
// Every rebuild (symbol / timeframe change) bumps this: answers and socket events of an older build are dropped.
let loadVersion = 0;
let quotes = new Map(), livePrice = null, hiddenAt = 0;
let stopKlineStream = null, stopPriceStream = null, stopQuoteStream = null;
let klineUrl = null, priceUrl = null, quotesUrl = null;
let klineState = '', priceState = '', quotesState = '';
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
  let token = null;
  try { token = JSON.parse(localStorage.getItem('main') ?? '{}').authToken; } catch { token = null; }
  if (!token) throw new Error('保存截图需要先在同一地址的 Jesse 页面登录，再刷新此页。');
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(body), credentials: 'same-origin' });
  if (response.status === 401) throw new Error('登录已失效：请在同一地址的 Jesse 页面重新登录，再刷新此页。');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? data.detail ?? `Jesse 请求失败（HTTP ${response.status}）`);
  return data;
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
  const panel = { tf, interval, card, host, empty: false,
    candles: answer.closed, closes: new Map(answer.closed.map(candle => [candle.time, candle.close])),
    byTime: new Map(answer.closed.map(candle => [candle.time, candle])),
    overlaySeries: [], overlayGroups: [], forming: answer.forming, tailTimer: null,
    loadingEarlier: false, noMore: false, sized: false };
  if (!answer.closed.length) {
    card.classList.add('empty');
    host.textContent = `${timeframeLabel(interval)} 周期没有拿到 K 线，稍后刷新试试。`;
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
  if (panel.empty || !panel.candles.length) { box.textContent = ''; return; }
  const candle = time === null ? null : panel.byTime.get(time) ?? (panel.forming?.time === time ? panel.forming : null);
  if (!candle) {
    const last = panel.forming ?? panel.candles.at(-1);
    box.textContent = `${panel.candles.length.toLocaleString()} 根 K 线 · 最新 ${stamp(last.time)} UTC · 收 ${fmtPrice(last.close)}`
      + (panel.forming ? '（形成中）' : '');
    return;
  }
  const change = candle.open > 0 ? (candle.close - candle.open) / candle.open : null;
  box.textContent = `${stamp(candle.time)} UTC${panel.forming?.time === candle.time ? '（形成中）' : ''}`
    + ` · 开 ${fmtPrice(candle.open)} · 高 ${fmtPrice(candle.high)} · 低 ${fmtPrice(candle.low)} · 收 ${fmtPrice(candle.close)}`
    + (Number.isFinite(change) ? ` · ${signedPercent(change)}` : '');
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
    subtitle: `${symbol} · ${utcStamp()} UTC` });
  openAnnotator(canvas, { onSave: screenshotSaver(post, label), fileLabel: label });
}

// ---- Data ------------------------------------------------------------------
// One klines page. Binance answers 400 for a symbol it does not list, which the caller turns into a readable hint.
async function fetchKlines(symbolName, tf, options = {}) {
  const response = await fetch(klinesUrl(symbolName, tf, options));
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`币安没有「${symbolName}」这个 USDT 永续合约。输入 btc、BTCUSDT 或 BTC-USDT 都可以。`);
    }
    if (response.status === 451 || response.status === 403) {
      throw new Error(`币安拒绝了这次请求（HTTP ${response.status}），这个网络所在地区可能被限制。`);
    }
    throw new Error(`币安 K 线请求失败（HTTP ${response.status}），稍后再试。`);
  }
  return parseKlines(await response.json(), Date.now());
}

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
    const { closed } = await fetchKlines(symbol, panel.tf, { limit, endTime: endTimeBefore(panel.candles[0].time) });
    if (version !== loadVersion || panel.empty) return;
    if (!closed.length) { panel.noMore = true; return; /* the contract's listing is the end of the history */ }
    const next = mergeCandles(panel.candles, closed);
    if (next.length === panel.candles.length) { panel.noMore = true; return; }
    setBars(panel, next);
  } catch {
    // A failed page just leaves the history as it was; the next drag towards the left tries again.
  } finally { panel.loadingEarlier = false; }
}

// The newest 1000 bars of one timeframe, merged into what is already loaded (by open time, newest wins).
async function refreshPanel(panel, version) {
  if (panel.empty) return;
  try {
    const { closed, forming } = await fetchKlines(symbol, panel.tf, { limit: KLINE_LIMIT });
    if (version !== loadVersion || !closed.length) return;
    setBars(panel, mergeCandles(panel.candles, closed));
    // The REST answer's forming bar is a snapshot of the same bar the stream is drawing: only replace ours with a
    // newer one, never move it backwards.
    if (forming && (!panel.forming || forming.time > panel.forming.time)) paintForming(panel, forming);
  } catch { /* the socket keeps pushing; a failed catch-up leaves the charts as they are */ }
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
  try { answers = await Promise.all(ordered.map(tf => fetchKlines(symbol, tf, { limit: KLINE_LIMIT }))); }
  catch (error) { if (version === loadVersion) status(error.message, true); return; }
  if (version !== loadVersion) return;
  destroyPanels();
  panels = ordered.map((tf, i) => makePanel(tf, answers[i]));
  rangeLink = linkTimeRanges(panels.filter(panel => !panel.empty));
  status('');
  paintLivePrice();
  if (panels[0]) paintMeta(panels[0]);
  paintLastPrice();
  syncStreams();
}

// Switches the whole page to another symbol. One cheap request first: a typo must be reported instead of wiping the
// charts that are on screen.
async function openSymbol(input) {
  const next = normalizeSymbol(input);
  if (!next) { status('请输入币种，例如 btc、BTCUSDT、BTC-USDT。', true); return; }
  const version = ++loadVersion;
  try { await fetchKlines(next, timeframes[0], { limit: 5 }); }
  catch (error) { if (version === loadVersion) status(error.message, true); return; }
  if (version !== loadVersion) return;
  if (next === symbol) { $('m-symbol').value = symbol; await render(); return; }
  symbol = next;
  write(MARKET_KEYS.symbol, symbol);
  $('m-symbol').value = symbol;
  livePrice = null;
  paintWatchlist(); paintLastPrice();
  await render();
}

// ---- Watchlist -------------------------------------------------------------
function paintWatchlist() {
  watchRows.clear();
  const box = $('watchlist');
  box.replaceChildren(...watchlist.map(item => {
    const row = document.createElement('div');
    row.className = 'watch-row';
    row.setAttribute('aria-pressed', String(item === symbol));
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'watch-main';
    button.setAttribute('aria-label', `看 ${item} 的行情`);
    const name = document.createElement('strong');
    name.textContent = item.replace(/USDT$/, '');
    const quote = document.createElement('span');
    quote.className = 'watch-quote';
    const price = document.createElement('span'); price.className = 'watch-last';
    const change = document.createElement('span'); change.className = 'watch-change';
    quote.append(price, change);
    button.append(name, quote);
    button.onclick = () => openSymbol(item);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'watch-del'; remove.textContent = '×';
    remove.setAttribute('aria-label', `把 ${item} 从自选里删掉`);
    remove.onclick = event => { event.stopPropagation(); dropWatch(item); };
    row.append(button, remove);
    watchRows.set(item, { row, price, change });
    return row;
  }));
  paintQuotes();
}

function paintQuotes() {
  for (const [item, parts] of watchRows) {
    const quote = quotes.get(item);
    parts.price.textContent = quote ? fmtPrice(quote.price) : '—';
    parts.change.textContent = quote && Number.isFinite(quote.change) ? signedPercent(quote.change) : '';
    // 涨绿跌红, like every other page of the review extension.
    parts.change.className = `watch-change${quote?.change > 0 ? ' up' : quote?.change < 0 ? ' down' : ''}`;
  }
  paintLastPrice();
}

function addWatch(input) {
  const pair = normalizeSymbol(input);
  if (!pair) return;
  if (watchlist.includes(pair)) return;
  if (watchlist.length >= MAX_WATCHLIST) { status(`自选最多 ${MAX_WATCHLIST} 个，先删掉一个再加。`, true); return; }
  watchlist = addToWatchlist(watchlist, pair);
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  paintWatchlist();
  syncStreams();
}

function dropWatch(item) {
  watchlist = removeFromWatchlist(watchlist, item);
  if (!watchlist.length) { watchlist = restoreWatchlist(null); status('自选不能全删光，已恢复默认列表。', true); }
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  quotes = new Map([...quotes].filter(([key]) => watchlist.includes(key)));
  paintWatchlist();
  syncStreams();
}

function paintLastPrice() {
  const quote = quotes.get(symbol);
  const price = Number.isFinite(livePrice) ? livePrice : quote?.price ?? panels[0]?.candles.at(-1)?.close;
  $('m-last').textContent = Number.isFinite(price)
    ? `${symbol} 最新 ${fmtPrice(price)}${Number.isFinite(quote?.change) ? ` · 24h ${signedPercent(quote.change)}` : ''}`
    : symbol;
}

// ---- Live streams ----------------------------------------------------------
// The last traded price as a light red dashed line with an axis label on every chart (the finder's own line).
function paintLivePrice() {
  for (const panel of panels) {
    if (panel.empty || !panel.series) continue;
    if (livePrice === null) {
      if (panel.livePriceLine) { try { panel.series.removePriceLine(panel.livePriceLine); } catch { /* chart rebuilt */ } }
      panel.livePriceLine = null;
      continue;
    }
    const options = { price: livePrice, color: LIVE_PRICE, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '实时' };
    if (panel.livePriceLine) panel.livePriceLine.applyOptions(options);
    else panel.livePriceLine = panel.series.createPriceLine(options);
  }
}

function paintLiveNote() {
  const note = $('m-live-note');
  const parts = [];
  if (priceState === 'reconnecting') parts.push('实时价格重连中');
  if (klineState === 'reconnecting') parts.push('形成中的 K 线重连中');
  if (quotesState === 'reconnecting') parts.push('自选报价重连中');
  note.hidden = false;
  note.textContent = parts.length ? parts.join(' · ') : (livePrice === null ? '等待第一次推送' : '实时');
}

// One socket per job: the forming bar + the bar that just closed, the last traded price, and the watchlist's quotes.
function syncStreams() {
  const klines = klineStreamUrl(EXCHANGE, symbol, timeframes);
  if (klines !== klineUrl) {
    stopKlineStream?.(); stopKlineStream = null;
    klineUrl = klines; klineState = '';
    if (klines) stopKlineStream = openKlines(klines, { onKline, onState: onKlineState });
  }
  const price = streamUrl(EXCHANGE, symbol);
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
  // The watchlist plus the symbol on screen, so the header always has a 24-hour change to show.
  const stream = miniTickerStreamUrl([...watchlist, symbol]);
  if (stream !== quotesUrl) {
    stopQuoteStream?.(); stopQuoteStream = null;
    quotesUrl = stream; quotesState = '';
    if (stream) stopQuoteStream = openMessages(stream, {
      onMessage: onQuoteMessage,
      onState: state => { quotesState = state; paintLiveNote(); },
    });
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

function onQuoteMessage(message) {
  const quote = parseMiniTicker(message);
  if (!quote) return;
  quotes.set(quote.symbol, quote);
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
  // hole: refetch the newest bars of every timeframe when it was away for over a minute.
  if (away > HIDDEN_REFRESH_MS) refreshAll();
}

function start() {
  $('m-symbol').value = symbol;
  paintClock();
  setInterval(paintClock, 1000);
  paintTimeframes(); paintHeight(); paintWatchlist();
  $('m-form').onsubmit = event => { event.preventDefault(); openSymbol($('m-symbol').value); };
  $('m-add').onclick = () => {
    const next = normalizeSymbol($('m-symbol').value);
    if (!next) { status('请输入币种，例如 btc、BTCUSDT、BTC-USDT。', true); return; }
    status('');
    addWatch(next);
  };
  document.addEventListener('visibilitychange', onVisibility);
  render();
}

start();
