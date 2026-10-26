// Reuse the dependency already shipped with this Jesse dashboard. No CDN or
// third-party requests are needed; the adapter is isolated for future rebuilds.
import { t as createChart } from '../_nuxt/eDEyLi0S.js';
import { aggregateCandles, sma, lastClosedCandle, contextAt, executionMarkers, centeredRange, contextPointsFor, linkTimeRanges } from './data.mjs';

const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 19);
const sessionId = new URLSearchParams(location.search).get('session');
const intervals = [15, 5, 3, 1];
let session, chartData, trades = [], orderedTrades = [], selected, panels = [], anchor, syncing = false;
let entryTime, contextPoints = [], token, loadVersion = 0;
let rangeLink;

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

function makePanel(interval, source) {
  const { candles, omittedBuckets } = aggregateCandles(source, interval);
  if (!candles.length) throw new Error(`${interval}m 没有完整 K 线，无法展示。`);
  const card = document.createElement('article');
  card.className = 'chart-card'; card.dataset.interval = interval;
  // Only fixed application markup goes through innerHTML; session data is text.
  card.innerHTML = `<div class="chart-head"><h3>${interval} 分钟 <span>SMA5</span></h3><div class="closed-summary"></div></div><div class="chart-host"><div class="event-line"></div></div><div class="chart-meta"></div>`;
  $('charts').append(card);
  const host = card.querySelector('.chart-host');
  const chart = createChart(host, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#72819a', fontSize: 10 },
    grid: { vertLines: { color: '#f2f5fa' }, horzLines: { color: '#f2f5fa' } },
    rightPriceScale: { borderColor: '#edf0f5', minimumWidth: 66 },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#edf0f5' },
    localization: { locale: 'zh-CN', timeFormatter: t => `${stamp(t)} UTC` },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  });
  const series = chart.addCandlestickSeries({ upColor: '#16a082', downColor: '#dd6070',
    wickUpColor: '#16a082', wickDownColor: '#dd6070', borderVisible: false,
    lastValueVisible: false, priceLineVisible: false });
  series.setData(candles);
  const averages = sma(candles, 5, interval);
  const ma = chart.addLineSeries({ color: '#dd9a23', lineWidth: 2,
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  ma.setData(averages);
  const panel = { interval, card, chart, series, candles, averages, line: null };
  card.querySelector('.chart-meta').textContent = `${candles.length.toLocaleString()} 根完整 K 线 · 略过 ${omittedBuckets} 个不完整区间 · 均线为该周期 SMA5`;
  for (const event of ['pointerdown', 'wheel']) host.addEventListener(event,
    () => rangeLink?.activate(panel), { capture: true, passive: true });
  chart.subscribeCrosshairMove(event => {
    if (syncing) return;
    syncing = true;
    try {
      for (const other of panels) {
        if (other === panel) continue;
        const time = typeof event.time === 'number' ? Math.floor(event.time / (other.interval * 60)) * other.interval * 60 : null;
        const bar = other.candles.find(c => c.time === time);
        if (bar) other.chart.setCrosshairPosition(bar.close, bar.time, other.series);
        else other.chart.clearCrosshairPosition();
      }
    } finally { syncing = false; }
  });
  panel.observer = new ResizeObserver(() => drawAnchor(panel));
  panel.observer.observe(host);
  return panel;
}

function drawAnchor(panel) {
  const line = panel.card.querySelector('.event-line');
  const t = Math.floor(anchor / (panel.interval * 60)) * panel.interval * 60;
  const x = panel.chart.timeScale().timeToCoordinate(t);
  line.hidden = x === null || x < 0 || x > panel.card.clientWidth - 66;
  if (!line.hidden) line.style.left = `${x}px`;
}

function rangeChanged(panel) {
  // Read the actual interval-rounded range after the chart's update event.
  const actual = panel.chart.timeScale().getVisibleRange();
  panel.card.dataset.rangeFrom = actual?.from ?? '';
  panel.card.dataset.rangeTo = actual?.to ?? '';
  drawAnchor(panel);
}

function focusAt(seconds) {
  anchor = seconds;
  rangeLink.set(centeredRange(anchor, Number($('span').value)));
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
    details.textContent = `${stamp(trade.opened_at / 1000)} UTC · ${Math.round(trade.holding_period / 60)} 分钟`;
    button.append(row, details); button.onclick = () => selectTrade(trade);
    button.setAttribute('aria-label', `交易 ${index + 1} ${title.textContent} ${pnl.textContent}`);
    $('trades').append(button);
  }
}

function updateMarkers() {
  for (const panel of panels) {
    const shown = $('all-markers').checked ? trades : selected ? [selected] : [];
    panel.series.setMarkers(executionMarkers(shown, panel.candles, panel.interval));
    if (panel.line) panel.series.removePriceLine(panel.line);
    panel.line = selected ? panel.series.createPriceLine({ price: selected.entry_price,
      color: '#315cd080', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '入场均价' }) : null;
  }
}

function selectTrade(trade) {
  selected = trade; entryTime = trade.opened_at / 1000;
  const context = contextAt(contextPoints, entryTime, 1);
  const entryOrders = (trade.orders ?? []).filter(o => !o.reduce_only && o.status === 'EXECUTED');
  const firstOrder = [...entryOrders].sort((a, b) => a.created_at - b.created_at)[0];
  const createdContext = firstOrder ? contextAt(contextPoints, firstOrder.created_at / 1000, 1) : null;
  $('trade-info').textContent = `${trade.type === 'long' ? '做多' : '做空'} · ${stamp(entryTime)} UTC · 净盈亏 ${money(trade.PNL)} USDT`;
  $('context').textContent = `入场前最近记录的周期：${context > 0 ? `${context}m` : context === 0 ? '无趋势' : '未记录'}`;
  $('order-info').textContent = `入场 ${money(trade.entry_price)} → 离场 ${money(trade.exit_price)} · ${entryOrders.map(o => o.type).join(' / ') || '缺少成交记录'}${firstOrder ? ` · 入场单创建 ${stamp(firstOrder.created_at / 1000)} UTC，创建前最近记录周期 ${createdContext > 0 ? `${createdContext}m` : createdContext === 0 ? '无趋势' : '未知'}` : ''}`;
  for (const panel of panels) {
    panel.card.classList.toggle('chosen', panel.interval === context);
    const closed = lastClosedCandle(panel.candles, panel.interval, entryTime);
    const avg = closed ? panel.averages.find(v => v.time === closed.time)?.value : null;
    panel.card.querySelector('.closed-summary').textContent = closed
      ? `入场时最后已收盘：${stamp(closed.time)} → ${stamp(closed.time + panel.interval * 60).slice(6)} UTC\n收盘 ${money(closed.close)} · SMA5 ${money(avg)}（含当前这根已收盘 K 线）`
      : '入场时没有已保存的完整收盘 K 线';
  }
  for (const button of $('trades').children) button.setAttribute('aria-pressed', String(button.dataset.tradeId === trade.id));
  const index = orderedTrades.findIndex(t => t.id === trade.id);
  $('previous').disabled = index <= 0; $('next').disabled = index >= orderedTrades.length - 1;
  $('exit').disabled = !Number.isFinite(trade.closed_at);
  updateMarkers(); focusAt(entryTime);
}

async function loadRoute() {
  const version = ++loadVersion;
  // Keep the route picker usable after an unsupported-route or network error,
  // while hiding stale charts so they cannot be mistaken for the selected route.
  $('workspace').hidden = false;
  document.querySelector('main').hidden = true;
  for (const control of document.querySelectorAll('.toolbar button, .toolbar input, #span')) control.disabled = true;
  status('正在读取保存的 K 线…');
  const route = session.state.form.routes[Number($('route').value)];
  if (route.timeframe !== '1m') throw new Error('此扩展页需要 1m 交易路由及其已保存图表。不会用高周期数据虚构 1m K 线。');
  const result = await post(`/backtest/sessions/${sessionId}/chart-data`, route);
  if (version !== loadVersion) return;
  chartData = result.chart_data;
  if (!chartData?.candles?.length) throw new Error('该回测没有保存 K 线图数据。请使用已有 1m 图表的回测。');
  trades = (session.trades ?? []).filter(t => t.exchange === route.exchange && t.symbol === route.symbol && Number.isFinite(t.opened_at));
  contextPoints = contextPointsFor(chartData.strategy_charts);
  for (const panel of panels) { panel.observer.disconnect(); panel.chart.remove(); }
  panels = []; $('charts').replaceChildren();
  for (const interval of intervals) panels.push(makePanel(interval, chartData.candles));
  rangeLink = linkTimeRanges(panels, rangeChanged);
  for (const control of document.querySelectorAll('.toolbar button, .toolbar input, #span')) control.disabled = false;
  selected = null; paintTrades(); $('trade-count').textContent = `${trades.length} 笔`;
  if (orderedTrades.length) selectTrade(orderedTrades[0]);
  else { $('trade-info').textContent = '此路由没有成交记录'; focusAt(panels.at(-1).candles.at(-1).time); }
  $('status').hidden = true; document.querySelector('main').hidden = false;
}

async function start() {
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(sessionId ?? '')) throw new Error('链接缺少有效的回测 session 参数。');
  $('dashboard').href = `/#/backtest/${sessionId}`;
  // Same-origin Jesse auth only. Never place credentials in URLs or logs.
  try { token = JSON.parse(localStorage.getItem('main') ?? '{}').authToken; } catch { token = null; }
  if (!token) throw new Error('请先在同一地址的 Jesse 页面登录，再刷新此页。localhost 与 127.0.0.1 的登录状态不同。');
  const result = await post(`/backtest/sessions/${sessionId}`);
  session = result.session;
  if (!session?.state?.form?.routes?.length) throw new Error('此回测没有保存交易路由。');
  $('session-title').textContent = `${session.state.form.start_date} — ${session.state.form.finish_date} · ${session.title || session.id}`;
  session.state.form.routes.forEach((route, index) => {
    const option = document.createElement('option'); option.value = index;
    option.textContent = `${route.symbol} · ${route.timeframe}`; $('route').append(option);
  });
  $('route').onchange = () => { loadRoute().catch(error => status(error.message, true)); };
  $('sort').onchange = () => { paintTrades(); if (orderedTrades.length) selectTrade(orderedTrades[0]); };
  for (const [id, step] of [['previous', -1], ['next', 1]]) $(id).onclick = () => {
    const index = orderedTrades.findIndex(t => t.id === selected?.id);
    if (orderedTrades[index + step]) selectTrade(orderedTrades[index + step]);
  };
  $('entry').onclick = () => { if (selected) focusAt(selected.opened_at / 1000); };
  $('exit').onclick = () => { if (selected?.closed_at) focusAt(selected.closed_at / 1000); };
  $('span').onchange = () => focusAt(anchor);
  $('all-markers').onchange = updateMarkers;
  await loadRoute();
}
start().catch(error => status(error.message, true));
