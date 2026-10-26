// Pure data for the hover tooltip shown on a chart while the indicator values
// above the charts are hidden. Only main-chart overlays (MA, BOLL, ...) are listed.
export function tooltipData(overlays, time) {
  if (!Number.isFinite(time)) return null;
  const groups = overlays.map(overlay => ({
    title: overlay.title,
    items: overlay.lines.map(line => ({
      label: overlay.lines.length > 1 ? line.name : '',
      color: line.color,
      value: line.values.get(time),
    })),
  }));
  return { time, groups };
}
