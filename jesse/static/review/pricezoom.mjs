// TradingView-style vertical stretch: with the pointer over the right price scale, the mouse wheel / two-finger
// swipe stretches or squashes the candles vertically; the "A" button in the bottom-right corner (or double-clicking
// the price scale) fits the visible candles to the chart height, like TradingView's A.
// The bundled Lightweight Charts v4 only zooms the TIME axis on wheel and has no "set visible price range" call,
// so the stretch is done through the series' autoscaleInfoProvider: the automatic price range is widened or
// narrowed around its middle by a factor, and autoScale stays on so the chart keeps following scrolling.
// (Pressing and dragging the price scale up/down is the library's own built-in stretch and keeps working.)

// Wheel delta -> zoom factor. exp() makes one notch in and one notch out cancel exactly; the bounds keep the
// candles from collapsing to a line or exploding off-screen.
// Auto-fit ("A"): 4% padding top and bottom, and at most 12 px kept for markers (arrows stay visible, their
// text may overlap the candles a little, like TradingView).
export const FIT_MARGINS = { top: 0.04, bottom: 0.04 }, FIT_MARKER_PX = 12;
export const MIN_FACTOR = 0.01, MAX_FACTOR = 20, WHEEL_SPEED = 0.002;
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
  // factor: wheel stretch (1 = none). fit: the "A" button (TradingView's auto-fit) — the price scale follows
  // only the visible candles, so they fill the chart height; MA overlays and the ride line no longer widen it.
  let factor = 1, fit = false;
  const candlesOnly = () => fit || factor !== 1;
  // The price scale fits the union of every series' automatic range, so MA overlays and the thick ride line
  // stopped the stretch early ("放大到一定程度就不能再放大"). Lines added to this chart from now on drop out of
  // the automatic range while a stretch or auto-fit is active, so only the candles decide it.
  for (const method of ['addLineSeries', 'addHistogramSeries', 'addAreaSeries', 'addBaselineSeries']) {
    const add = chart[method]?.bind(chart);
    if (!add) continue;
    chart[method] = (options = {}) => add({
      ...options,
      autoscaleInfoProvider: original => (candlesOnly() ? null : (options.autoscaleInfoProvider ?? (o => o()))(original)),
    });
  }
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'price-fit'; button.textContent = 'A';
  button.title = '自动适应：按当前看到的 K 线调整高度，让 K 线填满图（再点一次取消）';
  button.setAttribute('aria-pressed', 'false');
  host.append(button);
  // Auto-fit fills the height: the page's normal 10% top/bottom padding and the room reserved for the ride
  // markers' text (often 30+ px on a short chart) left the candles in only about half of it.
  const normalMargins = chart.priceScale('right').options().scaleMargins;
  const apply = () => {
    series.applyOptions({
      autoscaleInfoProvider: original => {
        const info = original();
        if (!info?.priceRange) return info;
        const margins = fit && info.margins
          ? { above: Math.min(info.margins.above, FIT_MARKER_PX), below: Math.min(info.margins.below, FIT_MARKER_PX) }
          : info.margins;
        return { ...info, priceRange: scaledRange(info.priceRange, factor), margins };
      },
    });
    chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: fit ? FIT_MARGINS : normalMargins });
    button.setAttribute('aria-pressed', String(fit));
  };
  const setFit = on => { fit = on; factor = 1; apply(); };
  // stop the chart from also seeing the click (it would start a pan / move the crosshair)
  for (const type of ['pointerdown', 'mousedown', 'dblclick']) button.addEventListener(type, event => event.stopPropagation());
  button.addEventListener('click', event => { event.stopPropagation(); setFit(!fit); });
  const overScale = event => {
    const width = chart.priceScale('right').width();
    return width > 0 && event.clientX >= host.getBoundingClientRect().right - width;
  };
  // capture: runs before the chart's own wheel handler, which would otherwise zoom the time axis
  host.addEventListener('wheel', event => {
    if (!overScale(event)) return;
    event.preventDefault(); event.stopPropagation();
    fit = false;
    factor = nextFactor(factor, event.deltaY);
    apply();
  }, { capture: true, passive: false });
  // double-clicking the price scale = back to auto height (same as the A button)
  host.addEventListener('dblclick', event => {
    if (event.target === button || !overScale(event)) return;
    setFit(true);
  }, { capture: true });
}
