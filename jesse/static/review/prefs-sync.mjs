// Server copy of the review pages' settings (T-58). The pages keep their settings in localStorage, which is per
// browser *and per origin*: a new LAN address, another computer or another browser opened everything at its default
// (the watchlist, the indicators, the finder form). Every `jesse.*` key is now also mirrored into the project's
// `storage/review-prefs.json` (`POST /review/prefs`, `/review/prefs/save` in review_controller.py), so any address
// opens with the settings that were last used anywhere.
//
// The three pages load this module's `loadPrefs()` *before* their own module, so it runs while the page is still
// empty: it brings the server's keys into localStorage, uploads the keys only this browser has, and then intercepts
// the pages' own writes. Everything that can be reasoned about without a browser (the merge, the debounced batch,
// the interception rule) is a plain function, tested by tests/review-prefs-sync.test.mjs.
//
// Only `jesse.` keys are mirrored: the dashboard's `main` key (the login token) must stay in the browser, and the
// pages' other keys are not settings. A new `jesse.` key added by a page is mirrored automatically — nothing to
// change here, and nothing to change on the server.
// `jesse.` + 1-80 characters, the rule the server applies (review_controller.PREF_KEY): a key this module would
// upload and the server would refuse must never leave the browser.
export const PREF_KEY_RE = /^jesse\.[A-Za-z0-9_.\-]{1,80}$/;
// One value is a serialised localStorage value; the server refuses anything above 256 KB (MAX_PREF_VALUE_BYTES).
export const MAX_VALUE_BYTES = 256 * 1024;
export const READ_PATH = '/review/prefs';
export const SAVE_PATH = '/review/prefs/save';
// The dashboard stores `{authToken}` under this key; the review pages read the token the same way (market.mjs).
export const TOKEN_KEY = 'main';
// A click on a page can write a dozen keys in a row (one indicator = periods, colours and the list), so the writes
// are batched: one request after the page has been quiet for this long.
export const SAVE_DEBOUNCE_MS = 800;
// Reading the settings must never hold the page back: a server that does not answer within this leaves the page on
// its own settings (offline, Jesse restarting, the wrong address).
export const LOAD_TIMEOUT_MS = 3000;

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** UTF-8 length of a value. The server measures bytes, and a Chinese note is 3 bytes per character. */
export const valueBytes = value => (encoder ? encoder.encode(String(value)).length : String(value).length);

export const isPrefKey = key => typeof key === 'string' && PREF_KEY_RE.test(key);
export const isPrefValue = value => typeof value === 'string' && valueBytes(value) <= MAX_VALUE_BYTES;

/**
 * What to do with the server's copy and this browser's keys.
 *
 * `server` is `POST /review/prefs`'s `prefs` (`{key: value}`), `local` is this browser's list of `[key, value]` pairs.
 * The server wins for every key it has (that is the whole point: a new address must show what was saved elsewhere),
 * and the keys only this browser has are uploaded (a browser that already had settings before this feature existed
 * seeds the server the first time it opens a page). Keys that are not `jesse.` are never touched either way.
 *
 * Returns `{write, upload}`: `write` goes into localStorage, `upload` goes to `POST /review/prefs/save`.
 */
export function mergePrefs(server, local) {
  const stored = server && typeof server === 'object' && !Array.isArray(server) ? server : {};
  const write = {};
  for (const [key, value] of Object.entries(stored)) {
    // A hand-edited server file can hold a key or value the API would refuse; it is simply not a setting.
    if (isPrefKey(key) && isPrefValue(value)) write[key] = value;
  }
  const upload = {};
  for (const entry of Array.isArray(local) ? local : []) {
    const [key, value] = Array.isArray(entry) ? entry : [entry?.key, entry?.value];
    if (!isPrefKey(key) || !isPrefValue(value)) continue;
    // A server value that was unusable above is not a server value: this browser's copy fills it in.
    if (!Object.hasOwn(write, key)) upload[key] = value;
  }
  return { write, upload };
}

/** This browser's `jesse.` keys as `[key, value]` pairs (the `local` argument of `mergePrefs`). */
export function localPrefs(storage) {
  const entries = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const value = isPrefKey(key) ? storage.getItem(key) : null;
      if (typeof value === 'string') entries.push([key, value]);
    }
  } catch { /* a browser that refuses localStorage has no settings to send */ }
  return entries;
}

/** The dashboard token, read exactly like market.mjs / finder.mjs do it. */
export function tokenOf(storage) {
  try { return JSON.parse(storage.getItem(TOKEN_KEY) ?? '{}').authToken ?? null; } catch { return null; }
}

const logFailure = (where, error) => console.warn(`[prefs] 设置同步失败（${where}）：${error?.message ?? error}`);

const later = (callback, ms) => globalThis.setTimeout(callback, ms);
const stop = handle => globalThis.clearTimeout(handle);

/**
 * The write side: collect changes and send them as one batch after the page stops writing.
 *
 * `send(items, {keepalive})` performs the request (`items[key] = null` deletes). A failed send is logged once and
 * dropped — a settings mirror must never interrupt the page with an error box, and the next change re-sends its key.
 * `flush({keepalive: true})` is for `visibilitychange` / `pagehide`, where there is no time left for the debounce.
 */
export function createPrefsSaver({ send, delay = SAVE_DEBOUNCE_MS,
  setTimeout: setTimer = later, clearTimeout: clearTimer = stop } = {}) {
  let pending = new Map();
  let timer = null;
  const flush = ({ keepalive = false } = {}) => {
    timer = null;
    if (!pending.size) return;
    const items = Object.fromEntries(pending);
    pending = new Map();
    try {
      const answer = send(items, { keepalive });
      if (answer && typeof answer.then === 'function') answer.then(undefined, error => logFailure('保存', error));
    } catch (error) { logFailure('保存', error); }
  };
  return {
    flush,
    /** Remember one change. A key or value the server would refuse is not recorded (the local copy stays). */
    change(key, value) {
      if (!isPrefKey(key)) return;
      if (value !== null && !isPrefValue(value)) return;
      pending.set(key, value);
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => flush(), delay);
    },
    /** What is waiting to be sent (tests). */
    pending: () => new Map(pending),
  };
}

/**
 * Wrap one Storage prototype so every `jesse.` write is reported to `onChange(key, value | null)`.
 *
 * The prototype is wrapped, not the instance, on purpose: `localStorage.setItem = fn` would not replace the method —
 * assigning a property on a Storage object *stores an item* called `setItem` — so the only way to see the pages'
 * writes without touching the dozens of `localStorage.setItem(...)` call sites is `Storage.prototype`.
 * `isTarget(instance)` keeps the patch off sessionStorage (and anything else sharing the prototype).
 */
export function patchStorage(proto, { onChange, isTarget = () => true } = {}) {
  const originalSet = proto.setItem;
  const originalRemove = proto.removeItem;
  proto.setItem = function setItem(key, value) {
    const text = String(value);
    // The real write happens first: a quota error must not look like a saved setting.
    const result = originalSet.call(this, key, text);
    if (isTarget(this) && isPrefKey(key) && isPrefValue(text)) onChange(key, text);
    return result;
  };
  proto.removeItem = function removeItem(key) {
    const result = originalRemove.call(this, key);
    if (isTarget(this) && isPrefKey(key)) onChange(key, null);
    return result;
  };
  return function restore() {
    proto.setItem = originalSet;
    proto.removeItem = originalRemove;
  };
}

/** One POST to Jesse. A hidden / closing page passes `keepalive` and gets no timeout (the browser finishes it). */
async function postJson(path, body, token, fetcher, { keepalive = false, timeout = LOAD_TIMEOUT_MS } = {}) {
  const controller = !keepalive && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? later(() => controller.abort(), timeout) : null;
  try {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      keepalive,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json().catch(() => ({}));
  } finally {
    if (timer !== null) stop(timer);
  }
}

let installed = null;

/**
 * Load the server's settings into this browser, then mirror every later `jesse.` write back to it.
 *
 * Called (awaited) by index.html / finder.html / market.html before their own module. No token (never logged in),
 * no answer within 3 seconds, or a failing request: the page keeps its own settings and nothing is shown — the pages
 * work offline exactly as before. The returned object is for the console and the tests.
 */
export async function loadPrefs({ storage = globalThis.localStorage, fetcher = globalThis.fetch,
  doc = globalThis.document, delay = SAVE_DEBOUNCE_MS } = {}) {
  const skipped = { synced: false, applied: [], uploaded: [] };
  if (!storage || typeof fetcher !== 'function') return skipped;
  const token = tokenOf(storage);
  if (!token) return skipped;

  let answer;
  try {
    answer = await postJson(READ_PATH, {}, token, fetcher);
  } catch (error) {
    logFailure('读取', error);
    return skipped;
  }

  const { write, upload } = mergePrefs(answer?.prefs, localPrefs(storage));
  for (const [key, value] of Object.entries(write)) {
    // Written before the patch below is installed: the server's own keys must not be uploaded straight back.
    try { storage.setItem(key, value); } catch { /* quota: the page still works with what it has */ }
  }

  const saver = createPrefsSaver({
    delay,
    send: (items, options) => postJson(SAVE_PATH, { items }, token, fetcher, options),
  });
  for (const [key, value] of Object.entries(upload)) saver.change(key, value);
  if (Object.keys(upload).length) saver.flush();

  if (installed !== storage) {
    installed = storage;
    patchStorage(Object.getPrototypeOf(storage), {
      onChange: (key, value) => saver.change(key, value),
      isTarget: instance => instance === storage,
    });
  }

  if (doc && typeof doc.addEventListener === 'function') {
    const leave = () => saver.flush({ keepalive: true });
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') leave(); });
    doc.addEventListener('pagehide', leave);
  }

  return { synced: true, applied: Object.keys(write), uploaded: Object.keys(upload) };
}
