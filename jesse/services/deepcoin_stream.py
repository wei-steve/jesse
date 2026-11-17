"""
The owner's own Deepcoin fills, live (T-63): the private WebSocket push, with the REST sync of `deepcoin_private` as the
authority and the backfill.

Why a push at all: until T-62 the page asked `POST /review/market/fills` every 30 seconds and a new fill could take
half a minute to show up on the chart. Deepcoin's private stream pushes a Trade frame within a few hundred milliseconds
of the match, so the page's own long poll (`POST /review/market/fills/wait`) carries a fill over in about a second. The
push is only ever an accelerator: the store under `storage/deepcoin-fills/` still comes from `GET /deepcoin/trade/fills`,
and everything here is deduplicated against it before it reaches the page.

What the other project (deepcoin-trade-tui) measured, and what this module therefore does (see its `docs/API说明.md` §3
and `docs/API经验-来自telegram项目.md` §1-3):

- `GET /deepcoin/listenkey/acquire` is signed like every other private GET (`timestamp + GET + path`), no query, no
  body. `data` is sometimes an object and sometimes a one-element array, and the field is `listenkey` (`listenKey` is
  accepted too). The key is a credential: it never appears in a log line, an exception message or the status answer.
- The socket is `wss://stream.deepcoin.com/v1/private?listenKey=<key>` and a connection is only subscribed to the Trade
  table, which is the only one a fill needs. The URL carries the key, so a transport failure is reported by its type
  and never by its text.
- A listenKey is hard-expired after 60 minutes and there is no usable renewal endpoint (that is why no extend is ever
  called): every 2700 seconds the worker closes the old socket, acquires a new key, connects and subscribes again. Old
  and new connection never coexist — the venue allows at most 300 connections per IP per 5 minutes, so one at a time is
  the only shape that is safe.
- The venue can also say `{"code":"50118"}` (listen key expired); that is the same rotation, without a backoff.
- Heartbeat is the protocol level ping (websocket-client: one `ping()` every 20 seconds, and the library answers the
  venue's own pings with a pong while it reads).
- A dropped connection reconnects after 1 / 2 / 5 / 10 / 30 / 60 seconds (rotation and 50118 never back off).
- **A subscription sends no snapshot and a reconnect does not replay anything** (the stream has no sequence number), so
  the REST increment is run immediately after every successful connect: the gap the disconnect opened is filled from
  the authoritative endpoint, never assumed to be empty.
- A rate limit is dressed as `HTTP 401 + code 50000` (the whole key is limited to 5 reads per second): back off one
  second and retry at most twice.

On demand, and off when idle: the worker starts when a page asks for a long poll and stops when no page has asked for
three minutes (so an owner who closes the dashboard does not keep a listenKey open). An unconfigured project (no
`.env.deepcoin`) never starts it. The thread is a daemon and a shutdown hook closes its socket, so Ctrl+C never waits
for it.

The fills it receives go into an in-memory realtime layer, one instrument at a time, with a global increasing `seq`:
the long poll asks for "what is newer than `seq`", which is what makes the page's poll a cheap wait instead of a
request per second. Two hours / 2000 fills per instrument is more than a page can draw and far more than a fill takes
to reach the REST store. Each frame also schedules one REST increment for its instrument, debounced by 2 seconds
(a burst of fills of one order is one sync), so the authoritative store catches up while the markers are already on the
chart.

Both pure functions and the worker are tested in `tests/test_deepcoin_stream.py` with invented fills, a fake socket and
a fake clock; nothing here opens a socket or reads a real key during the tests.
"""
import asyncio
import json
import math
import re
import threading
import time
import urllib.parse

import requests
import websocket

from jesse.services import deepcoin_private

BASE = 'https://api.deepcoin.com'
LISTENKEY_PATH = '/deepcoin/listenkey/acquire'
WS_URL = 'wss://stream.deepcoin.com/v1/private'
# The fills are the only table this page needs; subscribing to less is also less to parse.
TABLES = ('Trade',)
# A listenKey is hard-expired after 60 minutes with no usable renewal, so the key is rotated with 15 minutes to spare.
ROTATE_SECONDS = 2700
# The worker connects on demand and stops after this long without a page waiting for it.
IDLE_SECONDS = 180
# The long poll: how long a `wait` request may hold, and how often it looks at the realtime layer (a tiny sleep, so the
# async route never holds a thread-pool thread while it waits).
WAIT_LIMIT = 25.0
WAIT_POLL = 0.3
# Reconnect delays after a dropped connection. Rotation and 50118 are not in here: the key is already unusable then, so
# the new one is acquired immediately.
BACKOFF = (1.0, 2.0, 5.0, 10.0, 30.0, 60.0)
# The venue's read limit is 5 per second for the whole key, dressed as HTTP 401 + code 50000; a rate-limited acquire is
# retried after one second, at most twice.
RATE_LIMIT_CODE = '50000'
RATE_LIMIT_RETRIES = 2
RATE_LIMIT_BACKOFF = 1.0
# The venue's "listen key expired, connection closing" error frame.
EXPIRED_CODE = '50118'
# Frames read with a one-second socket timeout, so rotation, the idle stop and the debounced REST sync are checked even
# while nothing is pushed. The venue pings every ~30-40 seconds.
READ_TIMEOUT = 1.0
PING_SECONDS = 20.0
CONNECT_TIMEOUT = 10.0
# One REST increment per instrument per burst of pushes. A fill takes a moment to appear in the venue's fill endpoint,
# and asking for every fill of one order separately would only spend the rate limit.
SYNC_DEBOUNCE = 2.0
# How much of the realtime layer a page may still ask for: two hours / 2000 fills per instrument.
RETENTION_SECONDS = 2 * 3600
MAX_FILLS = 2000
# Where a fill row's second comes from when `TT` is missing or garbage: the local receive time, because a fill on the
# chart at the wrong hour is worse than one that is a moment late.
# `I` of a Trade frame is the venue's own spelling (`BTCUSDT`); the REST instrument adds both dashes and the market.
INSTRUMENT = re.compile(r'^([A-Z0-9]{1,20})USDT$')
SIDES = {'0': 'buy', '1': 'sell'}
POS_SIDES = {'0': 'long', '1': 'short'}

# Patched by the tests: the realtime layer and the idle/rotation decisions must not depend on a real clock.
monotonic = time.monotonic
wall_time = time.time


class StreamError(Exception):
    """A readable reason for a refused listenKey / push, never carrying the key or the socket URL."""


# --- The listenKey ------------------------------------------------------------------------------------------------
# The acquire call is the only new endpoint of this module, and the listenKey it returns is a credential for the rest of
# its 60 minutes. The signing and the transport shape are the ones of deepcoin_private, so the two cannot drift apart.

def listen_key_of(payload) -> str:
    """The `listenkey` of one acquire answer: `data` as an object or as a one-element array.

    A missing key is an error without the answer in it: printing the body would print the key itself.
    """
    data = payload.get('data') if isinstance(payload, dict) else None
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict):
        raise StreamError('Deepcoin 没有返回 listenKey（data 缺失）')
    key = data.get('listenkey')
    if key is None:
        key = data.get('listenKey')
    key = str(key).strip() if key is not None else ''
    if not key:
        raise StreamError('Deepcoin 没有返回 listenKey（字段为空）')
    return key


def acquire_headers(credentials: dict, timestamp: str) -> dict:
    """The four signed headers of one acquire request, exactly as the fills endpoint builds them."""
    headers = {
        'DC-ACCESS-KEY': credentials['DEEPCOIN_API_KEY'],
        'DC-ACCESS-SIGN': deepcoin_private.sign(credentials['DEEPCOIN_API_SECRET'], timestamp, 'GET', LISTENKEY_PATH),
        'DC-ACCESS-TIMESTAMP': timestamp,
        'DC-ACCESS-PASSPHRASE': credentials['DEEPCOIN_API_PASSPHRASE'],
        'Content-Type': 'application/json',
        'User-Agent': deepcoin_private.USER_AGENT,
    }
    return headers


def rate_limited(response, payload) -> bool:
    """Whether an answer is the venue's rate limit (`HTTP 401 + code 50000`) rather than a refused key."""
    return response.status_code in (401, 403) and isinstance(payload, dict) \
        and str(payload.get('code') or '').strip() == RATE_LIMIT_CODE


def acquire_listen_key(credentials: dict, get=None, wait=None) -> str:
    """One signed `GET /deepcoin/listenkey/acquire`, as the listenKey string.

    A rate-limited answer is retried after one second (at most twice, re-signed each time, because the timestamp is part
    of the signature). Everything else is a StreamError with a Chinese reason; the venue's own message is scrubbed of
    the credentials, and a transport failure is reported by its type only — the request text never reaches an exception.
    """
    get = requests.get if get is None else get
    wait = time.sleep if wait is None else wait
    payload = None
    response = None
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        timestamp = deepcoin_private.timestamp_text()
        try:
            response = get(f'{BASE}{LISTENKEY_PATH}', headers=acquire_headers(credentials, timestamp),
                           timeout=deepcoin_private.TIMEOUT)
        except requests.RequestException as error:
            raise StreamError(f'Deepcoin listenKey 请求失败（{type(error).__name__}），稍后再试')
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if rate_limited(response, payload) and attempt < RATE_LIMIT_RETRIES:
            wait(RATE_LIMIT_BACKOFF)
            continue
        break
    if rate_limited(response, payload):
        raise StreamError('Deepcoin 限流（code 50000），稍后再试')
    if response.status_code in (401, 403):
        raise StreamError(f'Deepcoin 拒绝了这个 API 密钥（HTTP {response.status_code}），检查 .env.deepcoin 的三个值'
                          '是否属于同一个只读 APIKey')
    if not response.ok:
        raise StreamError(f'Deepcoin listenKey 请求失败（HTTP {response.status_code}），稍后再试')
    if not isinstance(payload, dict):
        raise StreamError('Deepcoin 返回的不是 JSON 对象，稍后再试')
    code = str(payload.get('code', '')).strip()
    if code != '0':
        message = str(payload.get('msg') or '').strip()
        # The venue's message can quote back anything it was sent; the credentials are the only secret in there.
        raise StreamError(deepcoin_private._scrub(f'Deepcoin 返回错误：{code} {message}'.strip(), credentials))
    return listen_key_of(payload)


def private_url(listen_key: str) -> str:
    """The private socket URL of one listenKey. It is a credential-bearing URL, so it is never logged."""
    return f'{WS_URL}?listenKey={urllib.parse.quote(str(listen_key), safe="")}'


def subscribe_frame() -> str:
    """The one subscribe frame: the Trade table, which is every fill of the account."""
    return json.dumps({'action': 'subscribe', 'tables': list(TABLES)})


# --- A pushed Trade frame -----------------------------------------------------------------------------------------
# The venue's documented field names are short (`I`, `D`, `o`, `p`, `P`, `V`, `TT`, `F`, `f`, `m`, `OS`, `TI`) and the
# enums were reverse-engineered on a real account (deepcoin-trade-tui §"真实推送反推出的枚举"): D 0 buy / 1 sell, p 0
# long / 1 short, and `p` of a closing fill is the direction of the position being closed. The resulting row has exactly
# the shape `deepcoin_private.parse_fills` produces, so the page cannot tell a pushed fill from a REST one.

def decode_frame(message):
    """One raw socket message as a JSON object, or None for anything that is not one (text is all the venue sends)."""
    if isinstance(message, bytes):
        message = message.decode('utf-8', 'replace')
    if not isinstance(message, str) or not message.strip():
        return None
    try:
        payload = json.loads(message)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def expired(payload) -> bool:
    """Whether a frame is the venue's `listen key expired, connection closing` error (code 50118)."""
    return isinstance(payload, dict) and str(payload.get('code') or '').strip() == EXPIRED_CODE


def instrument_of(code):
    """`BTCUSDT` -> `BTC-USDT-SWAP`, or None for a name this page cannot draw (the venue sends no other market).

    The mapping is explicit (the venue's instrument id is not a string transformation of its REST id), and an unknown
    instrument is dropped instead of guessed: a fill drawn on the wrong pair is worse than a missing marker.
    """
    match = INSTRUMENT.match(str(code or '').strip().upper())
    return f'{match.group(1)}-USDT-SWAP' if match else None


def _number(value):
    """A finite float, or None for null / '' / text. Booleans are refused: `float(True)` is not a price."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def trade_time(value, now=None) -> int:
    """The fill's second from `TT`. The unit is unproven: > 1e12 is milliseconds, > 1e9 seconds, anything else the
    moment this process received the frame (the venue's `TT` has been seen as both, and a wrong hour is worse than a
    moment of delay)."""
    number = _number(value)
    stamp = int(wall_time() if now is None else now)
    if number is None:
        return stamp
    if number > 1e12:
        return int(number // 1000)
    if number > 1e9:
        return int(number)
    return stamp


def parse_trade(row, now=None):
    """One `data` object of a Trade frame as `(instId, fill)`, or None when it is not a drawable fill.

    A row without a price / size / side cannot become a marker, and an instrument outside the explicit mapping is
    dropped. A missing `p` keeps `posSide` empty, like a spot fill.
    """
    if not isinstance(row, dict):
        return None
    inst_id = instrument_of(row.get('I'))
    price, size = _number(row.get('P')), _number(row.get('V'))
    side = SIDES.get(str(row.get('D') if row.get('D') is not None else '').strip())
    if inst_id is None or price is None or size is None or price <= 0 or size <= 0 or side is None:
        return None
    fee = _number(row.get('F'))
    fill = {'time': trade_time(row.get('TT'), now), 'price': price, 'size': size, 'side': side,
            'posSide': POS_SIDES.get(str(row.get('p') if row.get('p') is not None else '').strip(), ''),
            'execType': str(row.get('m') or '').strip(),
            'fee': fee if fee is not None else 0.0,
            'feeCcy': str(row.get('f') or '').strip().upper(),
            'ordId': str(row.get('OS') or '').strip(),
            'tradeId': str(row.get('TI') or '').strip()}
    return inst_id, fill


def trade_fills(payload, now=None) -> list:
    """Every drawable fill of one frame as `[(instId, fill)]`: `result` entries of `table == "Trade"`, `data` an object
    or an array. Other tables (the venue may push more than was subscribed) and junk are skipped."""
    now = int(wall_time() if now is None else now)
    result = payload.get('result') if isinstance(payload, dict) else None
    fills = []
    for entry in result if isinstance(result, list) else []:
        if not isinstance(entry, dict):
            continue
        if str(entry.get('table') or '').strip().lower() != 'trade':
            continue
        data = entry.get('data')
        for row in (data if isinstance(data, list) else [data]):
            parsed = parse_trade(row, now)
            if parsed is not None:
                fills.append(parsed)
    return fills


# --- When to rotate / reconnect / stop ----------------------------------------------------------------------------

def rotation_due(opened_at: float, now: float, rotate_every: float = ROTATE_SECONDS) -> bool:
    """Whether a socket has been open long enough to rotate its key (a listenKey dies hard at 60 minutes)."""
    return now - opened_at >= float(rotate_every)


def backoff_delay(failures: int) -> float:
    """The reconnect delay after `failures` consecutive failed / dropped connections: 1 / 2 / 5 / 10 / 30 / 60 seconds."""
    index = max(0, int(failures))
    return BACKOFF[min(index, len(BACKOFF) - 1)]


def idle_due(deadline: float, now: float) -> bool:
    """Whether the worker may stop: no page has asked for fills since `deadline` (a monotonic stamp, 0 = never stop)."""
    return bool(deadline) and now >= deadline


# --- The realtime layer -------------------------------------------------------------------------------------------
# One process-wide layer: the worker thread writes it, the long-poll route reads it. It is a plain list per instrument
# plus one increasing counter, because a fill is only ever appended and asked for by "newer than seq".

_LOCK = threading.RLock()
_STATE = {
    'seq': 0,
    # instId -> [{'seq': n, 'at': local receive second, 'fill': {...}}], oldest first.
    'fills': {},
    # instIds a page is waiting for (and therefore the ones a reconnect syncs).
    'wanted': set(),
    'state': 'off',
    'since': 0,
    'last_frame_at': None,
    'reconnects': 0,
    # Monotonic instant after which no page is waiting; 0 means the worker was never asked for anything.
    'idle_until': 0.0,
    'thread': None,
    'stop': None,
    'socket': None,
}


def seq() -> int:
    """The global fill counter: every pushed fill of every instrument takes the next number."""
    with _LOCK:
        return _STATE['seq']


def status() -> dict:
    """`{state, since, last_frame_at, reconnects}` — the state of the push, and never a credential or the socket URL."""
    with _LOCK:
        return {'state': _STATE['state'], 'since': _STATE['since'],
                'last_frame_at': _STATE['last_frame_at'], 'reconnects': _STATE['reconnects']}


def _set_state(state: str) -> None:
    with _LOCK:
        if _STATE['state'] != state:
            _STATE['state'] = state
            _STATE['since'] = int(wall_time())


def _mark_frame() -> None:
    with _LOCK:
        _STATE['last_frame_at'] = int(wall_time())


def _count_reconnect() -> None:
    with _LOCK:
        _STATE['reconnects'] += 1


def trim_rows(rows, now: float, limit: int = MAX_FILLS, retention: float = RETENTION_SECONDS) -> list:
    """The newest `limit` rows of one instrument that arrived within `retention` seconds of `now`.

    The age is the local receive time, not the venue's `TT`: a row is kept for as long as it can still be newer than
    what the REST store has, whatever the venue's clock says.
    """
    kept = [row for row in rows if now - row['at'] <= retention]
    return kept[-max(1, int(limit)):]


def push(inst_id: str, fill: dict) -> int:
    """Append one pushed fill and return its `seq`. The layer keeps two hours / 2000 fills per instrument."""
    if not inst_id or not isinstance(fill, dict):
        return seq()
    now = int(wall_time())
    with _LOCK:
        _STATE['seq'] += 1
        number = _STATE['seq']
        rows = _STATE['fills'].setdefault(inst_id, [])
        rows.append({'seq': number, 'at': now, 'fill': fill})
        if len(rows) > 1:
            _STATE['fills'][inst_id] = trim_rows(rows, now)
        return number


def register(inst_id: str) -> None:
    """Remember that a page is waiting for this instrument and push the idle deadline out by IDLE_SECONDS."""
    with _LOCK:
        if inst_id:
            _STATE['wanted'].add(inst_id)
        _STATE['idle_until'] = monotonic() + IDLE_SECONDS


def idle_deadline() -> float:
    with _LOCK:
        return _STATE['idle_until']


def wanted_instruments() -> list:
    """The instruments a reconnect has to bring up to date: everything a page asked for, and everything already pushed."""
    with _LOCK:
        return sorted(set(_STATE['wanted']) | set(_STATE['fills']))


def realtime_fills(inst_id: str, after_seq: int = 0) -> list:
    """The pushed fills of one instrument newer than `after_seq`, oldest first, without the layer's own bookkeeping."""
    with _LOCK:
        rows = list(_STATE['fills'].get(inst_id, []))
    return [dict(row['fill']) for row in rows if row['seq'] > int(after_seq or 0)]


def covered_by_store(fills, store: dict) -> list:
    """The pushed fills the REST store does not have yet.

    The push and the REST endpoint are two views of the same fills, and their ids are not interchangeable: a pushed
    `TI` is not necessarily the REST `tradeId` (the beacon is a per-trade number on one side and the fill's bill id on
    the other, and nothing guarantees they match). So a pushed fill is dropped when its second is at or before the
    newest stored fill (the store's sync has already covered it), and — in case the venue reuses the number — when its
    id equals a stored fill's `tradeId`. Both checks err on the side of dropping: a dropped push costs nothing because
    the fill is on its way to the store anyway, while a duplicated marker is visibly wrong.
    """
    stored = store.get('fills') if isinstance(store, dict) else None
    stored = stored if isinstance(stored, list) else []
    newest = stored[-1]['time'] if stored else 0
    trade_ids = {str(fill.get('tradeId')) for fill in stored if fill.get('tradeId')}
    kept = []
    for fill in fills if isinstance(fills, list) else []:
        if not isinstance(fill, dict):
            continue
        if _number(fill.get('time')) is None or fill['time'] <= newest:
            continue
        trade_id = str(fill.get('tradeId') or '')
        if trade_id and trade_id in trade_ids:
            continue
        kept.append(fill)
    return kept


async def _pause(seconds: float) -> None:
    """The long poll's look-again sleep (async, so a waiting request holds no thread-pool thread)."""
    await asyncio.sleep(seconds)


async def wait_fills(inst_id: str, after_seq: int = 0, timeout=None) -> tuple:
    """Wait up to `timeout` (WAIT_LIMIT) seconds for a pushed fill of `inst_id` newer than `after_seq`.

    Returns `(fills, seq)`: the fills the page may draw now (deduplicated against the REST store) and the global counter
    at that moment. An empty list means the limit ran out with nothing newer — the page simply asks again, which is why
    a waiting request is one long poll instead of a request every second. The deadline is a monotonic clock, so a clock
    that jumps cannot extend a wait forever.
    """
    limit = WAIT_LIMIT if timeout is None else float(timeout)
    deadline = monotonic() + limit
    while True:
        register(inst_id)
        candidates = realtime_fills(inst_id, after_seq)
        if candidates:
            fills = covered_by_store(candidates, deepcoin_private.read_store(inst_id))
            if fills:
                return fills, seq()
        if monotonic() >= deadline:
            return [], seq()
        await _pause(WAIT_POLL)


# --- The REST increment the push leans on -------------------------------------------------------------------------
# The push is the fast view; the store is the authoritative one. Every successful connect and every burst of pushes runs
# the same increment the page's 60-second poll runs, so the store catches up and the two views converge.

def rest_instrument(inst_id: str) -> tuple:
    """`(market, symbol)` of a pushed instrument (`BTC-USDT-SWAP` -> `('swap', 'BTC-USDT')`), or `(None, None)`."""
    code = str(inst_id or '').strip().upper()
    if not code.endswith('-USDT-SWAP'):
        return None, None
    return 'swap', code[: -len('-SWAP')]


def instrument_id(market, symbol) -> str:
    """The venue's instrument id of the page's `{market, symbol}`, through the same whitelist as the REST fills."""
    return deepcoin_private.resolve_request(market, symbol, 1)['instId']


def sync_instrument(inst_id: str) -> None:
    """One REST increment of one instrument's store (the same walk `POST /review/market/fills` does), or nothing.

    It deliberately does not use `deepcoin_private.read_fills`: that one answers from a 5-second cache, and the point of
    this call is to bring the store up to date right after a fill was pushed. The store lock keeps it from interleaving
    with the page's own poll, and a refused venue raises the usual DeepcoinError (the caller swallows it: the socket is
    more valuable than one failed increment).
    """
    credentials = deepcoin_private.read_credentials()
    if credentials is None:
        return
    market, symbol = rest_instrument(inst_id)
    if market is None:
        return
    with deepcoin_private.store_lock(inst_id):
        store = deepcoin_private.read_store(inst_id)
        # `begin` at the oldest stored fill: the increment must not turn into a backfill walk (the page's poll owns the
        # history); with an empty store, an hour of fills is the window the increment is worth.
        oldest = store['fills'][0]['time'] if store['fills'] else None
        begin = oldest if oldest is not None else int(wall_time()) - 3600
        request = deepcoin_private.resolve_request(market, symbol, begin)
        before = deepcoin_private.store_signature(store)
        store = deepcoin_private.sync_store(store, request, credentials)
        if deepcoin_private.store_signature(store) == before:
            return
        try:
            deepcoin_private.write_store(inst_id, store)
        except OSError:
            # A project folder this process cannot write still gets the push; the store keeps what it had.
            pass


def sync_instruments(inst_ids) -> None:
    """The REST increment of every instrument in `inst_ids`; one refused instrument never stops the others."""
    for inst_id in list(inst_ids or []):
        try:
            sync_instrument(inst_id)
        except Exception:
            # A rate limit or a timeout is not a reason to drop the socket: the push keeps flowing, and the page's own
            # poll retries the store. The exception's text is deliberately not kept (it could quote the key).
            continue


# --- The worker ---------------------------------------------------------------------------------------------------

def open_socket(url: str):
    """The private socket, with the library's own protocol-level keepalive shape.

    websocket-client has no `ping_interval` option (that is the asyncio `websockets` library): the worker sends one
    `ping()` every 20 seconds itself and the library answers the venue's pings while it reads. A failure is reported by
    its type, because the exception text of a bad handshake quotes the URL and the URL carries the listenKey.
    """
    try:
        return websocket.create_connection(url, timeout=CONNECT_TIMEOUT, enable_multithread=False)
    except Exception as error:
        raise StreamError(f'Deepcoin 推送连接失败（{type(error).__name__}）')


class Worker:
    """One listening thread: acquire / connect / subscribe / read, and rotate, reconnect or stop when it should.

    `run()` returns when the worker is told to stop (Jesse shutting down) or when the idle deadline has passed; every
    other ending is a reconnect. The `stop` object is a `threading.Event` in production (a daemon thread whose socket
    the shutdown hook closes) and a recording fake in the tests.
    """

    def __init__(self, stop, rotate_every=ROTATE_SECONDS, ping_every=PING_SECONDS, sync=None):
        self._stop = stop
        self._rotate_every = float(rotate_every)
        self._ping_every = float(ping_every)
        self._sync = sync or sync_instruments
        self._socket = None
        self._opened_at = 0.0
        self._connected = False
        # instId -> monotonic instant of the REST increment that its last push asked for.
        self._pending = {}
        self.reason = 'stop'

    def _stopped(self) -> bool:
        return bool(self._stop.is_set())

    def run(self) -> str:
        failures = 0
        while not self._stopped():
            _set_state('connecting')
            try:
                credentials = deepcoin_private.read_credentials()
                if credentials is None:
                    self.reason = 'off'
                    return self.reason
                socket = open_socket(private_url(acquire_listen_key(credentials)))
                self._open(socket)
                reason = self._read()
            except StreamError:
                reason = 'failed'
            except Exception:
                # Whatever the socket library raised: the text may carry the listenKey URL, so only the decision matters.
                reason = 'failed'
            finally:
                self._close()
            if self._stopped() or reason == 'stop':
                self.reason = 'stop'
                return self.reason
            if reason == 'idle':
                self.reason = 'idle'
                return self.reason
            if reason in ('rotate', 'expired'):
                # The key is gone (expired by the venue) or about to be: a new one is acquired at once, no backoff.
                failures = 0
                continue
            delay = backoff_delay(failures)
            failures += 1
            _set_state('reconnecting')
            self._stop.wait(delay)
        self.reason = 'stop'
        return self.reason

    def _open(self, socket) -> None:
        self._socket = socket
        with _LOCK:
            _STATE['socket'] = socket
        socket.send(subscribe_frame())
        self._opened_at = monotonic()
        if self._connected:
            _count_reconnect()
        self._connected = True
        _set_state('live')
        # A subscription sends no snapshot and a reconnect does not replay: the gap is filled from the REST endpoint.
        self._sync_now(wanted_instruments())

    def _sync_now(self, inst_ids) -> None:
        """One REST increment, in this thread.

        It blocks the read for at most one venue timeout (10 seconds, deepcoin_private.TIMEOUT). That is the deliberate
        trade-off of one thread and one connection: a separate sync thread would need its own copy of the store lock and
        would let a slow endpoint race the socket. Frames that arrive meanwhile wait in the socket's buffer and are
        handled on the next read.
        """
        try:
            self._sync(inst_ids)
        except Exception:
            pass
        self._pending.clear()

    def _read(self) -> str:
        socket = self._socket
        socket.settimeout(READ_TIMEOUT)
        next_ping = monotonic() + self._ping_every
        while not self._stopped():
            now = monotonic()
            if rotation_due(self._opened_at, now, self._rotate_every):
                return 'rotate'
            if idle_due(idle_deadline(), now):
                return 'idle'
            if now >= next_ping:
                try:
                    socket.ping()
                except Exception:
                    return 'disconnect'
                next_ping = now + self._ping_every
            self._flush_pending(now)
            try:
                message = socket.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                return 'disconnect'
            if not message:
                # An empty read is the library's "the peer closed the connection".
                return 'disconnect'
            reason = self._handle(message)
            if reason:
                return reason
        return 'stop'

    def _handle(self, message) -> str:
        payload = decode_frame(message)
        if payload is None:
            return ''
        _mark_frame()
        if expired(payload):
            return 'expired'
        for inst_id, fill in trade_fills(payload):
            push(inst_id, fill)
            # One incremental REST sync per instrument per burst: `_flush_pending` runs it when the debounce is over.
            self._pending[inst_id] = monotonic() + SYNC_DEBOUNCE
        return ''

    def _flush_pending(self, now: float) -> None:
        due = [inst_id for inst_id, deadline in self._pending.items() if now >= deadline]
        if not due:
            return
        for inst_id in due:
            self._pending.pop(inst_id, None)
        self._sync_now(due)

    def _close(self) -> None:
        socket, self._socket = self._socket, None
        with _LOCK:
            if _STATE['socket'] is socket:
                _STATE['socket'] = None
        if socket is not None:
            try:
                socket.close()
            except Exception:
                pass


# --- The singleton ------------------------------------------------------------------------------------------------

def _run_worker(stop) -> None:
    worker = Worker(stop)
    try:
        worker.run()
    finally:
        with _LOCK:
            if _STATE['stop'] is stop:
                _STATE['thread'] = None
                _STATE['stop'] = None
        _set_state('off')


def touch(inst_id: str) -> bool:
    """Start the worker on demand for one waiting page; False when the project has no Deepcoin credentials.

    The idle deadline is pushed out on every call, so the worker lives exactly as long as pages keep waiting. Only one
    worker ever runs (an old one that exited has cleared itself), which is also what keeps a listenKey from being
    opened twice.
    """
    register(inst_id)
    if deepcoin_private.read_credentials() is None:
        return False
    with _LOCK:
        thread = _STATE['thread']
        if thread is not None and thread.is_alive():
            return True
        stop = threading.Event()
        _STATE['stop'] = stop
        _STATE['thread'] = threading.Thread(target=_run_worker, args=(stop,),
                                            name='deepcoin-fills-stream', daemon=True)
        _set_state('connecting')
        _STATE['thread'].start()
    return True


def shutdown() -> None:
    """Stop the worker at process exit: set the stop flag and close the socket so a blocked read returns.

    The thread is a daemon, so this is a courtesy (an orderly close) rather than a requirement: Ctrl+C never waits for
    it, and a listenKey is simply left to expire.
    """
    with _LOCK:
        stop = _STATE['stop']
        socket = _STATE['socket']
        _STATE['stop'] = None
        _STATE['thread'] = None
        _STATE['socket'] = None
    if stop is not None:
        stop.set()
    if socket is not None:
        try:
            socket.close()
        except Exception:
            pass
    _set_state('off')


def reset_for_tests() -> None:
    """Forget everything the worker and the layer hold (tests only: the process-wide singleton outlives a test)."""
    shutdown()
    with _LOCK:
        _STATE['seq'] = 0
        _STATE['fills'] = {}
        _STATE['wanted'] = set()
        _STATE['state'] = 'off'
        _STATE['since'] = 0
        _STATE['last_frame_at'] = None
        _STATE['reconnects'] = 0
        _STATE['idle_until'] = 0.0


# --- What the fills route adds -------------------------------------------------------------------------------------

def augment(answer: dict, market, symbol, end=None) -> dict:
    """A `POST /review/market/fills` answer with the pushed fills merged in, plus `stream` and `seq`.

    The pushed fills are deduplicated against the store (see `covered_by_store`) and cut to the window the answer was
    asked for, so a page that asked for an old window never gets a fill outside it. An answer that is not configured
    (no store, no key) is returned untouched by the route.
    """
    state, current = status(), seq()
    try:
        inst_id = instrument_id(market, symbol)
    except deepcoin_private.DeepcoinError:
        return {**answer, 'seq': current, 'stream': state}
    if str(market or '').strip().lower() != 'swap':
        return {**answer, 'seq': current, 'stream': state}
    pushes = covered_by_store(realtime_fills(inst_id), deepcoin_private.read_store(inst_id))
    begin = answer.get('begin')
    # The window's right edge is the caller's (the fills answer only carries its `begin`): a pushed fill after it is not
    # part of what the page asked for.
    finish = _number(end)
    pushes = [fill for fill in pushes if begin is None or fill['time'] >= begin]
    if finish is not None:
        pushes = [fill for fill in pushes if fill['time'] <= finish]
    if not pushes:
        return {**answer, 'seq': current, 'stream': state}
    return {**answer, 'fills': deepcoin_private.merge_fills(answer.get('fills') or [], pushes),
            'seq': current, 'stream': state}
