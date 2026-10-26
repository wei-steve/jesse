// Pure helpers for the backtest picker and the trade list. No DOM, no network.

export const PAGE_SIZE = 100;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const STATUS_TEXT = { finished: '已完成', running: '运行中', queued: '排队中', stopped: '已停止',
  cancelled: '已取消', terminated: '已终止', failed: '失败', exception: '出错' };

export const isSessionId = value => typeof value === 'string' && UUID.test(value);

// Only a finished backtest has the saved trades and chart data the page needs.
export const canSelect = session => session?.status === 'finished';

export function statusText(status) {
  return STATUS_TEXT[status] ?? (typeof status === 'string' && status ? status : '未知');
}

// Request body for POST /backtest/sessions. An empty search is left out so the
// server returns everything; the search text is trimmed.
export function listRequest(search, offset = 0, limit = PAGE_SIZE) {
  const body = { limit, offset };
  const title = typeof search === 'string' ? search.trim() : '';
  if (title) body.title_search = title;
  return body;
}

// Keeps only usable rows (object with a string id). Server order (most recently
// updated first) is preserved.
export function normalizeSessions(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.id === 'string' && row.id);
}

// Appends a page to the loaded list. A backtest can move up the order between
// requests, so the same id may come back; the first copy wins.
export function mergePages(current, page) {
  const seen = new Set(current.map(row => row.id));
  return [...current, ...normalizeSessions(page).filter(row => !seen.has(row.id))];
}

// A full page means there may be more; the next offset counts rows the server returned.
export const hasMore = (pageRows, limit = PAGE_SIZE) => Array.isArray(pageRows) && pageRows.length >= limit;

const firstRoute = session => session?.state?.form?.routes?.[0];

// Title, or the strategy name of the first route, or a short id.
export function sessionTitle(session) {
  const title = typeof session?.title === 'string' ? session.title.trim() : '';
  if (title) return title;
  const strategy = firstRoute(session)?.strategy;
  return typeof strategy === 'string' && strategy ? strategy : String(session?.id ?? '').slice(0, 8);
}

export function sessionRange(session) {
  const form = session?.state?.form;
  return form?.start_date && form?.finish_date ? `${form.start_date} — ${form.finish_date}` : null;
}

// net_profit_percentage is already a percentage (-13.26 means -13.26%).
const profitValue = session => {
  const value = session?.net_profit_percentage;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export function profitText(session) {
  const value = profitValue(session);
  return value === null ? null : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

// Everything the list row shows; absent fields are null, never guessed.
// The list API has no trade count today; it is shown only if one appears.
export function sessionRow(session) {
  const count = session?.trade_count ?? session?.total_trades;
  const profit = profitValue(session);
  return {
    id: session.id,
    title: sessionTitle(session),
    range: sessionRange(session),
    status: statusText(session.status),
    selectable: canSelect(session),
    trades: Number.isInteger(count) && count >= 0 ? `${count} 笔` : null,
    profit: profitText(session),
    profitSign: profit === null ? null : profit >= 0 ? 'positive' : 'negative',
  };
}

// Holding time from seconds: minutes up to 60, "X 小时 Y 分钟" beyond.
export function formatHolding(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes <= 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

// `?session=` value from a location.search string, or null.
export function sessionFromSearch(search) {
  const value = new URLSearchParams(search).get('session');
  return isSessionId(value) ? value : null;
}

// Search string for a chosen session; other query parameters are kept.
export function searchForSession(search, id) {
  const params = new URLSearchParams(search);
  params.set('session', id);
  return `?${params}`;
}
