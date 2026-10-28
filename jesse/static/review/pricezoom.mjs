// TradingView-style vertical stretch: with the pointer over the right price scale, the mouse wheel / two-finger
// swipe stretches or squashes the candles vertically; double-clicking the price scale returns to auto height.
// The bundled Lightweight Charts v4 only zooms the TIME axis on wheel and has no "set visible price range" call,
// so the stretch is done through the series' autoscaleInfoProvider: the automatic price range is widened or
// narrowed around its middle by a factor, and autoScale stays on so the chart keeps following scrolling.
// (Pressing and dragging the price scale up/down is the library's own built-in stretch and keeps working.)

// Wheel delta -> zoom factor. exp() makes one notch in and one notch out cancel exactly; the bounds keep the
// candles from collapsing to a line or exploding off-screen.
export const MIN_FACTOR = 0.05, MAX_FACTOR = 20, WHEEL_SPEED = 0.002;
export function nextFactor(factor, deltaY) {
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor * Math.exp(deltaY * WHEEL_SPEED)));
}

// The automatic range scaled around its middle (factor > 1 shows more price = shorter candles).
export function scaledRange(range, factor) {
  if (!range || factor === 1) return range;
  const mid = (range.minValue + range.maxValue) / 2, half = (range.maxValue - range.minValue) / 2 * factor;
  return { minValue: mid - half, maxValue: mid + half };
}

export function enablePriceZoom(chart, series, host) {
  let factor = 1;
  const apply = () => {
    series.applyOptions({
      autoscaleInfoProvider: original => {
        const info = original();
        return info?.priceRange ? { ...info, priceRange: scaledRange(info.priceRange, factor) } : info;
      },
    });
    chart.priceScale('right').applyOptions({ autoScale: true });
  };
  const overScale = event => {
    const width = chart.priceScale('right').width();
    return width > 0 && event.clientX >= host.getBoundingClientRect().right - width;
  };
  // capture: runs before the chart's own wheel handler, which would otherwise zoom the time axis
  host.addEventListener('wheel', event => {
    if (!overScale(event)) return;
    event.preventDefault(); event.stopPropagation();
    factor = nextFactor(factor, event.deltaY);
    apply();
  }, { capture: true, passive: false });
  host.addEventListener('dblclick', event => {
    if (!overScale(event)) return;
    factor = 1;
    apply();
  }, { capture: true });
}
