"""
Factor finder: loads user-written factor files from the project's ``factors/`` folder and runs them on
candles read straight from the database (so the newest minutes are included, unlike a backtest).

The framework knows nothing about any concrete rule. A factor file only has to follow the contract below.
Nothing here executes code taken from a request: the factor is chosen by name and must be a file that
already exists in ``<cwd>/factors/``.

Factor file (``factors/<name>.py``, ``<name>`` matches ``^[A-Za-z0-9_]+$``)::

    TITLE = '...'          # shown in the page's drop-down
    VERSION = 'v1'
    DESCRIPTION = '...'    # optional
    TIMEFRAMES = ['1h', '5m']                  # default ticked timeframes
    PARAMS = [{'name': 'window', 'label': '...', 'default': 8, 'min': 3, 'max': 50, 'step': 1}]
    WARMUP_BARS = 45       # bars each timeframe needs before the displayed range
    def compute(candles_by_tf, params) -> {tf: {'value': [...], 'touches': [...], 'label': '...'}}
"""
import importlib
import os
import re
import sys
import threading
from datetime import datetime, timezone

import numpy as np

from jesse.constants import TIMEFRAME_TO_ONE_MINUTES

NAME_PATTERN = re.compile(r'^[A-Za-z0-9_]+$')
FACTORS_PACKAGE = 'factors'
# The limit is on how many bars one request returns (summed over the chosen timeframes), not on days: one
# year of 1h+15m is light while one year of 3m is not. 600k bars is about 45 MB of JSON and still draws
# smoothly; e.g. 1h/15m/5m/3m together allow about 1.8 years, 1h/15m alone the whole history.
MAX_TOTAL_BARS = 600_000
# Weeks and months have no clean epoch-aligned bucket, so they are not offered.
MAX_TIMEFRAME_MINUTES = 1440
MAX_TIMEFRAMES = 8
DEFAULT_WARMUP_BARS = 50
MINUTE_MS = 60_000
_FIELD_NAMES = {'start': '开始时间', 'finish': '结束时间'}

# Importing purges and re-imports the `factors` package; two requests must not interleave doing that.
_import_lock = threading.Lock()


class FactorError(Exception):
    """A problem with the request or the factor file; ``status`` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------------------------------

def factors_dir() -> str:
    return os.path.join(os.getcwd(), FACTORS_PACKAGE)


def _last_line(exc: BaseException) -> str:
    """Last line of the exception text, e.g. ``ValueError: bad window``."""
    lines = [line for line in f'{type(exc).__name__}: {exc}'.strip().splitlines() if line.strip()]
    return lines[-1] if lines else type(exc).__name__


def load_factor(name: str):
    """
    Import ``factors.<name>`` fresh. Every call purges the ``factors`` package from ``sys.modules`` first, so
    edits to the factor file or to a helper module it imports take effect on the next call without restarting.
    """
    if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name) or name.startswith('_'):
        raise FactorError('因子名不合法：只能用字母、数字和下划线。')
    if not os.path.isfile(os.path.join(factors_dir(), f'{name}.py')):
        raise FactorError(f'在项目的 factors/ 目录里找不到因子“{name}”。')
    cwd = os.getcwd()
    with _import_lock:
        if cwd not in sys.path:
            # Appended, not inserted first: jesse.helpers.get_strategy_class reads sys.path[0].
            sys.path.append(cwd)
        for loaded in [m for m in sys.modules if m == FACTORS_PACKAGE or m.startswith(FACTORS_PACKAGE + '.')]:
            del sys.modules[loaded]
        importlib.invalidate_caches()
        try:
            module = importlib.import_module(f'{FACTORS_PACKAGE}.{name}')
        except Exception as exc:
            raise FactorError(f'因子“{name}”加载失败：{_last_line(exc)}') from exc
    if not callable(getattr(module, 'compute', None)):
        raise FactorError(f'因子“{name}”里没有 compute(candles_by_tf, params) 函数。')
    return module


def _params_spec(module) -> list:
    spec = []
    for item in getattr(module, 'PARAMS', None) or []:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str):
            continue
        spec.append(item)
    return spec


def describe(module, name: str) -> dict:
    return {
        'name': name,
        'title': str(getattr(module, 'TITLE', name)),
        'version': str(getattr(module, 'VERSION', '')),
        'description': str(getattr(module, 'DESCRIPTION', '')),
        'timeframes': [tf for tf in (getattr(module, 'TIMEFRAMES', None) or []) if tf in TIMEFRAME_TO_ONE_MINUTES],
        'params': _params_spec(module),
    }


def list_factors() -> list:
    """Every ``factors/<name>.py``. A file that fails to import is listed with an ``error`` so it is not silent."""
    folder = factors_dir()
    if not os.path.isdir(folder):
        return []
    result = []
    for file in sorted(os.listdir(folder)):
        name, ext = os.path.splitext(file)
        if ext != '.py' or name.startswith('_') or not NAME_PATTERN.fullmatch(name):
            continue
        try:
            result.append(describe(load_factor(name), name))
        except FactorError as exc:
            result.append({'name': name, 'title': name, 'version': '', 'description': '', 'timeframes': [],
                           'params': [], 'error': str(exc)})
    return result


def resolve_params(module, given) -> dict:
    """
    Only names declared in PARAMS are accepted (anything else is a 400). A missing one takes its default and a
    number outside [min, max] is clamped. A param stays an int only when its default, min, max and step are all
    ints: a factor file may write `'default': 3` for a value that takes 2.5 (step 0.1), and rounding that to 2
    would silently ignore what the user typed.
    """
    if given is None:
        given = {}
    if not isinstance(given, dict):
        raise FactorError('参数格式不对（params 必须是对象）。')
    spec = {item['name']: item for item in _params_spec(module)}
    unknown = sorted(set(given) - set(spec))
    if unknown:
        raise FactorError(f'不认识的参数：{"、".join(map(str, unknown))}。')
    resolved = {}
    for pname, item in spec.items():
        default = item.get('default')
        value = given.get(pname, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value):
            raise FactorError(f'参数“{pname}”必须是数字。')
        low, high = item.get('min'), item.get('max')
        if isinstance(low, (int, float)) and value < low:
            value = low
        if isinstance(high, (int, float)) and value > high:
            value = high
        declared = [item.get(key) for key in ('default', 'min', 'max', 'step') if item.get(key) is not None]
        if all(isinstance(x, int) and not isinstance(x, bool) for x in declared):
            value = int(round(value))
        resolved[pname] = value
    return resolved


# ---------------------------------------------------------------------------------------------------
# Candles
# ---------------------------------------------------------------------------------------------------

def parse_time_ms(value, field: str) -> int:
    """UTC time as epoch milliseconds (int/float, or digits) or an ISO string; a string without zone is UTC."""
    if isinstance(value, bool) or value is None:
        raise FactorError(f'缺少{_FIELD_NAMES.get(field, field)}。')
    if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r'\d{10,}', value.strip())):
        return int(float(value))
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace('Z', '+00:00'))
    except ValueError:
        raise FactorError(f'{_FIELD_NAMES.get(field, field)}格式不对：要 UTC 时间（如 2026-10-01T00:00）或毫秒数。')
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def aggregate_complete(one_minute: np.ndarray, minutes: int) -> np.ndarray:
    """
    Jesse-format candles (timestamp ms, open, close, high, low, volume) of ``minutes``-minute bars built from
    1m rows, UTC-aligned. A bucket is kept only when it holds every one of its 1m candles, so a bar that is
    still forming (or has a gap) never appears.
    """
    if minutes == 1:
        return one_minute.copy()
    if len(one_minute) == 0:
        return one_minute.reshape(0, 6)
    size = minutes * MINUTE_MS
    ts = one_minute[:, 0].astype(np.int64)
    bucket = ts // size
    # Rows are time-sorted, so equal buckets are contiguous.
    starts = np.flatnonzero(np.r_[True, bucket[1:] != bucket[:-1]])
    counts = np.diff(np.r_[starts, len(ts)])
    complete = counts == minutes
    if not complete.any():
        return one_minute[:0].reshape(0, 6)
    # reduceat runs over every bucket (each ends where the next begins); then only complete ones are kept.
    ends = starts + counts - 1
    out = np.empty((int(complete.sum()), 6))
    out[:, 0] = bucket[starts[complete]] * size
    out[:, 1] = one_minute[starts[complete], 1]
    out[:, 2] = one_minute[ends[complete], 2]
    out[:, 3] = np.maximum.reduceat(one_minute[:, 3], starts)[complete]
    out[:, 4] = np.minimum.reduceat(one_minute[:, 4], starts)[complete]
    out[:, 5] = np.add.reduceat(one_minute[:, 5], starts)[complete]
    return out


def _fetch_one_minute(exchange: str, symbol: str, start_ms: int, finish_ms: int) -> np.ndarray:
    """1m rows with open time in [start_ms, finish_ms]; empty when the database has none. Tests replace this."""
    from jesse.exceptions import CandleNotFoundInDatabase
    from jesse.services.candle_service import _get_candles_from_db
    try:
        return _get_candles_from_db(exchange, symbol, start_ms, finish_ms)
    except CandleNotFoundInDatabase:
        return np.empty((0, 6))


def _latest_one_minute_ms(exchange: str, symbol: str):
    """Open time (ms) of the newest 1m row of the symbol, or None. Tests replace this."""
    from peewee import fn
    from jesse.models.Candle import Candle
    return Candle.select(fn.MAX(Candle.timestamp)).where(
        Candle.exchange == exchange, Candle.symbol == symbol,
        (Candle.timeframe == '1m') | (Candle.timeframe.is_null()),
    ).scalar()


# ---------------------------------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------------------------------

def _numbers(raw, length: int, tf: str, key: str) -> list:
    try:
        arr = np.asarray(raw, dtype=float)
    except (TypeError, ValueError):
        raise FactorError(f'因子 compute() 给 {tf} 返回的 {key} 不是数字。')
    if arr.shape != (length,):
        raise FactorError(f'因子 compute() 给 {tf} 返回的 {key} 有 {arr.size} 个，应该是 {length} 个（每根 K 线一个）。')
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    return [int(x) if x == int(x) else float(x) for x in arr]


def run_factor(request: dict) -> dict:
    name = request.get('factor')
    module = load_factor(name)
    params = resolve_params(module, request.get('params'))

    exchange, symbol = request.get('exchange'), request.get('symbol')
    if not exchange or not symbol or not isinstance(exchange, str) or not isinstance(symbol, str):
        raise FactorError('请填写交易所和品种。')

    timeframes = request.get('timeframes') or getattr(module, 'TIMEFRAMES', None) or []
    if not isinstance(timeframes, list) or not timeframes:
        raise FactorError('请至少勾选 1 个周期。')
    timeframes = list(dict.fromkeys(timeframes))
    if len(timeframes) > MAX_TIMEFRAMES:
        raise FactorError(f'一次最多勾选 {MAX_TIMEFRAMES} 个周期。')
    for tf in timeframes:
        if tf not in TIMEFRAME_TO_ONE_MINUTES or TIMEFRAME_TO_ONE_MINUTES[tf] > MAX_TIMEFRAME_MINUTES:
            raise FactorError(f'不支持的周期“{tf}”。')

    start_ms = parse_time_ms(request.get('start'), 'start') // MINUTE_MS * MINUTE_MS
    if request.get('finish') in (None, ''):
        finish_ms = _latest_one_minute_ms(exchange, symbol)
        if finish_ms is None:
            raise FactorError(f'数据库里没有 {exchange} {symbol} 的 K 线，请先导入。', 404)
        finish_ms = int(finish_ms)
    else:
        finish_ms = parse_time_ms(request.get('finish'), 'finish') // MINUTE_MS * MINUTE_MS
    if finish_ms <= start_ms:
        raise FactorError('结束时间要晚于开始时间。')
    minutes = (finish_ms - start_ms) // MINUTE_MS + 1
    total_bars = sum(minutes // TIMEFRAME_TO_ONE_MINUTES[tf] for tf in timeframes)
    if total_bars > MAX_TOTAL_BARS:
        raise FactorError(f'这次要取的 K 线太多：约 {total_bars / 10_000:.0f} 万根，上限 {MAX_TOTAL_BARS // 10_000} 万根'
                          f'（各周期合计）。可以缩短范围，或去掉 1m、3m、5m 这类小周期。')

    warmup = getattr(module, 'WARMUP_BARS', DEFAULT_WARMUP_BARS)
    if isinstance(warmup, bool) or not isinstance(warmup, int) or warmup < 0:
        raise FactorError('因子的 WARMUP_BARS 必须是不小于 0 的整数。')
    longest = max(TIMEFRAME_TO_ONE_MINUTES[tf] for tf in timeframes)
    fetch_from = start_ms - warmup * longest * MINUTE_MS
    one_minute = _fetch_one_minute(exchange, symbol, fetch_from, finish_ms)
    in_range = one_minute[one_minute[:, 0] >= start_ms] if len(one_minute) else one_minute
    if not len(in_range):
        raise FactorError(f'这个时间范围里没有 {exchange} {symbol} 的 K 线。', 404)

    by_tf, shown_from = {}, {}
    for tf in timeframes:
        bars = aggregate_complete(one_minute, TIMEFRAME_TO_ONE_MINUTES[tf])
        # A bar that opened before `start` is warmup even if part of it lies inside the range.
        first_shown = int(np.searchsorted(bars[:, 0], start_ms, side='left')) if len(bars) else 0
        by_tf[tf] = bars[max(0, first_shown - warmup):]
        # Index in by_tf[tf] where the displayed (non-warmup) bars begin.
        shown_from[tf] = first_shown - max(0, first_shown - warmup)

    try:
        result = module.compute({tf: by_tf[tf].copy() for tf in timeframes}, dict(params))
    except Exception as exc:
        raise FactorError(f'因子计算出错：{_last_line(exc)}') from exc
    if not isinstance(result, dict):
        raise FactorError('因子 compute() 的返回格式不对：应为 {周期: {"value": [...]}}。')

    output = {}
    for tf in timeframes:
        entry = result.get(tf)
        if not isinstance(entry, dict) or 'value' not in entry:
            raise FactorError(f'因子 compute() 没有返回 {tf} 的 value。')
        length = len(by_tf[tf])
        values = _numbers(entry['value'], length, tf, 'value')
        touches = _numbers(entry['touches'], length, tf, 'touches') if entry.get('touches') is not None else [0] * length
        cut = shown_from[tf]
        bars = by_tf[tf][cut:]
        item = {
            'candles': [{'time': int(b[0] // 1000), 'open': float(b[1]), 'high': float(b[3]),
                         'low': float(b[4]), 'close': float(b[2]), 'volume': float(b[5])} for b in bars],
            'value': values[cut:],
            'touches': touches[cut:],
        }
        if entry.get('label') is not None:
            item['label'] = str(entry['label'])
        output[tf] = item

    return {
        'factor': name,
        'title': str(getattr(module, 'TITLE', name)),
        'version': str(getattr(module, 'VERSION', '')),
        'exchange': exchange,
        'symbol': symbol,
        'params': params,
        'start': start_ms // 1000,
        'finish': finish_ms // 1000,
        'last_candle_time': int(one_minute[-1, 0] // 1000),
        'timeframes': output,
    }
