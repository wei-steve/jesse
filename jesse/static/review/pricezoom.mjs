// TradingView-style vertical stretch: with the pointer over the right price scale, the mouse wheel / two-finger
// swipe stretches or squashes the candles vertically; the "A" button in the bottom-right corner (or double-clicking
// the price scale) fits the visible candles to the chart height, like TradingView's A.
// The bundled Lightweight Charts v4 only zooms the TIME axis on wheel and has no "set visible price range" call,
// so the stretch is done through the series' autoscaleInfoProvider, with autoScale left on so the chart keeps
// following scrolling: a stretch fixes how much price the chart shows (`span`, in price units) and centres it on
// the middle of the visible candles. (It used to be a multiple of the automatic range, so the candles grew or
// shrank while dragging the chart sideways as that range changed — the user saw the candle length change.)
// (Pressing and dragging the price scale up/down is the library's own built-in stretch and keeps working.)
// Because autoScale stays on, the library ignores an up/down drag on the chart after a wheel stretch (it only
// pans the price axis when autoScale is off), so stretched candles could not be moved up or down. While a
// stretch is active, an up/down drag in the plot shifts the range itself (`offset`, in spans); the
// time pan of the same drag still works, and "A" / double-clicking the price scale clears it.
// The library's own price-scale drag keeps a separate range of its own (autoScale off), so switching from that
// drag to the wheel used to jump ("两种方式切换时变化很大"). Every wheel notch therefore starts from what is on
// screen right now — the price at the top and bottom of the plot — and a stretch uses no padding, so its span is
// exactly the visible range and both ways continue from each other.

// Wheel delta -> zoom factor applied to the span. exp() makes one notch in and one notch out cancel exactly; the bounds keep the
// candles from collapsing to a line or exploding off-screen.
// Auto-fit ("A"): 4% padding top and bottom, and at most 12 px kept for markers (arrows stay visible, their
// text may overlap the candles a little, like TradingView).
export const FIT_MARGINS = { top: 0.04, bottom: 0.04 }, FIT_MARKER_PX = 12;
export const STRETCH_MARGINS = { top: 0, bottom: 0 };
export const MIN_FACTOR = 0.01, MAX_FACTOR = 20, WHEEL_SPEED = 0.002;
export function nextFactor(factor, deltaY) {
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor * Math.exp(deltaY * WHEEL_SPEED)));
}

// `span` of price centred on the middle of the automatic range (null = no stretch, the range as is). offset
// moves it by that many spans (positive = higher prices, i.e. candles move down).
export function spanRange(range, span, offset = 0) {
  if (!range || span == null) return range;
  const mid = (range.minValue + range.maxValue) / 2 + offset * span;
  return { minValue: mid - span / 2, maxValue: mid + span / 2 };
}

// The span after one wheel step; bounded against the visible candles' own range.
export function nextSpan(span, deltaY, autoSpan) {
  return autoSpan * nextFactor(span / autoSpan, deltaY);
}

export function enablePriceZoom(chart, series, host) {
  // span: wheel stretch in price units (null = none). fit: the "A" button (TradingView's auto-fit) — the price scale follows
  // only the visible candles, so they fill the chart height; MA overlays and the ride line no longer widen it.
  // pinMid: the on-screen middle a wheel notch keeps; turned into `offset` once the provider has the fresh
  // automatic range (it may be stale after a library price-scale drag, during which the provider is not used).
  let span = null, fit = false, offset = 0, autoSpan = 0, pinMid = null;
  const candlesOnly = () => fit || span !== null;
  const stretched = () => span !== null;
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
        autoSpan = info.priceRange.maxValue - info.priceRange.minValue;
        if (pinMid !== null && span !== null) {
          offset = (pinMid - (info.priceRange.maxValue + info.priceRange.minValue) / 2) / span;
          pinMid = null;
        }
        const margins = stretched() ? { above: 0, below: 0 } : fit && info.margins
          ? { above: Math.min(info.margins.above, FIT_MARKER_PX), below: Math.min(info.margins.below, FIT_MARKER_PX) }
          : info.margins;
        return { ...info, priceRange: spanRange(info.priceRange, span, offset), margins };
      },
    });
    chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: stretched() ? STRETCH_MARGINS : fit ? FIT_MARGINS : normalMargins });
    // On touch screens the page normally scrolls on an up/down swipe; while stretched the swipe moves the
    // candles instead (the library sets touch-action: none when vertTouchDrag is on).
    chart.applyOptions({ handleScroll: { vertTouchDrag: stretched() } });
    button.setAttribute('aria-pressed', String(fit));
  };
  const setFit = on => { fit = on; span = null; offset = 0; pinMid = null; apply(); };
  const plotHeight = () => host.clientHeight - chart.timeScale().height();
  // Prices at the top and bottom edge of the plot, whoever set them (this module or the library's scale drag).
  const visibleRange = () => {
    const h = plotHeight(), top = series.coordinateToPrice(0), bottom = series.coordinateToPrice(h);
    return h > 0 && Number.isFinite(top) && Number.isFinite(bottom) && top > bottom ? { top, bottom } : null;
  };
  const autoScaleOn = () => chart.priceScale('right').options().autoScale;
  // Install the provider now: the wheel needs autoSpan (the visible candles' range) from its first notch on.
  apply();
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
    const seen = visibleRange();
    const base = seen ? seen.top - seen.bottom : span ?? autoSpan;
    if (!(base > 0)) return;
    span = nextSpan(base, event.deltaY, autoSpan > 0 ? autoSpan : base);
    pinMid = seen ? (seen.top + seen.bottom) / 2 : null;
    if (pinMid === null) offset = 0;
    apply();
  }, { capture: true, passive: false });
  // up/down drag in the plot while stretched; not stopped, so the chart still pans time with the same drag
  let drag = null, frame = 0;
  host.addEventListener('pointerdown', event => {
    // after a library price-scale drag (autoScale off) the library pans up/down itself
    if (!stretched() || !autoScaleOn() || event.button !== 0 || event.target === button || overScale(event)) return;
    drag = { id: event.pointerId, y: event.clientY, offset };
  }, { capture: true });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const plot = plotHeight();
    if (plot <= 0) return;
    offset = drag.offset + (event.clientY - drag.y) / plot;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); });
  });
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, event => { if (drag && event.pointerId === drag.id) drag = null; });
  }
  // double-clicking the price scale = back to auto height (same as the A button)
  host.addEventListener('dblclick', event => {
    if (event.target === button || !overScale(event)) return;
    setFit(true);
  }, { capture: true });
}
