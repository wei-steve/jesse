// Market page: a clean multi-timeframe chart screen (「看行情」), with no signals, orders, labels or backtest
// content. Four sources (T-54): Binance (contract / spot), OKX (contract / spot), Deepcoin (contract / spot) and the
// US treasury yields. Binance, OKX and CNBC (the yields, T-55) are CORS-open and read straight from the venue's public
// REST API in the browser — nothing is imported into Jesse's database — and the exchanges' public websockets keep them
// live: the forming bar, the last price, and the watchlist's quotes. Deepcoin sends no CORS headers, so its candles and
// tickers come from Jesse's own proxy (`POST /review/market/candles`, `/market/tickers`) and are polled. The treasury
// yields have no push at all: CNBC's one-minute series and its quote are polled every 15 seconds.
// The chart behaviour (range linking, price zoom, snapshots) and the overlays (the review page's display settings)
// are reused from the review/finder modules instead of being reimplemented.
import { t as createChart } from './lightweight-charts.mjs?v=20261116q';
import { linkTimeRanges } from './data.mjs?v=20261116q';
import { enablePriceZoom } from './pricezoom.mjs?v=20261116q';
import { STORAGE_KEY, INDICATORS, timeframeLabel, timeframeMinutes, restorePreferences } from './settings.mjs?v=20261116q';
import { calculateIndicator, formingTail } from './indicators.mjs?v=20261116q';
import { klineStreamUrl, streamUrl, openTicker, openKlines, openMessages, okxCandleChannels, openOkxKlines,
  openOkxTicker, openOkxTickers, openDeepcoinTicker } from './live-price.mjs?v=20261116q';
import { addSnapshotButton, addMaximizeButton, captureCard, openAnnotator, screenshotSaver, utcStamp } from './snapshot.mjs?v=20261116q';
import { CHART_HEIGHT_KEY, CHART_HEIGHTS, DEFAULT_CHART_HEIGHT, FIT_CHART_HEIGHT, chartHeightOf } from './finder-data.mjs?v=20261116q';
import { BINANCE_SOURCE, DEEPCOIN_SOURCE, MARKETS, MARKET_SOURCES, OKX_SOURCE, YIELD_SOURCE, YIELD_INSTRUMENTS,
  DEFAULT_YIELD_SYMBOL, YIELD_POLL_RANGE, aggregateCandles, candleRequest, cnbcSymbolOf, exchangeOf, instrumentName,
  isYieldSource, marketLabel, marketsOf, mergeYieldBars, mergeYieldDailyClose, normalizeMarket, normalizeYieldSymbol,
  parseCnbcBars, parseCnbcQuote, parseMarketCandles, restoreSource, sessionIndicator, sessionTail, signedPoints,
  sourceLabel, symbolOf, yieldRequest } from './market-sources.mjs?v=20261116q';
import { MARKET_KEYS, MARKET_TIMEFRAMES, MAX_BARS, MAX_WATCHLIST, PRODUCT_PAGE, PROXY_CANDLES,
  PROXY_TICKERS, aggregateAnswer, addToWatchlist, cnbcChartUrl, cnbcQuoteUrl, defaultSymbolFor, endTimeBefore,
  filterProducts, klinesUrlFor, mergeCandles, miniTickerStreamUrl, pageSizeOf, parseKlines, parseMiniTicker,
  parseOkxCandles, proxyTickerRows, removeFromWatchlist, moveWatchItem, orderTimeframes, restoreAsideTab,
  restoreListMarket, restoreSelection, restoreTimeframes, restoreWatchlist, sameWatchItem, shiftLogical,
  tickerRows, tickersUrlFor, watchItem, watchKey, withDefaultYields } from './market-data.mjs?v=20261116q';
// Candle notes (double-click a bar): the same box, key, 「注」 markers and stored file as the factor finder; the shared
// module is why a note written on one page shows up on the other.
import { barLabel, barsFor, createBarNoteBox, createBookPicker, barNoteBody, barNoteKey, barNoteOf, filterNoteRows,
  noteDigest, noteIdentity, noteMarkers, noteRowsFrom, noteSummary, noteTimeText, noteWhere, rememberNote, snapshotOf
  } from './bar-notes.mjs?v=20261116q';
// The open 备注本 (`storage/labels/<book>.jsonl`): the same notebook as the factor finder, kept in one localStorage key.
import { bookName, readBook, resolveBook, withBook, writeBook } from './labels.mjs?v=20261116q';

const $ = id => document.getElementById(id);
const UP = '#16a082', DOWN = '#dd6070', SCALE_WIDTH = 72;
// Same light red as the finder's live price line (虚线, 轴标「实时」).
const LIVE_PRICE = '#f19aa4';
// Bars on screen when the page opens. Each chart keeps its own number of bars, which is what the bar-based range
// linking needs: 4h and 5m cannot share one clock window (a 4h window of 200 bars is 33 days, which 5m cannot cover
// inside the 5000-bar cap).
const VIEW_BARS = 180, RIGHT_PAD = 4;
// How many bars each timeframe shows (the owner's own zoom), kept per browser so switching symbol or source rebuilds
// the charts at the same width instead of the default (2026-11-16). Keyed by timeframe: 4h and 5m zoom differently.
const VIEW_KEY = 'jesse.market.viewBars';
const MIN_VIEW_BARS = 10, MAX_VIEW_BARS = 5000;
let viewBars = {};
try { viewBars = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') ?? {}; } catch { viewBars = {}; }
const viewBarsOf = tf => {
  const bars = Number(viewBars?.[tf]);
  return Number.isFinite(bars) && bars >= MIN_VIEW_BARS && bars <= MAX_VIEW_BARS ? bars : VIEW_BARS + RIGHT_PAD;
};
let viewSaveTimer = null;
function rememberViewBars(tf, bars) {
  if (!Number.isFinite(bars) || bars < MIN_VIEW_BARS || bars > MAX_VIEW_BARS) return;
  viewBars = { ...viewBars, [tf]: Math.round(bars * 10) / 10 };
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewBars)); } catch { /* this tab only */ } }, 400);
}
// Left of this logical position the chart is close enough to its oldest bar to pull the page before it.
const EARLIER_TRIGGER = 50;
// The forming bar's indicator tail: kline pushes arrive several times a second, and redrawing every overlay line that
// often costs more than it shows (the same 500ms the finder uses).
const TAIL_MS = 500;
// Coming back to a hidden tab refetches the newest bars when it was away longer than this (the sockets may have been
// cut, and a missing bar breaks the overlay lines).
const HIDDEN_REFRESH_MS = 60000;
// A yield is not pushed anywhere: CNBC's one-minute series and its quote are read this often (only while visible).
const POLL_MS = 15000;
// Deepcoin pushes no multi-timeframe candles (its socket has a 1-minute K-line topic only), so the forming bar of every
// panel is fetched from the proxy every 3 seconds; the proxy caches each series for 2 seconds, which is what keeps
// four panels at one upstream request per series per 2 seconds.
const CRYPTO_POLL_MS = 3000;
// The product list and the Deepcoin watchlist quotes: one REST read of a venue's 24h tickers, every 10 seconds.
const TICKER_POLL_MS = 10000;

const fmtPrice = value => Number.isFinite(value)
  ? value.toLocaleString('en-US', { minimumFractionDigits: value >= 1 ? 2 : 0, maximumFractionDigits: value >= 1 ? 2 : 6 })
  : '—';
const signedPercent = change => Number.isFinite(change)
  ? `${change >= 0 ? '+' : '-'}${(Math.abs(change) * 100).toFixed(2)}%` : '';
// A yield is a percentage already: 4.02 → 4.021 (three decimals, the precision CNBC / Tradeweb quotes it with).
const fmtYield = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 16);
const candleOf = ({ time, open, high, low, close }) => ({ time, open, high, low, close });
const quoteOf = item => ({ source: item.source, market: item.market ?? null, symbol: item.symbol });

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* still works for this page */ } };

const saved = restoreSelection(read(MARKET_KEYS.symbol));
// The dropdown is its own saved choice; when it disagrees with the saved chart, the dropdown wins and the chart falls
// back to that source's default instrument (in the market the saved chart was on, when that source has it).
let source = restoreSource(read(MARKET_KEYS.source) ?? saved.source);
let market = normalizeMarket(source, source === saved.source ? saved.market : null);
let symbol = source === saved.source && (saved.market ?? null) === market ? saved.symbol : defaultSymbolFor(source, market);
let watchlist = restoreWatchlist(read(MARKET_KEYS.watchlist));
// The four yields of the owner's screenshot join the list once, and the flag makes deleting them stick.
if (!read(MARKET_KEYS.yieldSeed)) {
  watchlist = withDefaultYields(watchlist);
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  write(MARKET_KEYS.yieldSeed, '1');
}
let timeframes = restoreTimeframes(read(MARKET_KEYS.timeframes));
// 「自选 | <数据源>」: which of the two left column tabs is open, and the product list's 合约 / 现货 sub-tab.
let asideTab = restoreAsideTab(read(MARKET_KEYS.aside));
let listMarket = normalizeMarket(source, restoreListMarket(read(MARKET_KEYS.listMarket)) ?? market);
let panels = [], pointerPanel = null, rangeLink = null, syncing = false;
// Every rebuild (source / symbol / timeframe change) bumps this: answers and socket events of an older build are dropped.
let loadVersion = 0;
// Keyed by `watchKey` ({source, market, symbol}): the same pair on two venues or markets is two rows.
let quotes = new Map(), livePrice = null, hiddenAt = 0;
let pollTimer = null, pollBusy = false, pollError = false;
let cryptoPollTimer = null, cryptoPollBusy = false;
let tickerTimer = null, tickerBusy = false;
let stopKlineStream = null, stopPriceStream = null;
let klineKey = '', priceKey = '';
let klineState = '', priceState = '';
const quoteSockets = new Map();
const watchRows = new Map();
// The product list of the venue on screen: `[{symbol, last, change, quoteVolume}]`, biggest turnover first.
let productRows = [], productShown = PRODUCT_PAGE, productQuery = '', productError = '', productVenue = '';
// Candle notes: `bars` of POST /review/labels for the whole label file (every source and instrument; a key carries
// the exchange and the symbol), the box under the search field of the 备注 tab, the note a list row jumped to
// (kept so its marker stays amber across the next 3 / 15-second update), and why the last read failed (the tab says
// it instead of pretending there are no notes).
let allBars = {}, noteSearch = '', chosenNote = null, noteError = '';
// The open 备注本 (`storage/labels/<book>.jsonl`, the factor finder's book too), the server's list for its dropdown,
// and the picker control itself (built once in start()).
let book = readBook(localStorage), books = [], bookPicker = null;

function status(message, error = false) {
  const box = $('status');
  box.hidden = !message;
  box.classList.toggle('error', error);
  box.textContent = message;
}

const tokenOf = () => {
  try { return JSON.parse(localStorage.getItem('main') ?? '{}').authToken ?? null; } catch { return null; }
};

// One POST to Jesse, for the one thing the browser cannot read itself (Deepcoin: its API sends no CORS headers) and
// for saving a snapshot. The token is read exactly like the finder does it.
async function post(path, body = {}) {
  const token = tokenOf();
  if (!token) throw new Error('这个数据源要经 Jesse 代理，需要先在同一地址的 Jesse 页面登录，再刷新此页（币安、OKX、美债的图表不需要登录）。');
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(body), credentials: 'same-origin' });
  if (response.status === 401) throw new Error('登录已失效：请在同一地址的 Jesse 页面重新登录，再刷新此页。');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? data.detail ?? `Jesse 请求失败（HTTP ${response.status}）`);
  return data;
}

function saveSelection() {
  write(MARKET_KEYS.symbol, JSON.stringify({ source, market, symbol }));
  write(MARKET_KEYS.source, source);
}

// ---- Clock ------------------------------------------------------------------
// The header shows both clocks, so a screenshot from another continent still says what 「现在」 was.
function paintClock() {
  const now = new Date();
  $('m-clock').textContent = `${now.toISOString().slice(11, 19)} UTC · 本地 ${now.toLocaleTimeString('zh-CN', { hour12: false })} · 备注本 ${book}`;
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
    for (const line of (source === YIELD_SOURCE ? sessionIndicator : calculateIndicator)(panel.candles, config, panel.interval).series) {
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
    try { tail = (source === YIELD_SOURCE ? sessionTail : formingTail)(before, bar, group.config, panel.interval); } catch { continue; }
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
  const startedBar = previous?.time !== candle.time;
  panel.forming = candle;
  try { panel.series.update(candleOf(candle)); } catch { return; /* chart rebuilt */ }
  // A new forming bar can be a noted one (the 「注」 belongs to that candle's time): every tick would be too often.
  if (startedBar) paintMarkers(panel);
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
  const to = count + RIGHT_PAD;
  panel.chart.timeScale().setVisibleLogicalRange({ from: to - viewBarsOf(panel.tf), to });
}

function makePanel(tf, answer) {
  const interval = timeframeMinutes(tf);
  const card = document.createElement('article');
  card.className = 'chart-card'; card.dataset.interval = interval;
  card.innerHTML = '<div class="chart-head"><h3></h3></div><div class="chart-host"></div><div class="chart-meta"></div>';
  card.querySelector('h3').textContent = timeframeLabel(interval);
  // The double-click box at the top of this card (a note on one candle of this timeframe), hidden until used.
  // bar-notes.mjs owns it, so the finder's box and this one behave exactly alike.
  const noteBox = createBarNoteBox({ submit: () => submitBarNote(panel), close: () => closeBarNote(panel) });
  card.insertBefore(noteBox.row, card.querySelector('.chart-host'));
  $('charts').append(card);
  const host = card.querySelector('.chart-host');
  const panel = { tf, interval, card, host, noteBox, noteTime: null, empty: false, note: answer.note ?? '',
    candles: answer.closed, closes: new Map(answer.closed.map(candle => [candle.time, candle.close])),
    byTime: new Map(answer.closed.map(candle => [candle.time, candle])),
    overlaySeries: [], overlayGroups: [], forming: answer.forming, tailTimer: null,
    // A yield panel keeps the series it is built from (CNBC's own bars) so the poll can rebuild its newest bars.
    request: source === YIELD_SOURCE ? yieldRequest(tf) : null, raw: answer.raw ?? null,
    // CNBC hands back one range per panel: there is no earlier page to ask for.
    loadingEarlier: false, noMore: source === YIELD_SOURCE, sized: false };
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
  paintMarkers(panel);
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
  // Double-clicking a candle opens this card's note box. A click on the scales, past the last candle, or on a bar that
  // is not there (a gap in a session market) has no candle and opens nothing; a single click is left alone.
  panel.chart.subscribeDblClick(param => {
    const time = barTimeAt(panel, param);
    if (time !== null) openBarNote(panel, time);
  });
  // Dragged to the left edge: pull the page of bars before the oldest one. `sized` guards the first, unsized layout,
  // which reports a range from bar 0 and would fetch history nobody asked for.
  panel.chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (!panel.sized || !range) return;
    // The window's width in bars is the zoom to keep for this timeframe (scrolling alone leaves it unchanged).
    rememberViewBars(panel.tf, range.to - range.from);
    if (range.from >= EARLIER_TRIGGER) return;
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

// The line under a chart: the text, plus the note of the candle under the pointer in the finder's purple, so a 「注」
// can be read in full without opening the box.
function paintMetaText(box, text, barNote = '') {
  box.replaceChildren(document.createTextNode(text));
  if (!barNote) return;
  const span = document.createElement('span');
  span.className = 'bar-note-text';
  span.textContent = ` · 注：${barNote}`;
  box.append(span);
}

// The candle under the pointer (or the newest one) in words, under the chart.
function paintMeta(panel, time = null) {
  const box = panel.card.querySelector('.chart-meta');
  const note = panel.note ? ` · ${panel.note}` : '';
  if (panel.empty || !panel.candles.length) { box.textContent = panel.note; return; }
  const candle = time === null ? null : panel.byTime.get(time) ?? (panel.forming?.time === time ? panel.forming : null);
  const barNote = time === null ? '' : barNoteOf(panelNotes(), noteKeyAt(panel, time));
  if (!candle) {
    const last = panel.forming ?? panel.candles.at(-1);
    paintMetaText(box, `${panel.candles.length.toLocaleString()} 根 K 线 · 最新 ${stamp(last.time)} UTC · 收 ${fmtPrice(last.close)}`
      + (panel.forming ? '（形成中）' : '') + note, barNote);
    return;
  }
  const change = candle.open > 0 ? (candle.close - candle.open) / candle.open : null;
  paintMetaText(box, `${stamp(candle.time)} UTC${panel.forming?.time === candle.time ? '（形成中）' : ''}`
    + ` · 开 ${fmtPrice(candle.open)} · 高 ${fmtPrice(candle.high)} · 低 ${fmtPrice(candle.low)} · 收 ${fmtPrice(candle.close)}`
    + (Number.isFinite(change) ? ` · ${signedPercent(change)}` : '') + note, barNote);
}

// `price` is the price under the pointer: every other chart puts its horizontal line at that same price, and falls
// back to its own bar's close when unknown. Only the chart under the mouse drives the others.
function syncCrosshair(from, time, price = null) {
  if (syncing || from.empty) return;
  if (pointerPanel && from !== pointerPanel) return;
  syncing = true;
  try {
    paintMeta(from, time);
    for (const panel of panels) {
      if (panel === from || panel.empty) continue;
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
const marketSuffix = () => (market ? ` ${marketLabel(market)}` : '');

function snapshotPanel(panel) {
  if (panel.empty || !panel.chart) return;
  const label = `market-${timeframeLabel(panel.interval)}`;
  const canvas = captureCard(panel.card, [panel.chart], { title: timeframeLabel(panel.interval),
    subtitle: `${symbol} · ${sourceLabel(source)}${marketSuffix()} · ${utcStamp()} UTC` });
  openAnnotator(canvas, { onSave: screenshotSaver(post, label), fileLabel: label });
}

// ---- Data ------------------------------------------------------------------
/**
 * What a yield chart says under it about the series it draws: CNBC's feed is Tradeweb's, its intraday history starts
 * with the `1D` / `5D` range that panel is built from, and the daily panel is three years of `6M` bars.
 */
function yieldNote(tf) {
  const { range, base } = yieldRequest(tf);
  if (base >= 1440) return '来源 CNBC（Tradeweb），日线，约 3 年';
  return `来源 CNBC（Tradeweb），${base} 分钟级，约 ${range === '1D' ? '1 天' : '10 天'}盘中历史`;
}

/**
 * A yield panel's bars from its source series: `aggregate` is the bucket width in minutes (aggregateCandles counts
 * minutes). The last bucket is always the one still forming — the poll keeps moving it, and the indicator tail that
 * follows it — instead of a half-built bar being drawn as closed.
 */
function yieldBarsOf(raw, aggregate) {
  const bars = aggregate > 1 ? aggregateCandles(raw, aggregate) : [...raw];
  return bars.length > 1 ? { closed: bars.slice(0, -1), forming: bars.at(-1) } : { closed: bars, forming: null };
}

/**
 * One CNBC chart series (`1D` one-minute, `5D` five-minute, `6M` daily), read by the browser: CNBC sends CORS headers,
 * so neither Jesse nor a login token is involved.
 */
async function fetchYieldSeries(symbolName, range) {
  const code = cnbcSymbolOf(symbolName);
  if (!code) throw new Error(`${symbolName} 不是 CNBC 有的美债品种。`);
  const response = await fetch(cnbcChartUrl(code, range));
  if (!response.ok) throw new Error(`CNBC 美债行情请求失败（HTTP ${response.status}），稍后再试。`);
  const bars = parseCnbcBars(await response.json());
  if (!bars.length) throw new Error(`CNBC 没有返回 ${symbolName} 的美债行情，稍后再试。`);
  return bars;
}

/**
 * One page of candles of one source. Binance answers in one REST page (fapi for the perpetual, api/v3 for spot), OKX
 * in its own envelope; Deepcoin comes from Jesse's proxy, which reads the venue and hands back the series the panel
 * needs (a bucketed panel asks for 1m and is aggregated here, so both pages agree on buckets). The treasury yields are
 * one CNBC chart range, kept whole as `raw` so the 15-second poll can rebuild the panel's newest bars from it.
 */
async function fetchCandles(sourceId, marketId, symbolName, tf, options = {}) {
  if (sourceId === YIELD_SOURCE) {
    const request = yieldRequest(tf);
    const raw = await fetchYieldSeries(symbolName, options.range ?? request.range);
    return { raw, ...yieldBarsOf(raw, request.aggregate), note: yieldNote(tf) };
  }
  const request = candleRequest(sourceId, tf);
  const limit = Math.max(1, Math.trunc((options.limit ?? pageSizeOf(sourceId)) * request.aggregate));
  if (sourceId === DEEPCOIN_SOURCE) {
    const answer = await post(PROXY_CANDLES, { source: DEEPCOIN_SOURCE, market: marketId, symbol: symbolName,
      interval: request.interval, limit: Math.min(limit, 1000),
      ...(Number.isFinite(options.before) ? { before: Math.trunc(options.before) } : {}) });
    const parsed = parseMarketCandles(answer);
    const bucketed = request.aggregate > 1 ? aggregateAnswer(parsed.closed, parsed.forming, request.aggregate)
      : { closed: parsed.closed, forming: parsed.forming };
    return { closed: bucketed.closed, forming: bucketed.forming, note: parsed.note };
  }
  const response = await fetch(klinesUrlFor(sourceId, marketId, symbolName, tf, { ...options, limit }));
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`${sourceLabel(sourceId)}没有「${symbolName}」这个交易对。输入 btc、BTC-USDT 或 BTC-USDT-SWAP 都可以。`);
    }
    if (response.status === 451 || response.status === 403) {
      throw new Error(`${sourceLabel(sourceId)}拒绝了这次请求（HTTP ${response.status}），这个网络所在地区可能被限制。`);
    }
    throw new Error(`${sourceLabel(sourceId)} K 线请求失败（HTTP ${response.status}），稍后再试。`);
  }
  const payload = await response.json();
  if (sourceId === OKX_SOURCE) return { ...parseOkxCandles(payload), note: '' };
  return { ...parseKlines(payload, Date.now()), note: '' };
}

// Everything is capped at MAX_BARS like the exchange panels.
const panelAnswer = answer => ({ ...answer,
  closed: answer.closed.length > MAX_BARS ? answer.closed.slice(-MAX_BARS) : answer.closed });

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
  // After the forming bar is back on the data set: a note can sit on that bar, and a marker needs its candle.
  paintMarkers(panel);
  paintMeta(panel);
  if (!logical || !Number.isFinite(first)) return;
  const index = panel.candles.findIndex(candle => candle.time === first);
  // -1: the old oldest bar fell off the front (the MAX_BARS cap), so every index moved left by the trimmed bars.
  const shift = index >= 0 ? index : -(next.length - capped.length);
  if (shift) panel.chart.timeScale().setVisibleLogicalRange(shiftLogical(logical, shift));
}

/**
 * A yield panel redrawn from its source series after a poll: the buckets are rebuilt (the last one is still forming),
 * the visible window stays where it is, and the indicator lines reach the new last bar.
 */
function applyYieldBars(panel) {
  if (panel.empty || !panel.raw) return;
  if (panel.raw.length > MAX_BARS) panel.raw = panel.raw.slice(-MAX_BARS);
  const { closed, forming } = yieldBarsOf(panel.raw, panel.request.aggregate);
  // setBars drops the forming bar the chart was drawing (it replaces the whole data set), so it is re-created below.
  clearTimeout(panel.tailTimer); panel.tailTimer = null; panel.forming = null;
  setBars(panel, closed);
  if (forming) paintForming(panel, forming);
}

// One page of older bars for a chart dragged to its left edge. The limit keeps a timeframe at most MAX_BARS bars.
async function loadEarlier(panel) {
  if (panel.empty || panel.loadingEarlier || panel.noMore || panel.candles.length >= MAX_BARS) return;
  const version = loadVersion;
  panel.loadingEarlier = true;
  try {
    const limit = Math.min(pageSizeOf(source), MAX_BARS - panel.candles.length);
    const oldest = panel.candles[0].time;
    // Binance pages by `endTime` (ms, inclusive, hence the one millisecond); the proxied and OKX sources page by the
    // open time of the oldest bar already loaded.
    const query = source === BINANCE_SOURCE ? { limit, endTime: endTimeBefore(oldest) } : { limit, before: oldest };
    const { closed } = await fetchCandles(source, market, symbol, panel.tf, query);
    if (version !== loadVersion || panel.empty) return;
    if (!closed.length) { panel.noMore = true; return; /* the contract's listing is the end of the history */ }
    const next = mergeCandles(panel.candles, closed);
    if (next.length === panel.candles.length) { panel.noMore = true; return; }
    setBars(panel, next);
  } catch {
    // A failed page just leaves the history as it was; the next drag towards the left tries again.
  } finally { panel.loadingEarlier = false; }
}

// The newest bars of one timeframe, merged into what is already loaded (by open time, newest wins).
async function refreshPanel(panel, version) {
  if (panel.empty) return;
  try {
    const { closed, forming } = await fetchCandles(source, market, symbol, panel.tf, { limit: pageSizeOf(source) });
    if (version !== loadVersion || !closed.length) return;
    setBars(panel, mergeCandles(panel.candles, closed));
    // The REST answer's forming bar is a snapshot of the same bar the stream is drawing: only replace ours with a
    // newer one, never move it backwards.
    if (forming && (!panel.forming || forming.time > panel.forming.time)) paintForming(panel, forming);
  } catch {
    // A failed catch-up just leaves the history as it was; the socket keeps pushing, and the next reconnect or the
    // next drag towards the left asks again.
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
  try { answers = await Promise.all(ordered.map(tf => fetchCandles(source, market, symbol, tf, { limit: pageSizeOf(source) }))); }
  catch (error) { if (version === loadVersion) status(error.message, true); return; }
  if (version !== loadVersion) return;
  destroyPanels();
  panels = ordered.map((tf, i) => makePanel(tf, panelAnswer(answers[i])));
  rangeLink = linkTimeRanges(panels.filter(panel => !panel.empty));
  status('');
  // The sockets (or, for a proxied source, the poll's own line) own the light red line, so the stream state is
  // settled first.
  syncStreams();
  if (source === YIELD_SOURCE) paintYieldPrice(); else paintLivePrice();
  if (panels[0]) paintMeta(panels[0]);
  paintLastPrice();
}

/**
 * Switches the whole page to another instrument (source + market + symbol). One cheap request first: a typo must be
 * reported instead of wiping the charts that are on screen. Returns false when the instrument could not be read.
 */
async function openSelection(nextSource, nextMarket, input) {
  const wantedMarket = normalizeMarket(nextSource, nextMarket);
  const next = symbolOf(nextSource, wantedMarket, input);
  if (!next) {
    status(isYieldSource(nextSource)
      ? '请选一个美债品种：US03M / US02Y / US05Y / US10Y / US20Y / US30Y。'
      : (nextSource === BINANCE_SOURCE ? '请输入币种，例如 btc、BTCUSDT、BTC-USDT。'
        : '请输入币种，例如 btc、BTC-USDT、BTC-USDT-SWAP。'), true);
    return false;
  }
  const same = nextSource === source && wantedMarket === market && next === symbol;
  const version = ++loadVersion;
  try {
    // A yield is probed with the small `1D` range (a few hundred one-minute bars) instead of the panel's whole series.
    await fetchCandles(nextSource, wantedMarket, next, timeframes[0],
      isYieldSource(nextSource) ? { range: YIELD_POLL_RANGE } : { limit: 5 });
  } catch (error) {
    if (version === loadVersion) { status(error.message, true); paintSource(); }
    return false;
  }
  if (version !== loadVersion) return false;
  // The highlighted note of a 备注 row belonged to the instrument that was on screen.
  chosenNote = null;
  if (same) { paintSource(); await render(); return true; }
  source = nextSource; market = wantedMarket; symbol = next;
  // The product list's sub-tab stays on the market it showed, unless this source has no such market.
  listMarket = normalizeMarket(source, listMarket);
  saveSelection();
  livePrice = null;
  paintSource(); paintAside(); paintWatchlist(); paintLastPrice();
  syncStreams(); syncPolling();
  if (asideTab === 'products') loadProducts();
  await render();
  // The notes are the whole label file; read again so a note written elsewhere (the finder, a restart) is drawn.
  loadNotes();
  return true;
}

/** The dropdown: same source, or that source's first kept instrument / default, in the market it already shows. */
async function switchSource(next) {
  if (!MARKET_SOURCES.some(entry => entry.id === next) || next === source) { paintSource(); return; }
  const nextMarket = normalizeMarket(next, market);
  const kept = watchlist.find(item => item.source === next && (item.market ?? null) === nextMarket);
  const nextSymbol = kept?.symbol ?? defaultSymbolFor(next, nextMarket);
  await openSelection(next, nextMarket, nextSymbol);
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

// The symbol control follows the source: a text box for an exchange (with that venue's own spelling), the six
// whitelisted codes for the yields (the upstream has nothing else, so typing is pointless there).
function paintSymbolBox() {
  const select = $('m-yield'), input = $('m-symbol');
  const yields = source === YIELD_SOURCE;
  input.hidden = yields;
  $('m-yield-label').hidden = !yields;
  if (!yields) {
    input.value = symbol;
    input.placeholder = source === BINANCE_SOURCE ? 'btc / BTCUSDT / BTC-USDT' : 'btc / BTC-USDT / BTC-USDT-SWAP';
    return;
  }
  select.replaceChildren(...YIELD_INSTRUMENTS.map(({ symbol: code, name }) => {
    const option = document.createElement('option'); option.value = code; option.textContent = `${code}（${name}）`;
    return option;
  }));
  select.value = normalizeYieldSymbol(symbol) || DEFAULT_YIELD_SYMBOL;
  select.onchange = () => openSelection(source, market, select.value);
}

// ---- Left column: 「自选 | <数据源>」 ----------------------------------------
const rowLabel = item => instrumentName(item.source, item.symbol);
const itemTag = item => [sourceLabel(item.source), item.market ? marketLabel(item.market) : ''].filter(Boolean).join(' ');

function paintAside() {
  for (const button of document.querySelectorAll('.aside-tab')) {
    const tab = button.dataset.tab;
    button.setAttribute('aria-pressed', String(tab === asideTab));
    if (tab === 'products') button.textContent = sourceLabel(source);
  }
  $('watchlist').hidden = asideTab !== 'watch';
  $('products').hidden = asideTab !== 'products';
  $('notes').hidden = asideTab !== 'notes';
  if (asideTab === 'products') paintProducts();
  if (asideTab === 'notes') paintNoteList();
}

function setAsideTab(tab) {
  asideTab = tab === 'products' ? 'products' : tab === 'notes' ? 'notes' : 'watch';
  write(MARKET_KEYS.aside, asideTab);
  paintAside();
  syncTickerPolling();
  if (asideTab === 'products') loadProducts();
  // The list is read from the file again when its tab is opened: a note may have been written on the finder since.
  if (asideTab === 'notes') loadNotes();
}

// ---- Watchlist -------------------------------------------------------------
function paintWatchlist() {
  watchRows.clear();
  const box = $('watchlist');
  // Only a mixed list needs the venue tag: with one source and one market the whole sidebar is that one.
  const mixed = new Set(watchlist.map(item => `${item.source}|${item.market ?? ''}`)).size > 1;
  box.replaceChildren(...watchlist.map(item => {
    const row = document.createElement('div');
    row.className = 'watch-row';
    row.dataset.source = item.source;
    row.setAttribute('aria-pressed', String(item.source === source && item.symbol === symbol
      && (item.market ?? null) === (market ?? null)));
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'watch-main';
    button.setAttribute('aria-label', `看 ${item.symbol}（${itemTag(item)}）的行情`);
    const name = document.createElement('strong');
    name.textContent = rowLabel(item);
    const tag = document.createElement('span');
    tag.className = 'watch-tag';
    tag.textContent = mixed ? itemTag(item) : (item.market ? marketLabel(item.market) : '美债');
    name.append(tag);
    const quote = document.createElement('span');
    quote.className = 'watch-quote';
    const price = document.createElement('span'); price.className = 'watch-last';
    const change = document.createElement('span'); change.className = 'watch-change';
    quote.append(price, change);
    button.append(name, quote);
    button.onclick = () => openSelection(item.source, item.market, item.symbol);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'watch-del'; remove.textContent = '×';
    remove.setAttribute('aria-label', `把 ${item.symbol}（${itemTag(item)}）从自选里删掉`);
    remove.onclick = event => { event.stopPropagation(); dropWatch(item); };
    const handle = document.createElement('span');
    handle.className = 'watch-drag'; handle.textContent = '⠿';
    handle.title = '按住上下拖动，调整自选顺序';
    handle.onpointerdown = event => startWatchDrag(event, row);
    row.append(handle, button, remove);
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

const inWatchlist = item => watchlist.some(existing => sameWatchItem(existing, item));

/** 「加入自选」 of the toolbar: the chart's instrument. */
function addWatch() {
  const item = watchItem({ source, market, symbol });
  if (item) addWatchItem(item);
}

// Custom order of the watchlist: press the ⠿ handle and drag the row up or down. Pointer events (not HTML drag and
// drop) so it also works with a finger on a phone or tablet. The rows move live while dragging; the new order is
// saved when the pointer is released.
function startWatchDrag(event, row) {
  event.preventDefault();
  const box = $('watchlist');
  const from = [...box.children].indexOf(row);
  if (from < 0) return;
  const horizontal = getComputedStyle(box).flexDirection === 'row'; // the phone layout lays the rows out side by side
  row.classList.add('dragging');
  try { event.target.setPointerCapture(event.pointerId); } catch { /* still follows window events */ }
  const move = moving => {
    for (const other of box.children) {
      if (other === row) continue;
      const rect = other.getBoundingClientRect();
      const inside = horizontal ? moving.clientX >= rect.left && moving.clientX <= rect.right
        : moving.clientY >= rect.top && moving.clientY <= rect.bottom;
      if (!inside) continue;
      const before = horizontal ? moving.clientX < rect.left + rect.width / 2 : moving.clientY < rect.top + rect.height / 2;
      box.insertBefore(row, before ? other : other.nextSibling);
      break;
    }
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    row.classList.remove('dragging');
    const to = [...box.children].indexOf(row);
    if (to === from) return;
    watchlist = moveWatchItem(watchlist, from, to);
    write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
    paintWatchlist();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function dropWatch(item) {
  watchlist = removeFromWatchlist(watchlist, item);
  if (!watchlist.length) { watchlist = restoreWatchlist(null); status('自选不能全删光，已恢复默认列表。', true); }
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  const keys = new Set(watchlist.map(watchKey));
  quotes = new Map([...quotes].filter(([key]) => keys.has(key)));
  paintWatchlist(); paintProducts();
  syncStreams();
}

/** The ☆ / ★ of a product row: one click adds the row to the watchlist, the next removes it. */
function toggleStar(item) {
  if (inWatchlist(item)) dropWatch(item); else addWatchItem(item);
}

/** One row into the watchlist (the toolbar button and a product row's ☆ share this). */
function addWatchItem(item) {
  if (inWatchlist(item)) return;
  if (watchlist.length >= MAX_WATCHLIST) { status(`自选最多 ${MAX_WATCHLIST} 个，先删掉一个再加。`, true); return; }
  watchlist = addToWatchlist(watchlist, item);
  write(MARKET_KEYS.watchlist, JSON.stringify(watchlist));
  paintWatchlist(); paintProducts();
  syncStreams();
}

// ---- Product list ----------------------------------------------------------
/** The rows the second tab lists: the venue's tickers, or the six yields when the source is the treasury. */
function productList() {
  if (source === YIELD_SOURCE) {
    return YIELD_INSTRUMENTS.map(({ symbol: code, name }) => {
      const quote = quotes.get(watchKey({ source: YIELD_SOURCE, market: null, symbol: code }));
      return { symbol: code, name, last: quote?.price, change: quote?.change };
    });
  }
  return productRows;
}

function paintProducts() {
  // 合约 / 现货 is a sub-tab of the list, and the yields have none.
  const subTabs = $('product-markets');
  const markets = marketsOf(source);
  subTabs.hidden = markets.length === 0;
  subTabs.replaceChildren(...MARKETS.filter(entry => markets.includes(entry.id)).map(entry => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'product-market';
    button.textContent = entry.label;
    button.setAttribute('aria-pressed', String(entry.id === listMarket));
    button.onclick = () => {
      if (listMarket === entry.id) return;
      listMarket = entry.id;
      write(MARKET_KEYS.listMarket, listMarket);
      productShown = PRODUCT_PAGE;
      paintProducts();
      loadProducts();
    };
    return button;
  }));
  const search = $('product-search');
  if (search.value !== productQuery) search.value = productQuery;
  search.placeholder = isYieldSource(source) ? '搜索，如 10y' : '搜索，如 sol';

  const rows = filterProducts(productList(), productQuery);
  const shown = rows.slice(0, productShown);
  const box = $('product-list');
  box.replaceChildren(...shown.map(row => productRow(row)));
  const more = $('product-more');
  more.hidden = rows.length <= shown.length;
  more.textContent = `显示更多（还有 ${(rows.length - shown.length).toLocaleString()} 个）`;
  const count = $('product-count');
  count.textContent = rows.length
    ? `${filterProducts(productList(), productQuery).length.toLocaleString()} 个 USDT 产品`
      + (productError ? ' · 报价刷新失败，稍后重试' : '')
    : (productError ? '报价刷新失败，稍后重试' : (isYieldSource(source) ? '' : '正在读取产品列表…'));
}

function productRow(row) {
  const item = watchItem({ source, market: isYieldSource(source) ? null : listMarket, symbol: row.symbol });
  const element = document.createElement('div');
  element.className = 'watch-row product-row';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'watch-main';
  button.setAttribute('aria-label', `看 ${row.symbol} 的行情`);
  const name = document.createElement('strong');
  name.textContent = row.name ?? instrumentName(source, row.symbol);
  const quote = document.createElement('span');
  quote.className = 'watch-quote';
  const price = document.createElement('span'); price.className = 'watch-last';
  const change = document.createElement('span'); change.className = 'watch-change';
  const yields = isYieldSource(source);
  price.textContent = Number.isFinite(row.last) ? (yields ? fmtYield(row.last) : fmtPrice(row.last)) : '—';
  change.textContent = Number.isFinite(row.change) ? (yields ? signedPoints(row.change) : signedPercent(row.change)) : '';
  change.className = `watch-change${row.change > 0 ? ' up' : row.change < 0 ? ' down' : ''}`;
  quote.append(price, change);
  button.append(name, quote);
  button.onclick = () => openSelection(source, isYieldSource(source) ? null : listMarket, row.symbol);
  const star = document.createElement('button');
  const starred = !!item && inWatchlist(item);
  star.type = 'button';
  star.className = `product-star${starred ? ' on' : ''}`;
  star.textContent = starred ? '★' : '☆';
  star.setAttribute('aria-pressed', String(starred));
  star.setAttribute('aria-label', starred ? `把 ${row.symbol} 从自选里删掉` : `把 ${row.symbol} 加入自选`);
  star.onclick = event => { event.stopPropagation(); if (item) toggleStar(item); };
  element.append(button, star);
  return element;
}

/** The rows the product list needs to be able to draw: which venue, which market. */
const productRequest = () => ({
  source,
  market: isYieldSource(source) ? null : listMarket,
  key: `${source}|${isYieldSource(source) ? '' : listMarket}`,
});

async function loadProducts() {
  if (asideTab !== 'products' || document.hidden) return;
  const request = productRequest();
  if (request.source === YIELD_SOURCE) {
    // The six yield rows are already in the watchlist quotes: one CNBC quote request refreshes all of them.
    paintProducts();
    try { await refreshYieldQuotes(); productError = ''; } catch (error) { productError = error.message; }
    paintProducts();
    return;
  }
  // Another venue or market than the rows on screen: they are not this list any more, so nothing is shown until the
  // answer lands (a stale Binance list under an OKX heading would be worse than an empty one for a second).
  if (request.key !== productVenue) { productRows = []; productVenue = request.key; productError = ''; }
  try {
    const rows = await fetchProducts(request.source, request.market);
    if (request.key !== productRequest().key) return; // the tab moved to another venue meanwhile
    productRows = rows;
    productError = '';
  } catch (error) {
    productError = error.message;
  }
  paintProducts();
}

/** One venue's product list: the direct REST read for Binance / OKX, Jesse's proxy for Deepcoin. */
async function fetchProducts(sourceId, marketId) {
  if (sourceId === DEEPCOIN_SOURCE) {
    return proxyTickerRows(await post(PROXY_TICKERS, { source: DEEPCOIN_SOURCE, market: marketId }));
  }
  const response = await fetch(tickersUrlFor(sourceId, marketId));
  if (!response.ok) throw new Error(`${sourceLabel(sourceId)} 产品列表请求失败（HTTP ${response.status}），稍后再试。`);
  return tickerRows(sourceId, marketId, await response.json());
}

// ---- Prices and streams ----------------------------------------------------
function paintLastPrice() {
  const quote = quotes.get(watchKey({ source, market, symbol }));
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

// The last traded price as a light red dashed line with an axis label on every chart (the finder's own line).
function paintLivePrice() {
  const title = '实时';
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

// A yield has no websocket: the line is the newest value the poll brought back — the last bar of a chart on screen,
// or the quote when there is none.
function paintYieldPrice() {
  const newest = panels.filter(panel => !panel.empty)
    .map(panel => panel.forming ?? panel.candles.at(-1))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time).at(-1);
  const quote = quotes.get(watchKey({ source, market, symbol }));
  livePrice = newest ? newest.close : (Number.isFinite(quote?.price) ? quote.price : null);
  paintLivePrice();
  paintLastPrice();
  // The header's note carries the numbers just read, so it is repainted here.
  paintLiveNote();
}

const quotesReconnecting = () => [...quoteSockets.values()].some(socket => socket.state === 'reconnecting');

function paintLiveNote() {
  const note = $('m-live-note');
  if (source === YIELD_SOURCE) {
    // No websocket at all: CNBC's one-minute series is read on a timer.
    note.hidden = false;
    note.textContent = pollError ? '美债 · CNBC 轮询失败，稍后重试' : '美债 · CNBC 每 15 秒更新';
    return;
  }
  const parts = [];
  if (priceState === 'reconnecting') parts.push('实时价格重连中');
  if (klineState === 'reconnecting') parts.push('形成中的 K 线重连中');
  if (quotesReconnecting()) parts.push('自选报价重连中');
  note.hidden = false;
  if (parts.length) { note.textContent = parts.join(' · '); return; }
  if (source === DEEPCOIN_SOURCE) {
    // The venue sends no CORS header: the candles come from Jesse every 3 seconds, and only the swap market's price
    // also has a public push (its spot endpoint has no ticker cluster).
    const how = market === 'spot' ? '每 3 秒经 Jesse 轮询' : '价格走 Deepcoin 推送、K 线每 3 秒经 Jesse 轮询';
    note.textContent = livePrice === null ? '等待第一次轮询' : `实时 · ${how}`;
    return;
  }
  note.textContent = livePrice === null ? '等待第一次推送' : '实时';
}

/** The kline socket of the current source: a descriptor with a key (so a redundant resubscribe is skipped) and an
 *  `open` that returns its stop(). Binance and OKX only; Deepcoin and the yields have no candle stream. */
function klineStreamFor() {
  if (source === BINANCE_SOURCE) {
    const url = klineStreamUrl(exchangeOf(source, market), symbol, timeframes);
    return url ? { key: url, open: callbacks => openKlines(url, callbacks) } : null;
  }
  if (source === OKX_SOURCE) {
    const channels = okxCandleChannels(timeframes);
    if (!channels.length) return null;
    return { key: `${symbol}|${market}|${channels.join(',')}`,
      open: callbacks => openOkxKlines(symbol, timeframes, callbacks) };
  }
  return null;
}

/** The last-price socket: Binance's aggTrade, OKX's tickers channel, Deepcoin's swap ticker topic. */
function priceStreamFor() {
  if (source === BINANCE_SOURCE) {
    const url = streamUrl(exchangeOf(source, market), symbol);
    return url ? { key: url, open: callbacks => openTicker(url, callbacks) } : null;
  }
  if (source === OKX_SOURCE) return { key: `okx|${symbol}`, open: callbacks => openOkxTicker(symbol, callbacks) };
  if (source === DEEPCOIN_SOURCE && market !== 'spot') {
    // The spot endpoint has no ticker cluster, so a spot chart's price comes from the 3-second candle poll instead.
    return { key: `deepcoin|${symbol}`, open: callbacks => openDeepcoinTicker(market, symbol, callbacks) };
  }
  return null;
}

// One socket per job: the forming bar + the bar that just closed, the last traded price, and the watchlist's quotes.
function syncStreams() {
  const kline = klineStreamFor();
  if ((kline?.key ?? '') !== klineKey) {
    stopKlineStream?.(); stopKlineStream = null;
    klineKey = kline?.key ?? ''; klineState = '';
    if (kline) stopKlineStream = kline.open({ onKline, onState: onKlineState });
  }
  const price = priceStreamFor();
  if ((price?.key ?? '') !== priceKey) {
    stopPriceStream?.(); stopPriceStream = null;
    priceKey = price?.key ?? ''; priceState = ''; livePrice = null;
    paintLivePrice(); paintLastPrice();
    if (price) {
      stopPriceStream = price.open({
        onPrice: next => { const first = livePrice === null; livePrice = next; paintLivePrice(); paintLastPrice(); if (first) paintLiveNote(); },
        onState: state => { priceState = state; paintLiveNote(); },
      });
    }
  }
  syncQuoteStreams();
  syncCryptoPoll();
  syncTickerPolling();
  paintLiveNote();
}

/**
 * The watchlist's quotes. Binance pushes them on one `@miniTicker` combined stream per venue, OKX on one socket that
 * carries every watched instrument. Deepcoin has no CORS and its spot socket has no ticker cluster, so those rows
 * come from the 10-second REST read of the venue's ticker list (see pollTickers). The yield rows come from the poll.
 */
function syncQuoteStreams() {
  const specs = quoteSocketSpecs();
  for (const [name, socket] of [...quoteSockets]) {
    if (specs.get(name)?.key === socket.key) continue;
    socket.stop?.();
    quoteSockets.delete(name);
  }
  for (const [name, spec] of specs) {
    if (quoteSockets.has(name)) continue;
    const socket = { key: spec.key, state: '', stop: null };
    socket.stop = spec.open({
      onQuote: quote => {
        quotes.set(watchKey({ source: quote.source, market: quote.market, symbol: quote.symbol }),
          { symbol: quote.symbol, price: quote.price, change: quote.change });
        paintQuotes();
      },
      onState: state => { socket.state = state; paintLiveNote(); },
    });
    quoteSockets.set(name, socket);
  }
  paintLiveNote();
}

function quoteSocketSpecs() {
  const specs = new Map();
  const binance = new Map(), okx = new Map();
  const add = item => {
    if (item.source === BINANCE_SOURCE) {
      const exchange = exchangeOf(item.source, item.market);
      if (!exchange) return;
      if (!binance.has(exchange)) binance.set(exchange, { market: item.market ?? 'swap', symbols: [] });
      binance.get(exchange).symbols.push(item.symbol);
    } else if (item.source === OKX_SOURCE) {
      okx.set(item.symbol, item.market ?? 'swap');
    }
  };
  for (const item of watchlist) add(item);
  add({ source, market, symbol });

  for (const [exchange, { market: venueMarket, symbols }] of binance) {
    const url = miniTickerStreamUrl(symbols, exchange);
    if (!url) continue;
    specs.set(`binance|${exchange}`, { key: url, open: ({ onQuote, onState }) => openMessages(url, { onState,
      onMessage: message => {
        const quote = parseMiniTicker(message);
        if (quote) onQuote({ ...quote, source: BINANCE_SOURCE, market: venueMarket });
      } }) });
  }
  if (okx.size) {
    const instIds = [...okx.keys()];
    specs.set('okx', { key: `${instIds.join(',')}`, open: ({ onQuote, onState }) => openOkxTickers(instIds, { onState,
      onQuote: quote => onQuote({ source: OKX_SOURCE, market: okx.get(quote.symbol) ?? 'swap', symbol: quote.symbol,
        price: quote.price, change: quote.change }) }) });
  }
  return specs;
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

// ---- Polling ---------------------------------------------------------------
// Deepcoin: every 3 seconds ask the proxy for the newest two bars of every panel and hand them to the same routines a
// socket would call, so the forming bar keeps moving and a bar that closed lands in the history. `forming` and
// `closed` are both display-only here (the panel's own candles are updated by appendClosed / paintForming).
function syncCryptoPoll() {
  const wanted = source === DEEPCOIN_SOURCE;
  if (wanted && !cryptoPollTimer) cryptoPollTimer = setInterval(pollDeepcoin, CRYPTO_POLL_MS);
  if (!wanted && cryptoPollTimer) { clearInterval(cryptoPollTimer); cryptoPollTimer = null; }
}

async function pollDeepcoin() {
  if (document.hidden || cryptoPollBusy || source !== DEEPCOIN_SOURCE) return;
  cryptoPollBusy = true;
  const version = loadVersion;
  try {
    for (const panel of panels.filter(item => !item.empty)) {
      if (version !== loadVersion) break;
      const { closed, forming } = await fetchCandles(source, market, symbol, panel.tf, { limit: 2 });
      const newest = closed.at(-1);
      const lastClosed = panel.candles.at(-1)?.time ?? -Infinity;
      if (newest && newest.time > lastClosed) {
        // One or two bars arrived. More than one bar of gap means a whole bar was missed (the tab was busy or the
        // poll failed): the page of bars is refetched and merged instead of a hole being left in the overlay lines.
        if (newest.time > lastClosed + panel.interval * 60) refreshPanel(panel, version);
        else appendClosed(panel, candleOf(newest));
      }
      if (forming) paintForming(panel, forming);
      // No ticker socket for this market (spot): the newest close is the price line.
      if (!priceKey && (forming || newest)) {
        livePrice = (forming ?? newest).close;
        paintLivePrice(); paintLastPrice();
      }
    }
  } catch { /* the next tick tries again; the header keeps the last state */ }
  finally { cryptoPollBusy = false; }
}

// The product list and the Deepcoin watchlist quotes share one 10-second ticker read: every 10 seconds while the
// list is open (the venue's REST list, not a socket per product), and for the Deepcoin rows of the watchlist.
function syncTickerPolling() {
  const wanted = (asideTab === 'products' && source !== YIELD_SOURCE) || deepcoinRows().length > 0;
  if (wanted && !tickerTimer) tickerTimer = setInterval(pollTickers, TICKER_POLL_MS);
  if (!wanted && tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
}

const deepcoinRows = () => watchlist.filter(item => item.source === DEEPCOIN_SOURCE);

async function pollTickers() {
  if (document.hidden || tickerBusy) return;
  tickerBusy = true;
  try {
    if (asideTab === 'products' && source !== YIELD_SOURCE) await loadProducts();
    await refreshDeepcoinQuotes();
  } catch { /* the next tick tries again; the list keeps what it has */ }
  finally { tickerBusy = false; paintProducts(); }
}

/** Deepcoin quotes of the rows that have no socket: one ticker read per market present in the watchlist. */
async function refreshDeepcoinQuotes() {
  const markets = new Set(deepcoinRows().map(item => item.market ?? 'swap'));
  if (asideTab === 'products' && source === DEEPCOIN_SOURCE && listMarket) markets.add(listMarket);
  for (const venueMarket of markets) {
    let rows;
    try { rows = await fetchProducts(DEEPCOIN_SOURCE, venueMarket); } catch { continue; }
    const bySymbol = new Map(rows.map(row => [row.symbol, row]));
    for (const item of deepcoinRows()) {
      if ((item.market ?? 'swap') !== venueMarket) continue;
      const row = bySymbol.get(item.symbol);
      if (!row) continue;
      quotes.set(watchKey(item), { symbol: item.symbol, price: row.last, change: row.change });
    }
    if (venueMarket === listMarket && source === DEEPCOIN_SOURCE && asideTab === 'products') {
      productRows = rows;
      productVenue = `${source}|${listMarket}`;
    }
  }
  paintQuotes();
}

// Every 15 seconds read the yields from CNBC: the current session's one-minute bars for the panels on screen, and one
// quote request for every yield row in the watchlist (and the six products, while that list is open). A hidden page
// does not poll and coming back polls once.
const yieldRows = () => watchlist.filter(item => item.source === YIELD_SOURCE);
const yieldSymbolsToQuote = () => {
  const symbols = new Set(yieldRows().map(item => item.symbol));
  if (asideTab === 'products' && source === YIELD_SOURCE) for (const code of YIELD_INSTRUMENTS) symbols.add(code.symbol);
  return [...symbols];
};

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
    await Promise.all([pollYieldPanels(version), refreshYieldQuotes()]);
    pollError = false;
  } catch { pollError = true; }
  finally {
    pollBusy = false;
    if (source === YIELD_SOURCE && version === loadVersion) paintYieldPrice();
    paintLiveNote();
  }
}

/**
 * One `1D` read (the session's one-minute bars) merged into every panel on screen: an intraday panel re-buckets the
 * newest bars from it (the last one stays forming), and the daily panel takes the newest minute as today's close.
 */
async function pollYieldPanels(version) {
  if (source !== YIELD_SOURCE || !panels.length) return;
  const minutes = await fetchYieldSeries(symbol, YIELD_POLL_RANGE);
  if (version !== loadVersion) return;
  for (const panel of panels) {
    if (panel.empty || !panel.request || !panel.raw) continue;
    panel.raw = panel.request.base >= 1440
      ? mergeYieldDailyClose(panel.raw, minutes.at(-1))
      : mergeYieldBars(panel.raw, panel.request.base, minutes);
    applyYieldBars(panel);
  }
}

/**
 * The value and today's change of every yield on screen, in one CNBC quote request. The rows the list is showing are
 * repainted with it, and the failure goes to the poll, which reports it in the header instead of leaving a row that
 * silently never updates.
 */
async function refreshYieldQuotes() {
  const url = cnbcQuoteUrl(yieldSymbolsToQuote().map(cnbcSymbolOf).filter(Boolean));
  if (!url) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CNBC 美债报价请求失败（HTTP ${response.status}），稍后再试。`);
  for (const quote of parseCnbcQuote(await response.json())) {
    quotes.set(watchKey({ source: YIELD_SOURCE, market: null, symbol: quote.symbol }),
      { symbol: quote.symbol, price: quote.price, change: quote.change });
  }
  paintQuotes();
  if (asideTab === 'products' && source === YIELD_SOURCE) paintProducts();
}

// ---- Candle notes ----------------------------------------------------------
// The finder's candle notes on the market page too (2026-11-16): double-click any candle of any chart, write one line,
// and it is stored as a `kind=bar` row of the same project file as the signal marks (POST /review/label). The key
// names the exchange and the symbol the finder's way (`Binance Perpetual Futures` + `BTC-USDT`), so one candle is one
// note on both pages; bar-notes.mjs owns the key, the box, the 「注」 markers and the snapshot a note carries.

const noteId = () => noteIdentity(source, market, symbol);
const panelNotes = () => barsFor(allBars, noteId());
const noteKeyAt = (panel, time) => barNoteKey(noteId(), panel.tf, time);
// The forming bar is a candle too: it can be noted, its snapshot taken mid-bar.
const hasBar = (panel, time) => !!panel && (panel.closes.has(time) || panel.forming?.time === time);

// The purple 「注」 squares of one chart (only its own timeframe, only candles that are drawn), the jumped-to one amber.
function paintMarkers(panel) {
  if (!panel?.series) return;
  const chosen = chosenNote && chosenNote.tf === panel.tf ? chosenNote.time : null;
  panel.series.setMarkers(noteMarkers(panelNotes(), panel.tf, time => hasBar(panel, time), chosen));
}

// Without a Jesse login the note calls cannot run at all (unlike the Binance / OKX / CNBC charts), so a failure says
// what to do instead of the proxy's own wording.
const noteErrorText = error => (tokenOf() ? error.message
  : '备注存在 Jesse 的项目文件里：先在同一地址的 Jesse 页面登录，再刷新此页。');

// Every candle note of the label file: the charts draw their own instrument's, the 备注 tab lists them all.
async function loadNotes() {
  try {
    const data = await post('/review/labels', withBook({}, book));
    allBars = data.bars ?? {};
    noteError = '';
  } catch (error) {
    noteError = noteErrorText(error);
    if (asideTab === 'notes') paintNoteList();
    return; /* the charts keep the notes they have; the next read tries again */
  }
  for (const panel of panels) paintMarkers(panel);
  if (asideTab === 'notes') paintNoteList();
}

// ---- Label books -----------------------------------------------------------
// The notes live in `storage/labels/<book>.jsonl`; the picker at the top of the 备注 tab switches which notebook this
// page reads and writes (2026-11-16, the user: "我有不同的备注文件，怎么切换可以继续工作？"). The factor finder keeps its
// book in the same localStorage key, so the two pages always work in one notebook; a book the server no longer has
// falls back to the default with a line saying so.
function buildBookPicker() {
  bookPicker = createBookPicker({ change: name => switchBook(name), create: name => createBook(name) });
  $('note-book').append(bookPicker.row);
}

// The server's list (name, rows, last written) and the book this page may use. A failed list leaves `books` empty and
// does NOT touch `noteError`: the notes themselves are a separate request, and a page that cannot list books still has
// its notes (the picker then shows the open book alone).
async function loadBooks() {
  try {
    const data = await post('/review/label-books', {});
    books = data.books ?? [];
  } catch {
    books = []; // an old server without books: the default one keeps working (the picker shows it alone)
  }
  const wanted = book;
  const resolved = resolveBook(books, wanted);
  book = resolved.name;
  if (book !== wanted) writeBook(localStorage, book);
  bookPicker?.setBooks(books, book);
  bookPicker?.note(resolved.missing ? `备注本「${resolved.missing}」在服务器上不在了，已回到「${book}」` : '');
  paintClock();
  return book;
}

// Switch to another book: remember it, re-read that book's notes (charts and 备注 list) and say which one is open.
async function switchBook(name) {
  const next = bookName(name);
  if (next === book) return;
  book = next;
  writeBook(localStorage, book);
  bookPicker?.setBooks(books, book);
  await loadBooks();
  // The highlighted note belonged to the book that was open.
  chosenNote = null;
  await loadNotes();
  for (const panel of panels) paintMarkers(panel);
  status(`已切换到备注本「${book}」`);
}

// 新建: the picker has already checked the name (plain file name, not taken). An existing name is the server's 409.
async function createBook(name) {
  try { await post('/review/label-books/create', { name }); }
  catch (error) { bookPicker?.say(noteErrorText(error)); return; }
  bookPicker?.hideForm();
  book = name;
  writeBook(localStorage, book);
  status(`已新建并切换到备注本「${name}」`);
  await loadBooks();
  await loadNotes();
}

// The 备注 tab: `品种 · 来源 · 周期 · K 线时间 UTC` and the first 40 characters of the text, newest candle first; a row
// jumps to the chart that holds that candle. Long lists are cut off and narrowed with the search field instead.
const NOTE_ROWS_SHOWN = 200;

function paintNoteList() {
  const all = noteRowsFrom(allBars);
  const rows = filterNoteRows(all, noteSearch);
  const box = $('note-list');
  const count = rows.length === all.length ? `${all.length}` : `${rows.length} / ${all.length}`;
  $('note-count').textContent = `${count} 条备注`;
  box.replaceChildren(...rows.slice(0, NOTE_ROWS_SHOWN).map(row => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'note-row'; button.title = row.note;
    const head = document.createElement('strong');
    head.textContent = `${row.symbol} · ${noteWhere(row)} · ${row.tf} · ${noteTimeText(row.time)} UTC`;
    const text = document.createElement('small');
    text.textContent = noteDigest(row.note);
    button.append(head, text);
    button.onclick = () => jumpToNote(row);
    return button;
  }));
  const message = rows.length ? (rows.length > NOTE_ROWS_SHOWN ? `只显示最新的 ${NOTE_ROWS_SHOWN} 条，用上面的搜索缩小范围。` : '')
    : (noteError ? `读不到备注：${noteError}`
      : (all.length ? '没有匹配的备注。' : '还没有备注：双击图上任意 K 线，写下你的想法。'));
  if (!message) return;
  const hint = document.createElement('p');
  hint.className = 'notes-empty';
  hint.textContent = message;
  box.append(hint);
}

// The candle a double-click landed on. The library reports the candle under the pointer; `logical` covers a click a
// few pixels outside it. A click on the price / time scale, past the last candle, or on a bar that is not there (the
// night / weekend gap of a yield chart) has no candle and starts nothing.
function barTimeAt(panel, param) {
  const pane = panel.chart.paneSize(), point = param?.point;
  if (!point || !pane || point.x < 0 || point.y < 0 || point.x > pane.width || point.y > pane.height) return null;
  if (typeof param.time === 'number' && hasBar(panel, param.time)) return param.time;
  const index = Math.round(param.logical);
  const candle = Number.isFinite(index) ? panel.candles[index] : null;
  return candle && hasBar(panel, candle.time) ? candle.time : null;
}

function openBarNote(panel, time) {
  // One box at a time: the box belongs to the candle it was opened on.
  for (const other of panels) if (other !== panel) closeBarNote(other);
  panel.noteTime = time;
  panel.noteBox.show(`${barLabel(time, panel.tf)} 这根 K 线的看法`, barNoteOf(panelNotes(), noteKeyAt(panel, time)));
}

function closeBarNote(panel) {
  if (!panel?.noteBox) return;
  panel.noteBox.hide(); panel.noteTime = null;
}

// Enter in the box: one `kind=bar` row carrying the candle's numbers (a bar still forming is flagged, so the reader
// knows the values were taken mid-bar). An empty box is the explicit "delete this note" row; Esc leaves without saving.
async function submitBarNote(panel) {
  const time = panel.noteTime;
  if (time === null) return;
  const text = panel.noteBox.value();
  const form = noteId();
  const key = barNoteKey(form, panel.tf, time);
  const forming = panel.forming?.time === time;
  const candles = forming ? [...panel.candles, panel.forming] : panel.candles;
  // A session market (the yields) counts its indicator windows over consecutive bars, the way a trading app does.
  const snapshot = snapshotOf(candles, time, panel.interval, isYieldSource(source));
  try {
    await post('/review/label', barNoteBody({ form, tf: panel.tf, time, text, book,
      bar: snapshot ? { ...snapshot, ...(forming ? { forming: true } : {}) } : null }));
  } catch (error) { panel.noteBox.say(noteErrorText(error)); return; }
  allBars = rememberNote(allBars, key, text, panel.tf, time);
  closeBarNote(panel);
  paintMarkers(panel);
  if (asideTab === 'notes') paintNoteList();
  status(text ? `已保存 ${barLabel(time, panel.tf)} 的备注` : `已删除 ${barLabel(time, panel.tf)} 的备注`);
}

// A 备注 row: switch to its source / instrument, check its timeframe, scroll to that candle and highlight it amber
// (the finder jumps to a signal the same way).
async function jumpToNote(row) {
  if (!row.target) {
    status(`这条备注的来源「${row.exchange} · ${row.symbol}」在看行情页没有对应数据源。`, true);
    return;
  }
  if (!MARKET_TIMEFRAMES.includes(row.tf)) { status(`看行情页没有 ${row.tf} 这个周期。`, true); return; }
  if (!timeframes.includes(row.tf)) {
    timeframes = orderTimeframes([...timeframes, row.tf]);
    write(MARKET_KEYS.timeframes, JSON.stringify(timeframes));
    paintTimeframes();
  }
  if (!await openSelection(row.target.source, row.target.market, row.target.symbol)) return;
  const panel = panels.find(item => item.tf === row.tf && !item.empty);
  if (!panel) { status(`${row.tf} 周期还没有拿到 K 线，跳不过去。`, true); return; }
  // An older note lies before the first page: load earlier pages (the same ones a drag to the left asks for) until
  // that candle is in, the MAX_BARS cap is reached or the history ends (2026-11-16, a 15m note 20 days back failed).
  while (panel.candles.length && panel.candles[0].time > row.time && !panel.noMore && panel.candles.length < MAX_BARS) {
    const before = panel.candles.length;
    status(`正在往前加载 ${row.tf} K 线，找 ${noteSummary(row)}…`);
    await loadEarlier(panel);
    if (panel.candles.length === before) break; // a failed page or a page already loading: stop instead of spinning
  }
  if (!showNoteBar(panel, row.time)) {
    status(`那根 ${row.tf} K 线不在已加载的历史里（每个周期最多 ${MAX_BARS} 根）。`, true);
    return;
  }
  status(`已跳到 ${noteSummary(row)}`);
}

// Puts the window on one candle (about a screenful around it), shows its numbers and marks it as the chosen note.
function showNoteBar(panel, time) {
  const index = panel.candles.findIndex(candle => candle.time === time);
  const position = index >= 0 ? index : panel.forming?.time === time ? panel.candles.length : -1;
  if (position < 0) return false;
  chosenNote = { tf: panel.tf, time };
  const half = viewBarsOf(panel.tf) / 2;
  panel.chart.timeScale().setVisibleLogicalRange({ from: position - half, to: position + half });
  paintMarkers(panel);
  const candle = panel.byTime.get(time) ?? panel.forming;
  if (candle) { try { panel.chart.setCrosshairPosition(candle.close, time, panel.series); } catch { /* not sized yet */ } }
  paintMeta(panel, time);
  return true;
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
  // A hidden page stops polling the yields, so coming back reads them at once. The sockets keep the newest bars, but a
  // background tab may have been cut or throttled long enough to leave a hole: refetch the newest bars of every
  // timeframe when it was away for over a minute.
  if (source === YIELD_SOURCE) pollYields();
  else if (away > HIDDEN_REFRESH_MS) { refreshAll(); pollYields(); }
  if (asideTab === 'products') loadProducts();
  // Notes may have been written while this page was in the background.
  loadNotes();
}

function start() {
  paintClock();
  setInterval(paintClock, 1000);
  paintSource(); paintTimeframes(); paintHeight(); paintWatchlist(); paintAside();
  buildBookPicker();
  loadBooks();
  for (const button of document.querySelectorAll('.aside-tab')) {
    button.onclick = () => setAsideTab(button.dataset.tab);
  }
  $('product-search').oninput = () => {
    productQuery = $('product-search').value;
    productShown = PRODUCT_PAGE;
    paintProducts();
  };
  $('product-more').onclick = () => { productShown += PRODUCT_PAGE; paintProducts(); };
  $('note-search').oninput = () => { noteSearch = $('note-search').value; paintNoteList(); };
  // Esc closes an open note box even when the focus moved off its input (to a chart, or a button).
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    // The chart whose note box is open (noteTime is set while it is), if any.
    const panel = panels.find(item => item.noteTime !== null && item.noteTime !== undefined);
    if (!panel) return;
    event.preventDefault();
    closeBarNote(panel);
  });
  $('m-form').onsubmit = event => {
    event.preventDefault();
    openSelection(source, market, source === YIELD_SOURCE ? $('m-yield').value : $('m-symbol').value);
  };
  $('m-add').onclick = () => {
    if (isYieldSource(source) && !normalizeYieldSymbol(symbol)) {
      status('请先选一个美债品种。', true);
      return;
    }
    if (!isYieldSource(source) && !symbolOf(source, market, symbol)) {
      status('请输入币种，例如 btc、BTC-USDT、BTC-USDT-SWAP。', true);
      return;
    }
    status('');
    addWatch();
  };
  document.addEventListener('visibilitychange', onVisibility);
  loadNotes();
  render();
  syncPolling(); syncTickerPolling();
}
start();
