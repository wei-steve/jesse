import { indicatorTitle } from './indicators.mjs?v=20261118a';

function latestValue(line) {
  if (line && 'latest' in line) return Number.isFinite(line.latest) ? line.latest : null;
  if (line?.values instanceof Map && line.values.size > 0) {
    let last;
    for (const v of line.values.values()) last = v;
    return Number.isFinite(last) ? last : null;
  }
  if (Array.isArray(line?.data) && line.data.length > 0) {
    const v = line.data.at(-1)?.value;
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function valueAt(line, time) {
  if (time === null || time === undefined) return latestValue(line);
  if (line?.values instanceof Map) {
    const v = line.values.get(time);
    return Number.isFinite(v) ? v : null;
  }
  if (Array.isArray(line?.data)) {
    const point = line.data.find(p => p?.time === time);
    return Number.isFinite(point?.value) ? point.value : null;
  }
  return null;
}

/**
 * Pure helper for the market chart's top-left legend: extracts display labels, colors, and
 * values for each overlaid indicator group at `time` (or the latest bar when `time` is null).
 */
export function legendItems(groups, time = null) {
  const result = [];
  for (const group of groups ?? []) {
    const config = group?.config;
    if (!config) continue;
    const lines = Array.isArray(group.lines) ? group.lines : [];
    if (config.type === 'MAGROUP') {
      const mode = config.mode === 'EMA' ? 'EMA' : 'MA';
      const enabled = (config.lines ?? []).filter(l => l.enabled);
      result.push({
        type: 'MAGROUP',
        title: indicatorTitle(config),
        items: enabled.map((line, i) => ({
          label: `${mode}${line.period}`,
          color: lines[i]?.color ?? line.color,
          value: valueAt(lines[i], time),
        })),
      });
    } else if (config.type === 'BOLL') {
      result.push({
        type: 'BOLL',
        title: indicatorTitle(config),
        color: config.color,
        items: ['上', '中', '下'].map((label, i) => ({
          label,
          color: lines[i]?.color ?? config.color,
          value: valueAt(lines[i], time),
        })),
      });
    } else {
      const title = indicatorTitle(config);
      result.push({
        type: config.type,
        title,
        color: config.color,
        items: [{
          label: title,
          color: lines[0]?.color ?? config.color,
          value: valueAt(lines[0], time),
        }],
      });
    }
  }
  return result;
}
