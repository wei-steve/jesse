// Reuse the dependency already shipped with this Jesse dashboard. No CDN or
// third-party requests are needed; the adapter is isolated for future rebuilds.
import { t as createChart } from '../_nuxt/eDEyLi0S.js';
import { aggregateCandles, sma, lastClosedCandle, contextAt, executionMarkers, centeredRange, contextPointsFor, linkTimeRanges } from './data.mjs?v=20261027c';
import { STORAGE_KEY, INDICATORS, timeframeLabel, restorePreferences } from './settings.mjs?v=20261027c';
import { calculateIndicator } from './indicators.mjs?v=20261027c';
import { tradeInfoIndex, tradeConditions, entrySummary, entryLines, exitLines, tfText } from './tradeinfo.mjs?v=20261027c';
import { mountControls } from './controls.mjs?v=20261027c';
import { buildRides, rideSeries, maText, arrow, filterRides, neighbour, signalStatus, rideAnnotations } from './rides.mjs?v=20261027c';
import { listRequest, mergePages, hasMore, sessionRow, formatHolding, sessionFromSearch, searchForSession } from './sessions.mjs?v=20261027c';

const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 19);
const number = value => !Number.isFinite(value) ? '—'
  : Math.abs(value) >= 100 ? value.toFixed(2) : Math.abs(value) >= 1 ? value.toFixed(3) : value.toFixed(4);
// The session shown now; changes when the user picks another backtest.
let sessionId = null;
// Every chart (candles and sub-panes) uses the same price-scale width, so their
// time axes line up vertically inside a card.
const SCALE_WIDTH = 72;
const UP = '#16a082', DOWN = '#dd6070';
let rideData = [];
let session, chartData, route, trades = [], orderedTrades = [], selected, panels = [], views = [], anchor, syncing = false;
let tradeIndex = null;
// Signal mode: the backtest has extra_charts.ride (see rides.mjs). Rides replace the trade list.
let signalMode = false, rides = [], rideLines = [], selectedRide = null, shownTfs = new Set(), statusTime;
let entryTime, contextPoints = [], token, loadVersion = 0, rangeLink, preferences, wantedRange;

try { preferences = restorePreferences(localStorage.getItem(STORAGE_KEY)); }
catch { preferences = restorePreferences(null); }

async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: token,
  }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (response.status === 401) throw new Error('请先在同一地址的 Jesse 页面登录，再刷新此页。');
  if (!response.ok) throw new Error(`Jesse 数据读取失败（HTTP ${response.status}）`);
  return response.json();
}

function status(message, error = false) {
  $('status').hidden = false;
  $('status').classList.toggle('error', error);
  $('status').textContent = message;
}

function newChart(host, pane) {
  return createChart(host, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#72819a', fontSize: 10 },
    grid: { vertLines: { color: '#f2f5fa' }, horzLines: { color: '#f2f5fa' } },
    rightPriceScale: { borderColor: '#edf0f5', minimumWidth: SCALE_WIDTH,
      scaleMargins: pane ? { top: 0.12, bottom: 0.06 } : { top: 0.1, bottom: 0.1 } },
    // A low minimum bar spacing lets the 1m chart fit the same window as the others.
    timeScale: { visible: !pane, timeVisible: true, secondsVisible: false, borderColor: '#edf0f5', minBarSpacing: 0.05 },
    localization: { locale: 'zh-CN', timeFormatter: t => `${stamp(t)} UTC` },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  });
}

// Values are looked up by bar time for legends and crosshair syncing.
function withLookup(line) {
  return { ...line, values: new Map(line.data.filter(p => Number.isFinite(p.value)).map(p => [p.time, p.value])) };
}

function addOverlay(chart, result) {
  const lines = result.series.map(withLookup);
  lines.forEach((line, i) => {
    const series = chart.addLineSeries({ color: line.color, lineWidth: 1.5,
      lineStyle: line.dashed ? 2 : 0,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    series.setData(line.data);
  });
  return { title: result.title, lines, group: result.group };
}

// Colours are validated as #rrggbb in settings.mjs before they reach a style.
function swatch(color) {
  const dot = document.createElement('i'); dot.className = 'ma-dot'; dot.style.background = color; return dot;
}

function makeView(panel, chart, host, kind, series, lookup) {
  const view = { panel, chart, host, kind, series, lookup, line: host.querySelector('.event-line') };
  for (const event of ['pointerdown', 'wheel']) host.addEventListener(event,
    () => rangeLink?.activate(view), { capture: true, passive: true });
  chart.subscribeCrosshairMove(event => {
    syncCrosshair(view, typeof event.time === 'number' ? event.time : null);
  });
  view.observer = new ResizeObserver(() => {
    // A chart told its window before it had a size shows the wrong span, so
    // the latest programmatic window is applied again when it is first sized.
    if (!view.sized && host.clientWidth > 0) {
      view.sized = true;
      if (wantedRange) view.chart.timeScale().setVisibleRange(wantedRange);
    }
    drawAnchor(view);
  });
  view.observer.observe(host);
  return view;
}

function addPane(panel, result) {
  const element = document.createElement('div');
  element.className = 'pane';
  element.innerHTML = '<div class="pane-head"></div><div class="pane-host"><div class="event-line"></div></div>';
  panel.card.querySelector('.panes').append(element);
  const host = element.querySelector('.pane-host');
  const chart = newChart(host, true);
  const lines = result.series.map(withLookup);
  let primary;
  lines.forEach(line => {
    const histogram = line.kind === 'histogram';
    const options = { color: line.color, lastValueVisible: false, priceLineVisible: false };
    // RSI keeps a fixed 0–100 scale so its 30/70 lines are always visible.
    if (result.title.startsWith('RSI')) options.autoscaleInfoProvider = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
    const series = histogram
      ? chart.addHistogramSeries({ ...options, priceFormat: result.title === '成交量' ? { type: 'volume' } : { type: 'price', precision: 2, minMove: 0.01 } })
      : chart.addLineSeries({ ...options, lineWidth: 1.5, crosshairMarkerVisible: false });
    // MACD histogram bars show their sign; volume keeps the chosen colour.
    series.setData(histogram && result.title !== '成交量'
      ? line.data.map(p => Number.isFinite(p.value) ? { ...p, color: p.value >= 0 ? UP : DOWN } : p)
      : line.data);
    primary ??= { series, line };
  });
  for (const price of result.thresholds) primary.series.createPriceLine({ price, color: '#9aa7ba',
    lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
  const hasValues = lines.some(line => line.values.size);
  const pane = { title: result.title, lines, head: element.querySelector('.pane-head'), hasValues };
  if (!hasValues) element.classList.add('no-data');
  pane.view = makeView(panel, chart, host, 'pane', primary.series, primary.line.values);
  return pane;
}

// Signal mode: the ridden SMA as a thick line (green up / red down, one series per interval so they never join) and a marker
// at the first bar of every interval of THIS timeframe. Markers are merged with trade markers in updateMarkers.
function addRides(panel, chart, series, candles, interval) {
  const cache = new Map();
  const smaFor = period => {
    if (!cache.has(period)) cache.set(period, new Map(sma(candles, period, interval).filter(p => Number.isFinite(p.value)).map(p => [p.time, p.value])));
    return cache.get(period);
  };
  const mine = rides.filter(r => r.minutes === interval);
  const { markers, lines } = rideAnnotations(candles, mine, smaFor);
  panel.rideMarkers = markers;
  // One series per interval: consecutive points of a series are always joined, so this is what keeps
  // the thick lines of different intervals apart.
  for (const [key, color] of [['up', UP], ['down', DOWN]]) {
    for (const data of lines[key]) {
      const line = chart.addLineSeries({ color, lineWidth: 4, lastValueVisible: false, priceLineVisible: false,
        crosshairMarkerVisible: false });
      line.setData(data);
    }
  }
}

function makePanel(interval, source) {
  const { candles, omittedBuckets } = aggregateCandles(source, interval);
  const label = timeframeLabel(interval);
  const card = document.createElement('article');
  card.className = 'chart-card'; card.dataset.interval = interval;
  // Only fixed application markup goes through innerHTML; session data is text.
  card.innerHTML = '<div class="chart-head"><h3></h3><div class="closed-summary"></div><div class="legend"></div></div><div class="chart-host"><div class="event-line"></div></div><div class="panes"></div><div class="chart-meta"></div>';
  card.querySelector('h3').textContent = label;
  $('charts').append(card);
  const panel = { interval, label, card, candles, overlays: [], panes: [], views: [], line: null, asOf: null };
  if (!candles.length) {
    panel.empty = true;
    card.classList.add('empty');
    card.querySelector('.chart-host').replaceChildren();
    card.querySelector('.chart-host').textContent = `${label} 没有完整 K 线：保存的 1m 数据不够合成一根完整的 ${label} K 线。请换更小的周期，或使用更长的回测区间。`;
    return panel;
  }
  const host = card.querySelector('.chart-host');
  const chart = newChart(host, false);
  const series = chart.addCandlestickSeries({ upColor: UP, downColor: DOWN,
    wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
    lastValueVisible: false, priceLineVisible: false });
  series.setData(candles);
  // The strategy-reference SMA5 in the summary is independent of display overlays.
  panel.averages = sma(candles, 5, interval);
  panel.series = series;
  panel.main = makeView(panel, chart, host, 'main', series, new Map(candles.map(c => [c.time, c.close])));
  panel.views.push(panel.main);
  for (const config of preferences.indicators) {
    if (!preferences.showPanes && INDICATORS[config.type].pane !== 'main') continue;
    const result = calculateIndicator(candles, config, interval);
    if (result.pane === 'main') panel.overlays.push(addOverlay(chart, result));
    else {
      const pane = addPane(panel, result);
      panel.panes.push(pane);
      panel.views.push(pane.view);
    }
  }
  if (signalMode) addRides(panel, chart, series, candles, interval);
  const tags = card.querySelector('h3');
  // One tag per indicator; a MA group lists each line's period next to its colour swatch.
  for (const overlay of panel.overlays) {
    const tag = document.createElement('span'); tag.className = 'ma-tag';
    if (overlay.group) {
      tag.append(document.createTextNode(overlay.group.mode === 'EMA' ? 'EMA(' : 'MA('));
      overlay.lines.forEach((line, i) => {
        if (i) tag.append(document.createTextNode(','));
        tag.append(swatch(line.color), document.createTextNode(String(overlay.group.periods[i])));
      });
      tag.append(document.createTextNode(')'));
    } else tag.textContent = overlay.title;
    tags.append(tag);
  }
  card.querySelector('.chart-meta').textContent = `${candles.length.toLocaleString()} 根完整 K 线 · 略过 ${omittedBuckets} 个不完整区间`;
  return panel;
}

function valuesText(item, time) {
  const parts = item.lines.map(line => `${item.lines.length > 1 ? `${line.name} ` : ''}${number(line.values.get(time))}`);
  return `${item.title} ${parts.join(' ')}`;
}

// Legends show either the hovered bar or, by default, the last bar that had
// closed when the selected trade was entered (what the strategy could see).
function renderLegend(panel, time, hovered) {
  if (panel.empty) return;
  const prefix = time === null || time === undefined ? (signalMode ? '触发时无已收盘 K 线' : '入场时无已收盘 K 线')
    : hovered ? `${stamp(time)} UTC` : (signalMode ? '触发时已收盘' : '入场时已收盘');
  const legend = panel.card.querySelector('.legend');
  legend.replaceChildren();
  if (panel.overlays.length && time !== null && time !== undefined) {
    legend.append(document.createTextNode(`${prefix} · `));
    panel.overlays.forEach((overlay, k) => {
      if (k) legend.append(document.createTextNode(' · '));
      legend.append(document.createTextNode(`${overlay.title} `));
      overlay.lines.forEach((line, i) => {
        const item = document.createElement('span'); item.className = 'legend-item';
        item.append(swatch(line.color), document.createTextNode(`${overlay.lines.length > 1 ? `${line.name} ` : ''}${number(line.values.get(time))}`));
        legend.append(i ? document.createTextNode(' ') : document.createTextNode(''), item);
      });
    });
  }
  for (const pane of panel.panes) {
    pane.head.textContent = !pane.hasValues
      ? `${pane.title} · 数据不足：此周期的完整 K 线少于指标所需的根数`
      : time === null || time === undefined ? pane.title : `${valuesText(pane, time)}${hovered ? '' : ' · 入场时已收盘'}`;
  }
}

// Top bar of signal mode: every timeframe's state at 1m time t, plus the advice.
function paintSignalBar(t) {
  $('signal-bar').hidden = !signalMode;
  if (!signalMode) return;
  if (t === undefined) { $('signal-text').textContent = ''; $('signal-advice').textContent = ''; return; }
  const state = signalStatus(rideData, t);
  $('signal-text').textContent = `${stamp(t)} UTC　${state.text}`;
  $('signal-advice').textContent = state.advice;
}

function syncCrosshair(source, time) {
  if (syncing) return;
  syncing = true;
  try {
    // A hovered bar is judged as of its close (what was known when it finished), like the markers.
    if (signalMode) paintSignalBar(time === null ? statusTime : time + source.panel.interval * 60 - 60);
    for (const view of views) {
      if (view === source) continue;
      const step = view.panel.interval * 60;
      const t = time === null ? null : Math.floor(time / step) * step;
      const value = t === null ? undefined : view.lookup.get(t);
      if (Number.isFinite(value)) view.chart.setCrosshairPosition(value, t, view.series);
      else view.chart.clearCrosshairPosition();
    }
    for (const panel of panels) {
      if (time === null) renderLegend(panel, panel.asOf, false);
      else {
        const step = panel.interval * 60;
        renderLegend(panel, Math.floor(time / step) * step, true);
      }
    }
  } finally { syncing = false; }
}

function drawAnchor(view) {
  if (!view.line || anchor === undefined) return;
  const step = view.panel.interval * 60;
  const t = Math.floor(anchor / step) * step;
  const x = view.chart.timeScale().timeToCoordinate(t);
  view.line.hidden = x === null || x < 0 || x > view.host.clientWidth - SCALE_WIDTH;
  if (!view.line.hidden) view.line.style.left = `${x}px`;
}

function rangeChanged(view, userRange) {
  // Remember a window the user dragged or zoomed to, so a settings rebuild keeps it.
  if (userRange) wantedRange = userRange;
  // Read the actual interval-rounded range after the chart's update event.
  if (view.kind === 'main') {
    const actual = view.chart.timeScale().getVisibleRange();
    view.panel.card.dataset.rangeFrom = actual?.from ?? '';
    view.panel.card.dataset.rangeTo = actual?.to ?? '';
  }
  drawAnchor(view);
}

function showRange(range) {
  wantedRange = range;
  rangeLink.set(range);
}

function focusAt(seconds) {
  anchor = seconds;
  showRange(centeredRange(anchor, Number($('span').value)));
}

function paintTrades() {
  orderedTrades = [...trades].sort((a, b) => $('sort').value === 'recent'
    ? a.opened_at - b.opened_at : ($('sort').value === 'worst' ? a.PNL - b.PNL : b.PNL - a.PNL));
  $('trades').replaceChildren();
  for (const [index, trade] of orderedTrades.entries()) {
    const button = document.createElement('button');
    button.className = 'trade'; button.dataset.tradeId = trade.id;
    button.setAttribute('aria-pressed', String(selected?.id === trade.id));
    const row = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${trade.type === 'long' ? '做多' : '做空'} ${money(trade.entry_price)}`;
    const pnl = document.createElement('span'); pnl.className = trade.PNL >= 0 ? 'positive' : 'negative';
    pnl.textContent = `${trade.PNL >= 0 ? '+' : ''}${money(trade.PNL)} USDT`;
    row.append(title, pnl);
    const details = document.createElement('small');
    const held = formatHolding(trade.holding_period);
    details.textContent = `${stamp(trade.opened_at / 1000)} UTC${held ? ` · 持仓 ${held}` : ''}`;
    button.append(row, details); button.onclick = () => selectTrade(trade);
    button.setAttribute('aria-label', `交易 ${index + 1} ${title.textContent} ${pnl.textContent}`);
    $('trades').append(button);
  }
}

function updateMarkers() {
  for (const panel of panels) {
    if (panel.empty) continue;
    const shown = $('all-markers').checked ? trades : selected ? [selected] : [];
    const markers = [...executionMarkers(shown, panel.candles, panel.interval), ...(panel.rideMarkers ?? [])];
    panel.series.setMarkers(markers.sort((a, b) => a.time - b.time));
    if (panel.line) panel.series.removePriceLine(panel.line);
    panel.line = selected ? panel.series.createPriceLine({ price: selected.entry_price,
      color: '#315cd080', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '入场均价' }) : null;
  }
}

// Entry / exit conditions of the selected trade. All text goes in through textContent.
function conditionBlock(title, rows) {
  const block = document.createElement('div'); block.className = 'condition-block';
  const heading = document.createElement('h4'); heading.textContent = title; block.append(heading);
  if (!rows.length) {
    const none = document.createElement('p'); none.textContent = '这一笔没有匹配到记录'; block.append(none);
    return block;
  }
  const list = document.createElement('dl');
  for (const row of rows) {
    const term = document.createElement('dt'); term.textContent = row.label;
    const value = document.createElement('dd'); value.textContent = row.text;
    list.append(term, value);
  }
  block.append(list);
  return block;
}

function renderConditions(trade, entry, exit) {
  const body = $('conditions-body');
  $('conditions').hidden = false;
  $('conditions-body').hidden = !preferences.showConditions;
  $('conditions-toggle').textContent = preferences.showConditions ? '收起' : '展开';
  $('conditions-toggle').setAttribute('aria-expanded', String(preferences.showConditions));
  if (!tradeIndex || tradeIndex.empty) {
    const none = document.createElement('p'); none.textContent = '此回测没有记录入场/离场条件';
    body.replaceChildren(none);
    return;
  }
  body.replaceChildren(conditionBlock('入场条件', entryLines(entry)), conditionBlock('离场条件', exitLines(exit, trade)));
}

function selectTrade(trade, focus = true) {
  selected = trade; entryTime = trade.opened_at / 1000;
  const context = contextAt(contextPoints, entryTime, 1);
  const entryOrders = (trade.orders ?? []).filter(o => !o.reduce_only && o.status === 'EXECUTED');
  const firstOrder = [...entryOrders].sort((a, b) => a.created_at - b.created_at)[0];
  const createdContext = firstOrder ? contextAt(contextPoints, firstOrder.created_at / 1000, 1) : null;
  $('trade-info').textContent = `${trade.type === 'long' ? '做多' : '做空'} · ${stamp(entryTime)} UTC · 净盈亏 ${money(trade.PNL)} USDT`;
  const { entry, exit } = tradeConditions(tradeIndex, trade);
  const summary = entrySummary(entry);
  // With trade_info the top line shows the trend / entry timeframes; V1 keeps the MA5 context.
  $('context').textContent = summary ? `入场前最近记录的周期：${summary}`
    : `入场前最近记录的周期：${context > 0 ? tfText(context) : context === 0 ? '无趋势' : '未记录'}`;
  renderConditions(trade, entry, exit);
  $('order-info').textContent = `入场 ${money(trade.entry_price)} → 离场 ${money(trade.exit_price)} · ${entryOrders.map(o => o.type).join(' / ') || '缺少成交记录'}${firstOrder ? ` · 入场单创建 ${stamp(firstOrder.created_at / 1000)} UTC${tradeIndex && !tradeIndex.empty ? '' : `，创建前最近记录周期 ${createdContext > 0 ? tfText(createdContext) : createdContext === 0 ? '无趋势' : '未知'}`}` : ''}`;
  for (const panel of panels) {
    panel.card.classList.toggle('chosen', summary && Number.isFinite(entry.entry_exec_tf) ? panel.interval === entry.entry_exec_tf : panel.interval === context);
    if (panel.empty) continue;
    const closed = lastClosedCandle(panel.candles, panel.interval, entryTime);
    const avg = closed ? panel.averages.find(v => v.time === closed.time)?.value : null;
    panel.asOf = closed?.time ?? null;
    // Show the end date only when the candle ends on a different day (e.g. 1D).
    const closeStamp = closed ? stamp(closed.time + panel.interval * 60) : '';
    const closeText = closed && closeStamp.slice(0, 5) === stamp(closed.time).slice(0, 5) ? closeStamp.slice(6) : closeStamp;
    panel.card.querySelector('.closed-summary').textContent = closed
      ? `入场时最后已收盘：${stamp(closed.time)} → ${closeText} UTC\n收盘 ${money(closed.close)} · 策略参考 SMA5 ${money(avg)}（含当前这根已收盘 K 线）`
      : '入场时没有已保存的完整收盘 K 线';
    renderLegend(panel, panel.asOf, false);
  }
  for (const button of $('trades').children) button.setAttribute('aria-pressed', String(button.dataset.tradeId === trade.id));
  const index = orderedTrades.findIndex(t => t.id === trade.id);
  $('previous').disabled = index <= 0; $('next').disabled = index >= orderedTrades.length - 1;
  $('exit').disabled = !Number.isFinite(trade.closed_at);
  updateMarkers();
  if (focus) focusAt(entryTime);
}

// ---- Signal mode: ride list ------------------------------------------------
const shownRides = () => filterRides(rides, shownTfs);
const rideButtons = new Map();

function paintRides() {
  const list = shownRides();
  rideButtons.clear();
  const box = $('trades'); box.replaceChildren();
  if (!list.length) {
    const none = document.createElement('p'); none.className = 'rides-empty';
    none.textContent = rides.length ? '没有勾选的周期' : '此回测没有出现信号区间'; box.append(none);
  }
  const fragment = document.createDocumentFragment();
  for (const ride of list) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'trade ride';
    button.setAttribute('aria-pressed', String(ride === selectedRide));
    const head = document.createElement('strong');
    const side = document.createElement('span'); side.className = ride.dir > 0 ? 'up' : 'down'; side.textContent = arrow(ride.dir);
    head.append(document.createTextNode(`${ride.tf} `), side, document.createTextNode(` ${maText(ride.periods)}`));
    const details = document.createElement('small');
    details.textContent = `${stamp(ride.start).slice(0, 11)} UTC · ${ride.bars} 根${ride.ended ? '' : '（到回测结束）'}`;
    button.append(head, details);
    button.onclick = () => selectRide(ride);
    rideButtons.set(ride, button); fragment.append(button);
  }
  box.append(fragment);
  $('trade-count').textContent = `${list.length}/${rides.length} 个`;
  updateRideNav();
}

function updateRideNav() {
  const list = shownRides();
  $('previous').disabled = !neighbour(list, selectedRide, -1);
  $('next').disabled = !neighbour(list, selectedRide, 1);
}

function selectRide(ride, focus = true) {
  const previous = selectedRide;
  selectedRide = ride; statusTime = ride.start;
  if (previous && rideButtons.has(previous)) rideButtons.get(previous).setAttribute('aria-pressed', 'false');
  rideButtons.get(ride)?.setAttribute('aria-pressed', 'true');
  rideButtons.get(ride)?.scrollIntoView?.({ block: 'nearest' });
  $('trade-info').textContent = `${ride.tf} ${arrow(ride.dir)} ${maText(ride.periods)} · ${stamp(ride.start)} UTC 起 · 持续 ${ride.bars} 根${ride.ended ? '' : '（到回测结束）'} · 最多回踩 ${ride.maxTouches} 次`;
  $('context').textContent = ''; $('order-info').textContent = '';
  for (const panel of panels) {
    panel.card.classList.toggle('chosen', panel.interval === ride.minutes);
    if (panel.empty) continue;
    // The value is known when the 1m candle closes, at start + 60.
    const closed = lastClosedCandle(panel.candles, panel.interval, ride.start + 60);
    panel.asOf = closed?.time ?? null;
    panel.card.querySelector('.closed-summary').textContent = closed
      ? `触发时最后已收盘：${stamp(closed.time)} UTC · 收盘 ${money(closed.close)}` : '触发时没有已保存的完整收盘 K 线';
    renderLegend(panel, panel.asOf, false);
  }
  paintSignalBar(statusTime); updateRideNav(); updateMarkers();
  if (focus) focusAt(ride.start);
}

function buildPanels() {
  for (const view of views) { view.observer.disconnect(); view.chart.remove(); }
  panels = []; views = []; $('charts').replaceChildren();
  panels = preferences.intervals.map(interval => makePanel(interval, chartData.candles));
  views = panels.flatMap(panel => panel.views);
  rangeLink = linkTimeRanges(views, rangeChanged);
}

// Display settings changed: redraw from the already-loaded data and keep the
// selected trade, the event line and the visible time window.
function rebuild() {
  if (!chartData) return;
  const range = wantedRange;
  try { buildPanels(); } catch (error) { status(error.message, true); return; }
  if (signalMode && selectedRide) selectRide(selectedRide, false);
  else if (selected) selectTrade(selected, false); else updateMarkers();
  if (range) showRange(range); else if (anchor !== undefined) focusAt(anchor);
  for (const view of views) drawAnchor(view);
}

// Enters or leaves signal mode for the loaded route (there is a `ride` series or not). Without one the page
// is exactly the trade review page.
function setSignalMode(data) {
  const extra = data?.strategy_charts?.extra_charts;
  rideData = rideSeries(extra);
  signalMode = rideData.length > 0;
  const end = data?.candles?.length ? data.candles.reduce((m, c) => Math.max(m, c.time), 0) + 60 : undefined;
  rides = signalMode ? buildRides(extra, end) : [];
  selectedRide = null; statusTime = undefined; shownTfs = new Set(rideData.map(s => s.title));
  document.body.classList.toggle('signal-mode', signalMode);
  $('aside-title').textContent = signalMode ? '信号区间' : '交易记录';
  $('previous').textContent = signalMode ? '← 上一个' : '← 上一笔';
  $('next').textContent = signalMode ? '下一个 →' : '下一笔 →';
  $('signal-bar').hidden = true;
  const filter = $('ride-filter');
  filter.replaceChildren(); filter.hidden = !signalMode;
  for (const series of rideData) {
    const label = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true;
    box.setAttribute('aria-label', `列表显示 ${series.title} 区间`);
    box.onchange = () => {
      if (box.checked) shownTfs.add(series.title); else shownTfs.delete(series.title);
      paintRides();
    };
    label.append(box, document.createTextNode(series.title)); filter.append(label);
  }
}

async function loadRoute() {
  const version = ++loadVersion;
  // Keep the route picker usable after an unsupported-route or network error,
  // while hiding stale charts so they cannot be mistaken for the selected route.
  $('workspace').hidden = false;
  document.querySelector('main').hidden = true;
  for (const control of document.querySelectorAll('.toolbar button, .toolbar input, #span')) control.disabled = true;
  status('正在读取保存的 K 线…');
  route = session.state.form.routes[Number($('route').value)];
  if (route.timeframe !== '1m') throw new Error('此扩展页需要 1m 交易路由及其已保存图表。不会用高周期数据虚构 1m K 线。');
  const loadingSession = sessionId;
  const result = await post(`/backtest/sessions/${sessionId}/chart-data`, route);
  // Ignore an answer for a route or backtest the user has already moved away from.
  if (version !== loadVersion || loadingSession !== sessionId) return;
  chartData = result.chart_data;
  if (!chartData?.candles?.length) throw new Error('该回测没有保存 K 线图数据。请使用已有 1m 图表的回测。');
  trades = (session.trades ?? []).filter(t => t.exchange === route.exchange && t.symbol === route.symbol && Number.isFinite(t.opened_at));
  contextPoints = contextPointsFor(chartData.strategy_charts);
  tradeIndex = tradeInfoIndex(chartData.strategy_charts);
  setSignalMode(chartData);
  mountControls(session.state.form, route, preferences, rebuild);
  buildPanels();
  for (const control of document.querySelectorAll('.toolbar button, .toolbar input, #span')) control.disabled = false;
  selected = null;
  if (signalMode) paintRides(); else { paintTrades(); $('trade-count').textContent = `${trades.length} 笔`; }
  $('status').hidden = true; document.querySelector('main').hidden = false;
  if (signalMode) {
    const first = shownRides()[0];
    if (first) selectRide(first);
    else {
      $('trade-info').textContent = '此回测没有出现信号区间';
      const last = panels.find(p => !p.empty)?.candles.at(-1);
      statusTime = last ? last.time + 60 : undefined; paintSignalBar(statusTime);
      if (last) focusAt(last.time);
    }
  } else if (orderedTrades.length) selectTrade(orderedTrades[0]);
  else {
    $('trade-info').textContent = '此路由没有成交记录';
    const last = panels.find(p => !p.empty)?.candles.at(-1);
    if (last) focusAt(last.time);
  }
}

// ---- Backtest picker -------------------------------------------------------
let listRows = [], listOffset = 0, listMore = false, listSearch = '', listVersion = 0, searchTimer;

function paintList() {
  const list = $('picker-list');
  list.replaceChildren();
  for (const session of listRows) {
    const row = sessionRow(session);
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'session-item'; button.dataset.sessionId = row.id;
    button.disabled = !row.selectable;
    if (!row.selectable) button.title = '只有已完成的回测可以查看';
    if (row.id === sessionId) button.setAttribute('aria-current', 'true');
    const head = document.createElement('strong'); head.textContent = row.title;
    const meta = document.createElement('small');
    // Absent fields are skipped; every part is plain text.
    for (const [text, sign] of [[row.range], [row.status], [row.trades], [row.profit && `净收益 ${row.profit}`, row.profitSign]]) {
      if (!text) continue;
      const part = document.createElement('span'); part.textContent = text;
      if (sign) part.className = sign;
      meta.append(part);
    }
    button.append(head, meta);
    button.onclick = () => choose(row.id);
    item.append(button); list.append(item);
  }
  $('picker-more').hidden = !listMore; $('picker-more').disabled = false;
  $('picker-message').textContent = listRows.length
    ? `已加载 ${listRows.length} 个回测${listMore ? '，还有更多' : ''}`
    : (listSearch.trim() ? '没有标题匹配的回测' : '还没有回测');
}

async function loadList(reset) {
  const version = ++listVersion;
  if (reset) { listRows = []; listOffset = 0; listMore = false; paintList(); }
  $('picker-message').classList.remove('error');
  $('picker-message').textContent = '正在读取回测列表…';
  $('picker-more').disabled = true;
  try {
    const result = await post('/backtest/sessions', listRequest(listSearch, listOffset));
    if (version !== listVersion) return;
    const page = result.sessions ?? [];
    listRows = mergePages(listRows, page); listOffset += page.length; listMore = hasMore(page);
    paintList();
  } catch (error) {
    if (version !== listVersion) return;
    paintList();
    $('picker-message').classList.add('error');
    $('picker-message').textContent = error.message;
  }
}

function setPicker(open) {
  $('picker-panel').hidden = !open;
  $('picker-toggle').setAttribute('aria-expanded', String(open));
}

function choose(id) {
  setPicker(false);
  if (id === sessionId) return;
  // A history entry per backtest, so the browser back button returns to the previous one.
  history.pushState(null, '', searchForSession(location.search, id));
  openSession(id);
}

// ---- Opening a backtest ----------------------------------------------------
let openVersion = 0;

// Forgets everything tied to the previous backtest. Display preferences
// (timeframes, indicators, sub-chart switch) and the toolbar choices stay.
function clearSession() {
  loadVersion++;
  for (const view of views) { view.observer.disconnect(); view.chart.remove(); }
  panels = []; views = []; session = chartData = route = selected = anchor = wantedRange = entryTime = undefined;
  trades = []; orderedTrades = []; contextPoints = []; tradeIndex = null;
  signalMode = false; rides = []; rideData = []; selectedRide = null; statusTime = undefined; rideButtons.clear();
  document.body.classList.remove('signal-mode'); $('signal-bar').hidden = true; $('ride-filter').replaceChildren();
  for (const id of ['charts', 'trades', 'route']) $(id).replaceChildren();
  for (const id of ['trade-info', 'context', 'order-info', 'trade-count']) $(id).textContent = '';
  $('conditions-body').replaceChildren(); $('conditions').hidden = true;
  $('workspace').hidden = true; document.querySelector('main').hidden = true;
}

async function openSession(id) {
  const version = ++openVersion;
  sessionId = id;
  clearSession();
  for (const element of document.querySelectorAll('#picker-list [aria-current]')) element.removeAttribute('aria-current');
  if (!id) {
    // No (valid) session in the address: the list is the starting point.
    $('status').hidden = true;
    $('session-title').textContent = '请选择要复盘的回测';
    $('dashboard').href = '/';
    setPicker(true);
    return;
  }
  status('正在读取回测…');
  $('session-title').textContent = '正在读取 Jesse 回测…';
  $('dashboard').href = `/#/backtest/${id}`;
  paintList();
  try {
    const result = await post(`/backtest/sessions/${id}`);
    if (version !== openVersion) return;
    session = result.session;
    if (!session?.state?.form?.routes?.length) throw new Error('此回测没有保存交易路由。');
    $('session-title').textContent = `${session.state.form.start_date} — ${session.state.form.finish_date} · ${session.title || session.id}`;
    session.state.form.routes.forEach((item, index) => {
      const option = document.createElement('option'); option.value = index;
      option.textContent = `${item.symbol} · ${item.timeframe}`; $('route').append(option);
    });
    await loadRoute();
  } catch (error) {
    if (version === openVersion) { status(error.message, true); setPicker(true); }
  }
}

async function start() {
  // Same-origin Jesse auth only. Never place credentials in URLs or logs.
  try { token = JSON.parse(localStorage.getItem('main') ?? '{}').authToken; } catch { token = null; }
  if (!token) throw new Error('请先在同一地址的 Jesse 页面登录，再刷新此页。localhost 与 127.0.0.1 的登录状态不同。');
  $('picker').hidden = false;
  $('picker-toggle').onclick = () => {
    setPicker($('picker-panel').hidden);
  };
  $('picker-search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { listSearch = $('picker-search').value; loadList(true); }, 300);
  };
  $('picker-search').onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); clearTimeout(searchTimer);
    listSearch = $('picker-search').value; loadList(true);
  };
  $('picker-more').onclick = () => loadList(false);
  $('route').onchange = () => { loadRoute().catch(error => status(error.message, true)); };
  $('sort').onchange = () => { paintTrades(); if (orderedTrades.length) selectTrade(orderedTrades[0]); };
  for (const [id, step] of [['previous', -1], ['next', 1]]) $(id).onclick = () => {
    if (signalMode) { const ride = neighbour(shownRides(), selectedRide, step); if (ride) selectRide(ride); return; }
    const index = orderedTrades.findIndex(t => t.id === selected?.id);
    if (orderedTrades[index + step]) selectTrade(orderedTrades[index + step]);
  };
  $('entry').onclick = () => { if (selected) focusAt(selected.opened_at / 1000); };
  $('exit').onclick = () => { if (selected?.closed_at) focusAt(selected.closed_at / 1000); };
  $('span').onchange = () => focusAt(anchor);
  $('all-markers').onchange = updateMarkers;
  // Entry/exit conditions can be folded away; remembered with the display settings.
  $('conditions-toggle').onclick = () => {
    preferences.showConditions = !preferences.showConditions;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* still works for this page */ }
    if (selected) { const { entry, exit } = tradeConditions(tradeIndex, selected); renderConditions(selected, entry, exit); }
  };
  // Indicator values above the charts: a CSS class only, so no chart is rebuilt.
  const applyValues = () => {
    $('charts').classList.toggle('hide-values', !preferences.showValues);
  };
  $('show-values').checked = preferences.showValues; applyValues();
  $('show-values').onchange = () => {
    preferences.showValues = $('show-values').checked; applyValues();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* still works for this page */ }
  };
  // Master switch for every timeframe's sub-charts; remembered with the display settings.
  $('show-panes').checked = preferences.showPanes;
  $('show-panes').onchange = () => {
    preferences.showPanes = $('show-panes').checked;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* still works for this page */ }
    rebuild();
  };
  // Back/forward between backtests re-reads the address.
  addEventListener('popstate', () => { openSession(sessionFromSearch(location.search)); });
  loadList(true);
  const wanted = new URLSearchParams(location.search).get('session');
  if (wanted !== null && !sessionFromSearch(location.search)) {
    clearSession(); sessionId = null; setPicker(true);
    throw new Error('链接中的回测 session 参数无效，请从列表中选择。');
  }
  await openSession(sessionFromSearch(location.search));
}
start().catch(error => status(error.message, true));
