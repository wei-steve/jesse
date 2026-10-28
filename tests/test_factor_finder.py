import os
import sys
from hashlib import sha256

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jesse.controllers import factors_controller
from jesse.services import auth, factor_finder

PASSWORD = 'factor-finder-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}
MINUTE = 60_000
# 2024-01-01 00:00 UTC, aligned to every timeframe used below.
T0 = 1_704_067_200_000

# A deliberately trivial example factor: +5 when the close rose from the previous bar, else 0. The label
# reports how many bars compute() received, which shows the warmup was passed in.
EXAMPLE = '''
TITLE = 'Example'
VERSION = 'v1'
DESCRIPTION = 'rises'
TIMEFRAMES = ['5m']
PARAMS = [{'name': 'window', 'label': 'window', 'default': 8, 'min': 3, 'max': 50, 'step': 1},
          {'name': 'ratio', 'label': 'ratio', 'default': 0.25, 'min': 0, 'max': 2, 'step': 0.05}]
WARMUP_BARS = 3
def compute(candles_by_tf, params):
    out = {}
    for tf, c in candles_by_tf.items():
        close = c[:, 2]
        value = [0] + [5 if close[i] > close[i - 1] else 0 for i in range(1, len(close))]
        out[tf] = {'value': value, 'touches': list(range(len(close))), 'label': f'{len(close)}:{params["window"]}'}
    return out
'''


def one_minutes(start_ms, count, skip=()):
    """Rising 1m candles: close of minute i is 100 + i."""
    rows = []
    for i in range(count):
        if i in skip:
            continue
        rows.append([start_ms + i * MINUTE, 100 + i - 0.5, 100 + i, 101 + i, 99 + i, 1.0])
    return np.array(rows, dtype=float)


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project directory (cwd) with a factors/ folder and a fake 1m database of 600 minutes."""
    monkeypatch.chdir(tmp_path)
    # Loading a factor adds the project dir to sys.path and imports `factors`; undo both after the test.
    monkeypatch.setattr(sys, 'path', list(sys.path))
    (tmp_path / 'factors').mkdir()
    (tmp_path / 'factors' / 'example.py').write_text(EXAMPLE)
    state = {'rows': one_minutes(T0, 600), 'calls': []}

    def fetch(exchange, symbol, start_ms, finish_ms):
        state['calls'].append((start_ms, finish_ms))
        rows = state['rows']
        return rows[(rows[:, 0] >= start_ms) & (rows[:, 0] <= finish_ms)]

    monkeypatch.setattr(factor_finder, '_fetch_one_minute', fetch)
    monkeypatch.setattr(factor_finder, '_latest_one_minute_ms', lambda e, s: int(state['rows'][-1, 0]))
    state['dir'] = tmp_path
    yield state
    for name in [m for m in sys.modules if m == 'factors' or m.startswith('factors.')]:
        del sys.modules[name]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(auth.ENV_VALUES, 'PASSWORD', PASSWORD)
    app = FastAPI()

    @app.exception_handler(auth.InvalidAuthError)
    async def invalid_auth_handler(_request, _exc):
        return auth.unauthorized_response()

    app.include_router(factors_controller.router)
    return TestClient(app)


def body(**overrides):
    payload = {'factor': 'example', 'exchange': 'Binance Perpetual Futures', 'symbol': 'BTC-USDT',
               'start': T0 + 100 * MINUTE, 'timeframes': ['5m'], 'params': {}}
    payload.update(overrides)
    return payload


def run(client, **overrides):
    return client.post('/factors/run', json=body(**overrides), headers=HEADERS)


def test_endpoints_require_auth(client, project):
    assert client.post('/factors/list').status_code == 401
    assert client.post('/factors/run', json=body()).status_code == 401


def test_list_describes_factor_files(client, project):
    (project['dir'] / 'factors' / '_private.py').write_text('x = 1')
    (project['dir'] / 'factors' / 'broken.py').write_text('raise ValueError("boom")')
    items = {i['name']: i for i in client.post('/factors/list', headers=HEADERS).json()}
    assert set(items) == {'example', 'broken'}
    example = items['example']
    assert (example['title'], example['version'], example['timeframes']) == ('Example', 'v1', ['5m'])
    assert example['params'][0]['name'] == 'window'
    assert 'ValueError: boom' in items['broken']['error']


def test_list_without_factors_folder_is_empty(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert client.post('/factors/list', headers=HEADERS).json() == []


def test_aggregation_keeps_only_complete_bars():
    # 12 minutes = bars at 0-4 (complete), 5-9 (minute 7 missing), 10-11 (still forming).
    rows = one_minutes(T0, 12, skip=(7,))
    bars = factor_finder.aggregate_complete(rows, 5)
    assert bars.shape == (1, 6)
    assert bars[0, 0] == T0
    assert (bars[0, 1], bars[0, 2], bars[0, 3], bars[0, 4], bars[0, 5]) == (99.5, 104, 105, 99, 5.0)


def test_run_drops_forming_bar_and_warmup(client, project):
    # Data is 600 minutes; the newest 5m bar is complete (minutes 595-599), start is minute 100.
    data = run(client).json()
    candles = data['timeframes']['5m']['candles']
    assert candles[0]['time'] == (T0 + 100 * MINUTE) // 1000
    assert candles[-1]['time'] == (T0 + 595 * MINUTE) // 1000
    assert len(candles) == len(data['timeframes']['5m']['value']) == len(data['timeframes']['5m']['touches'])
    # compute() got 3 warmup bars + the displayed ones; the label carries the count.
    assert data['timeframes']['5m']['label'] == f'{len(candles) + 3}:8'
    assert data['last_candle_time'] == (T0 + 599 * MINUTE) // 1000
    assert data['version'] == 'v1'
    # Touches indices are relative to the full array, so the first displayed bar is index 3.
    assert data['timeframes']['5m']['touches'][0] == 3
    # The 1m fetch started warmup_bars * 5 minutes before start.
    assert project['calls'][-1][0] == T0 + (100 - 15) * MINUTE


def test_run_without_finish_uses_newest_candle_and_forming_bar_is_excluded(client, project):
    project['rows'] = one_minutes(T0, 603)  # newest 5m bucket holds 3 of 5 minutes
    data = run(client).json()
    assert data['last_candle_time'] == (T0 + 602 * MINUTE) // 1000
    assert data['timeframes']['5m']['candles'][-1]['time'] == (T0 + 595 * MINUTE) // 1000


def test_explicit_finish_iso_and_range_limit(client, project):
    ok = run(client, start='2024-01-01T01:40:00Z', finish='2024-01-01T08:00:00')
    assert ok.status_code == 200
    assert ok.json()['finish'] == T0 // 1000 + 8 * 3600
    # the limit is on bars returned, not days: a long range is fine on a big timeframe, too many bars is not
    long_1h = run(client, start='2023-01-01T00:00:00Z', finish='2024-01-01T08:00:00Z', timeframes=['1h'])
    assert long_1h.status_code != 400 or '太多' not in long_1h.json().get('error', '')
    too_many = run(client, start='2022-01-01T00:00:00Z', finish='2024-01-01T08:00:00Z', timeframes=['1m'])
    assert too_many.status_code == 400 and '太多' in too_many.json()['error']
    assert run(client, start=T0 + 200 * MINUTE, finish=T0 + 100 * MINUTE).status_code == 400


def test_params_are_clamped_defaulted_and_validated(client, project):
    data = run(client, params={'window': 999}).json()
    assert data['params'] == {'window': 50, 'ratio': 0.25}
    assert data['timeframes']['5m']['label'].endswith(':50')
    assert run(client, params={'window': 1}).json()['params']['window'] == 3
    assert run(client, params={'window': 7.6}).json()['params']['window'] == 8  # int param stays int
    unknown = run(client, params={'evil': 1})
    assert unknown.status_code == 400 and 'evil' in unknown.json()['error']
    assert run(client, params={'window': 'x'}).status_code == 400


@pytest.mark.parametrize('name', ['../example', 'a.b', 'a b', 'missing', '', '__init__', 'example.py'])
def test_invalid_or_missing_factor_name_is_400(client, project, name):
    assert run(client, factor=name).status_code == 400


def test_unsupported_timeframe_is_400(client, project):
    assert run(client, timeframes=['7m']).status_code == 400
    assert run(client, timeframes=['1W']).status_code == 400


def test_compute_exception_returns_last_line(client, project):
    (project['dir'] / 'factors' / 'bad.py').write_text(
        'def compute(c, p):\n    raise ValueError("window too small")\n')
    response = run(client, factor='bad')
    assert response.status_code == 400
    assert response.json()['error'].endswith('ValueError: window too small')


def test_wrong_length_value_is_400(client, project):
    (project['dir'] / 'factors' / 'short.py').write_text(
        "def compute(c, p):\n    return {tf: {'value': [1]} for tf in c}\n")
    assert run(client, factor='short').status_code == 400


def test_edited_factor_file_takes_effect_on_next_run(client, project):
    path = project['dir'] / 'factors' / 'example.py'
    assert run(client).json()['version'] == 'v1'
    path.write_text(EXAMPLE.replace("'v1'", "'v2'").replace("'default': 8", "'default': 9"))
    # Same-second edits could keep a stale .pyc (mtime has one-second resolution), so move the mtime.
    stat = path.stat()
    os.utime(path, (stat.st_atime, stat.st_mtime + 5))
    data = run(client).json()
    assert data['version'] == 'v2'
    assert data['params']['window'] == 9


def test_no_candles_in_range_is_404(client, project):
    assert run(client, start=T0 + 5000 * MINUTE, finish=T0 + 5100 * MINUTE).status_code == 404
