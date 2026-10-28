// Factor finder page: runs a factor file from the project's factors/ folder (POST /factors/run) on candles read
// straight from the database, and draws the intervals it finds like the signal mode of the review page.
// The page knows nothing about any rule; it draws the numbers the factor returns (+N / -N / 0 per bar).
import { t as createChart } from '../_nuxt/eDEyLi0S.js';
import { sma, centeredRange, linkTimeRanges } from './data.mjs?v=20261028h';
import { enablePriceZoom } from './pricezoom.mjs?v=20261028h';
import { STORAGE_KEY, INDICATORS, timeframeLabel, timeframeMinutes, restorePreferences } from './settings.mjs?v=20261028h';
import { calculateIndicator } from './indicators.mjs?v=20261028h';
import { buildRides, rideSeries, maText, arrow, filterRides, neighbour, signalStatus, rideAnnotations, joinRideLines } from './rides.mjs?v=20261028h';
import { FORM_KEY, RECENT_DAYS, WINDOWS, restoreForm, isoToLocal, clampParam, runBody, importStartDate, rideExtra, importDone } from './finder-data.mjs?v=20261028h';

const $ = id => document.getElementById(id);
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 16);
const stampFull = seconds => `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16)}`;
const UP = '#16a082', DOWN = '#dd6070', SCALE_WIDTH = 72;
const TIMEFRAME_CHOICES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D'];

let token, form, factors = [], result = null, rides = [], rideData = [], shownTfs = new Set();
let panels = [], selectedRide = null, statusTime, wantedRange, rangeLink, syncing = false, runVersion = 0;
const rideButtons = new Map();

try { form = restoreForm(localStorage.getItem(FORM_KEY)); } catch { form = restoreForm(null); }
const saveForm = () => { try { localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch { /* still works for this page */ } };

async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(body), credentials: 'same-origin' });
  if (response.status === 401) throw new Error('请先在同一地址的 Jesse 页面登录，再刷新此页。');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? data.detail ?? `Jesse 请求失败（HTTP ${response.status}）`);
  return data;
}

function status(message, error = false) {
  $('status').hidden = !message;
  $('status').classList.toggle('error', error);
  $('status').textContent = message;
}

// ---- Form ------------------------------------------------------------------
const currentFactor = () => factors.find(f => f.name === form.factor) ?? null;

function paintParams() {
  const factor = currentFactor();
  const box = $('f-params'); box.replaceChildren();
  $('f-description').textContent = factor ? `${factor.title} ${factor.version}${factor.description ? ` · ${factor.description}` : ''}` : '';
  for (const spec of factor?.params ?? []) {
    const label = document.createElement('label');
    label.append(document.createTextNode(spec.label ?? spec.name));
    const input = document.createElement('input');
    input.type = 'number'; input.dataset.param = spec.name;
    for (const key of ['min', 'max', 'step']) if (Number.isFinite(spec[key])) input[key] = spec[key];
    input.value = form.params[factor.name]?.[spec.name] ?? spec.default;
    input.setAttribute('aria-label', spec.label ?? spec.name);
    input.onchange = () => {
      input.value = clampParam(spec, input.value);
      form.params[factor.name] = { ...form.params[factor.name], [spec.name]: Number(input.value) }; saveForm();
    };
    label.append(input); box.append(label);
  }
}

function paintTimeframes() {
  const factor = currentFactor();
  const box = $('f-timeframes'); box.replaceChildren();
  if (!factor) return;
  const chosen = form.timeframes[factor.name] ?? factor.timeframes;
  const choices = [...new Set([...TIMEFRAME_CHOICES, ...factor.timeframes])].sort((a, b) => timeframeMinutes(a) - timeframeMinutes(b));
  for (const tf of choices) {
    const label = document.createElement('label');
    const box2 = document.createElement('input'); box2.type = 'checkbox'; box2.checked = chosen.includes(tf); box2.value = tf;
    box2.setAttribute('aria-label', `查找 ${tf} 周期`);
    box2.onchange = () => {
      form.timeframes[factor.name] = [...box.querySelectorAll('input:checked')].map(i => i.value); saveForm();
    };
    label.append(box2, document.createTextNode(tf));
    if (factor.timeframes.includes(tf)) { const small = document.createElement('small'); small.textContent = '默认'; label.append(small); }
    box.append(label);
  }
}

function paintFactors() {
  const select = $('f-factor'); select.replaceChildren();
  for (const factor of factors) {
    const option = document.createElement('option'); option.value = factor.name;
    option.textContent = factor.error ? `${factor.name}（加载失败）` : `${factor.title} ${factor.version}`;
    select.append(option);
  }
  if (!factors.some(f => f.name === form.factor)) form.factor = factors.find(f => !f.error)?.name ?? factors[0]?.name ?? '';
  select.value = form.factor;
  paintParams(); paintTimeframes();
  $('f-run').disabled = !currentFactor() || !!currentFactor().error;
  if (currentFactor()?.error) status(currentFactor().error, true);
}

function paintForm() {
  $('f-exchange').value = form.exchange; $('f-symbol').value = form.symbol;
  $('f-range').value = form.rangeMode === 'custom' ? 'custom' : String(form.recentDays);
  $('f-custom').hidden = form.rangeMode !== 'custom';
  $('f-start').value = form.start; $('f-finish').value = form.finish;
  $('f-overlay').checked = form.overlay;
  $('f-window').replaceChildren(...WINDOWS.map(([seconds, label]) => {
    const option = document.createElement('option'); option.value = seconds; option.textContent = label; return option;
  }));
  $('f-window').value = form.window;
}

// Takes the page's inputs into `form` (and saves them). Params are bounded the same way the server does.
function readForm() {
  form.exchange = $('f-exchange').value.trim(); form.symbol = $('f-symbol').value.trim();
  const range = $('f-range').value;
  form.rangeMode = range === 'custom' ? 'custom' : 'recent';
  if (form.rangeMode === 'recent') form.recentDays = RECENT_DAYS.includes(Number(range)) ? Number(range) : 7;
  form.start = $('f-start').value; form.finish = $('f-finish').value;
  form.overlay = $('f-overlay').checked; form.window = Number($('f-window').value);
  saveForm();
}

function selectedParams(factor) {
  const params = {};
  for (const spec of factor.params) {
    const input = $('f-params').querySelector(`[data-param="${spec.name}"]`);
    params[spec.name] = clampParam(spec, input?.value);
  }
  return params;
}

// ---- Charts ----------------------------------------------------------------
function newChart(host) {
  return createChart(host, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#72819a', fontSize: 10 },
    grid: { vertLines: { color: '#f2f5fa' }, horzLines: { color: '#f2f5fa' } },
    rightPriceScale: { borderColor: '#edf0f5', minimumWidth: SCALE_WIDTH, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#edf0f5', minBarSpacing: 0.05 },
    localization: { locale: 'zh-CN', timeFormatter: t => `${stampFull(t)} UTC` },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  });
}

// The ridden SMA of all intervals is one thick line series; the segments between intervals are transparent
// (see joinRideLines). One series per interval froze the page on long ranges.
function addRides(panel) {
  const cache = new Map();
  const smaFor = period => {
    if (!cache.has(period)) cache.set(period, new Map(sma(panel.candles, period, panel.interval).filter(p => Number.isFinite(p.value)).map(p => [p.time, p.value])));
    return cache.get(period);
  };
  const { markers, lines } = rideAnnotations(panel.candles, rides.filter(r => r.minutes === panel.interval), smaFor);
  panel.series.setMarkers(markers);
  const data = joinRideLines(lines, { up: UP, down: DOWN });
  if (data.length) {
    const line = panel.chart.addLineSeries({ color: UP, lineWidth: 4, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(data);
  }
}

// Optional: the review page's own main-chart indicators (MA group, SMA, EMA, BOLL) on top.
function addOverlay(panel, preferences) {
  for (const config of preferences.indicators) {
    if (INDICATORS[config.type].pane !== 'main') continue;
    for (const line of calculateIndicator(panel.candles, config, panel.interval).series) {
      const series = panel.chart.addLineSeries({ color: line.color, lineWidth: 1.5, lineStyle: line.dashed ? 2 : 0,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      series.setData(line.data);
    }
  }
}

function makePanel(tf, item, preferences) {
  const interval = timeframeMinutes(tf);
  const card = document.createElement('article');
  card.className = 'chart-card'; card.dataset.interval = interval;
  card.innerHTML = '<div class="chart-head"><h3></h3></div><div class="chart-host"></div><div class="chart-meta"></div>';
  card.querySelector('h3').textContent = timeframeLabel(interval);
  if (item.label) { const tag = document.createElement('span'); tag.textContent = item.label; card.querySelector('h3').append(tag); }
  $('charts').append(card);
  const panel = { tf, interval, card, candles: item.candles, closes: new Map(item.candles.map(c => [c.time, c.close])) };
  const meta = card.querySelector('.chart-meta');
  if (!item.candles.length) {
    card.classList.add('empty');
    card.querySelector('.chart-host').textContent = `${tf} 在这个范围内没有完整 K 线。`;
    panel.empty = true;
    return panel;
  }
  const host = card.querySelector('.chart-host');
  panel.host = host;
  panel.chart = newChart(host);
  panel.series = panel.chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    borderVisible: false, lastValueVisible: false, priceLineVisible: false });
  panel.series.setData(item.candles);
  enablePriceZoom(panel.chart, panel.series, host);
  if (form.overlay) addOverlay(panel, preferences);
  addRides(panel);
  const count = rides.filter(r => r.minutes === interval).length;
  meta.textContent = `${item.candles.length.toLocaleString()} 根完整 K 线 · ${count} 个区间`;
  for (const event of ['pointerdown', 'wheel']) host.addEventListener(event, () => rangeLink?.activate(panel), { capture: true, passive: true });
  panel.chart.subscribeCrosshairMove(event => syncCrosshair(panel, typeof event.time === 'number' ? event.time : null));
  // A chart given its window before it had a size shows the wrong span: apply it again when first sized.
  panel.observer = new ResizeObserver(() => {
    if (!panel.sized && host.clientWidth > 0) {
      panel.sized = true;
      if (wantedRange) panel.chart.timeScale().setVisibleRange(wantedRange);
    }
  });
  panel.observer.observe(host);
  return panel;
}

function destroyPanels() {
  for (const panel of panels) { panel.observer?.disconnect(); panel.chart?.remove(); }
  panels = []; $('charts').replaceChildren();
}

function syncCrosshair(source, time) {
  if (syncing) return;
  syncing = true;
  try {
    // A hovered bar is judged as of its close, like the markers.
    paintSignalBar(time === null ? statusTime : time + source.interval * 60 - 60, time !== null);
    for (const panel of panels) {
      if (panel === source || panel.empty) continue;
      const step = panel.interval * 60;
      const t = time === null ? null : Math.floor(time / step) * step;
      const value = t === null ? undefined : panel.closes.get(t);
      if (Number.isFinite(value)) panel.chart.setCrosshairPosition(value, t, panel.series);
      else panel.chart.clearCrosshairPosition();
    }
  } finally { syncing = false; }
}

function showRange(range) { wantedRange = range; rangeLink?.set(range); }

// ---- Status bar ------------------------------------------------------------
// `t` is a 1m open time (seconds). Hovering shows the state when the pointed bar closed.
function paintSignalBar(t, hovered = false) {
  if (t === undefined || !result) { $('signal-text').textContent = ''; $('signal-advice').textContent = ''; return; }
  const state = signalStatus(rideData, t);
  const kind = hovered ? '所指 K 线收盘时' : selectedRide ? '区间开始时' : '最新';
  $('signal-text').textContent = `${kind} · ${stampFull(t + 60)} UTC　${state.text}`;
  // Always fill the advice line (grey when there is nothing to warn about) so the bar keeps the same height
  // while the mouse moves; a changing height shifted every chart below it and made the page shake.
  $('signal-advice').textContent = state.advice || '无提示：各周期都没有沿均线走';
  $('signal-advice').classList.toggle('calm', !state.advice);
}

// The condition the shown result was computed with: factor title/version plus every parameter value sent.
function paintCondition(factor, params) {
  if (!factor) { $('condition').textContent = ''; return; }
  const values = factor.params.map(spec => `${spec.label} ${params[spec.name]}`).join(' · ');
  $('condition-params').textContent = `当前触发条件（${factor.title} ${factor.version}）：${values || '无参数'}`;
  $('condition-text').textContent = factor.description ?? '';
}

function paintDataNote() {
  if (!result) { $('data-note').textContent = '还没有查找'; return; }
  const age = Math.max(0, Math.round((Date.now() / 1000 - result.last_candle_time) / 60));
  const stale = age > 10 ? `（距现在约 ${age >= 120 ? `${Math.round(age / 60)} 小时` : `${age} 分钟`}，可点“更新到最新”）` : '';
  $('data-note').textContent = `${result.symbol} · 数据到 ${stampFull(result.last_candle_time)} UTC（最后一根 1m K 线的开盘时间）${stale}`;
}

// ---- Ride list -------------------------------------------------------------
const shownRides = () => filterRides(rides, shownTfs);

// A long range has tens of thousands of intervals; building every button at once stalls the page, so the
// list is built in chunks: more are appended when the list is scrolled near its end, or when a ride further
// down is selected (上一个/下一个, clicking a chart).
const LIST_CHUNK = 300;
let listShown = [], listRendered = 0;
function rideButton(ride) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'trade ride';
  button.setAttribute('aria-pressed', String(ride === selectedRide));
  const head = document.createElement('strong');
  const side = document.createElement('span'); side.className = ride.dir > 0 ? 'up' : 'down'; side.textContent = arrow(ride.dir);
  head.append(document.createTextNode(`${ride.tf} `), side, document.createTextNode(` ${maText(ride.periods)}`));
  const details = document.createElement('small');
  details.textContent = `${stamp(ride.start)} UTC · ${ride.bars} 根${ride.ended ? '' : '（进行中）'}`;
  button.append(head, details);
  button.onclick = () => selectRide(ride);
  rideButtons.set(ride, button);
  return button;
}
function renderMoreRides(count) {
  const upto = Math.min(listShown.length, listRendered + count);
  if (upto <= listRendered) return;
  const fragment = document.createDocumentFragment();
  for (let i = listRendered; i < upto; i++) fragment.append(rideButton(listShown[i]));
  $('trades').append(fragment);
  listRendered = upto;
}
function ensureRendered(ride) {
  const i = listShown.indexOf(ride);
  if (i >= listRendered) renderMoreRides(i - listRendered + LIST_CHUNK);
}

function paintRides() {
  const list = shownRides();
  rideButtons.clear(); listShown = list; listRendered = 0;
  const box = $('trades'); box.replaceChildren();
  if (!list.length) {
    const none = document.createElement('p'); none.className = 'rides-empty';
    none.textContent = rides.length ? '没有勾选的周期' : '这个范围内没有找到区间'; box.append(none);
  }
  renderMoreRides(LIST_CHUNK);
  $('trade-count').textContent = `${list.length}/${rides.length} 个`;
  updateNav();
}

function paintFilter() {
  const filter = $('ride-filter'); filter.replaceChildren();
  for (const series of rideData) {
    const label = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = shownTfs.has(series.title);
    box.setAttribute('aria-label', `列表显示 ${series.title} 区间`);
    box.onchange = () => { if (box.checked) shownTfs.add(series.title); else shownTfs.delete(series.title); paintRides(); };
    const count = rides.filter(r => r.tf === series.title).length;
    label.append(box, document.createTextNode(`${series.title} ${count} 个`)); filter.append(label);
  }
}

function updateNav() {
  const list = shownRides();
  $('previous').disabled = !neighbour(list, selectedRide, -1);
  $('next').disabled = !neighbour(list, selectedRide, 1);
}

function selectRide(ride, focus = true) {
  const previous = selectedRide;
  selectedRide = ride; statusTime = ride.start;
  if (previous && rideButtons.has(previous)) rideButtons.get(previous).setAttribute('aria-pressed', 'false');
  ensureRendered(ride);
  rideButtons.get(ride)?.setAttribute('aria-pressed', 'true');
  rideButtons.get(ride)?.scrollIntoView?.({ block: 'nearest' });
  $('trade-info').textContent = `${ride.tf} ${arrow(ride.dir)} ${maText(ride.periods)} · ${stampFull(ride.start + 60)} UTC 起 · 持续 ${ride.bars} 根${ride.ended ? '' : '（进行中）'}${ride.maxTouches ? ` · 最多回踩 ${ride.maxTouches} 次` : ''}`;
  for (const panel of panels) panel.card.classList.toggle('chosen', panel.interval === ride.minutes);
  paintSignalBar(statusTime); updateNav();
  if (focus) showRange(centeredRange(ride.start, Number($('f-window').value)));
}

// The newest state: the newest 1m candle is the "now" of the status bar and every chart shows its right edge.
function gotoLatest() {
  if (!result) return;
  if (selectedRide) rideButtons.get(selectedRide)?.setAttribute('aria-pressed', 'false');
  selectedRide = null; statusTime = result.last_candle_time;
  for (const panel of panels) panel.card.classList.remove('chosen');
  $('trade-info').textContent = '最新：各周期在最后一根已收盘 K 线时的状态';
  paintSignalBar(statusTime); updateNav();
  const span = Number($('f-window').value);
  showRange({ from: result.last_candle_time + 60 - span * 0.95, to: result.last_candle_time + 60 + span * 0.05 });
}

// ---- Running ---------------------------------------------------------------
function render(data) {
  destroyPanels();
  result = data;
  const extra = rideExtra(data.timeframes);
  rideData = rideSeries(extra);
  rides = buildRides(extra, data.last_candle_time + 60);
  shownTfs = new Set(rideData.map(s => s.title)); selectedRide = null;
  let preferences;
  try { preferences = restorePreferences(localStorage.getItem(STORAGE_KEY)); } catch { preferences = restorePreferences(null); }
  const order = Object.keys(data.timeframes).sort((a, b) => timeframeMinutes(b) - timeframeMinutes(a));
  panels = order.map(tf => makePanel(tf, data.timeframes[tf], preferences));
  rangeLink = linkTimeRanges(panels.filter(p => !p.empty));
  $('results').hidden = false;
  paintFilter(); paintRides(); paintDataNote();
  $('f-latest').disabled = false;
  gotoLatest();
}

async function run() {
  readForm();
  const factor = currentFactor();
  if (!factor) return;
  const version = ++runVersion;
  $('f-run').disabled = true;
  try {
    const timeframes = form.timeframes[factor.name] ?? factor.timeframes;
    if (!timeframes.length) throw new Error('请至少勾选 1 个周期。');
    const params = selectedParams(factor);
    const body = runBody(form, factor.name, params, timeframes, Date.now());
    status('正在查找…');
    const data = await post('/factors/run', body);
    if (version !== runVersion) return;
    status('');
    render(data);
    paintCondition(factor, params);
  } catch (error) {
    if (version === runVersion) status(error.message, true);
  } finally { if (version === runVersion) $('f-run').disabled = false; }
}

// Pull the newest candles with the existing import API, then search again.
async function importLatest() {
  readForm();
  $('f-import').disabled = true;
  try {
    const id = crypto.randomUUID();
    await post('/candles/import', { id, exchange: form.exchange, symbol: form.symbol, start_date: importStartDate(Date.now()) });
    for (;;) {
      status('正在更新 K 线数据…');
      await new Promise(resolve => setTimeout(resolve, 2000));
      const state = await post('/candles/import-status', { id });
      if (state.progress?.percent !== undefined) status(`正在更新 K 线数据… ${Math.round(state.progress.percent)}%`);
      if (!importDone(state)) continue;
      if (state.status === 'failed') throw new Error(`更新失败：${state.error ?? '未知错误'}`);
      break;
    }
    status('');
    await run();
  } catch (error) { status(error.message, true); } finally { $('f-import').disabled = false; }
}

async function start() {
  try { token = JSON.parse(localStorage.getItem('main') ?? '{}').authToken; } catch { token = null; }
  if (!token) throw new Error('请先在同一地址的 Jesse 页面登录，再刷新此页。localhost 与 127.0.0.1 的登录状态不同。');
  paintForm();
  $('finder-form').onsubmit = event => { event.preventDefault(); run(); };
  $('f-import').onclick = importLatest;
  $('f-latest').onclick = gotoLatest;
  // #trades scrolls vertically (horizontally on narrow screens): load the next chunk near either end.
  $('trades').addEventListener('scroll', event => {
    const box = event.currentTarget;
    const nearEnd = box.scrollTop + box.clientHeight > box.scrollHeight - 400 || box.scrollLeft + box.clientWidth > box.scrollWidth - 400;
    if (nearEnd) renderMoreRides(LIST_CHUNK);
  }, { passive: true });
  $('f-range').onchange = () => {
    // A first switch to "custom" starts from the last 7 days instead of an empty box.
    if ($('f-range').value === 'custom' && !$('f-start').value) $('f-start').value = isoToLocal(Date.now() - 7 * 86400000);
    readForm(); $('f-custom').hidden = form.rangeMode !== 'custom';
  };
  for (const id of ['f-exchange', 'f-symbol', 'f-start', 'f-finish']) $(id).onchange = readForm;
  $('f-overlay').onchange = () => { readForm(); if (result) render(result); };
  $('f-window').onchange = () => {
    readForm();
    if (selectedRide) showRange(centeredRange(selectedRide.start, form.window)); else gotoLatest();
  };
  $('f-factor').onchange = () => { form.factor = $('f-factor').value; saveForm(); paintParams(); paintTimeframes(); $('f-run').disabled = !!currentFactor()?.error; };
  for (const [id, step] of [['previous', -1], ['next', 1]]) $(id).onclick = () => {
    const ride = neighbour(shownRides(), selectedRide, step); if (ride) selectRide(ride);
  };
  factors = await post('/factors/list');
  if (!factors.length) {
    $('data-note').textContent = '项目的 factors/ 文件夹里没有因子文件';
    status('没有找到因子文件。在项目目录的 factors/ 下放一个 <名字>.py（约定见复盘页 README 的“因子查找器”一节）。', true);
    $('f-run').disabled = true;
    return;
  }
  status('');
  paintFactors();
  paintDataNote();
  if (!currentFactor()?.error) await run();
}
start().catch(error => status(error.message, true));
