"""
Market sources of the 看行情 page that the browser cannot read by itself.

Two of them: the US treasury yields (Yahoo's chart endpoint and FRED's CSV export answer without CORS headers) and
Deepcoin (the owner's own venue, which sends no CORS headers at all). So the page asks Jesse
(`POST /review/market/candles`, `POST /review/market/tickers`) and this module does the whitelist, the request and
the parsing. Binance (perpetual and spot) and OKX are not here on purpose: both are CORS-open and the browser talks
to the exchanges directly.

Everything that decides what a request means and what the answer contains is a pure function
(`resolve_request`, `parse_yahoo_chart`, `parse_fred_csv`, `resolve_deepcoin_request`, `parse_deepcoin_candles`,
`parse_deepcoin_tickers`), so `tests/test_market_sources.py` runs without a network. The `read_*` functions are the
only ones that go out; each caches, because several timeframe panels and the page's polls ask for the same series
within seconds of each other (30 seconds for a yield, 2 seconds for Deepcoin candles, 10 for its tickers).
"""
import csv
import io
import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

import requests

SOURCE = 'us-yields'
DEEPCOIN = 'deepcoin'

# TradingView-style codes, because that is how the owner named them. The value of every series IS the yield in
# percent (4.95 means 4.95%), which is why the page shows a change as +0.03 and never as a percentage of a
# percentage. 'yahoo' is the Cboe index Yahoo publishes (^TNX 10y, ^TYX 30y, ^FVX 5y, ^IRX 13w); there is no Cboe
# index for the 2 and the 20 year, so those two are FRED-only and therefore daily-only.
YIELD_INSTRUMENTS = {
    'US03M': {'yahoo': '^IRX', 'fred': 'DGS3MO'},
    'US02Y': {'yahoo': None, 'fred': 'DGS2'},
    'US05Y': {'yahoo': '^FVX', 'fred': 'DGS5'},
    'US10Y': {'yahoo': '^TNX', 'fred': 'DGS10'},
    'US20Y': {'yahoo': None, 'fred': 'DGS20'},
    'US30Y': {'yahoo': '^TYX', 'fred': 'DGS30'},
}

# The timeframes the page draws. 3m and 4h are aggregated by the page (three 1m bars, four 1h bars), so a request
# never asks for an interval the upstream has no data for. The ranges are the ones Yahoo serves for that interval
# (1m: 7 days at most, 5m/15m/30m: 60 days, 60m: 730 days) and the default is what the page opens with.
INTERVALS = {
    '1m': {'yahoo': '1m', 'ranges': ('1d', '5d', '7d'), 'default': '5d'},
    '5m': {'yahoo': '5m', 'ranges': ('5d', '1mo'), 'default': '1mo'},
    '15m': {'yahoo': '15m', 'ranges': ('5d', '1mo'), 'default': '1mo'},
    '30m': {'yahoo': '30m', 'ranges': ('5d', '1mo'), 'default': '1mo'},
    '1h': {'yahoo': '60m', 'ranges': ('1mo', '3mo', '1y', '2y'), 'default': '1y'},
    '1D': {'yahoo': '1d', 'ranges': ('1mo', '1y', '5y', '10y', 'max'), 'default': '10y'},
}
# FRED only publishes daily series, so its range is a start date (`cosd`) instead of a Yahoo range name. The day
# counts carry a small buffer over the nominal span, so the requested window really is complete.
FRED_RANGES = ('1mo', '1y', '5y', '10y', 'max')
FRED_DAYS = {'1mo': 45, '1y': 400, '5y': 1850, '10y': 3700}
FRED_DEFAULT_RANGE = '10y'

YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval={interval}&range={range}'
FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}'

# Yahoo answers 429 to python-requests' own UA, and also to a full Chrome string without Yahoo's cookies (checked
# 2026-11-16: the full string got 429 while the bare 'Mozilla/5.0' got 200), so it gets the bare token. FRED's edge
# does the opposite: it resets the connection of a User-Agent that claims to be a browser, so FRED gets requests' own
# UA. Neither string carries anything about the owner.
YAHOO_USER_AGENT = 'Mozilla/5.0'
FRED_USER_AGENT = f'python-requests/{requests.__version__}'
TIMEOUT = 10
CACHE_TTL = 30.0
CACHE_MAX = 128

# --- Deepcoin -----------------------------------------------------------------------------------------------------
# Its REST API is shaped like OKX's (newest bar first, `[ts, o, h, l, c, vol, volCcy]`), but it answers without any
# CORS header, so the browser cannot read it: every candle and ticker of that source goes through this module.
DEEPCOIN_BASE = 'https://api.deepcoin.com/deepcoin/market/'
# `1D` is the venue's own day bar; 3m does not exist there (the page buckets it from 1m itself), and neither does
# OKX's 1Dutc spelling (checked 2026-11-16: `1m,5m,15m,30m,1H,4H,12H,1D,1W,1M,1Y`).
DEEPCOIN_BARS = {'1m': 1, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '1D': 1440}
DEEPCOIN_MARKETS = {'swap': 'SWAP', 'spot': 'SPOT'}
# The page asks for a whole page of history, and earlier pages by `before` (the open time of the oldest loaded bar).
DEEPCOIN_DEFAULT_LIMIT = 300
DEEPCOIN_MAX_LIMIT = 1000
DEEPCOIN_CANDLE_TTL = 2.0
DEEPCOIN_TICKER_TTL = 10.0
# The instId whitelist: one base, the USDT quote, and the perpetual suffix. Nothing else reaches the venue.
DEEPCOIN_SYMBOL = re.compile(r'^[A-Z0-9]{1,20}-USDT(-SWAP)?$')
# Deepcoin's public endpoints refuse requests' own User-Agent, and a full browser string is refused too (the same
# trap as FRED, see below), so the retry goes out with the bare token.
DEEPCOIN_FALLBACK_USER_AGENT = 'Mozilla/5.0'
DEEPCOIN_NOTE = '来源 Deepcoin 公开行情接口'

YAHOO_NOTE = '来源 Yahoo Finance（Cboe 收益率指数），延迟约 0~10 分钟，美股交易时段才更新'
FRED_NOTE = '来源 FRED 官方日线（T+1 更新），节假日没有数据；日线 K 线开高低收相同，就是当天收盘值'


class MarketSourceError(Exception):
    """A readable reason for a bad request (400) or an upstream that answered nothing usable (502)."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _number(value) -> Optional[float]:
    """A finite float, or None for null / '' / text / NaN.

    Accepts numeric strings too (FRED's CSV cells are text; '.' is its missing value), and refuses booleans, since
    `float(True)` would silently become 1.0. Yahoo fills the minutes outside a session with nulls.
    """
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _day_seconds(text: str) -> Optional[int]:
    """'2026-11-14' (FRED's UTC day) as UTC midnight in seconds, or None for the CSV header row."""
    try:
        day = datetime.strptime(str(text).strip(), '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    return int(day.timestamp())


def _dedupe(candles: list) -> list:
    """Oldest first, one candle per open time (the later copy wins), like every other series this page draws."""
    by_time = {candle['time']: candle for candle in candles}
    return [by_time[key] for key in sorted(by_time)]


def resolve_request(source: str, symbol: str, interval: str, range_: Optional[str] = None) -> dict:
    """The instrument, provider and upstream URL of one request, or MarketSourceError(400) for anything else.

    The whitelist is the whole point: nothing but these six symbols and these intervals can reach an upstream.
    """
    if source != SOURCE:
        raise MarketSourceError(
            f'美债 K 线的数据源只能是 {SOURCE}：币安 / OKX 由浏览器直连交易所，Deepcoin 走市场行情接口')
    code = str(symbol or '').strip().upper()
    instrument = YIELD_INSTRUMENTS.get(code)
    if instrument is None:
        raise MarketSourceError(
            f'不支持的美债品种：{symbol or "空"}（可选 {" / ".join(YIELD_INSTRUMENTS)}）')
    interval = str(interval or '').strip()
    spec = INTERVALS.get(interval)
    if spec is None:
        raise MarketSourceError(
            f'不支持的周期：{interval or "空"}（可选 {" / ".join(INTERVALS)}；3m、4h 由页面用 1m、1h 聚合）')
    provider = 'Yahoo' if instrument['yahoo'] else 'FRED'
    if provider == 'FRED':
        if interval != '1D':
            raise MarketSourceError(f'{code} 只有 FRED 官方日线数据，周期只能是 1D')
        allowed, default, note = FRED_RANGES, FRED_DEFAULT_RANGE, FRED_NOTE
    else:
        allowed, default, note = spec['ranges'], spec['default'], YAHOO_NOTE
    wanted = str(range_ or '').strip() or default
    if wanted not in allowed:
        raise MarketSourceError(f'range 只能是 {" / ".join(allowed)}')

    if provider == 'Yahoo':
        url = YAHOO_URL.format(symbol=quote(instrument['yahoo'], safe=''), interval=spec['yahoo'], range=wanted)
    else:
        url = FRED_URL.format(series=instrument['fred'])
        days = FRED_DAYS.get(wanted)
        if days:
            start = datetime.now(timezone.utc) - timedelta(days=days)
            url += '&cosd=' + start.strftime('%Y-%m-%d')
    return {'source': SOURCE, 'symbol': code, 'provider': provider, 'interval': interval, 'range': wanted,
            'url': url, 'note': note, 'daily_only': provider == 'FRED'}


def parse_yahoo_chart(payload) -> list:
    """Yahoo's chart JSON as candles: `{time, open, high, low, close, volume: 0}` in UTC seconds.

    The minutes outside the session come back as nulls and are dropped; a bar whose open / high / low is null keeps
    the close for it (one flat bar is better than a hole in the overlay lines). Anything malformed gives [].
    """
    result = ((payload or {}).get('chart') or {}).get('result') or []
    if not result or not isinstance(result[0], dict):
        return []
    entry = result[0]
    stamps = entry.get('timestamp') or []
    quotes = ((entry.get('indicators') or {}).get('quote') or [{}])[0] or {}
    opens, highs, lows, closes = (quotes.get(key) or [] for key in ('open', 'high', 'low', 'close'))

    def at(values, index, fallback):
        """The value at `index`, or the fallback when it is missing / null."""
        value = _number(values[index]) if index < len(values) else None
        return fallback if value is None else value

    candles = []
    for index, stamp in enumerate(stamps):
        close = _number(closes[index]) if index < len(closes) else None
        if close is None:
            continue
        time_ = _number(stamp)
        if time_ is None:
            continue
        candles.append({'time': int(time_), 'open': at(opens, index, close), 'high': at(highs, index, close),
                        'low': at(lows, index, close), 'close': close, 'volume': 0.0})
    return _dedupe(candles)


def parse_fred_csv(text: str) -> list:
    """FRED's `observation_date,value` CSV as daily candles: o = h = l = c = the day's yield, volume 0.

    A holiday is an empty or '.' cell and is skipped (not drawn as a bar nobody traded); the header row is skipped
    because it is not a date. Anything malformed gives [].
    """
    candles = []
    for row in csv.reader(io.StringIO(str(text or ''))):
        if len(row) < 2:
            continue
        time_ = _day_seconds(row[0])
        value = _number(row[1])
        if value is None or time_ is None:
            continue
        candles.append({'time': time_, 'open': value, 'high': value, 'low': value, 'close': value, 'volume': 0.0})
    return _dedupe(candles)


# --- Deepcoin candles and tickers ---------------------------------------------------------------------------------

def resolve_deepcoin_request(market: Optional[str], symbol: Optional[str], interval: Optional[str],
                             limit: Optional[int] = None, before: Optional[float] = None) -> dict:
    """The upstream URL of one Deepcoin candle request, or MarketSourceError(400) for anything outside the whitelist.

    `market` is `swap` (perpetual) or `spot`; the instId itself has to agree with it, so `BTC-USDT-SWAP` can only be
    asked for as a swap. `before` (seconds, the open time of the oldest bar already loaded) asks for the page before
    it: Deepcoin's `after` parameter is exclusive, like OKX's.
    """
    market = str(market or '').strip().lower()
    if market not in DEEPCOIN_MARKETS:
        raise MarketSourceError(f'market 只能是 {" / ".join(DEEPCOIN_MARKETS)}')
    code = str(symbol or '').strip().upper()
    if not DEEPCOIN_SYMBOL.match(code):
        raise MarketSourceError(f'不支持的 Deepcoin 品种：{symbol or "空"}（形如 BTC-USDT-SWAP 或 BTC-USDT）')
    perpetual = code.endswith('-SWAP')
    if perpetual != (market == 'swap'):
        raise MarketSourceError(f'{code} 是{"合约" if perpetual else "现货"}，market 应为 '
                                f'{"swap" if perpetual else "spot"}')
    bar = str(interval or '').strip()
    if bar not in DEEPCOIN_BARS:
        raise MarketSourceError(f'不支持的周期：{interval or "空"}（可选 {" / ".join(DEEPCOIN_BARS)}）')
    size = DEEPCOIN_DEFAULT_LIMIT if limit is None else int(limit)
    if not 1 <= size <= DEEPCOIN_MAX_LIMIT:
        raise MarketSourceError(f'limit 只能是 1~{DEEPCOIN_MAX_LIMIT}')
    params = {'instId': code, 'bar': bar, 'limit': str(size)}
    if before is not None:
        stamp = int(before)
        if stamp <= 0:
            raise MarketSourceError('before 必须是正数（最早一根 K 线的开盘时间，秒）')
        params['after'] = str(stamp * 1000 - 1)
    return {'source': DEEPCOIN, 'market': market, 'symbol': code, 'interval': bar, 'limit': size,
            'url': DEEPCOIN_BASE + 'candles?' + '&'.join(f'{key}={value}' for key, value in params.items()),
            'note': DEEPCOIN_NOTE}


def parse_deepcoin_candles(rows, interval: str, now_ms: Optional[int] = None) -> dict:
    """Deepcoin's candle array as `{closed, forming}`: UTC-second candles, oldest first.

    The array is newest first. Deepcoin has no `confirm` flag, so the newest bar is the one still forming while its
    window (open + interval) is in the future; everything else is closed data. Malformed rows are dropped.
    """
    minutes = DEEPCOIN_BARS.get(str(interval).strip(), 0)
    window = minutes * 60 * 1000
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    closed, forming = [], None
    for index, row in enumerate(rows if isinstance(rows, list) else []):
        if not isinstance(row, list) or len(row) < 6:
            continue
        try:
            open_ms = int(float(row[0]))
            open_, high, low, close = (float(value) for value in row[1:5])
            volume = float(row[5])
        except (TypeError, ValueError):
            continue
        if open_ms <= 0 or not all(math.isfinite(value) for value in (open_, high, low, close, volume)):
            continue
        if open_ <= 0 or high < max(open_, close) or low > min(open_, close):
            continue
        candle = {'time': open_ms // 1000, 'open': open_, 'high': high, 'low': low, 'close': close,
                  'volume': volume if volume >= 0 else 0.0}
        if index == 0 and window and open_ms + window > now:
            forming = candle
            continue
        closed.append(candle)
    # Newest first in, oldest first out, one bar per open time (the first copy, i.e. the newest answer, wins).
    by_time = {candle['time']: candle for candle in reversed(closed)}
    return {'closed': [by_time[key] for key in sorted(by_time)], 'forming': forming}


def parse_deepcoin_tickers(payload, market: str) -> list:
    """Deepcoin's ticker answer as `[{symbol, last, open24h, quoteVolume24h}]`, USDT instruments only, biggest 24h
    quote turnover first (the order the product list shows). The venue lists USD / USDC instruments next to them."""
    swap = str(market).strip().lower() == 'swap'
    rows = []
    for entry in ((payload or {}).get('data') or []) if isinstance(payload, dict) else []:
        if not isinstance(entry, dict):
            continue
        code = str(entry.get('instId') or '').upper()
        # The same whitelist as the candle route: a USDT pair, and the perpetual suffix exactly on the swap list.
        if not DEEPCOIN_SYMBOL.match(code) or (swap != code.endswith('-SWAP')):
            continue
        last = _number(entry.get('last'))
        if last is None or last <= 0:
            continue
        open24h = _number(entry.get('open24h'))
        volume = _number(entry.get('volCcy24h'))
        rows.append({'symbol': code, 'last': last, 'open24h': open24h,
                     'quoteVolume24h': volume if volume is not None else 0.0})
    rows.sort(key=lambda row: (-row['quoteVolume24h'], row['symbol']))
    return rows


def user_agent(provider: str) -> str:
    """The User-Agent that provider accepts; see YAHOO_USER_AGENT / FRED_USER_AGENT for why they differ."""
    return FRED_USER_AGENT if provider == 'FRED' else YAHOO_USER_AGENT


def fetch_candles(request: dict) -> list:
    """One upstream request of an already resolved request (see resolve_request). Raises MarketSourceError(502)."""
    provider = request['provider']
    try:
        response = requests.get(request['url'], headers={'User-Agent': user_agent(provider)}, timeout=TIMEOUT)
    except requests.RequestException as error:
        raise MarketSourceError(f'从 {provider} 取美债数据失败：{error}', status_code=502)
    if response.status_code == 429:
        raise MarketSourceError(
            f'{provider} 限流了（HTTP 429），稍后再试；这个网络的出口地址可能被上游限制', status_code=502)
    if not response.ok:
        raise MarketSourceError(f'从 {provider} 取美债数据失败（HTTP {response.status_code}）', status_code=502)
    if provider == 'Yahoo':
        try:
            candles = parse_yahoo_chart(response.json())
        except ValueError:
            raise MarketSourceError('Yahoo 返回的不是 JSON，稍后再试', status_code=502)
    else:
        candles = parse_fred_csv(response.text)
    if not candles:
        # An empty series is not a chart: say so instead of drawing nothing. Upstream throttling and a market
        # holiday both look like this from here.
        raise MarketSourceError(f'{provider} 这次没有返回任何 K 线（可能被限流或休市），稍后再试', status_code=502)
    return candles


# (symbol, interval, range) -> (monotonic stamp, answer). Several panels and the page's 60-second poll ask for the
# same series within seconds of each other; 30 seconds keeps the upstream load at one request per interval.
_CACHE = {}
# (kind, market, symbol, interval, limit, before) -> (monotonic stamp, answer) for the Deepcoin proxy. Their panels
# are polled every 3 seconds and the product list every 10, which is what the two TTLs are for.
_PROXY_CACHE = {}


def clear_cache() -> None:
    """Drop every cached answer (tests, and a manual retry that must not see an old failure)."""
    _CACHE.clear()
    _PROXY_CACHE.clear()


def _remember(cache: dict, key: tuple, ttl: float, produce):
    """`produce()` once per `key` per `ttl` seconds, marking a replayed answer with `cached: True`."""
    cached = cache.get(key)
    if cached is not None and time.monotonic() - cached[0] < ttl:
        return {**cached[1], 'cached': True}
    answer = produce()
    if len(cache) >= CACHE_MAX:
        for stale in sorted(cache, key=lambda item: cache[item][0])[: len(cache) - CACHE_MAX + 1]:
            cache.pop(stale, None)
    cache[key] = (time.monotonic(), answer)
    return {**answer, 'cached': False}


def _get_json(url: str, what: str) -> dict:
    """One anonymous GET of a public endpoint as JSON. Raises MarketSourceError(502) with a Chinese reason.

    Deepcoin answers requests' own User-Agent with a refusal and accepts the bare `Mozilla/5.0` (the reverse of what
    FRED does, see YAHOO_USER_AGENT / FRED_USER_AGENT), so a 403 / 451 is retried once with that token. Nothing in
    the request identifies the owner: no key, no cookie, no account.
    """
    try:
        response = requests.get(url, timeout=TIMEOUT)
        if response.status_code in (403, 451):
            response = requests.get(url, headers={'User-Agent': DEEPCOIN_FALLBACK_USER_AGENT}, timeout=TIMEOUT)
    except requests.RequestException as error:
        raise MarketSourceError(f'从 {what} 取数据失败：{error}', status_code=502)
    if response.status_code == 429:
        raise MarketSourceError(f'{what} 限流了（HTTP 429），稍后再试；这个网络的出口地址可能被上游限制', status_code=502)
    if not response.ok:
        raise MarketSourceError(f'从 {what} 取数据失败（HTTP {response.status_code}）', status_code=502)
    try:
        payload = response.json()
    except ValueError:
        raise MarketSourceError(f'{what} 返回的不是 JSON，稍后再试', status_code=502)
    if isinstance(payload, dict) and str(payload.get('code', '')) not in ('', '0'):
        raise MarketSourceError(f'{what} 返回了错误：{payload.get("msg") or payload.get("code")}', status_code=502)
    return payload


def fetch_deepcoin_candles(request: dict) -> dict:
    """One Deepcoin candle request of an already resolved request (see resolve_deepcoin_request)."""
    payload = _get_json(request['url'], 'Deepcoin')
    answer = parse_deepcoin_candles(payload.get('data') if isinstance(payload, dict) else None, request['interval'])
    if not answer['closed'] and not answer['forming']:
        # An empty page is not a chart: a delisted or misspelled instId looks like this from here.
        raise MarketSourceError(f'Deepcoin 这次没有返回 {request["symbol"]} 的 K 线，稍后再试', status_code=502)
    return answer


def fetch_deepcoin_tickers(market: str) -> list:
    """One Deepcoin ticker request (`instType=SWAP|SPOT`). Raises MarketSourceError(502) when the venue is unusable."""
    url = f'{DEEPCOIN_BASE}tickers?instType={DEEPCOIN_MARKETS[market]}'
    payload = _get_json(url, 'Deepcoin')
    rows = parse_deepcoin_tickers(payload, market)
    if not rows:
        raise MarketSourceError('Deepcoin 这次没有返回任何 USDT 品种的行情列表，稍后再试', status_code=502)
    return rows


def read_deepcoin_candles(market: Optional[str], symbol: Optional[str], interval: Optional[str],
                          limit: Optional[int] = None, before: Optional[float] = None) -> dict:
    """Candles of one Deepcoin instrument, with the `before` page serving history like Binance's `endTime`."""
    request = resolve_deepcoin_request(market, symbol, interval, limit, before)
    stamp = int(before) if before is not None else None
    key = (DEEPCOIN, request['market'], request['symbol'], request['interval'], request['limit'], stamp)

    def produce() -> dict:
        answer = fetch_deepcoin_candles(request)
        return {'candles': answer['closed'], 'forming': answer['forming'], 'source': DEEPCOIN,
                'market': request['market'], 'symbol': request['symbol'], 'interval': request['interval'],
                'limit': request['limit'], 'before': stamp, 'note': request['note'], 'delayed': False,
                'fetched_at': int(time.time())}

    return _remember(_PROXY_CACHE, key, DEEPCOIN_CANDLE_TTL, produce)


def read_tickers(source: str, market: Optional[str] = None) -> dict:
    """The product list of one source the browser cannot read itself: Deepcoin's (Binance / OKX are direct)."""
    if source != DEEPCOIN:
        raise MarketSourceError(
            f'行情列表只代理 {DEEPCOIN}：币安 / OKX 的列表由浏览器直连交易所，不走 Jesse')
    market = str(market or '').strip().lower()
    if market not in DEEPCOIN_MARKETS:
        raise MarketSourceError(f'market 只能是 {" / ".join(DEEPCOIN_MARKETS)}')

    def produce() -> dict:
        return {'tickers': fetch_deepcoin_tickers(market), 'source': DEEPCOIN, 'market': market,
                'fetched_at': int(time.time())}

    return _remember(_PROXY_CACHE, (DEEPCOIN, 'tickers', market), DEEPCOIN_TICKER_TTL, produce)


def read_candles(source: str, symbol: str, interval: str, range_: Optional[str] = None,
                 market: Optional[str] = None, limit: Optional[int] = None,
                 before: Optional[float] = None) -> dict:
    """The answer the review route returns: candles plus which provider they came from and how fresh they are."""
    if source == DEEPCOIN:
        return read_deepcoin_candles(market, symbol, interval, limit, before)
    request = resolve_request(source, symbol, interval, range_)
    key = (request['symbol'], request['interval'], request['range'])
    cached = _CACHE.get(key)
    if cached is not None and time.monotonic() - cached[0] < CACHE_TTL:
        return {**cached[1], 'cached': True}
    candles = fetch_candles(request)
    answer = {'candles': candles, 'provider': request['provider'], 'delayed': True, 'note': request['note'],
              'source': SOURCE, 'symbol': request['symbol'], 'interval': request['interval'],
              'range': request['range'], 'daily_only': request['daily_only'], 'fetched_at': int(time.time())}
    if len(_CACHE) >= CACHE_MAX:
        for stale in sorted(_CACHE, key=lambda item: _CACHE[item][0])[: len(_CACHE) - CACHE_MAX + 1]:
            _CACHE.pop(stale, None)
    _CACHE[key] = (time.monotonic(), answer)
    return {**answer, 'cached': False}
