import json
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jesse.controllers import review_controller
from jesse.services import auth

PASSWORD = 'review-labels-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}
# `factor|exchange|symbol|tf|start|dir`, exactly as the page builds it (labels.mjs).
KEY = 'ma_pullback|Binance Perpetual Futures|BTC-USDT|15m|1763000000|-1'


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project directory: the endpoints read and write relative to the cwd of `jesse run`."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(auth.ENV_VALUES, 'PASSWORD', PASSWORD)
    app = FastAPI()

    @app.exception_handler(auth.InvalidAuthError)
    async def invalid_auth_handler(_request, _exc):
        return auth.unauthorized_response()

    app.include_router(review_controller.router)
    return TestClient(app)


def record(**overrides):
    """One mark. No `kind` unless a test asks for it: the default (trend) is what old pages / scripts send."""
    body = {
        'key': KEY, 'label': 'good', 'factor': 'ma_pullback', 'version': 'v1', 'params': {'window': 8},
        'exchange': 'Binance Perpetual Futures', 'symbol': 'BTC-USDT', 'tf': '15m', 'start': 1763000000,
        'dir': -1, 'note': '回踩到位', 'order': {'rule': 'sma5', 'price': 64000.5, 'status': 'filled',
                                                 'stop': 63000, 'target': 66000, 'R': 1.9},
    }
    body.update(overrides)
    return body


def label(client, **overrides):
    return client.post('/review/label', json=record(**overrides), headers=HEADERS)


def labels(client, **overrides):
    query = {'factor': 'ma_pullback', 'exchange': 'Binance Perpetual Futures', 'symbol': 'BTC-USDT'}
    query.update(overrides)
    return client.post('/review/labels', json=query, headers=HEADERS)


def rows(project):
    path = project / 'storage' / 'labels' / 'finder-labels.jsonl'
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]


def write_rows(project, records):
    """A hand-written file, the way the project's own file looks: one JSON object per line."""
    path = project / 'storage' / 'labels' / 'finder-labels.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')


def test_endpoints_require_auth(client, project):
    assert client.post('/review/label', json=record()).status_code == 401
    assert client.post('/review/labels', json={'factor': 'ma_pullback'}).status_code == 401


def test_appends_one_line_with_every_field_and_a_stamp(client, project):
    assert label(client).status_code == 200
    assert label(client).json() == {'ok': True}
    saved = rows(project)[0]
    assert saved['key'] == KEY
    # No kind in the request: the row is a trend mark, and the file says so.
    assert saved['kind'] == 'trend'
    assert saved['label'] == 'good'
    assert (saved['factor'], saved['exchange'], saved['symbol'], saved['tf']) == (
        'ma_pullback', 'Binance Perpetual Futures', 'BTC-USDT', '15m')
    assert saved['start'] == 1763000000 and saved['dir'] == -1
    assert saved['params'] == {'window': 8}
    assert saved['order'] == record()['order']
    assert saved['note'] == '回踩到位'
    # saved_at is UTC ISO; the reader parses it, so the format matters more than the second.
    assert saved['saved_at'].endswith('Z') and 'T' in saved['saved_at']
    # Only append: a second mark for the same key is a second line, the first one is untouched.
    assert len(rows(project)) == 2


def test_kind_defaults_to_trend_and_the_latest_row_of_a_kind_wins(client, project):
    label(client)
    label(client, label='bad', note='挂单没成交')
    data = labels(client).json()
    assert data == {'labels': {KEY: {'trend': 'bad', 'order': None, 'note': '挂单没成交'}}}
    # The history stays readable: both marks are still in the file.
    assert [row['label'] for row in rows(project)] == ['good', 'bad']


def test_trend_and_order_marks_do_not_overwrite_each_other(client, project):
    label(client, kind='trend', label='good', note='')
    label(client, kind='order', label='bad', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'good', 'order': 'bad', 'note': ''}}}
    label(client, kind='trend', label='bad', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': 'bad', 'note': ''}}}
    # Clearing one kind leaves the other alone, and clearing both drops the key from the answer.
    label(client, kind='order', label='clear', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': None, 'note': ''}}}
    label(client, kind='trend', label='clear', note='')
    assert labels(client).json() == {'labels': {}}
    # A clear is kept as a row too, so the file shows who un-marked what.
    assert [(row['kind'], row['label']) for row in rows(project)][-2:] == [('order', 'clear'), ('trend', 'clear')]


def test_a_note_is_its_own_row(client, project):
    label(client, kind='trend', label='good', note='')
    # kind=note needs no label: it only records the text.
    assert label(client, kind='note', note='趋势对，挂单太远', label=None).status_code == 200
    saved = rows(project)[-1]
    assert saved['kind'] == 'note' and saved['note'] == '趋势对，挂单太远' and 'label' not in saved
    assert labels(client).json() == {'labels': {KEY: {'trend': 'good', 'order': None, 'note': '趋势对，挂单太远'}}}
    # An empty note is the explicit "clear the note" row; the marks stay.
    assert label(client, kind='note', note='', label=None).status_code == 200
    assert labels(client).json() == {'labels': {KEY: {'trend': 'good', 'order': None, 'note': ''}}}
    # A note alone still returns the key (no marks, but something to read).
    label(client, kind='trend', label='clear', note='')
    label(client, kind='note', note='只是记一句', label=None)
    assert labels(client).json() == {'labels': {KEY: {'trend': None, 'order': None, 'note': '只是记一句'}}}


def test_clearing_a_mark_keeps_the_note(client, project):
    label(client)  # trend good with a note
    label(client, kind='trend', label='clear', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': None, 'order': None, 'note': '回踩到位'}}}


def test_rejects_an_unknown_label_or_kind(client, project):
    response = label(client, label='maybe')
    assert response.status_code == 400
    assert 'good' in response.json()['error']
    # A trend / order row is nothing without a good / bad / clear label.
    assert label(client, label=None).status_code == 400
    response = label(client, kind='both')
    assert response.status_code == 400
    assert 'trend' in response.json()['error']
    assert not (project / 'storage' / 'labels' / 'finder-labels.jsonl').exists()


def test_rejects_a_record_above_the_size_limit(client, project):
    response = label(client, params={'window': 8, 'blob': 'x' * (review_controller.MAX_RECORD_BYTES + 1)})
    assert response.status_code == 413
    assert not (project / 'storage' / 'labels' / 'finder-labels.jsonl').exists()


def test_rejects_too_long_key_and_caps_the_note(client, project):
    assert label(client, key='k' * (review_controller.MAX_KEY + 1)).status_code == 400
    assert label(client, note='n' * 900).status_code == 200
    assert len(rows(project)[-1]['note']) == review_controller.MAX_LABEL_NOTE
    assert label(client, kind='note', note='n' * 900, label=None).status_code == 200
    assert len(rows(project)[-1]['note']) == review_controller.MAX_LABEL_NOTE


def test_labels_are_filtered_to_the_same_factor_exchange_and_symbol(client, project):
    label(client)
    label(client, key='other|Bybit|ETH-USDT|5m|1763000300|1', factor='other', exchange='Bybit', symbol='ETH-USDT')
    label(client, key='ma_pullback|Bybit|BTC-USDT|15m|1763000000|-1', exchange='Bybit')
    data = labels(client).json()
    assert list(data['labels']) == [KEY]
    # A partial query still filters by what it was given (and only by that).
    other = {'factor': 'other', 'exchange': 'Bybit', 'symbol': 'ETH-USDT'}
    assert list(client.post('/review/labels', json=other, headers=HEADERS).json()['labels']) == ['other|Bybit|ETH-USDT|5m|1763000300|1']
    factor_only = client.post('/review/labels', json={'factor': 'other'}, headers=HEADERS).json()['labels']
    assert list(factor_only) == ['other|Bybit|ETH-USDT|5m|1763000300|1']
    assert client.post('/review/labels', json={'symbol': 'DOGE-USDT'}, headers=HEADERS).json() == {'labels': {}}


def test_missing_file_reads_as_no_labels(client, project):
    assert labels(client).json() == {'labels': {}}
    assert not (project / 'storage' / 'labels').exists()


def test_rows_written_before_the_split_are_trend_marks(client, project):
    """The project's file already holds marks from before trend / order were two things: they are trend marks."""
    write_rows(project, [
        {'key': KEY, 'label': 'good', 'factor': 'ma_pullback', 'exchange': 'Binance Perpetual Futures',
         'symbol': 'BTC-USDT', 'tf': '15m', 'start': 1763000000, 'dir': -1, 'note': '旧的标注',
         'saved_at': '2026-10-01T00:00:00Z'},
        {'key': KEY, 'label': 'bad', 'factor': 'ma_pullback', 'exchange': 'Binance Perpetual Futures',
         'symbol': 'BTC-USDT', 'tf': '15m', 'start': 1763000000, 'dir': -1},
    ])
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': None, 'note': '旧的标注'}}}
    # A new order mark lives next to the old trend mark instead of replacing it.
    label(client, kind='order', label='good', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': 'good', 'note': '旧的标注'}}}
    # Neither the old lines nor the new one is rewritten.
    assert len(rows(project)) == 3
