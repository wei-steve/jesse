// Chart snapshots for the review pages: compose the Lightweight Charts images of a card into one PNG,
// optionally annotate it, and hand it to Jesse (POST /review/screenshot) so it lands in a fixed folder
// on the machine running `jesse run`. No dependency is added; only plain canvases and pointer events.
// gridLayout / snapshotFileName / utcStamp are pure and covered by tests/review-snapshot.test.mjs.

const HEADER_HEIGHT = 28;
const GRID_GAP = 8;
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
const TOOLS = [['pen', '画笔'], ['arrow', '箭头'], ['line', '直线'], ['box', '方框'], ['text', '文字']];
// 默认红；绿/蓝/黄/黑覆盖上涨、下跌、支撑/阻力、重点与中性说明这几种常见用法
const COLORS = [['红', '#e02424'], ['绿', '#12a150'], ['蓝', '#1d5fd0'], ['黄', '#f0b400'], ['黑', '#101828']];

// ---- Pure helpers ----------------------------------------------------------

/** UTC stamp of the header lines, e.g. `2026-10-27 20:21`. */
export function utcStamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  return (Number.isNaN(value.getTime()) ? new Date(0) : value).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Where every image goes in a grid. Each column is as wide as its widest image and each row as tall as
 * its tallest one, so cards with different sizes still line up; images are centred inside their cell.
 * The header band (HEADER_HEIGHT) sits above the first row and is not part of any cell.
 */
export function gridLayout(sizes, columns = 2, gap = GRID_GAP, headerHeight = HEADER_HEIGHT) {
  const list = (sizes ?? []).filter(Boolean);
  const layout = { width: 0, height: headerHeight, headerHeight, gap, columns: Math.max(1, columns || 1), cells: [] };
  if (!list.length) return layout;
  const cols = Math.max(1, Math.min(layout.columns, list.length));
  const widths = new Array(cols).fill(0);
  const heights = [];
  list.forEach((size, i) => {
    widths[i % cols] = Math.max(widths[i % cols], size.width);
    const row = Math.floor(i / cols);
    heights[row] = Math.max(heights[row] ?? 0, size.height);
  });
  const lefts = [];
  let x = 0;
  for (const width of widths) { lefts.push(x); x += width + gap; }
  const tops = [];
  let y = headerHeight;
  for (const height of heights) { tops.push(y); y += height + gap; }
  list.forEach((size, i) => {
    const column = i % cols;
    const row = Math.floor(i / cols);
    layout.cells.push({
      x: lefts[column] + Math.round((widths[column] - size.width) / 2),
      y: tops[row] + Math.round((heights[row] - size.height) / 2),
      width: size.width,
      height: size.height,
    });
  });
  layout.width = Math.max(0, x - gap);
  layout.height = Math.max(headerHeight, y - gap);
  return layout;
}

/**
 * Download name in UTC, e.g. `20261112-153045-3m.png`. Anything outside [A-Za-z0-9] in the label becomes
 * a single `-` (the server keeps `[A-Za-z0-9_-]` only, so both sides agree on the name).
 */
export function snapshotFileName(date, label = 'snapshot') {
  const value = date instanceof Date ? date : new Date(date);
  const stamp = (Number.isNaN(value.getTime()) ? new Date(0) : value)
    .toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const slug = String(label ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${stamp}-${slug || 'snapshot'}.png`;
}

// ---- Composition -----------------------------------------------------------

function fitText(ctx, text, maxWidth) {
  const value = String(text ?? '');
  if (!value || ctx.measureText(value).width <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// White title bar: bold title on the left, grey subtitle right-aligned. Both are trimmed to fit, so a long
// trade description never runs under the timeframe label.
function drawHeader(ctx, width, height, title, subtitle) {
  if (height <= 0) return;
  ctx.save();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e4e9f1'; ctx.fillRect(0, height - 1, width, 1);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `700 15px ${FONT}`;
  ctx.fillStyle = '#203047';
  const titleText = fitText(ctx, title, Math.max(60, width * 0.35));
  ctx.fillText(titleText, 10, height / 2);
  const titleWidth = ctx.measureText(titleText).width;
  const room = width - 20 - titleWidth - 12;
  if (room > 40) {
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#7b8aa0';
    ctx.textAlign = 'right';
    ctx.fillText(fitText(ctx, subtitle, room), width - 10, height / 2);
  }
  ctx.restore();
}

function chartImage(chart) {
  try {
    const shot = typeof chart?.takeScreenshot === 'function' ? chart.takeScreenshot() : chart;
    return shot?.width && shot?.height ? shot : null;
  } catch {
    // takeScreenshot throws for a chart that was already removed; one missing image beats a failed card.
    return null;
  }
}

/**
 * One card as one canvas: the card's charts (main first, then the sub-panes in display order) stacked
 * vertically under a white title bar. `card` only provides a minimum width so the header always fits.
 */
export function captureCard(card, charts, caption = {}) {
  const images = (charts ?? []).map(chartImage).filter(Boolean);
  const widest = images.reduce((max, image) => Math.max(max, image.width), 0);
  const width = Math.max(widest, Math.round(card?.clientWidth ?? 0), 320);
  const height = HEADER_HEIGHT + images.reduce((sum, image) => sum + image.height, 0);
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  let y = HEADER_HEIGHT;
  for (const image of images) {
    ctx.drawImage(image, Math.round((width - image.width) / 2), y);
    y += image.height;
  }
  drawHeader(ctx, width, HEADER_HEIGHT, caption.title ?? '', caption.subtitle ?? '');
  return out;
}

/** Several card canvases in a 2-column grid under one header line (`header` is the whole title text). */
export function captureGrid(items, columns = 2, header = '') {
  const list = (items ?? []).filter(Boolean);
  const headerHeight = header ? HEADER_HEIGHT : 0;
  const layout = gridLayout(list.map(item => ({ width: item.width, height: item.height })), columns, GRID_GAP, headerHeight);
  const out = document.createElement('canvas');
  out.width = Math.max(layout.width, 320);
  out.height = Math.max(layout.height, headerHeight);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height);
  list.forEach((item, i) => ctx.drawImage(item, layout.cells[i].x, layout.cells[i].y));
  drawHeader(ctx, out.width, headerHeight, header, '');
  return out;
}

/** Uploads a snapshot as the base64 body the server expects (no `data:` prefix). */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/** The `onSave` both pages pass to openAnnotator: POST /review/screenshot through the page's own post(). */
export function screenshotSaver(post, label) {
  return async (blob, note) => post('/review/screenshot', {
    image: await blobToBase64(blob),
    label,
    note: note || undefined,
  });
}

/** The small 「截图」 button in a card's title row. */
export function addSnapshotButton(card, onClick, text = '截图') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'snapshot-btn'; button.textContent = text;
  button.setAttribute('aria-label', '截图并标注这张图');
  button.onclick = onClick;
  (card.querySelector('.chart-head h3') ?? card.querySelector('.chart-head') ?? card).append(button);
  return button;
}

// ---- Maximize ---------------------------------------------------------------
// 放大: one card fills the chart grid and the other timeframes are hidden (display:none, so their charts
// keep running and catch up through the normal range linking when shown again). 还原 / Esc restores.
export function toggleMaximize(card, force) {
  const grid = card?.closest('.chart-grid');
  if (!grid) return;
  const on = force ?? !card.classList.contains('maximized');
  for (const other of grid.querySelectorAll('.chart-card.maximized')) other.classList.remove('maximized');
  for (const button of grid.querySelectorAll('.maximize-btn')) button.textContent = '放大';
  grid.classList.toggle('has-maximized', on);
  if (!on) return;
  card.classList.add('maximized');
  const button = card.querySelector('.maximize-btn');
  if (button) button.textContent = '还原';
  card.scrollIntoView({ block: 'start' });
}

export function addMaximizeButton(card) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'snapshot-btn maximize-btn'; button.textContent = '放大';
  button.title = '放大这张图，隐藏其他周期（再点一次或按 Esc 还原）';
  button.onclick = () => toggleMaximize(card);
  (card.querySelector('.chart-head h3') ?? card.querySelector('.chart-head') ?? card).append(button);
  return button;
}

// Registered when the module loads, i.e. before any annotator's own capture listener, so it runs first and
// can tell that an open annotator (or a text box in it) owns this Esc.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('.snapshot-annotator')) return;
    const card = document.querySelector('.chart-card.maximized');
    if (card) toggleMaximize(card, false);
  }, true);
}

// ---- Annotator -------------------------------------------------------------

function drawShape(ctx, shape, lineWidth, fontSize) {
  const points = shape.points ?? [];
  if (!points.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = shape.color; ctx.fillStyle = shape.color; ctx.lineWidth = lineWidth;
  if (shape.tool === 'text') {
    ctx.font = `600 ${fontSize}px ${FONT}`;
    ctx.textBaseline = 'top';
    // A white outline keeps the label readable on top of candles of any colour.
    ctx.lineWidth = Math.max(3, fontSize / 6);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(shape.text, points[0].x, points[0].y);
    ctx.fillStyle = shape.color;
    ctx.fillText(shape.text, points[0].x, points[0].y);
  } else if (shape.tool === 'pen') {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    // A tap with the pen tool still leaves a dot.
    if (points.length === 1) ctx.lineTo(points[0].x + 0.5, points[0].y);
    ctx.stroke();
  } else {
    const start = points[0];
    const end = points[points.length - 1];
    ctx.beginPath();
    if (shape.tool === 'box') {
      ctx.rect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y));
      ctx.stroke();
    } else {
      ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      if (shape.tool === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const head = Math.max(10, lineWidth * 4);
        // Narrow head so a short arrow is not all head.
        const reach = Math.min(head, Math.hypot(end.x - start.x, end.y - start.y) * 0.6);
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - reach * Math.cos(angle - Math.PI / 7), end.y - reach * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(end.x - reach * Math.cos(angle + Math.PI / 7), end.y - reach * Math.sin(angle + Math.PI / 7));
        ctx.closePath(); ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * Full-screen annotation layer for `canvas`. Drawings are kept as a list of strokes (one entry per
 * gesture) and replayed on every change, so undo/clear never touch the base image and the export is
 * the original resolution. `onSave(blob, note)` hands the PNG over (see screenshotSaver).
 */
export function openAnnotator(canvas, { onSave, fileLabel = 'snapshot' } = {}) {
  const width = canvas.width || 1;
  const height = canvas.height || 1;
  // Line and text sizes scale with the image so a high-DPI iPad screenshot does not get hair-thin lines.
  const lineWidth = Math.max(3, width / 400);
  const fontSize = Math.max(18, width / 60);

  const root = document.createElement('div');
  root.className = 'snapshot-annotator';
  root.innerHTML = `
    <div class="snapshot-top">
      <div class="snapshot-tools" role="toolbar" aria-label="标注工具"></div>
      <div class="snapshot-note"><label>备注（可选） <input type="text" maxlength="2000" placeholder="跟截图一起给 Claude 的说明"></label></div>
      <p class="snapshot-message" role="status"></p>
    </div>
    <div class="snapshot-stage"><div class="snapshot-frame">
      <canvas class="snapshot-base"></canvas><canvas class="snapshot-overlay"></canvas>
    </div></div>`;
  const tools = root.querySelector('.snapshot-tools');
  const frame = root.querySelector('.snapshot-frame');
  const base = root.querySelector('.snapshot-base');
  const overlay = root.querySelector('.snapshot-overlay');
  const messageBox = root.querySelector('.snapshot-message');
  const noteInput = root.querySelector('.snapshot-note input');
  const context = overlay.getContext('2d');

  for (const [name, label] of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.tool = name; button.textContent = label;
    tools.append(button);
  }
  tools.append(Object.assign(document.createElement('span'), { className: 'snapshot-sep' }));
  // Colour buttons are bare swatches; the colour name only lives in the aria-label.
  for (const [label, color] of COLORS) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.color = color; button.className = 'snapshot-color';
    button.style.background = color;
    button.setAttribute('aria-label', `颜色：${label}`);
    tools.append(button);
  }
  tools.append(Object.assign(document.createElement('span'), { className: 'snapshot-sep' }));
  for (const [action, label] of [['undo', '撤销'], ['clear', '清空']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.action = action; button.textContent = label;
    tools.append(button);
  }
  tools.append(Object.assign(document.createElement('span'), { className: 'snapshot-spacer' }));
  for (const [action, label] of [['copy', '复制'], ['download', '下载'], ['save', '保存给 Claude']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.action = action; button.textContent = label;
    tools.append(button);
  }
  const shareButton = document.createElement('button');
  shareButton.type = 'button'; shareButton.dataset.action = 'share'; shareButton.textContent = '分享'; shareButton.hidden = true;
  tools.append(shareButton);
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'snapshot-close'; closeButton.dataset.action = 'close'; closeButton.textContent = '关闭';
  tools.append(closeButton);

  for (const layer of [base, overlay]) {
    layer.width = width; layer.height = height;
  }
  base.getContext('2d').drawImage(canvas, 0, 0);

  let tool = 'pen';
  let color = COLORS[0][1];
  let drawing = null;
  let activePointer = null;
  const shapes = [];

  function message(text, error = false) {
    messageBox.textContent = text;
    messageBox.classList.toggle('error', error);
  }

  function redraw() {
    context.clearRect(0, 0, width, height);
    for (const shape of shapes) drawShape(context, shape, lineWidth, fontSize);
    if (drawing) drawShape(context, drawing, lineWidth, fontSize);
  }

  function paintTools() {
    for (const button of tools.querySelectorAll('[data-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    }
    for (const button of tools.querySelectorAll('[data-color]')) {
      button.setAttribute('aria-pressed', String(button.dataset.color === color));
    }
  }

  function fit() {
    const stage = root.querySelector('.snapshot-stage');
    if (!stage.clientWidth || !stage.clientHeight) return;
    // A single small chart is enlarged (up to 2x) so it is easy to draw on; large grids shrink to fit.
    const scale = Math.min(2, (stage.clientWidth - 24) / width, (stage.clientHeight - 24) / height);
    frame.style.width = `${Math.max(80, Math.round(width * scale))}px`;
    frame.style.height = `${Math.max(60, Math.round(height * scale))}px`;
  }

  // Pointer positions come back as CSS pixels; drawings are stored in the image's own pixels so the
  // export keeps the full resolution no matter how small the on-screen preview is.
  function point(event) {
    const rect = overlay.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (width / (rect.width || 1)),
      y: (event.clientY - rect.top) * (height / (rect.height || 1)),
    };
  }

  function addText(start) {
    const rect = overlay.getBoundingClientRect();
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'snapshot-text-input'; input.maxLength = 200;
    input.style.left = `${(start.x / width) * rect.width}px`;
    input.style.top = `${(start.y / height) * rect.height}px`;
    input.style.fontSize = `${Math.max(12, fontSize * (rect.width / width))}px`;
    frame.append(input);
    input.focus();
    // remove() blurs the input, which calls finish again from onblur: the flag makes the second call a no-op.
    let finished = false;
    const finish = commit => {
      if (finished) return;
      finished = true;
      const text = input.value.trim();
      input.remove();
      if (!commit || !text) return;
      shapes.push({ tool: 'text', color, points: [start], text });
      redraw();
    };
    input.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      // Esc closes only this text box; onKey sees the focused input and leaves the layer open.
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
  }

  overlay.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (activePointer !== null && activePointer !== event.pointerId) return;
    event.preventDefault();
    activePointer = event.pointerId;
    overlay.setPointerCapture?.(event.pointerId);
    const start = point(event);
    if (tool === 'text') { activePointer = null; addText(start); return; }
    drawing = { tool, color, points: [start, start] };
    redraw();
  });

  overlay.addEventListener('pointermove', event => {
    if (!drawing || event.pointerId !== activePointer) return;
    event.preventDefault();
    const moved = point(event);
    if (drawing.tool === 'pen') drawing.points.push(moved);
    else drawing.points[1] = moved;
    redraw();
  });

  function finishStroke(event) {
    if (!drawing || event.pointerId !== activePointer) return;
    const end = point(event);
    if (drawing.tool === 'pen') drawing.points.push(end);
    else drawing.points[1] = end;
    // Implicit release on pointerup can already have happened, and releasing twice throws.
    try { overlay.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    activePointer = null;
    const [start] = drawing.points;
    const last = drawing.points[drawing.points.length - 1];
    // A tap with a shape tool would store an invisible stroke; a pen tap is kept as a dot on purpose.
    if (Math.hypot(last.x - start.x, last.y - start.y) < 3 && drawing.tool !== 'pen') drawing = null;
    else { shapes.push(drawing); drawing = null; }
    redraw();
  }
  overlay.addEventListener('pointerup', finishStroke);
  // A cancelled gesture (the browser took over the touch) leaves nothing behind.
  overlay.addEventListener('pointercancel', () => { drawing = null; activePointer = null; redraw(); });

  function compose() {
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    ctx.drawImage(base, 0, 0);
    for (const shape of shapes) drawShape(ctx, shape, lineWidth, fontSize);
    return out;
  }

  function toBlob() {
    return new Promise((resolve, reject) => {
      compose().toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败')), 'image/png');
    });
  }

  async function copy() {
    try {
      const blob = await toBlob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      message('已复制，可以直接粘贴给 Claude');
    } catch {
      // Clipboard images need a secure context and a browser that supports ClipboardItem (Safari and
      // older mobile browsers often do not); the other two buttons always work.
      message('这个浏览器不能复制图片，请用下载或保存给 Claude', true);
    }
  }

  async function download() {
    try {
      const blob = await toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = snapshotFileName(new Date(), fileLabel);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      message(`已下载 ${link.download}`);
    } catch (error) { message(`下载失败：${error.message}`, true); }
  }

  async function save() {
    if (typeof onSave !== 'function') { message('这个页面没有配置保存接口', true); return; }
    message('正在保存…');
    try {
      const result = await onSave(await toBlob(), noteInput.value.trim());
      const file = typeof result === 'string' ? result : result?.file;
      message(`已保存${file ? ` ${file}` : ''}，跟 Claude 说「看最新截图」即可`);
    } catch (error) { message(`保存失败：${error.message}`, true); }
  }

  async function share() {
    try {
      const file = new File([await toBlob()], snapshotFileName(new Date(), fileLabel), { type: 'image/png' });
      await navigator.share({ files: [file], title: 'Jesse 截图' });
    } catch (error) {
      // The user closing the share sheet is not a failure.
      if (error?.name !== 'AbortError') message(`分享失败：${error.message}`, true);
    }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    root.remove();
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    // The listener runs in the capture phase, so an open text box gets Esc first and cancels only itself.
    if (document.activeElement?.classList?.contains('snapshot-text-input')) return;
    event.preventDefault(); close();
  }

  tools.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tool) { tool = button.dataset.tool; paintTools(); return; }
    if (button.dataset.color) { color = button.dataset.color; paintTools(); return; }
    const actions = { undo: () => { shapes.pop(); redraw(); }, clear: () => { shapes.length = 0; redraw(); },
      copy, download, save, share, close };
    actions[button.dataset.action]?.();
  });

  // canShare() only looks at the file types, so a placeholder PNG is enough to decide whether to offer 分享;
  // the real file is built from the annotated canvas when it is clicked.
  if (typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'snapshot.png', { type: 'image/png' })] })) {
    shareButton.hidden = false;
  }

  document.body.append(root);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', fit);
  paintTools(); redraw();
  // The stage has no size until it is in the document.
  requestAnimationFrame(fit);

  return { close, redraw };
}
