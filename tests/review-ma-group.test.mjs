import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateIndicator, restorePreferences, defaultMaLines, MA_DEFAULT_COLORS } from '../jesse/static/review/settings.mjs';
import { calculateIndicator, indicatorTitle } from '../jesse/static/review/indicators.mjs';

const candles = JSON.parse(readFileSync(new URL('./fixtures/review-indicators-jesse.json', import.meta.url))).candles;
const group = (overrides = {}) => ({ type: 'MAGROUP', ...overrides });
const lines = edit => defaultMaLines().map((l, i) => ({ ...l, ...(edit(i, l) ?? {}) }));

test('default MA group has 12 lines, default periods, 5/7/10/20/30 enabled and distinct colours', () => {
  const config = validateIndicator(group());
  assert.equal(config.mode, 'SMA');
  assert.deepEqual(config.lines.map(l => l.period), [5, 7, 10, 14, 20, 30, 50, 60, 100, 120, 150, 200]);
  assert.deepEqual(config.lines.filter(l => l.enabled).map(l => l.period), [5, 7, 10, 20, 30]);
  assert.equal(new Set(MA_DEFAULT_COLORS.map(c => c.toLowerCase())).size, 12);
  assert.equal(indicatorTitle(config), 'MA(5,7,10,20,30)');
  assert.equal(indicatorTitle({ ...config, mode: 'EMA' }), 'EMA(5,7,10,20,30)');
});

test('MA group validation rejects bad periods, colours, line counts, modes and no enabled line', () => {
  for (const bad of [
    group({ lines: lines(i => i === 0 ? { period: 0 } : null) }),
    group({ lines: lines(i => i === 0 ? { period: 5001 } : null) }),
    group({ lines: lines(i => i === 0 ? { period: 2.5 } : null) }),
    group({ lines: lines(i => i === 0 ? { color: 'red' } : null) }),
    group({ lines: lines(i => i === 0 ? { color: 'url(x)' } : null) }),
    group({ lines: lines(i => i === 0 ? { enabled: 1 } : null) }),
    group({ lines: defaultMaLines().slice(0, 11) }),
    group({ lines: [...defaultMaLines(), defaultMaLines()[0]] }),
    group({ lines: lines(() => ({ enabled: false })) }),
    group({ mode: 'WMA' }),
  ]) assert.throws(() => validateIndicator(bad));
});

test('saved settings: old single SMA/EMA still restore; invalid MA group falls back to the default group', () => {
  const old = restorePreferences(JSON.stringify({ version: 1, indicators: [
    { type: 'SMA', period: 5, color: '#dd9a23' }, { type: 'EMA', period: 20, color: '#8b5dc8' }] }));
  assert.deepEqual(old.indicators.map(i => i.type), ['SMA', 'EMA']);
  const saved = validateIndicator(group({ mode: 'EMA', lines: lines(i => ({ enabled: i < 2, period: 3 + i })) }));
  assert.deepEqual(restorePreferences(JSON.stringify({ version: 1, indicators: [saved] })).indicators, [saved]);
  const broken = restorePreferences(JSON.stringify({ version: 1, indicators: [group({ lines: lines(() => ({ enabled: false })) })] }));
  assert.deepEqual(broken.indicators.map(i => i.type), ['MAGROUP']);
  assert.equal(broken.indicators[0].lines.filter(l => l.enabled).length, 5);
});

test('MA group computes only enabled lines, in order, with their own colours', () => {
  const config = validateIndicator(group({ lines: lines(i => ({ enabled: i === 0 || i === 2 })) }));
  const result = calculateIndicator(candles, config, 1);
  assert.equal(result.title, 'MA(5,10)');
  assert.deepEqual(result.series.map(s => s.name), ['SMA5', 'SMA10']);
  assert.deepEqual(result.series.map(s => s.color), [config.lines[0].color, config.lines[2].color]);
  assert.equal(result.pane, 'main');
});

for (const mode of ['SMA', 'EMA']) test(`MA group ${mode} equals the single ${mode} indicator, including gaps`, () => {
  const gapped = [...candles.slice(0, 6), ...candles.slice(8)];
  const config = validateIndicator(group({ mode, lines: lines(i => ({ enabled: i < 3 })) }));
  for (const data of [candles, gapped]) {
    const result = calculateIndicator(data, config, 1);
    config.lines.filter(l => l.enabled).forEach((line, i) => {
      const single = calculateIndicator(data, { type: mode, period: line.period }, 1).series[0].data;
      assert.deepEqual(result.series[i].data, single);
    });
  }
});
