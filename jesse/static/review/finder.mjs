// Factor finder page: runs a factor file from the project's factors/ folder (POST /factors/run) on candles read
// straight from the database, and draws the intervals it finds like the signal mode of the review page.
// The page knows nothing about any rule; it draws the numbers the factor returns (+N / -N / 0 per bar).
import { t as createChart } from './lightweight-charts.mjs?v=20261113f';
import { sma, centeredRange, linkTimeRanges } from './data.mjs?v=20261113f';
import { enablePriceZoom } from './pricezoom.mjs?v=20261113f';
import { STORAGE_KEY, INDICATORS, timeframeLabel, timeframeMinutes, restorePreferences } from './settings.mjs?v=20261113f';
import { calculateIndicator } from './indicators.mjs?v=20261113f';
import { buildRides, rideSeries, maText, arrow, filterRides, neighbour, signalStatus, rideAnnotations, joinRideLines, rideSpan } from './rides.mjs?v=20261113f';
import { LIMIT_RULES, LIMIT_DEFAULTS, atr14, simulateOrder, summarize } from './limit-rules.mjs?v=20261113f';
import { FORM_KEY, RECENT_DAYS, WINDOWS, restoreForm, isoToLocal, clampParam, runBody, importStartDate, rideExtra, importDone } from './finder-data.mjs?v=20261113f';
import { addSnapshotButton, addMaximizeButton, captureCard, captureGrid, openAnnotator, screenshotSaver, utcStamp } from './snapshot.mjs?v=20261113f';
import { labelKey, labelCounts, entryOf, filterByLabel, countsText, LABEL_FILTERS, MARK_TEXT, KIND_TEXT, MARK_KINDS } from './labels.mjs?v=20261113f';

const $ = id => document.getElementById(id);
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 16);
const stampFull = seconds => `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16)}`;
const UP = '#16a082', DOWN = '#dd6070', SCALE_WIDTH = 72;
// Entry-price levels: darker than the ridden-SMA line so the two do not blend.
const UP_ENTRY = '#0b5e4c', DOWN_ENTRY = '#a3283a';
// Limit levels of orders that never traded (unfilled, or the next bar opened past the limit).
const GREY = '#9aa7b8';
const TIMEFRAME_CHOICES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D'];

let token, form, factors = [], result = null, rides = [], rideData = [], shownTfs = new Set();
let panels = [], selectedRide = null, statusTime, wantedRange, rangeLink, syncing = false, runVersion = 0;
const rideButtons = new Map();
// Labels of the signals on screen: `key -> {trend, order, note}`, as returned by POST /review/labels. A new run
// starts empty and reloads, so marks of another factor / symbol never show up here. `labelFilter` narrows the list.
let labels = {}, labelFilter = 'all';

try { form = restoreForm(localStorage.getItem(FORM_KEY)); } catch { form = restoreForm(null); }
const saveForm = () => { try { localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch { /* still works for this page */ } };
// Chart height is a per-browser display choice, kept apart from the finder form. The stylesheet shrinks
// .chart-host to 185px on short screens (laptops), which is too flat to read a chart; the chosen height
// overrides that through --chart-h (see review.css :root[data-chart-h]).
// "适应屏幕" (0) sizes the two chart rows to fill one screen: each card adds ~58px of title and footer
// around its chart and the rows are 12px apart, so 2 rows need 2h + ~135px; 170px leaves a small margin.
// v2 key: v1 saved the old 480px default, which hid the second row on laptops.
const HEIGHT_KEY = 'jesse.finder.chartHeight.v2';
const HEIGHTS = [[0, '适应屏幕'], [240, '矮'], [360, '中'], [480, '高'], [640, '很高']];
const DEFAULT_HEIGHT = 0;
const FIT_HEIGHT = 'max(200px, calc((100vh - 170px) / 2))';
function applyChartHeight(px) {
  document.documentElement.dataset.chartH = String(px);
  document.documentElement.style.setProperty('--chart-h', px ? `${px}px` : FIT_HEIGHT);
}
function paintHeight() {
  let px = DEFAULT_HEIGHT;
  try { const raw = localStorage.getItem(HEIGHT_KEY); const saved = Number(raw); if (raw !== null && HEIGHTS.some(([h]) => h === saved)) px = saved; } catch { /* default */ }
  const select = $('f-height');
  select.replaceChildren(...HEIGHTS.map(([h, label]) => { const o = document.createElement('option'); o.value = String(h); o.textContent = label; return o; }));
  select.value = String(px); applyChartHeight(px);
  // autoSize charts follow their host's new height on their own.
  select.onchange = () => { const h = Number(select.value); applyChartHeight(h); try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* this page only */ } };
}

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

// ---- Limit orders -----------------------------------------------------------
// The "挂单" controls: how the limit price of a signal is computed, and the stop / target / holding time used to
// judge the trade. The math is in limit-rules.mjs; the values are saved with the rest of the finder form.
const REASON_TEXT = { target: '止盈', stop: '止损', time: '超时', open: '进行中' };
const LIMIT_FIELDS = [['f-limit-x', 'x', 0.05], ['f-limit-y', 'y', 0.05], ['f-limit-k', 'k', 0.1],
  ['f-limit-r', 'r', 0.5], ['f-limit-hold', 'hold', 1]];
const limitOptions = () => ({ ...LIMIT_DEFAULTS, ...form.limit });
const percent = value => `${Math.round(value * 100)}%`;
const signedR = value => `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}R`;

function paintLimit() {
  const select = $('f-limit-rule');
  select.replaceChildren(...LIMIT_RULES.map(rule => {
    const option = document.createElement('option'); option.value = rule.id; option.textContent = rule.label; return option;
  }));
  select.value = limitOptions().rule;
  select.onchange = () => { form.limit.rule = select.value; saveForm(); repaintOrders(); };
  for (const [id, key, step] of LIMIT_FIELDS) {
    const input = $(id);
    input.step = step; input.value = String(form.limit[key]);
    input.onchange = () => {
      // A blank box, or a value that cannot size a stop (k/r must stay above 0), falls back to the default
      // instead of drawing nonsense; hold is whole bars, at least 1.
      const raw = Number(input.value);
      const minimum = key === 'hold' ? 1 : key === 'k' || key === 'r' ? 0.01 : 0;
      let value = Number.isFinite(raw) && raw >= minimum ? raw : LIMIT_DEFAULTS[key];
      if (key === 'hold') value = Math.max(1, Math.round(value));
      input.value = String(value); form.limit[key] = value; saveForm(); repaintOrders();
    };
  }
}

// Limit-order settings only change the drawing: redraw from the same result and keep the selected signal.
function repaintOrders() {
  if (!result) return;
  const keep = selectedRide;
  render(result);
  const again = keep && rides.find(ride => ride.tf === keep.tf && ride.start === keep.start && ride.dir === keep.dir);
  if (again) selectRide(again, false);
}

// One order per signal of this timeframe. The order stays in force while the ride lasts, so it gets the ride's
// last bar and whether the ride already ended (see simulateOrder); ATR is computed once per chart and handed
// down (opts.atr), so a long range stays linear. `price` is the level the page labels the order with: the price
// it was filled at, or — when it never filled — the last price it would have had.
function ordersFor(panel) {
  const opts = limitOptions();
  const atr = atr14(panel.candles);
  const orders = [];
  for (const ride of rides) {
    if (ride.minutes !== panel.interval) continue;
    const span = rideSpan(panel.candles, ride);
    if (!span) continue;
    const sim = simulateOrder(panel.candles, span.first, ride.dir, opts.rule,
      { ...opts, atr, lastIndex: span.last, ended: ride.ended });
    const price = sim?.fillPrice ?? sim?.path?.at(-1)?.price ?? null;
    orders.push({ ride, price, sim });
  }
  return orders;
}

const orderOf = ride => panels.find(panel => panel.interval === ride.minutes && !panel.empty)
  ?.orders?.find(order => order.ride === ride) ?? null;

// The selected signal's order in words: how many bars it waited, the price it filled at (or that it never did),
// how many bars opened past it, then stop / target, result and exit reason.
function orderText(order) {
  if (!order) return '';
  if (order.price === null) return ' · 挂单：这个信号的数据还不够算挂单价';
  const sim = order.sim;
  if (!sim) return ' · 挂单：数据不够，无法判断成交';
  const filled = sim.status === 'filled' || sim.status === 'open';
  const head = [filled ? `第 ${sim.waitBars} 根成交，挂单价 ${sim.fillPrice.toFixed(2)}`
    : sim.status === 'unfilled' ? `趋势结束仍没成交（等了 ${sim.waitBars} 根）`
      : `等待成交（已等 ${sim.waitBars} 根）`];
  if (sim.gapFill) head.push('开盘就越过挂单价，按开盘价成交');
  if (!filled) return ` · ${head.join(' · ')}`;
  head.push(`止损 ${sim.stop.toFixed(2)}`, `止盈 ${sim.target.toFixed(2)}`);
  if (sim.status === 'filled') head.push(`${signedR(sim.R)}（${REASON_TEXT[sim.reason]}，第 ${sim.exitIndex - sim.fillIndex + 1} 根离场）`);
  return ` · ${head.join(' · ')}`;
}

// The rule in force plus, per timeframe, how its signals would have done as limit orders.
function paintLimitSummary() {
  const box = $('limit-summary');
  const rows = panels.filter(panel => panel.summary);
  if (!result || !rows.length) { box.replaceChildren(); return; }
  const opts = limitOptions();
  const head = document.createElement('strong');
  head.textContent = `挂单：${LIMIT_RULES.find(rule => rule.id === opts.rule)?.label ?? opts.rule}`
    + `（x ${opts.x} · y ${opts.y} · 止损 ${opts.k}·ATR · 止盈 ${opts.r}R · 最多 ${opts.hold} 根）`;
  const list = document.createElement('span');
  list.className = 'finder-limit-list';
  for (const panel of rows) {
    const totals = panel.summary;
    const closed = panel.orders.filter(order => order.sim?.status === 'filled').length;
    // With no closed trade the win rate and the R totals have nothing to say: a dash, not 0%.
    const tail = closed ? `胜率 ${percent(totals.winRate)} · 平均 ${signedR(totals.avgR)} · 合计 ${signedR(totals.sumR)}`
      : '胜率 — · 平均 — · 合计 —';
    list.append(`${timeframeLabel(panel.interval)} 标记 ${totals.marks} · 成交率 ${percent(totals.fillRate)}`
      + ` · 等待中 ${totals.waiting} · ${tail}　`);
  }
  box.replaceChildren(head, list);
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
    // Normal (0) not the default Magnet: the vertical line still snaps to bars, the horizontal one follows the
    // mouse so any price level can be read off the scale.
    crosshair: { mode: 0 },
  });
}

// The ridden SMA of all intervals is one thick line series; the segments between intervals are transparent
// (see joinRideLines). One series per interval froze the page on long ranges. The limit level of every signal is
// a staircase: one level per bar the order sat there with (the rule re-computed it at every close), from the
// signal bar to the bar that filled it — dark for an order that was filled, grey for one that never traded —
// plus a marker at the fill and one at the exit.
function addRides(panel) {
  const cache = new Map();
  const smaFor = period => {
    if (!cache.has(period)) cache.set(period, new Map(sma(panel.candles, period, panel.interval).filter(p => Number.isFinite(p.value)).map(p => [p.time, p.value])));
    return cache.get(period);
  };
  const { markers, lines } = rideAnnotations(panel.candles, rides.filter(r => r.minutes === panel.interval), smaFor);
  const orders = ordersFor(panel);
  panel.orders = orders;
  panel.summary = summarize(orders.map(order => order.sim));
  const levels = { up: [], down: [] }, untraded = { up: [], down: [] }, pending = { up: [], down: [] };
  const stops = { up: [], down: [] }, targets = { up: [], down: [] };
  const last = panel.candles.length - 1;
  // A flat segment at `value` over bars from..to (inclusive, clipped to the chart).
  const flat = (from, to, value) => {
    const out = [];
    for (let i = from; i <= Math.min(to, last); i++) out.push({ time: panel.candles[i].time, value });
    return out;
  };
  // The order's staircase: one point per `path` entry (the price its close set), then the last price held to
  // `end` — the bar that filled the order, or the bar the order was cancelled on.
  const staircase = (path, end) => {
    const out = path.filter(point => point.index <= last).map(point => ({ time: panel.candles[point.index].time, value: point.price }));
    const tail = path.at(-1), stop = Math.min(end, last);
    if (tail && stop > tail.index) out.push({ time: panel.candles[stop].time, value: tail.price });
    return out;
  };
  for (const { ride, price, sim } of orders) {
    if (price === null || !sim?.path?.length) continue;
    // Never filled: the grey staircase still shows where the order sat until the trend ended (or, while the
    // data runs out first, a grey dashed one to the last bar).
    if (sim.status === 'unfilled') { untraded.up.push(staircase(sim.path, sim.path.at(-1).index + 1)); continue; }
    if (sim.status === 'waiting') { pending.up.push(staircase(sim.path, last)); continue; }
    // A traded order: the staircase runs from the signal bar to the fill bar, then the entry price stays level to
    // the exit (or the last bar while still open), with its stop and target as dashed levels over the same bars.
    const end = sim.status === 'filled' ? sim.exitIndex : last;
    const entry = staircase(sim.path, sim.fillIndex);
    entry.push(...flat(sim.fillIndex + 1, end, sim.fillPrice));
    (ride.dir > 0 ? levels.up : levels.down).push(entry);
    if (Number.isFinite(sim.stop)) stops.up.push(flat(sim.fillIndex, end, sim.stop));
    if (Number.isFinite(sim.target)) targets.up.push(flat(sim.fillIndex, end, sim.target));
    {
      // This chart library has no triangle shape: the arrow points at the fill from the side the price came
      // from (down into a buy limit, up into a sell limit), which reads the same.
      const fill = panel.candles[sim.fillIndex];
      markers.push({ time: fill.time, position: ride.dir > 0 ? 'aboveBar' : 'belowBar',
        shape: ride.dir > 0 ? 'arrowDown' : 'arrowUp', color: ride.dir > 0 ? UP_ENTRY : DOWN_ENTRY,
        // "挂 …" read as "an order is waiting here" (2026-11-13, the user asked whether it was a pending order or an
        // entry): it is the fill, so it says 多/空 + 成交.
        text: `${ride.dir > 0 ? '多' : '空'}单成交 ${sim.fillPrice.toLocaleString('en-US', { maximumFractionDigits: sim.fillPrice >= 100 ? 0 : 4 })}` });
      if (sim.status === 'filled') markers.push({ time: panel.candles[sim.exitIndex].time, position: 'aboveBar',
        shape: 'circle', color: sim.R >= 0 ? UP : DOWN,
        text: `平仓 ${sim.R >= 0 ? '+' : '-'}${Math.abs(sim.R).toFixed(1)}R` });
    }
  }
  panel.series.setMarkers(markers.sort((a, b) => a.time - b.time));
  const data = joinRideLines(lines, { up: UP, down: DOWN });
  if (data.length) {
    const line = panel.chart.addLineSeries({ color: UP, lineWidth: 4, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(data);
  }
  const levelData = joinRideLines(levels, { up: UP_ENTRY, down: DOWN_ENTRY });
  if (levelData.length) {
    const line = panel.chart.addLineSeries({ color: UP_ENTRY, lineWidth: 3, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(levelData);
  }
  const untradedData = joinRideLines(untraded, { up: GREY, down: GREY });
  if (untradedData.length) {
    const line = panel.chart.addLineSeries({ color: GREY, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(untradedData);
  }
  // Still waiting for a fill: dashed, because nothing has been decided for this order yet.
  const pendingData = joinRideLines(pending, { up: GREY, down: GREY });
  if (pendingData.length) {
    const line = panel.chart.addLineSeries({ color: GREY, lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(pendingData);
  }
  for (const [lines, color] of [[stops, DOWN], [targets, UP]]) {
    const dashed = joinRideLines(lines, { up: color, down: color });
    if (!dashed.length) continue;
    const line = panel.chart.addLineSeries({ color, lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(dashed);
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

// ---- Snapshots -------------------------------------------------------------
// Title bar of one card's snapshot: the timeframe on the left, symbol plus the selected interval (or the
// status bar text when nothing is selected) on the right.
function snapshotCaption(panel) {
  const info = $('trade-info').textContent.trim() || $('signal-text').textContent.trim() || '未选择区间';
  return { title: timeframeLabel(panel.interval), subtitle: `${result?.symbol ?? form.symbol} · ${info}` };
}
function openSnapshot(canvas, label) {
  openAnnotator(canvas, { onSave: screenshotSaver(post, label), fileLabel: label });
}
function snapshotPanel(panel) {
  if (!panel || panel.empty) return;
  const label = `finder-${timeframeLabel(panel.interval)}`;
  openSnapshot(captureCard(panel.card, [panel.chart], snapshotCaption(panel)), label);
}
function snapshotAll() {
  const shown = panels.filter(panel => !panel.empty);
  if (!shown.length) { status('还没有可以截图的结果，先点“查找”。', true); return; }
  const info = $('trade-info').textContent.trim() || $('signal-text').textContent.trim() || '最新';
  const header = `因子查找器 · ${result?.symbol ?? form.symbol} · ${utcStamp()} UTC · ${info}`;
  openSnapshot(captureGrid(shown.map(panel => captureCard(panel.card, [panel.chart], snapshotCaption(panel))), 2, header), 'finder-all');
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
  addSnapshotButton(card, () => snapshotPanel(panel));
  addMaximizeButton(card);
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

// keepSpan: move to the range but keep each chart's own zoom (signal navigation); without it every chart
// gets exactly `range` (a new window choice). `at` is the fraction of the range that holds the moment of interest.
function showRange(range, keepSpan = false, at = 0.5) { wantedRange = range; rangeLink?.set(range, { keepSpan, at }); }

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
// The timeframe filter and the label filter both narrow the list; the counts above it only follow the timeframe
// filter, otherwise marking a signal would change the number of "unlabeled" it was just counted in.
const tfRides = () => filterRides(rides, shownTfs);
const shownRides = () => filterByLabel(tfRides(), labels, labelFilter);

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
  // The marks of the review pass on the right of the row: 势✓ / 势✗ for the trend judgement, 挂✓ / 挂✗ for the limit
  // order, only the ones that were made, the note on hover.
  const entry = entryOf(labels, ride.key);
  const marks = document.createElement('span');
  marks.className = 'label-marks';
  if (entry.note) marks.title = entry.note;
  for (const kind of MARK_KINDS) {
    if (!entry[kind]) continue;
    const mark = document.createElement('span');
    mark.className = `label-mark ${kind} ${entry[kind]}`;
    mark.textContent = MARK_TEXT[kind][entry[kind]];
    marks.append(mark);
  }
  head.append(marks);
  const details = document.createElement('small');
  details.textContent = `${stamp(ride.start + 60)} UTC · ${ride.bars} 根${ride.ended ? '' : '（进行中）'}`;
  button.append(head, details);
  // The note itself on the row (one line, cut with …), not only on hover: the user could not see what was written
  // and so could not tell which notes to fix (2026-11-13).
  if (entry.note) {
    const note = document.createElement('small');
    note.className = 'label-note-text'; note.textContent = `备注：${entry.note}`; note.title = entry.note;
    button.append(note);
  }
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
    // Say which filter emptied the list, otherwise an empty list after pressing g looks like a lost result.
    none.textContent = !rides.length ? '这个范围内没有找到区间'
      : labelFilter === 'all' ? '没有勾选的周期'
      : `没有“${LABEL_FILTERS.find(([id]) => id === labelFilter)?.[1] ?? labelFilter}”标注的信号，点“全部”看回所有`;
    box.append(none);
  }
  renderMoreRides(LIST_CHUNK);
  $('trade-count').textContent = `${list.length}/${rides.length} 个`;
  $('ride-latest').disabled = !list.length;
  paintLabelBar(); updateNav();
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

// ---- Labels ----------------------------------------------------------------
// Marking a signal appends one line to the project's storage/labels/finder-labels.jsonl (POST /review/label), which
// is what the person (or Claude) reads afterwards instead of a screenshot per signal. A signal carries two marks —
// `trend` (should this signal exist at all) and `order` (was the limit price / fill / exit usable) — plus one note,
// so a “坏” says which of the two was wrong. The page keeps the current state per key in `labels` and only mirrors
// the file; the file itself is append-only and never rewritten here.

// The info line of the selected signal, the two marks included: the verdicts can be read without looking back at
// the list. Repainted after marking, so a fresh mark shows up immediately.
let selectedOrder = null;
function paintTradeInfo(ride) {
  const entry = entryOf(labels, ride.key);
  const marks = MARK_KINDS.map(kind => `${KIND_TEXT[kind]}${entry[kind] === 'good' ? '✓' : entry[kind] === 'bad' ? '✗' : '—'}`).join(' ');
  paintNoteShow(entry.note);
  $('trade-info').textContent = `${ride.tf} ${arrow(ride.dir)} ${maText(ride.periods)} · ${stampFull(ride.start + 60)} UTC 起${orderText(selectedOrder)} · 持续 ${ride.bars} 根${ride.ended ? '' : '（进行中）'}${ride.maxTouches ? ` · 最多回踩 ${ride.maxTouches} 次` : ''} · ${marks}${entry.note ? ` · 备注：${entry.note}` : ''}`;
}

// The factor run the marks belong to. The result's own identity, not the form's: the user may already have
// picked another factor / symbol in the form without running it, and a mark must still describe what is on screen.
const runIdentity = () => ({ factor: result?.factor ?? form.factor, exchange: result?.exchange ?? form.exchange,
  symbol: result?.symbol ?? form.symbol });

// Every ride needs its key before the list is drawn or the keys are pressed.
function keyRides() {
  const identity = runIdentity();
  for (const ride of rides) ride.key = labelKey(identity, ride);
}

function paintLabelBar() {
  $('label-counts').textContent = countsText(labelCounts(tfRides(), labels));
  for (const button of $('label-filter').children) button.setAttribute('aria-pressed', String(button.dataset.filter === labelFilter));
}

function buildLabelFilter() {
  $('label-filter').replaceChildren(...LABEL_FILTERS.map(([id, text]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.filter = id; button.textContent = text;
    button.onclick = () => { labelFilter = id; paintRides(); };
    return button;
  }));
}

// What the 挂单 row would trade for this signal right now, saved with the mark so the reader of the file knows
// which order was on screen when the signal was judged.
function orderPayload(ride) {
  const order = orderOf(ride);
  if (!order) return null;
  const sim = order.sim;
  return { rule: limitOptions().rule, price: order.price, status: sim?.status ?? null,
    waitBars: sim?.waitBars ?? null, fillPrice: sim?.fillPrice ?? null,
    stop: sim?.stop ?? null, target: sim?.target ?? null, R: sim?.R ?? null };
}

// One line of the file: a mark (`kind` trend / order, `label` good / bad / clear) or the note (`kind` note). The
// request also carries the note and the order that was on screen, so the row explains itself long after the screen
// is gone. The local mirror is updated from the same values, so the list repaints without waiting for a reload.
async function saveLabel(ride, kind, label, note) {
  const entry = entryOf(labels, ride.key);
  const text = kind === 'note' ? (note ?? '') : entry.note;
  await post('/review/label', {
    key: ride.key, ...runIdentity(), version: result?.version ?? null, params: result?.params ?? {},
    tf: ride.tf, start: ride.start, dir: ride.dir, kind, label: label ?? undefined, note: text,
    order: orderPayload(ride),
  });
  const next = { ...entry, note: text };
  if (kind !== 'note') next[kind] = label === 'clear' ? null : label;
  if (next.trend || next.order || next.note) labels[ride.key] = next;
  else delete labels[ride.key];
  if (selectedRide === ride) paintTradeInfo(ride);
  refreshRideRow(ride);
}

// After a mark, only that row changes. Rebuilding the whole list put it back at the top with only the first chunk
// rendered, so marking from the newest signal threw the view to the oldest one (2026-11-13, the user: "标注以后又
// 跳回首个信号"). The full rebuild is only needed when a label filter is on (the row may drop out of the list); then
// the selected signal is rendered and scrolled back into view.
function refreshRideRow(ride) {
  const old = rideButtons.get(ride);
  if (labelFilter === 'all' && old) {
    old.replaceWith(rideButton(ride));
    paintLabelBar(); updateNav();
    return;
  }
  paintRides();
  if (selectedRide && listShown.includes(selectedRide)) {
    ensureRendered(selectedRide);
    rideButtons.get(selectedRide)?.scrollIntoView?.({ block: 'nearest' });
  }
}

// g / b (trend) and f / v (order): mark the selected signal. It moves on only when both marks are in, or right
// away when the trend judgement is wrong — a signal that should not exist needs no verdict on its limit order.
async function markSelected(kind, label) {
  const ride = selectedRide;
  if (!ride) { status('先选一个信号（← → 或 k j），再按 g / b / f / v。', true); return; }
  try { await saveLabel(ride, kind, label); }
  catch (error) { status(error.message, true); return; }
  const what = `${KIND_TEXT[kind]}${label === 'good' ? '好' : '坏'}`;
  const entry = entryOf(labels, ride.key);
  if (entry.trend !== 'bad' && !(entry.trend && entry.order)) {
    const other = kind === 'trend' ? KIND_TEXT.order : KIND_TEXT.trend;
    status(`已标${what}：${ride.tf} ${stamp(ride.start + 60)} UTC（再标${other}）`);
    return;
  }
  // The list was just repainted (a filter may have dropped this signal), so look for the next one there.
  const next = neighbour(shownRides(), ride, navStep);
  if (next) { status(''); selectRide(next); }
  else status(`已标${what}：${ride.tf} ${stamp(ride.start + 60)} UTC（列表里没有下一个了）`);
}

// 0: drop both marks of the selected signal. The note is its own item and stays (an empty note removes it).
async function clearMarks() {
  const ride = selectedRide;
  if (!ride) { status('先选一个信号（← → 或 k j），再按 0。', true); return; }
  try { for (const kind of MARK_KINDS) await saveLabel(ride, kind, 'clear'); }
  catch (error) { status(error.message, true); return; }
  status(`已清除两项标注：${ride.tf} ${stamp(ride.start + 60)} UTC`);
}

function openNote() {
  const ride = selectedRide;
  if (!ride) { status('先选一个信号，再按 n 写备注。', true); return; }
  $('note-row').hidden = false; $('note-show').hidden = true;
  $('note-input').value = entryOf(labels, ride.key).note;
  $('note-hint').textContent = '';
  $('note-input').focus();
  $('note-input').select();
}

function closeNote() {
  $('note-row').hidden = true; $('note-hint').textContent = ''; $('note-input').value = '';
  paintNoteShow(selectedRide ? entryOf(labels, selectedRide.key).note : '');
}

// Enter in the note box: the note is its own row (kind=note), so it no longer waits for a good / bad mark. An empty
// box removes the note. Esc leaves without saving.
// The selected signal's note above the list, always in view; a click (or n) opens it for editing.
function paintNoteShow(note) {
  const box = $('note-show');
  box.hidden = !note || !$('note-row').hidden;
  box.textContent = note ? `备注：${note}（点这里或按 n 修改）` : '';
}

async function submitNote() {
  const ride = selectedRide;
  if (!ride) { closeNote(); return; }
  const text = $('note-input').value.trim().slice(0, 500);
  try { await saveLabel(ride, 'note', null, text); closeNote(); status(text ? '备注已保存' : '备注已清除'); }
  catch (error) { $('note-hint').textContent = error.message; }
}

// The saved marks of this factor / exchange / symbol, so reopening the page or switching back shows them.
async function loadLabels(version) {
  try {
    const data = await post('/review/labels', runIdentity());
    if (version !== runVersion) return;
    labels = data.labels ?? {};
  } catch {
    if (version !== runVersion) return;
    labels = {};
  }
  paintRides();
}

// Keys are ignored while a text field or a select has the focus: typing a param must not mark a signal or jump.
const typing = () => {
  const active = document.activeElement;
  return !!active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA'
    || active.isContentEditable);
};

function onKeydown(event) {
  if (!result || event.metaKey || event.ctrlKey || event.altKey) return;
  // Esc closes the note box even while the cursor sits in it.
  if (event.key === 'Escape' && !$('note-row').hidden) { closeNote(); return; }
  if (typing()) return;
  const key = event.key;
  if (key === 'ArrowLeft' || key === 'k' || key === 'K') { event.preventDefault(); stepRide(-1); }
  else if (key === 'ArrowRight' || key === 'j' || key === 'J') { event.preventDefault(); stepRide(1); }
  // 趋势 on g / b and 挂单 on f / v: on the keyboard f / v sit just left of g / b.
  else if (key === 'g' || key === 'G') { event.preventDefault(); markSelected('trend', 'good'); }
  else if (key === 'b' || key === 'B') { event.preventDefault(); markSelected('trend', 'bad'); }
  else if (key === 'f' || key === 'F') { event.preventDefault(); markSelected('order', 'good'); }
  else if (key === 'v' || key === 'V') { event.preventDefault(); markSelected('order', 'bad'); }
  else if (key === '0') { event.preventDefault(); clearMarks(); }
  else if (key === 'n' || key === 'N') { event.preventDefault(); openNote(); }
}

// Direction of the last move through the list: marking moves on the same way. Starting from 最新信号 and going
// back in time (←) must keep going back after a mark, not forward past the end.
let navStep = 1;
function stepRide(step) {
  navStep = step;
  const ride = neighbour(shownRides(), selectedRide, step);
  if (ride) selectRide(ride);
}

function selectRide(ride, focus = true) {
  // The note box belongs to the signal that was selected when it was opened: drop it when the selection moves.
  if (ride !== selectedRide && !$('note-row').hidden) closeNote();
  const previous = selectedRide;
  selectedRide = ride; statusTime = ride.start;
  if (previous && rideButtons.has(previous)) rideButtons.get(previous).setAttribute('aria-pressed', 'false');
  ensureRendered(ride);
  rideButtons.get(ride)?.setAttribute('aria-pressed', 'true');
  rideButtons.get(ride)?.scrollIntoView?.({ block: 'nearest' });
  // The selected signal's limit price as a dashed line with an axis label, on its own timeframe's chart.
  let order = null;
  for (const panel of panels) {
    panel.card.classList.toggle('chosen', panel.interval === ride.minutes);
    if (panel.limitLine) { panel.series.removePriceLine(panel.limitLine); panel.limitLine = null; }
    for (const extra of panel.orderLines ?? []) panel.series.removePriceLine(extra);
    panel.orderLines = [];
    if (panel.interval !== ride.minutes || !panel.candles?.length) continue;
    order = orderOf(ride);
    if (order?.price != null) panel.limitLine = panel.series.createPriceLine({ price: order.price, color: ride.dir > 0 ? UP_ENTRY : DOWN_ENTRY,
      lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
      // Filled orders show their entry price; only an order that never traded is still a 挂单.
      title: order.sim?.status === 'filled' || order.sim?.status === 'open' ? '入场' : '挂单（未成交）' });
    // Stop and target of a traded order, so all three prices can be read off the scale.
    if (order?.sim && (order.sim.status === 'filled' || order.sim.status === 'open')) {
      for (const [price, color, title] of [[order.sim.stop, DOWN, '止损'], [order.sim.target, UP, '止盈']]) {
        if (Number.isFinite(price)) panel.orderLines.push(panel.series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
      }
    }
  }
  selectedOrder = order;
  paintTradeInfo(ride);
  paintSignalBar(statusTime); updateNav();
  if (focus) showRange(centeredRange(ride.start, Number($('f-window').value)), true, 0.75);
}

// The newest state: the newest 1m candle is the "now" of the status bar and every chart shows its right edge.
function gotoLatest(keepSpan = true) {
  if (!result) return;
  if (selectedRide) rideButtons.get(selectedRide)?.setAttribute('aria-pressed', 'false');
  selectedRide = null; statusTime = result.last_candle_time;
  selectedOrder = null;
  for (const panel of panels) panel.card.classList.remove('chosen');
  $('trade-info').textContent = '最新：各周期在最后一根已收盘 K 线时的状态';
  paintSignalBar(statusTime); updateNav();
  const span = Number($('f-window').value);
  showRange({ from: result.last_candle_time + 60 - span * 0.95, to: result.last_candle_time + 60 + span * 0.05 }, keepSpan, 0.95);
}

// ---- Running ---------------------------------------------------------------
function render(data) {
  destroyPanels();
  result = data;
  const extra = rideExtra(data.timeframes);
  rideData = rideSeries(extra);
  rides = buildRides(extra, data.last_candle_time + 60);
  keyRides();
  shownTfs = new Set(rideData.map(s => s.title)); selectedRide = null;
  let preferences;
  try { preferences = restorePreferences(localStorage.getItem(STORAGE_KEY)); } catch { preferences = restorePreferences(null); }
  const order = Object.keys(data.timeframes).sort((a, b) => timeframeMinutes(b) - timeframeMinutes(a));
  panels = order.map(tf => makePanel(tf, data.timeframes[tf], preferences));
  rangeLink = linkTimeRanges(panels.filter(p => !p.empty));
  $('results').hidden = false;
  paintFilter(); paintRides(); paintDataNote(); paintLimitSummary();
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
    // Marks belong to the previous factor / exchange / symbol: start empty and load this run's own marks.
    labels = {};
    render(data);
    paintCondition(factor, params);
    await loadLabels(version);
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
  paintForm(); paintHeight(); paintLimit(); buildLabelFilter();
  // g / b / f / v mark the selected signal (and step on once both marks are in), 0 clears both, n writes the note;
  // ← → / k j walk the list. The note box has its own keys.
  document.addEventListener('keydown', onKeydown);
  $('note-input').onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); submitNote(); }
  };
  $('note-show').onclick = openNote;
  $('finder-form').onsubmit = event => { event.preventDefault(); run(); };
  $('f-import').onclick = importLatest;
  $('f-latest').onclick = () => gotoLatest();
  $('snapshot-all').onclick = snapshotAll;
  // The list is start-ordered, so its last ride is the newest; selectRide renders the chunks up to it and scrolls there.
  $('ride-latest').onclick = () => { const list = shownRides(); navStep = -1; if (list.length) selectRide(list[list.length - 1]); };
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
    if (selectedRide) showRange(centeredRange(selectedRide.start, form.window)); else gotoLatest(false);
  };
  $('f-factor').onchange = () => { form.factor = $('f-factor').value; saveForm(); paintParams(); paintTimeframes(); $('f-run').disabled = !!currentFactor()?.error; };
  for (const [id, step] of [['previous', -1], ['next', 1]]) $(id).onclick = () => {
    navStep = step;
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
