"""
Market sources of the 看行情 page that the browser cannot read by itself.

The US treasury yields come from two public sources, and neither allows a cross-origin read from the review page:
Yahoo's chart endpoint and FRED's CSV export answer without CORS headers. So the page asks Jesse
(`POST /review/market/candles`) and this module does the whitelist, the request and the parsing. Binance (perpetual
and spot) is not here on purpose: the browser talks to the exchange directly.

Everything that decides what a request means and what the answer contains is a pure function
(`resolve_request`, `parse_yahoo_chart`, `parse_fred_csv`), so `tests/test_market_sources.py` runs without a
network. `read_candles` is the only function that goes out, and it caches for 30 seconds because several timeframe
panels and the page's 60-second polls ask for the same series.
"""
import csv
import io
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

import requests

SOURCE = 'us-yields'

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

# Yahoo answers 429 to anything that is not a browser, so it gets a generic browser string. FRED's edge does the
# opposite: it resets the connection of a User-Agent that claims to be a browser (checked 2026-11-16), so FRED gets
# requests' own UA. Neither string carries anything about the owner.
YAHOO_USER_AGENT = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
FRED_USER_AGENT = f'python-requests/{requests.__version__}'
TIMEOUT = 10
CACHE_TTL = 30.0
CACHE_MAX = 128

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
            f'数据源只能是 {SOURCE}：币安永续 / 现货由浏览器直连交易所，不走 Jesse')
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


def clear_cache() -> None:
    """Drop every cached answer (tests, and a manual retry that must not see an old failure)."""
    _CACHE.clear()


def read_candles(source: str, symbol: str, interval: str, range_: Optional[str] = None) -> dict:
    """The answer the review route returns: candles plus which provider they came from and how fresh they are."""
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
