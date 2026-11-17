"""
The owner's own Deepcoin trades, for the 看行情 page's 「我的成交」 markers (T-59).

Deepcoin's trade endpoints are private (signed with an API key) and send no CORS headers, so the browser can never call
them itself: the page asks Jesse (`POST /review/market/fills`) and this module does the signing, the request and the
paging. Only read endpoints are ever called — `GET /deepcoin/trade/fills` and nothing else: no order, no cancel, no
amend.

The three credentials live in `.env.deepcoin` in the project folder (`jesse run`'s cwd) and are read on every request,
so the owner can paste them in without restarting Jesse. The file is parsed here instead of by dotenv, and nothing is
written into `os.environ` or into a module-level variable: the values exist only while one request is being built, and
they never reach the browser, a log line or an exception message (`_scrub` is the last line of defence).

Everything that decides what a request means and what comes back is a pure function (`parse_env`, `sign`,
`resolve_request`, `fills_query`, `parse_fills`, `page_oldest_bill`), so `tests/test_deepcoin_private.py` runs without a
network and without any real key. `fetch_page` / `read_fills` are the only ones that go out; one answer is cached for
15 seconds, because the page polls every 30 seconds and two tabs must not double the venue's load.
"""
import base64
import hmac
import math
import os
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Optional

import requests

from jesse.services import market_sources

BASE = 'https://api.deepcoin.com'
FILLS_PATH = '/deepcoin/trade/fills'
# The file the owner fills in, in the project folder. Relative to the cwd of `jesse run`, like storage/ and factors/.
ENV_FILE = '.env.deepcoin'
ENV_KEYS = ('DEEPCOIN_API_KEY', 'DEEPCOIN_API_SECRET', 'DEEPCOIN_API_PASSPHRASE')
# `instType` of the venue, per market of the page.
MARKET_TYPES = {'swap': 'SWAP', 'spot': 'SPOT'}
# The venue's own page size (its maximum) and how far back one answer may page. 20 pages of 100 fills is more than a
# day of active trading on one instrument, and it bounds the work a single request can cause.
PAGE_LIMIT = 100
MAX_PAGES = 20
TIMEOUT = 10
CACHE_TTL = 15.0
CACHE_MAX = 64
# Deepcoin's edge refuses requests' own User-Agent the way its public endpoints do (see market_sources), so the private
# calls go out with the bare browser token. It says nothing about the owner; the key is in the headers.
USER_AGENT = market_sources.DEEPCOIN_FALLBACK_USER_AGENT


class DeepcoinError(Exception):
    """A readable reason for a bad request (400) or an unusable upstream / missing key (502)."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# --- Credentials --------------------------------------------------------------------------------------------------

def parse_env(text) -> dict:
    """`KEY=VALUE` lines of `.env.deepcoin` as a dict: comments and blank lines skipped, spaces and quotes trimmed.

    A value is kept verbatim (an inline `#` is part of a secret, not a comment); a line without `=` or with an empty
    key is not a setting and is dropped. The reader is deliberately as forgiving as a person pasting into a text
    editor expects, and nothing is ever logged.
    """
    values = {}
    for line in str(text or '').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        key = key.strip()
        if not separator or not key:
            continue
        value = value.strip()
        # A quoted value is the same value: people quote keys that contain '#' or spaces.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key] = value
    return values


def read_credentials(folder: Optional[str] = None) -> Optional[dict]:
    """The three credentials of `<cwd>/.env.deepcoin`, or None when the file or one of the three is missing.

    Read on every call (not cached, not loaded into `os.environ`) so filling the file in takes effect on the page's
    next 30-second poll, without restarting Jesse. A missing / unreadable file is not an error: it means 「未配置」.
    """
    path = os.path.join(folder or os.getcwd(), ENV_FILE)
    try:
        with open(path, encoding='utf-8') as file:
            values = parse_env(file.read())
    except OSError:
        return None
    credentials = {name: str(values.get(name) or '').strip() for name in ENV_KEYS}
    return credentials if all(credentials.values()) else None


def is_configured(folder: Optional[str] = None) -> bool:
    """Whether `.env.deepcoin` holds all three values (the page only needs to know yes / no)."""
    return read_credentials(folder) is not None


def _scrub(text, credentials: Optional[dict]) -> str:
    """`text` with every credential value replaced by `***`: the upstream's own message can quote anything."""
    result = str(text)
    for name in ENV_KEYS:
        value = (credentials or {}).get(name)
        if value:
            result = result.replace(str(value), '***')
    return result


# --- Signing ------------------------------------------------------------------------------------------------------
# Deepcoin signs like OKX: base64(HMAC_SHA256(secret, timestamp + METHOD + requestPath + body)). For a GET the query
# string is part of requestPath and the body is empty, so the cheapest request is still unambiguous.

def timestamp_text(now_ms: Optional[float] = None) -> str:
    """UTC ISO with milliseconds, the shape the venue wants: `2020-12-08T09:08:57.715Z`."""
    millis = int(time.time() * 1000) if now_ms is None else int(now_ms)
    stamp = datetime.fromtimestamp(millis / 1000, tz=timezone.utc)
    return stamp.strftime('%Y-%m-%dT%H:%M:%S.') + f'{millis % 1000:03d}Z'


def sign(secret: str, timestamp: str, method: str, request_path: str, body: str = '') -> str:
    """The `DC-ACCESS-SIGN` of one request: base64 of the HMAC-SHA256 over `timestamp + METHOD + path + body`."""
    message = f'{timestamp}{str(method).upper()}{request_path}{body}'.encode('utf-8')
    digest = hmac.new(str(secret).encode('utf-8'), message, sha256).digest()
    return base64.b64encode(digest).decode('ascii')


# --- One fills request --------------------------------------------------------------------------------------------

def resolve_request(market, symbol, begin, end=None) -> dict:
    """The `instType` / `instId` / range of one fills request, or DeepcoinError(400) for anything else.

    The page names the instrument the way the market list does (`BTC-USDT`) and the market separately; `swap` maps to
    the perpetual (`BTC-USDT-SWAP`). The result has to pass the same whitelist as the public Deepcoin proxy, so nothing
    but a USDT pair of that market can reach the signed endpoint.
    """
    market = str(market or '').strip().lower()
    if market not in MARKET_TYPES:
        raise DeepcoinError(f'market 只能是 {" / ".join(MARKET_TYPES)}')
    code = str(symbol or '').strip().upper()
    base = code[: -len('-SWAP')] if code.endswith('-SWAP') else code
    instrument = base if market == 'spot' else f'{base}-SWAP'
    if not market_sources.DEEPCOIN_SYMBOL.match(instrument) or \
            instrument.endswith('-SWAP') != (market == 'swap'):
        raise DeepcoinError(f'不支持的 Deepcoin 品种：{symbol or "空"}（形如 BTC-USDT）')
    start = _seconds(begin, 'begin')
    finish = None if end is None else _seconds(end, 'end')
    if finish is not None and finish < start:
        raise DeepcoinError('end 不能早于 begin')
    return {'market': market, 'instType': MARKET_TYPES[market], 'symbol': base, 'instId': instrument,
            'begin': start, 'end': finish}


def _seconds(value, name: str) -> int:
    """A positive whole second from an int / float / numeric string."""
    if isinstance(value, bool) or value is None:
        raise DeepcoinError(f'{name} 必须是秒数（正整数）')
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        raise DeepcoinError(f'{name} 必须是秒数（正整数）')
    if number <= 0:
        raise DeepcoinError(f'{name} 必须是正数（秒）')
    return number


def fills_query(inst_type: str, inst_id: str, begin: Optional[int] = None, end: Optional[int] = None,
                older_than: Optional[str] = None, limit: int = PAGE_LIMIT) -> str:
    """The query string of one page (without `?`). The venue counts milliseconds, the page seconds.

    The first page carries the whole window; an older page is asked for by `after` (the oldest billId already loaded)
    alone, so the venue never has to combine the two filters.
    """
    params = [('instType', inst_type), ('instId', inst_id)]
    if older_than:
        # Deepcoin's docs say `before` pages to older fills, but the venue behaves like OKX (probed 2026-11-17 with a
        # real read-only key): `before=<billId>` returns the newest page again, `after=<billId>` returns the fills
        # older than that bill. So the older-page cursor goes out as `after`.
        params.append(('after', str(older_than)))
    else:
        params.append(('begin', str(int(begin) * 1000)))
        if end:
            params.append(('end', str(int(end) * 1000)))
    params.append(('limit', str(int(limit))))
    return '&'.join(f'{key}={value}' for key, value in params)


def parse_fills(rows, inst_id: Optional[str] = None, begin: Optional[int] = None,
                end: Optional[int] = None) -> list:
    """The venue's `data` rows as fills, oldest first, one row per trade.

    A row that is not a sane fill (no price / size / time, a side that is neither buy nor sell) is dropped instead of
    drawn, and the window is enforced here: paging can only ever add rows, and the page draws what it asked for.
    `instId` rows of another instrument are dropped too, so a venue that ignores the filter cannot put another pair's
    trades on this chart.
    """
    fills = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        code = str(row.get('instId') or '').strip().upper()
        if inst_id and code and code != inst_id:
            continue
        price = _number(row.get('fillPx'))
        size = _number(row.get('fillSz'))
        time_ms = _number(row.get('ts'))
        side = str(row.get('side') or '').strip().lower()
        if price is None or size is None or time_ms is None:
            continue
        if price <= 0 or size <= 0 or time_ms <= 0 or side not in ('buy', 'sell'):
            continue
        time_ = int(time_ms // 1000)
        if begin is not None and time_ < begin:
            continue
        if end is not None and time_ > end:
            continue
        pos_side = str(row.get('posSide') or '').strip().lower()
        fee = _number(row.get('fee'))
        trade_id = str(row.get('tradeId') or '').strip()
        ord_id = str(row.get('ordId') or '').strip()
        fill = {'time': time_, 'price': price, 'size': size, 'side': side,
                'posSide': pos_side if pos_side in ('long', 'short') else '',
                'execType': str(row.get('execType') or '').strip().upper(),
                'fee': fee if fee is not None else 0.0,
                'feeCcy': str(row.get('feeCcy') or '').strip().upper(),
                'ordId': ord_id, 'tradeId': trade_id}
        # The trade id is the identity of one fill; a venue without one still gets a key from what it sent.
        key = trade_id or '|'.join([ord_id, str(row.get('billId') or ''), str(time_ms), str(price), str(size)])
        fills[key] = fill
    return sorted(fills.values(), key=lambda fill: (fill['time'], fill['tradeId'], fill['price']))


def _number(value) -> Optional[float]:
    """A finite float, or None for null / '' / text / NaN. Booleans are refused: `float(True)` is not a price."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def page_oldest_bill(rows) -> Optional[str]:
    """The smallest `billId` of one page: the cursor of the page before it (sent as `after`), or None when there is none.

    The venue lists the newest fill first, so this is the last row's id; taking the smallest of the page is the same
    answer without trusting that order, and billIds that are not numbers fall back to the last row that has one.
    """
    bills = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        bill = str(row.get('billId') or '').strip()
        if bill:
            bills.append(bill)
    if not bills:
        return None
    try:
        return str(min(int(bill) for bill in bills))
    except ValueError:
        return bills[-1]


def page_oldest_time(rows) -> Optional[int]:
    """The oldest `ts` (milliseconds) of one page, or None when no row says one."""
    times = [_number(row.get('ts')) for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    known = [time_ for time_ in times if time_ is not None and time_ > 0]
    return int(min(known)) if known else None


# --- The requests -------------------------------------------------------------------------------------------------

def fetch_page(credentials: dict, query: str) -> list:
    """One signed `GET /deepcoin/trade/fills` page (`query` without the `?`), as the venue's raw `data` rows.

    The credentials go into headers only; a failure never carries them (the venue's own message is scrubbed, and a
    transport error is reported by its type, not by its text). Raises DeepcoinError(502) with a Chinese reason.
    """
    request_path = f'{FILLS_PATH}?{query}'
    timestamp = timestamp_text()
    headers = {
        'DC-ACCESS-KEY': credentials['DEEPCOIN_API_KEY'],
        'DC-ACCESS-SIGN': sign(credentials['DEEPCOIN_API_SECRET'], timestamp, 'GET', request_path),
        'DC-ACCESS-TIMESTAMP': timestamp,
        'DC-ACCESS-PASSPHRASE': credentials['DEEPCOIN_API_PASSPHRASE'],
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
    }
    try:
        response = requests.get(f'{BASE}{request_path}', headers=headers, timeout=TIMEOUT)
    except requests.RequestException as error:
        raise DeepcoinError(f'Deepcoin 请求失败（{type(error).__name__}），稍后再试', status_code=502)
    if response.status_code in (401, 403):
        raise DeepcoinError('Deepcoin 拒绝了这个 API 密钥（HTTP '
                            f'{response.status_code}），检查 .env.deepcoin 的三个值是否属于同一个只读 APIKey',
                            status_code=502)
    if not response.ok:
        raise DeepcoinError(f'Deepcoin 请求失败（HTTP {response.status_code}），稍后再试', status_code=502)
    try:
        payload = response.json()
    except ValueError:
        raise DeepcoinError('Deepcoin 返回的不是 JSON，稍后再试', status_code=502)
    if not isinstance(payload, dict):
        raise DeepcoinError('Deepcoin 返回的不是 JSON 对象，稍后再试', status_code=502)
    code = str(payload.get('code', '')).strip()
    if code != '0':
        message = str(payload.get('msg') or '').strip()
        raise DeepcoinError(_scrub(f'Deepcoin 返回错误：{code} {message}'.strip(), credentials), status_code=502)
    data = payload.get('data')
    return data if isinstance(data, list) else []


def fetch_fills(request: dict, credentials: dict) -> list:
    """Every fill of one resolved request: the first page carries the window, older pages page by `after` (see fills_query).

    Paging stops on the venue's own end (a page shorter than the page size), on a page whose oldest fill is already
    before `begin`, on a page that does not move the cursor, and after MAX_PAGES — whichever comes first, so one old
    chart can never walk the whole account history.
    """
    rows = []
    older_than = None
    for _ in range(MAX_PAGES):
        page = fetch_page(credentials, fills_query(request['instType'], request['instId'], request['begin'],
                                                   request['end'], older_than=older_than))
        rows.extend(page)
        if len(page) < PAGE_LIMIT:
            break
        oldest_time = page_oldest_time(page)
        if oldest_time is not None and oldest_time < request['begin'] * 1000:
            break
        oldest = page_oldest_bill(page)
        if not oldest or oldest == older_than:
            break
        older_than = oldest
    return parse_fills(rows, request['instId'], request['begin'], request['end'])


# (market, instId, begin // 60, end // 60) -> (monotonic stamp, answer). The page polls every 30 seconds and rounds its
# range to the minute, so a second tab within 15 seconds costs no request.
_CACHE = {}


def clear_cache() -> None:
    """Drop the cached answers (tests, and a manual retry that must not replay an old failure)."""
    _CACHE.clear()


def read_fills(market, symbol, begin, end=None) -> dict:
    """The answer of `POST /review/market/fills`: `{configured, fills}` (plus a little of what was asked).

    An unconfigured project answers `{configured: False, fills: []}` — nothing to explain to a reader, and nothing to
    request. The credentials are read here (every call), so a filled-in file works on the next poll.
    """
    request = resolve_request(market, symbol, begin, end)
    credentials = read_credentials()
    if credentials is None:
        return {'configured': False, 'fills': []}
    last_minute = None if request['end'] is None else request['end'] // 60
    key = (request['market'], request['instId'], request['begin'] // 60, last_minute)
    cached = _CACHE.get(key)
    if cached is not None and time.monotonic() - cached[0] < CACHE_TTL:
        return {**cached[1], 'cached': True}
    fills = fetch_fills(request, credentials)
    answer = {'configured': True, 'fills': fills, 'market': request['market'], 'symbol': request['symbol'],
              'begin': request['begin'], 'fetched_at': int(time.time())}
    if len(_CACHE) >= CACHE_MAX:
        for stale in sorted(_CACHE, key=lambda item: _CACHE[item][0])[: len(_CACHE) - CACHE_MAX + 1]:
            _CACHE.pop(stale, None)
    _CACHE[key] = (time.monotonic(), answer)
    return {**answer, 'cached': False}
