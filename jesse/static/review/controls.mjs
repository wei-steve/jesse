import { TIMEFRAMES, INDICATORS, MA_LINE_COUNT, STORAGE_KEY, timeframeLabel, configuredIntervals, chooseIntervals, validateIndicator } from './settings.mjs?v=20261028a';
import { indicatorTitle } from './indicators.mjs?v=20261028a';

const $ = id => document.getElementById(id);
const parameterLabels = { period: '周期', deviation: '标准差倍数', fast: '快线周期', slow: '慢线周期', signal: '信号周期' };

export function mountControls(form, route, preferences, changed) {
  const configured = configuredIntervals(form, route);
  if (!preferences.intervals) preferences.intervals = chooseIntervals(configured.length ? configured : [1]);
  let editing = null;
  function message(text) { $('settings-message').textContent = text; }
  function save() {
    message('');
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
    catch { message('浏览器无法保存设置；当前页面仍可使用。'); }
    changed();
  }
  function periods() {
    $('timeframe-list').replaceChildren();
    for (const interval of TIMEFRAMES) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = preferences.intervals.includes(interval);
      input.setAttribute('aria-label', `显示 ${timeframeLabel(interval)} 周期`);
      input.onchange = () => {
        const next = input.checked ? [...preferences.intervals, interval] : preferences.intervals.filter(n => n !== interval);
        if (!next.length) { input.checked = true; message('请至少保留 1 个显示周期。'); return; }
        preferences.intervals = next.sort((a, b) => a - b); save();
      };
      label.append(input, document.createTextNode(timeframeLabel(interval)));
      if (configured.includes(interval)) {
        const badge = document.createElement('small'); badge.textContent = '策略'; label.append(badge);
      }
      $('timeframe-list').append(label);
    }
    $('timeframe-note').textContent = `策略配置：${configured.map(timeframeLabel).join(' / ') || '未找到可展示周期'}。可选固定周期 1m–1D；数据不足时会提示。`;
  }
  function maFields(config) {
    const mode = document.createElement('label'); mode.textContent = '均线算法';
    const select = document.createElement('select'); select.id = 'indicator-mode'; select.setAttribute('aria-label', '均线算法');
    for (const value of ['SMA', 'EMA']) {
      const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option);
    }
    select.value = config.mode ?? 'SMA'; mode.append(select);
    const grid = document.createElement('div'); grid.className = 'ma-rows';
    config.lines.forEach((line, i) => {
      const row = document.createElement('label'); row.className = 'ma-row';
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.id = `ma-enabled-${i}`;
      enabled.checked = line.enabled; enabled.setAttribute('aria-label', `显示第 ${i + 1} 条均线`);
      const period = document.createElement('input'); period.type = 'number'; period.id = `ma-period-${i}`;
      period.min = '1'; period.max = '5000'; period.step = '1'; period.required = true; period.value = line.period;
      period.setAttribute('aria-label', `第 ${i + 1} 条均线周期`);
      const color = document.createElement('input'); color.type = 'color'; color.id = `ma-color-${i}`;
      color.value = line.color; color.setAttribute('aria-label', `第 ${i + 1} 条均线颜色`);
      row.append(enabled, period, color); grid.append(row);
    });
    $('indicator-params').append(mode, grid);
  }
  function fields(config) {
    $('indicator-type').value = config.type;
    $('indicator-color').value = config.color ?? INDICATORS[config.type].color;
    $('indicator-params').replaceChildren();
    $('indicator-color').parentElement.hidden = config.type === 'MAGROUP';
    $('indicator-params').classList.toggle('ma-params', config.type === 'MAGROUP');
    if (config.type === 'MAGROUP') maFields(config);
    else for (const [key, fallback] of Object.entries(INDICATORS[config.type].defaults)) {
      const label = document.createElement('label'); label.textContent = parameterLabels[key];
      const input = document.createElement('input'); input.id = `indicator-${key}`; input.type = 'number';
      input.required = true; input.min = key === 'deviation' ? '0.1' : '1'; input.max = key === 'deviation' ? '10' : '5000';
      input.step = key === 'deviation' ? '0.1' : '1'; input.value = config[key] ?? fallback;
      input.setAttribute('aria-label', `指标${parameterLabels[key]}`); label.append(input); $('indicator-params').append(label);
    }
    $('save-indicator').textContent = editing === null ? '添加指标' : '保存修改';
    $('cancel-indicator').hidden = editing === null;
  }
  function list() {
    $('indicator-list').replaceChildren();
    for (const [index, config] of preferences.indicators.entries()) {
      const row = document.createElement('div'); row.className = 'indicator-row';
      const swatch = document.createElement('span');
      if (config.type === 'MAGROUP') {
        swatch.className = 'indicator-swatches';
        for (const line of config.lines.filter(l => l.enabled)) {
          const dot = document.createElement('span'); dot.className = 'indicator-swatch'; dot.style.background = line.color; swatch.append(dot);
        }
      } else { swatch.className = 'indicator-swatch'; swatch.style.background = config.color; }
      const name = document.createElement('strong'); name.textContent = `${INDICATORS[config.type].pane === 'main' ? '主图' : '附图'} · ${indicatorTitle(config)}`;
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑';
      edit.setAttribute('aria-label', `编辑 ${indicatorTitle(config)}`);
      edit.onclick = () => { editing = index; fields(config); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除';
      remove.setAttribute('aria-label', `移除 ${indicatorTitle(config)}`);
      remove.onclick = () => { preferences.indicators.splice(index, 1); editing = null; fields(validateIndicator({ type: $('indicator-type').value })); list(); save(); };
      row.append(swatch, name, edit, remove); $('indicator-list').append(row);
    }
    if (!preferences.indicators.length) $('indicator-list').textContent = '当前仅显示 K 线与成交点，尚未添加指标。';
  }
  $('indicator-type').replaceChildren();
  for (const [type, definition] of Object.entries(INDICATORS)) {
    const option = document.createElement('option'); option.value = type;
    option.textContent = `${definition.pane === 'main' ? '主图' : '附图'} · ${definition.label}`; $('indicator-type').append(option);
  }
  $('indicator-type').onchange = () => { editing = null; fields(validateIndicator({ type: $('indicator-type').value })); };
  $('indicator-form').onsubmit = event => {
    event.preventDefault();
    try {
      const input = { type: $('indicator-type').value, color: $('indicator-color').value };
      if (input.type === 'MAGROUP') {
        delete input.color; input.mode = $('indicator-mode').value;
        input.lines = Array.from({ length: MA_LINE_COUNT }, (_, i) => ({ enabled: $(`ma-enabled-${i}`).checked,
          period: Number($(`ma-period-${i}`).value), color: $(`ma-color-${i}`).value }));
      } else for (const key of Object.keys(INDICATORS[input.type].defaults)) input[key] = Number($(`indicator-${key}`).value);
      const config = validateIndicator(input);
      if (editing === null) {
        if (preferences.indicators.length >= 10) throw new Error('最多添加 10 个指标，请先移除不需要的指标。');
        preferences.indicators.push(config);
      } else preferences.indicators[editing] = config;
      editing = null; fields(config); list(); save();
    } catch (error) { message(error.message); }
  };
  $('cancel-indicator').onclick = () => { editing = null; fields(validateIndicator({ type: $('indicator-type').value })); message(''); };
  $('strategy-periods').onclick = () => { preferences.intervals = chooseIntervals(configured.length ? configured : [1]); periods(); save(); };
  $('open-settings').onclick = () => { $('display-settings').open = !$('display-settings').open; };
  $('display-settings').ontoggle = () => $('open-settings').setAttribute('aria-expanded', String($('display-settings').open));
  periods(); fields(validateIndicator({ type: 'MAGROUP' })); list();
}
