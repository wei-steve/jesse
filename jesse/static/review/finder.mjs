// Factor finder page: runs a factor file from the project's factors/ folder (POST /factors/run) on candles read
// straight from the database, and draws the intervals it finds like the signal mode of the review page.
// The page knows nothing about any rule; it draws the numbers the factor returns (+N / -N / 0 per bar).
import { t as createChart } from './lightweight-charts.mjs?v=20261115g';
import { sma, centeredRange, linkTimeRanges } from './data.mjs?v=20261115g';
import { enablePriceZoom } from './pricezoom.mjs?v=20261115g';
import { STORAGE_KEY, INDICATORS, timeframeLabel, timeframeMinutes, restorePreferences } from './settings.mjs?v=20261115g';
import { calculateIndicator } from './indicators.mjs?v=20261115g';
import { buildRides, rideSeries, maText, arrow, filterRides, neighbour, signalStatus, rideAnnotations, joinRideLines, rideSpan } from './rides.mjs?v=20261115g';
import { LIMIT_RULES, LIMIT_DEFAULTS, FEES, atr14, simulateOrder, summarize } from './limit-rules.mjs?v=20261115g';
import { FORM_KEY, RECENT_DAYS, WINDOWS, restoreForm, isoToLocal, clampParam, runBody, importStartDate, rideExtra, importDone, barSnapshot,
  nextTickDelay, newKeys, atRightEdge, shiftRange } from './finder-data.mjs?v=20261115g';
import { streamUrl, openTicker } from './live-price.mjs?v=20261115g';
import { addSnapshotButton, addMaximizeButton, captureCard, captureGrid, openAnnotator, screenshotSaver, utcStamp } from './snapshot.mjs?v=20261115g';
import { labelKey, labelCounts, entryOf, filterByLabel, countsText, LABEL_FILTERS, MARK_TEXT, KIND_TEXT, MARK_KINDS,
  barKey, barNoteOf, barLabel, barMarkers } from './labels.mjs?v=20261115g';

const $ = id => document.getElementById(id);
const stamp = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(5, 16);
const stampFull = seconds => `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16)}`;
const UP = '#16a082', DOWN = '#dd6070', SCALE_WIDTH = 72;
// Entry-price levels: darker than the ridden-SMA line so the two do not blend.
const UP_ENTRY = '#0b5e4c', DOWN_ENTRY = '#a3283a';
// The selected signal's fill and exit markers: one colour no other marker uses, so it stands out when several
// entries sit close together (2026-11-13, the user asked for it).
const CHOSEN = '#f59e0b';
const LIVE_PRICE = '#f19aa4';
// Limit levels of orders that never traded (unfilled, or the next bar opened past the limit).
const GREY = '#9aa7b8';
const TIMEFRAME_CHOICES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D'];

let token, form, factors = [], result = null, rides = [], rideData = [], shownTfs = new Set();
let panels = [], selectedRide = null, statusTime, wantedRange, rangeLink, syncing = false, runVersion = 0;
const rideButtons = new Map();
// 「实时（每分钟）」 state: the pending timer, whether a round is running, how many rounds failed in a row, when the
// last one landed, the answer a round could not draw yet (the owner was typing) and the keys to blink in the list.
let liveTimer = null, liveBusy = false, manualBusy = false, liveFails = 0, liveUpdatedAt = 0, pendingLive = null;
let freshKeys = new Set(), freshTimer = null;
// Labels of the signals on screen: `key -> {trend, order, note}`, as returned by POST /review/labels. A new run
// starts empty and reloads, so marks of another factor / symbol never show up here. `labelFilter` narrows the list.
let labels = {}, labelFilter = 'all';
// Candle notes of the same answer (`bars`): `key -> {note, tf, time}`, drawn as a purple 「注」 on the candle of their
// own timeframe (labels.mjs). Kept apart from `labels` because a candle is not a signal.
let barNotes = {};

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
  $('f-live').checked = form.live;
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
  form.live = $('f-live').checked;
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
  if (sim.status === 'filled') head.push(`${signedR(sim.R)}（含手续费 ${signedR(-sim.feeR)}，${REASON_TEXT[sim.reason]}，第 ${sim.exitIndex - sim.fillIndex + 1} 根离场）`);
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
    + `（x ${opts.x} · y ${opts.y} · 止损 ${opts.k}·ATR · 止盈 ${opts.r}R · 最多 ${opts.hold} 根）`
    + ` · R 已扣手续费（挂单 ${FEES.maker * 100}% / 吃单 ${FEES.taker * 100}%）`;
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

// Hands the panel's markers to the chart, the selected signal's fill/exit recoloured (and a bit bigger). The
// ride tag is ours, so it is stripped before the library sees the marker. The purple squares of the noted candles on
// this timeframe are added the same way, so a re-paint (selection, new note) keeps both on the chart; they carry no
// ride, so selecting a signal never recolours a note.
function paintMarkers(panel) {
  if (!panel.markers || !panel.series) return;
  const marks = [...panel.markers, ...barMarkers(barNotes, panel.tf, time => panel.closes.has(time))]
    .sort((a, b) => a.time - b.time);
  panel.series.setMarkers(marks.map(({ ride, bar, ...marker }) =>
    ride && ride === selectedRide ? { ...marker, color: CHOSEN, size: 2, text: `▶ ${marker.text}` } : marker));
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
      markers.push({ ride, time: fill.time, position: ride.dir > 0 ? 'aboveBar' : 'belowBar',
        shape: ride.dir > 0 ? 'arrowDown' : 'arrowUp', color: ride.dir > 0 ? UP_ENTRY : DOWN_ENTRY,
        // "挂 …" read as "an order is waiting here" (2026-11-13, the user asked whether it was a pending order or an
        // entry): it is the fill, so it says 多/空 + 成交.
        text: `${ride.dir > 0 ? '多' : '空'}单成交 ${sim.fillPrice.toLocaleString('en-US', { maximumFractionDigits: sim.fillPrice >= 100 ? 0 : 4 })}` });
      if (sim.status === 'filled') markers.push({ ride, time: panel.candles[sim.exitIndex].time, position: 'aboveBar',
        shape: 'circle', color: sim.R >= 0 ? UP : DOWN,
        text: `平仓 ${sim.R >= 0 ? '+' : '-'}${Math.abs(sim.R).toFixed(1)}R` });
    }
  }
  panel.markers = markers.sort((a, b) => a.time - b.time);
  paintMarkers(panel);
  // "实时" repaints a panel from the new answer, so the ride lines of the previous one are dropped first: without
  // this, every live round would add another copy of every line.
  const addLine = (options, data) => {
    if (!data.length) return;
    const line = panel.chart.addLineSeries(options);
    line.setData(data);
    panel.rideSeries.push(line);
  };
  clearRideSeries(panel);
  addLine({ color: UP, lineWidth: 4, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
    joinRideLines(lines, { up: UP, down: DOWN }));
  addLine({ color: UP_ENTRY, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
    joinRideLines(levels, { up: UP_ENTRY, down: DOWN_ENTRY }));
  addLine({ color: GREY, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
    joinRideLines(untraded, { up: GREY, down: GREY }));
  // Still waiting for a fill: dashed, because nothing has been decided for this order yet.
  addLine({ color: GREY, lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
    joinRideLines(pending, { up: GREY, down: GREY }));
  for (const [lines, color] of [[stops, DOWN], [targets, UP]]) {
    addLine({ color, lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
      joinRideLines(lines, { up: color, down: color }));
  }
}

// Removes the ride lines a panel carries, so a repaint starts from an empty chart instead of stacking up.
function clearRideSeries(panel) {
  for (const series of panel.rideSeries ?? []) { try { panel.chart.removeSeries(series); } catch { /* chart rebuilt */ } }
  panel.rideSeries = [];
}

// Optional: the review page's own main-chart indicators (MA group, SMA, EMA, BOLL) on top.
function addOverlay(panel, preferences) {
  clearOverlay(panel);
  for (const config of preferences.indicators) {
    if (INDICATORS[config.type].pane !== 'main') continue;
    for (const line of calculateIndicator(panel.candles, config, panel.interval).series) {
      const series = panel.chart.addLineSeries({ color: line.color, lineWidth: 1.5, lineStyle: line.dashed ? 2 : 0,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      series.setData(line.data);
      panel.overlaySeries.push(series);
    }
  }
}

function clearOverlay(panel) {
  for (const series of panel.overlaySeries ?? []) { try { panel.chart.removeSeries(series); } catch { /* chart rebuilt */ } }
  panel.overlaySeries = [];
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
  // The double-click box at the top of this card (a note on one candle of this timeframe). Built with the card and
  // kept hidden until a candle is double-clicked; the title / input are filled then.
  const noteRow = document.createElement('div');
  noteRow.className = 'bar-note-row'; noteRow.hidden = true;
  noteRow.innerHTML = '<strong class="bar-note-title"></strong>'
    + '<input class="bar-note-input" maxlength="500" placeholder="对这根 K 线的看法：回车保存，空着回车删除，Esc 取消" aria-label="对这根 K 线的看法">'
    + '<span class="bar-note-hint"></span>';
  card.insertBefore(noteRow, card.querySelector('.chart-host'));
  $('charts').append(card);
  const panel = { tf, interval, card, noteRow, noteTime: null,
    candles: item.candles, closes: new Map(item.candles.map(c => [c.time, c.close])),
    rideSeries: [], overlaySeries: [], chosenSeries: [] };
  const input = noteRow.querySelector('.bar-note-input');
  input.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); submitBarNote(panel); }
    else if (event.key === 'Escape') { event.preventDefault(); closeBarNote(panel); }
  };
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
  panel.chart.subscribeCrosshairMove(event => syncCrosshair(panel, typeof event.time === 'number' ? event.time : null,
    event.point ? panel.series.coordinateToPrice(event.point.y) : null));
  // Double-clicking a candle opens the note box of this card; a click on the scales or past the last candle has no
  // candle, so nothing opens there. A single click is left alone (no handler).
  panel.chart.subscribeDblClick(param => {
    const time = barTimeAt(panel, param);
    if (time !== null) openBarNote(panel, time);
  });
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

// `price` is the price under the pointer: every other chart puts its horizontal line at that same price (2026-11-15,
// the user wanted the level comparable across timeframes), and falls back to its own bar's close when unknown.
function syncCrosshair(source, time, price = null) {
  if (syncing) return;
  syncing = true;
  try {
    // A hovered bar is judged as of its close, like the markers.
    paintSignalBar(time === null ? statusTime : time + source.interval * 60 - 60, time !== null);
    // The note of the hovered candle (if it has one) right below the status, over the line paintSignalBar just cleared.
    paintBarNote(time === null ? '' : barNoteAt(source, time));
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

// keepSpan: move to the range but keep each chart's own zoom (signal navigation); without it every chart
// gets exactly `range` (a new window choice). `at` is the fraction of the range that holds the moment of interest.
function showRange(range, keepSpan = false, at = 0.5) { wantedRange = range; rangeLink?.set(range, { keepSpan, at }); }

// ---- Status bar ------------------------------------------------------------
// `t` is a 1m open time (seconds). Hovering shows the state when the pointed bar closed.
function paintSignalBar(t, hovered = false) {
  // A candle note belongs to the pointed bar only: cleared here and set by syncCrosshair right after this paint.
  paintBarNote('');
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
  // A signal the last live round found for the first time blinks for three seconds (see paintFreshStatus).
  if (freshKeys.has(ride.key)) button.classList.add('fresh');
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

// `minRendered` rebuilds at least as many rows as were on screen before (a live round repaints the list too, and
// dropping back to one chunk while the owner is scrolled far down would look like a jump to the top).
function paintRides(minRendered = 0) {
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
  renderMoreRides(Math.max(LIST_CHUNK, minRendered));
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
  // The same key again undoes that one mark and stays on the signal (2026-11-14: the user pressed the wrong key
  // and 0 would have dropped the other mark too).
  if (entryOf(labels, ride.key)[kind] === label) {
    try { await saveLabel(ride, kind, 'clear'); }
    catch (error) { status(error.message, true); return; }
    status(`已取消${KIND_TEXT[kind]}标注：${ride.tf} ${stamp(ride.start + 60)} UTC`);
    return;
  }
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
  // A live round that landed while the box was open was only fetched, not drawn: draw it now.
  flushLive();
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
// `repaint` false leaves the list to the caller (a live round paints it once, after the marks are in).
async function loadLabels(version, repaint = true) {
  try {
    const data = await post('/review/labels', runIdentity());
    if (version !== runVersion) return;
    labels = data.labels ?? {};
    barNotes = data.bars ?? {};
  } catch {
    if (version !== runVersion) return;
    labels = {}; barNotes = {};
  }
  // The purple squares of the candles already noted, on the charts that are already drawn.
  for (const panel of panels) paintMarkers(panel);
  if (repaint) paintRides();
}

// ---- Candle notes ----------------------------------------------------------
// A note on one candle of any timeframe (2026-11-14, the user: "我想在 k 线图上点击某个周期中的某个 k 线，然后标注
// 这个 k 线上我的看法"): double-click a candle, write one line, and it is stored as a `kind=bar` row in the same
// project file as the signal marks, so the scheduler reads both from one file. The key (`bar|exchange|symbol|tf|time`)
// carries the timeframe, so a 3m note is a different row than a 15m note on the same clock time.

const barInput = panel => panel.noteRow.querySelector('.bar-note-input');
const openBarPanel = () => panels.find(panel => panel.noteRow && !panel.noteRow.hidden) ?? null;

// The candle a double-click landed on. The library reports the candle under the pointer; `logical` covers a click a
// few pixels outside it. A click on the price / time scale, or in the empty space after the last candle, has no bar
// and starts nothing.
function barTimeAt(panel, param) {
  const pane = panel.chart.paneSize(), point = param?.point;
  if (!point || !pane || point.x < 0 || point.y < 0 || point.x > pane.width || point.y > pane.height) return null;
  if (typeof param.time === 'number' && panel.closes.has(param.time)) return param.time;
  const index = Math.round(param.logical);
  const candle = Number.isFinite(index) ? panel.candles[index] : null;
  return candle && panel.closes.has(candle.time) ? candle.time : null;
}

// The candle's own numbers, so the note still explains itself after the chart has moved on: OHLC, MA5, MA10, ATR(14)
// and BOLL(20, 2) of the clicked bar, all computed up to that bar only (the math and its tests are in finder-data.mjs).
const barPayload = (panel, time) => barSnapshot(panel.candles, time, panel.interval);

function openBarNote(panel, time) {
  // One box at a time: the box belongs to the candle it was opened on.
  for (const other of panels) if (other !== panel) closeBarNote(other);
  panel.noteTime = time;
  panel.noteRow.querySelector('.bar-note-title').textContent = `${barLabel(time, panel.tf)} 这根 K 线的看法`;
  panel.noteRow.querySelector('.bar-note-hint').textContent = '';
  const input = barInput(panel);
  input.value = barNoteOf(barNotes, barKey(runIdentity(), panel.tf, time));
  panel.noteRow.hidden = false;
  input.focus(); input.select();
}

function closeBarNote(panel) {
  if (!panel?.noteRow) return;
  panel.noteRow.hidden = true; panel.noteTime = null;
  barInput(panel).value = '';
  flushLive();
}

// Enter in the box: one `kind=bar` row with the candle's numbers and the signal that was selected (if any), so the
// reader of the file knows the factor and signal that were on screen. An empty box is the explicit "delete this
// candle's note" row. Esc leaves without saving.
async function submitBarNote(panel) {
  const time = panel.noteTime;
  if (time === null) return;
  const text = barInput(panel).value.trim().slice(0, 500);
  const identity = runIdentity();
  const key = barKey(identity, panel.tf, time);
  try {
    await post('/review/label', { key, kind: 'bar', note: text, ...identity, version: result?.version ?? null,
      params: result?.params ?? {}, tf: panel.tf, time, bar: barPayload(panel, time),
      signal: selectedRide?.key ?? undefined });
  } catch (error) { panel.noteRow.querySelector('.bar-note-hint').textContent = error.message; return; }
  if (text) barNotes[key] = { note: text, tf: panel.tf, time };
  else delete barNotes[key];
  closeBarNote(panel);
  paintMarkers(panel);
  status(text ? `已保存 ${barLabel(time, panel.tf)} 的备注` : `已删除 ${barLabel(time, panel.tf)} 的备注`);
}

// The full note of the candle under the pointer, shown in the status bar so a 「注」 can be read without opening it.
function paintBarNote(note) {
  const box = $('bar-note');
  box.hidden = !note;
  box.textContent = note ? `注：${note}` : '';
}

const barNoteAt = (panel, time) =>
  (time === null || !panel ? '' : barNoteOf(barNotes, barKey(runIdentity(), panel.tf, time)));

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
  // A candle-note box owns the keyboard while it is open: no shortcut may mark a signal or jump behind it.
  const barPanel = openBarPanel();
  if (barPanel) {
    if (event.key === 'Escape') closeBarNote(barPanel);
    return;
  }
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
    if (order?.price != null) panel.limitLine = panel.series.createPriceLine({ price: order.price, color: CHOSEN,
      lineWidth: 1, lineStyle: 2, lineVisible: false, axisLabelVisible: true,
      // Filled orders show their entry price; only an order that never traded is still a 挂单.
      title: order.sim?.status === 'filled' || order.sim?.status === 'open' ? '入场' : '挂单（未成交）' });
    // Stop and target of a traded order, so all three prices can be read off the scale.
    if (order?.sim && (order.sim.status === 'filled' || order.sim.status === 'open')) {
      for (const [price, color, title] of [[order.sim.stop, DOWN, '止损'], [order.sim.target, UP, '止盈']]) {
        if (Number.isFinite(price)) panel.orderLines.push(panel.series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, lineVisible: false, axisLabelVisible: true, title }));
      }
    }
  }
  selectedOrder = order;
  for (const panel of panels) { paintMarkers(panel); drawChosen(panel, panel.interval === ride.minutes ? order : null); }
  paintTradeInfo(ride);
  paintSignalBar(statusTime); updateNav();
  if (focus) showRange(centeredRange(ride.start, Number($('f-window').value)), true, 0.75);
}

// The selected signal's own three prices, drawn only over the bars they apply to (2026-11-13: with every
// signal's levels on the chart, and the axis price lines running across the whole width, the user could not tell
// which line was the order and which the stop). Amber: dashed while the order waits, thick once it is filled, to the
// exit. Red solid: its stop. Green solid: its target. The axis keeps the 入场 / 止损 / 止盈 labels (no full-width line).
function drawChosen(panel, order) {
  for (const series of panel.chosenSeries ?? []) { try { panel.chart.removeSeries(series); } catch { /* chart rebuilt */ } }
  panel.chosenSeries = [];
  const sim = order?.sim;
  if (!sim?.path?.length || !panel.candles?.length) return;
  const last = panel.candles.length - 1;
  const at = index => panel.candles[Math.min(index, last)].time;
  const add = (points, options) => {
    const data = [];
    for (const point of points) if (!data.length || point.time > data.at(-1).time) data.push(point);
    if (!data.length) return;
    const series = panel.chart.addLineSeries({ lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, ...options });
    series.setData(data); panel.chosenSeries.push(series);
  };
  const traded = sim.status === 'filled' || sim.status === 'open';
  // Waiting: the order's price at each close, up to the fill (or to the cancel / last bar).
  const waitEnd = traded ? sim.fillIndex : sim.status === 'waiting' ? last : sim.path.at(-1).index + 1;
  const wait = sim.path.filter(point => point.index <= Math.min(waitEnd, last)).map(point => ({ time: at(point.index), value: point.price }));
  if (wait.length && waitEnd > sim.path.at(-1).index) wait.push({ time: at(waitEnd), value: sim.path.at(-1).price });
  add(wait, { color: CHOSEN, lineWidth: 2, lineStyle: 2 });
  if (!traded) return;
  const end = sim.status === 'filled' ? sim.exitIndex : last;
  const span = value => [{ time: at(sim.fillIndex), value }, { time: at(end), value }];
  add(span(sim.fillPrice), { color: CHOSEN, lineWidth: 4 });
  if (Number.isFinite(sim.stop)) add(span(sim.stop), { color: DOWN, lineWidth: 2 });
  if (Number.isFinite(sim.target)) add(span(sim.target), { color: UP, lineWidth: 2 });
}

// The newest state: the newest 1m candle is the "now" of the status bar and every chart shows its right edge.
function gotoLatest(keepSpan = true) {
  if (!result) return;
  if (selectedRide) rideButtons.get(selectedRide)?.setAttribute('aria-pressed', 'false');
  selectedRide = null; statusTime = result.last_candle_time;
  selectedOrder = null;
  for (const panel of panels) { panel.card.classList.remove('chosen'); paintMarkers(panel); drawChosen(panel, null); }
  $('trade-info').textContent = '最新：各周期在最后一根已收盘 K 线时的状态';
  paintSignalBar(statusTime); updateNav();
  const span = Number($('f-window').value);
  showRange({ from: result.last_candle_time + 60 - span * 0.95, to: result.last_candle_time + 60 + span * 0.05 }, keepSpan, 0.95);
}

// ---- Running ---------------------------------------------------------------
const readPreferences = () => {
  try { return restorePreferences(localStorage.getItem(STORAGE_KEY)); } catch { return restorePreferences(null); }
};

function render(data) {
  destroyPanels();
  result = data;
  const extra = rideExtra(data.timeframes);
  rideData = rideSeries(extra);
  rides = buildRides(extra, data.last_candle_time + 60);
  keyRides();
  shownTfs = new Set(rideData.map(s => s.title)); selectedRide = null;
  freshKeys = new Set(); clearTimeout(freshTimer);
  const preferences = readPreferences();
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
  if (form.live) syncTicker();
  const factor = currentFactor();
  if (!factor) return;
  const version = ++runVersion;
  // A live round must not import at the same moment: the user's own run has priority, the minute is skipped.
  manualBusy = true;
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
    labels = {}; barNotes = {};
    render(data);
    paintLivePrice();
    paintCondition(factor, params);
    await loadLabels(version);
  } catch (error) {
    if (version === runVersion) status(error.message, true);
  } finally { if (version === runVersion) $('f-run').disabled = false; manualBusy = false; }
}

// Pull the newest candles with the existing import API, then search again.
async function importLatest() {
  readForm();
  manualBusy = true;
  $('f-import').disabled = true;
  try {
    const id = crypto.randomUUID();
    await post('/candles/import', { id, exchange: form.exchange, symbol: form.symbol, start_date: importStartDate(Date.now(), result?.last_candle_time) });
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
  } catch (error) { status(error.message, true); } finally { $('f-import').disabled = false; manualBusy = false; }
}

// ---- 「实时（每分钟）」 ------------------------------------------------------
// A round imports the newest candles, runs the factor with the form as it is, and updates the panels already on
// screen in place: the selected signal, each chart's visible range, the filters and the list scroll all survive, so
// watching a chart is not interrupted every minute. The pure parts (next trigger, new-signal diff, right edge) are
// in finder-data.mjs with their node tests.
const LIVE_FAIL_LIMIT = 3;
const LIVE_POLL_MS = 2000;
// A minute's import can hang (network, exchange): give up on this round instead of blocking every later one.
const LIVE_IMPORT_TRIES = 45;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const liveClock = ms => new Date(ms).toISOString().slice(11, 19);

// Custom range with an end date: a live round that never reaches "now" makes no sense there.
const liveConflict = () => form.rangeMode === 'custom' && !!form.finish;

// ---- Live price (websocket) -----------------------------------------------
// While 实时 is on, the exchange's public trade stream gives the last price, drawn on every chart as a thin solid line
// with an axis label 「实时」 (2026-11-15, the owner wanted to see the live price like in a trading app). Candles are untouched: the charts keep showing closed bars only.
let stopTicker = null, tickerUrl = null, tickerState = '', livePrice = null;

function paintLivePrice() {
  for (const panel of panels) {
    if (panel.empty || !panel.series) continue;
    if (livePrice === null) {
      if (panel.livePriceLine) { try { panel.series.removePriceLine(panel.livePriceLine); } catch { /* chart rebuilt */ } }
      panel.livePriceLine = null;
      continue;
    }
    // Light red dashed (2026-11-15, the owner's choice): visible but lighter than the order / stop / target lines.
    const options = { price: livePrice, color: LIVE_PRICE, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '实时' };
    if (panel.livePriceLine) panel.livePriceLine.applyOptions(options);
    else panel.livePriceLine = panel.series.createPriceLine(options);
  }
}

// Opens, switches or closes the stream to match the form (实时 on/off, exchange, symbol).
function syncTicker() {
  const url = form.live ? streamUrl(form.exchange, form.symbol) : null;
  if (url === tickerUrl) return;
  stopTicker?.(); stopTicker = null; tickerUrl = url; tickerState = ''; livePrice = null;
  paintLivePrice();
  if (url) stopTicker = openTicker(url, {
    onPrice: price => { livePrice = price; paintLivePrice(); },
    onState: state => { tickerState = state; paintLiveNote(); },
  });
  else if (form.live) tickerState = 'unsupported';
  paintLiveNote();
}

const TICKER_TEXT = { connected: '', reconnecting: ' · 实时价格重连中', unsupported: ' · 这个交易所没有实时价格' };

function paintLiveNote(message) {
  const note = $('live-note');
  if (!form.live) { note.hidden = true; note.textContent = ''; return; }
  note.hidden = false;
  note.textContent = (message ?? (liveUpdatedAt ? `实时 · 最后更新 ${liveClock(liveUpdatedAt)} UTC` : '实时 · 等待第一次更新'))
    + (TICKER_TEXT[tickerState] ?? '');
}

// One timer, always re-armed from the clock: a slow round cannot drift the schedule the way a 60s setInterval does.
function scheduleLive(delay) {
  clearTimeout(liveTimer);
  liveTimer = null;
  if (!form.live || document.hidden) return;
  liveTimer = setTimeout(liveTick, delay ?? nextTickDelay(Date.now()));
}

function setLive(on) {
  form.live = on;
  $('f-live').checked = on;
  saveForm();
  liveFails = 0;
  if (!on) {
    clearTimeout(liveTimer); liveTimer = null;
    pendingLive = null;
    freshKeys = new Set(); clearTimeout(freshTimer);
    for (const button of rideButtons.values()) button.classList.remove('fresh');
    syncTicker();
    paintLiveNote();
    return;
  }
  syncTicker();
  paintLiveNote();
  scheduleLive(0);
}

// While the owner is writing (a note box is open, or the cursor sits in an input), a round only refreshes the data;
// the drawings wait until the box closes, so nothing jumps under the cursor.
const liveBlocked = () => !$('note-row').hidden || !!openBarPanel() || typing();

// The visible range of a chart in UTC seconds, or null before the chart has a size.
const panelRange = panel => {
  try {
    const range = panel.chart.timeScale().getVisibleRange();
    return range && Number.isFinite(range.from) && Number.isFinite(range.to) ? range : null;
  } catch { return null; }
};

// Selection marks of one panel: the amber dashed line, stop / target lines and the chosen holstered lines. Dropped
// before the selection is put back on new data, so no line of the previous answer stays behind.
function clearSelection(panel) {
  if (panel.limitLine) { try { panel.series.removePriceLine(panel.limitLine); } catch { /* chart rebuilt */ } }
  panel.limitLine = null;
  for (const line of panel.orderLines ?? []) { try { panel.series.removePriceLine(line); } catch { /* chart rebuilt */ } }
  panel.orderLines = [];
  drawChosen(panel, null);
}

// Replaces one panel's candles and drawings without touching the chart object, so the time scale (and what the
// owner is looking at) survives. `range` / `last` are what the chart showed before the update.
function updatePanel(panel, item, preferences, range, last) {
  panel.candles = item.candles;
  panel.closes = new Map(item.candles.map(candle => [candle.time, candle.close]));
  panel.series.setData(panel.candles);
  if (form.overlay) addOverlay(panel, preferences); else clearOverlay(panel);
  addRides(panel);
  const count = rides.filter(ride => ride.minutes === panel.interval).length;
  panel.card.querySelector('.chart-meta').textContent = `${panel.candles.length.toLocaleString()} 根完整 K 线 · ${count} 个区间`;
  if (!range) return;
  // A chart whose right edge was at the newest bar follows the newest bar (same zoom); one dragged into history
  // gets exactly the range it had.
  const newest = panel.candles.at(-1).time;
  panel.chart.timeScale().setVisibleRange(atRightEdge(range, last) ? shiftRange(range, newest - last) : range);
}

// A new signal from this round: the row blinks for 3s and the status bar names it. Nothing else marks the event.
function paintFreshStatus() {
  clearTimeout(freshTimer);
  if (!freshKeys.size) return;
  const rows = rides.filter(ride => freshKeys.has(ride.key));
  const named = rows.slice(0, 3).map(ride => `${ride.tf} ${arrow(ride.dir)} ${maText(ride.periods)} `
    + new Date((ride.start + 60) * 1000).toISOString().slice(11, 16));
  status(`新信号：${named.join('、')}${rows.length > named.length ? ` 等 ${rows.length} 个` : ''}`);
  // The row highlight (CSS, 3s) is the short signal; the sentence stays up a little longer and is replaced by the
  // next round's own message anyway.
  freshTimer = setTimeout(() => {
    freshKeys = new Set();
    for (const button of rideButtons.values()) button.classList.remove('fresh');
    if ($('status').textContent.startsWith('新信号：')) status('');
  }, 8000);
}

// Applies one live round to the page. Everything a person set up is read first and put back afterwards: the selected
// signal (by key, and "nothing selected" when it is gone), each chart's visible range, the period / label filters
// and the list scroll. A round that changes the set of timeframes (or a chart that had no candles and now has some)
// cannot keep the per-chart ranges, so it falls back to the normal first render.
async function applyLive({ data, factor, params, version }) {
  const keepKey = selectedRide?.key ?? null;
  const list = $('trades');
  const scroll = { top: list.scrollTop, left: list.scrollLeft, rendered: listRendered };
  const views = panels.map(panel => ({ panel, range: panelRange(panel), last: panel.candles.at(-1)?.time ?? null }));
  const firstDraw = !views.length;
  // Both the old and the new answer need candles of every timeframe that is on screen: a chart that was empty (or a
  // timeframe the form added) has no chart object to update.
  const sameShape = !firstDraw && views.every(({ panel }) => !panel.empty && data.timeframes[panel.tf]?.candles?.length);
  const preferences = readPreferences();
  const oldRides = rides;
  result = data;
  const extra = rideExtra(data.timeframes);
  rideData = rideSeries(extra);
  rides = buildRides(extra, data.last_candle_time + 60);
  keyRides();
  freshKeys = new Set(newKeys(oldRides, rides));
  // The time-scale link remembers which chart the last pointer gesture was on; a programmatic range on that chart
  // would then be pushed to every peer and overwrite the ranges read above.
  rangeLink?.activate(null);
  if (sameShape) {
    for (const { panel, range, last } of views) updatePanel(panel, data.timeframes[panel.tf], preferences, range, last);
  } else {
    destroyPanels();
    panels = Object.keys(data.timeframes).sort((a, b) => timeframeMinutes(b) - timeframeMinutes(a))
      .map(tf => makePanel(tf, data.timeframes[tf], preferences));
    rangeLink = linkTimeRanges(panels.filter(panel => !panel.empty));
  }
  paintFilter();
  paintDataNote(); paintLimitSummary(); paintCondition(factor, params);
  $('results').hidden = false; $('f-latest').disabled = false;
  // Nothing was on screen (the first search failed, or this is the first answer): behave like the first render.
  if (firstDraw) gotoLatest();
  selectedRide = null;
  for (const panel of panels) { panel.card.classList.remove('chosen'); clearSelection(panel); }
  // The marks are re-read first (they add the purple 注 squares to the panels), then the list is painted once with
  // as many rows as this page had — a live round must not throw the list back to its first chunk.
  await loadLabels(version, false);
  paintLivePrice();
  paintRides(scroll.rendered);
  const keep = keepKey ? rides.find(ride => ride.key === keepKey) : null;
  if (keep) selectRide(keep, false);
  else {
    if (keepKey) $('trade-info').textContent = '最新：各周期在最后一根已收盘 K 线时的状态';
    statusTime = data.last_candle_time;
    paintSignalBar(statusTime); updateNav();
  }
  paintFreshStatus();
  list.scrollTop = scroll.top; list.scrollLeft = scroll.left;
  liveUpdatedAt = Date.now(); liveFails = 0; paintLiveNote();
  if ($('status').classList.contains('error')) status('');
}

// The import half of a live round: start one and wait for it. Bounded, unlike 「更新到最新」: a stuck import must not
// swallow every later minute. Each round uses its own id, so the running one is cancelled on timeout.
async function importRound() {
  const id = crypto.randomUUID();
  await post('/candles/import', { id, exchange: form.exchange, symbol: form.symbol, start_date: importStartDate(Date.now(), result?.last_candle_time) });
  // Catching up a database that is hours or days behind is a long import, not a stuck one: give it 30 minutes.
  const behind = Date.now() / 1000 - (result?.last_candle_time ?? 0) > 7200;
  const tries = behind ? 900 : LIVE_IMPORT_TRIES;
  for (let attempt = 0; attempt < tries; attempt++) {
    await sleep(LIVE_POLL_MS);
    const state = await post('/candles/import-status', { id });
    if (!importDone(state)) continue;
    if (state.status === 'failed') throw new Error(`更新 K 线失败：${state.error ?? '未知错误'}`);
    return;
  }
  try { await post('/candles/cancel-import', { id }); } catch { /* the round fails anyway */ }
  throw new Error('更新 K 线超时');
}

async function liveTick() {
  liveTimer = null;
  if (!form.live || document.hidden) return;
  // The previous round is still running, or the owner is running a manual 查找 / 更新到最新: skip this minute.
  if (liveBusy || manualBusy) { scheduleLive(); return; }
  liveBusy = true;
  let version = runVersion;
  try {
    readForm();
    if (!form.live) return;
    if (liveConflict()) {
      setLive(false);
      status('实时需要把结束留空，已关闭“实时”。', true);
      return;
    }
    const factor = currentFactor();
    if (!factor) throw new Error('没有可用的因子。');
    const timeframes = form.timeframes[factor.name] ?? factor.timeframes;
    if (!timeframes.length) throw new Error('请至少勾选 1 个周期。');
    const params = selectedParams(factor);
    // Built from the form before the import, so the answer matches the candles this round pulled.
    const body = runBody(form, factor.name, params, timeframes, Date.now());
    // A manual run started meanwhile wins: the old round must not overwrite its answer.
    version = ++runVersion;
    await importRound();
    const data = await post('/factors/run', body);
    if (version !== runVersion || !form.live) return;
    if (liveBlocked()) {
      pendingLive = { data, factor, params, version };
      setTimeout(flushLive, 1500);
      return;
    }
    await applyLive({ data, factor, params, version });
  } catch (error) {
    if (version !== runVersion) return;
    liveFails++;
    paintLiveNote(`实时 · 上次失败 ${liveClock(Date.now())} UTC`);
    if (liveFails >= LIVE_FAIL_LIMIT) {
      setLive(false);
      status(`实时已关闭：连续 ${LIVE_FAIL_LIMIT} 次更新失败（${error.message}）。修好后重新勾选“实时（每分钟）”。`, true);
      return;
    }
    // The next minute tries again; the error stays on screen until then.
    status(`实时更新失败（第 ${liveFails} 次，下一分钟再试）：${error.message}`, true);
  } finally {
    liveBusy = false;
    if (form.live) scheduleLive();
  }
}

// A round that landed while the owner was typing: draw it once the box is closed (checked again every second and a
// half, and right away from closeNote / closeBarNote).
function flushLive() {
  if (!pendingLive) return;
  if (liveBlocked()) { setTimeout(flushLive, 1500); return; }
  const pending = pendingLive;
  pendingLive = null;
  if (pending.version !== runVersion || !form.live) return;
  applyLive(pending).catch(error => status(error.message, true));
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
    checkLiveConflict();
  };
  for (const id of ['f-exchange', 'f-symbol', 'f-start', 'f-finish']) $(id).onchange = () => { readForm(); checkLiveConflict(); };
  // "实时（每分钟）": turning it on runs a round right away, then one per UTC minute (finder-data.mjs nextTickDelay).
  $('f-live').onchange = () => {
    readForm();
    if ($('f-live').checked && liveConflict()) {
      setLive(false);
      status('实时需要把结束留空（自定义范围时填了“结束”就不能实时），已取消勾选。', true);
      return;
    }
    setLive($('f-live').checked);
    if (form.live) status('');
  };
  // A hidden tab does no work; coming back catches up at once instead of waiting for the next minute.
  document.addEventListener('visibilitychange', () => {
    if (!form.live) return;
    if (document.hidden) { clearTimeout(liveTimer); liveTimer = null; return; }
    if (!liveBusy) liveTick();
  });
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
    if (form.live) setLive(false);
    return;
  }
  status('');
  paintFactors();
  paintDataNote();
  if (!currentFactor()?.error) await run();
  // The saved form may have 实时 on: keep waiting for the next minute, the page already ran a fresh search.
  if (form.live) { if (liveConflict()) setLive(false); else { syncTicker(); paintLiveNote(); } scheduleLive(); }
}

// Filling in an end date while 实时 is on would make every round stale: say why and switch it off.
function checkLiveConflict() {
  if (!form.live || !liveConflict()) return;
  setLive(false);
  status('实时需要把结束留空，已关闭“实时”。', true);
}
start().catch(error => status(error.message, true));
