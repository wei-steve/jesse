import json
import os
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
    assert data == {'labels': {KEY: {'trend': 'bad', 'order': None, 'note': '挂单没成交'}}, 'bars': {}}
    # The history stays readable: both marks are still in the file.
    assert [row['label'] for row in rows(project)] == ['good', 'bad']


def test_trend_and_order_marks_do_not_overwrite_each_other(client, project):
    label(client, kind='trend', label='good', note='')
    label(client, kind='order', label='bad', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'good', 'order': 'bad', 'note': ''}}, 'bars': {}}
    label(client, kind='trend', label='bad', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': 'bad', 'note': ''}}, 'bars': {}}
    # Clearing one kind leaves the other alone, and clearing both drops the key from the answer.
    label(client, kind='order', label='clear', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': None, 'note': ''}}, 'bars': {}}
    label(client, kind='trend', label='clear', note='')
    assert labels(client).json() == {'labels': {}, 'bars': {}}
    # A clear is kept as a row too, so the file shows who un-marked what.
    assert [(row['kind'], row['label']) for row in rows(project)][-2:] == [('order', 'clear'), ('trend', 'clear')]


def test_a_note_is_its_own_row(client, project):
    label(client, kind='trend', label='good', note='')
    # kind=note needs no label: it only records the text.
    assert label(client, kind='note', note='趋势对，挂单太远', label=None).status_code == 200
    saved = rows(project)[-1]
    assert saved['kind'] == 'note' and saved['note'] == '趋势对，挂单太远' and 'label' not in saved
    assert labels(client).json() == {'labels': {KEY: {'trend': 'good', 'order': None, 'note': '趋势对，挂单太远'}}, 'bars': {}}
    # An empty note is the explicit "clear the note" row; the marks stay.
    assert label(client, kind='note', note='', label=None).status_code == 200
    assert labels(client).json() == {'labels': {KEY: {'trend': 'good', 'order': None, 'note': ''}}, 'bars': {}}
    # A note alone still returns the key (no marks, but something to read).
    label(client, kind='trend', label='clear', note='')
    label(client, kind='note', note='只是记一句', label=None)
    assert labels(client).json() == {'labels': {KEY: {'trend': None, 'order': None, 'note': '只是记一句'}}, 'bars': {}}


def test_clearing_a_mark_keeps_the_note(client, project):
    label(client)  # trend good with a note
    label(client, kind='trend', label='clear', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': None, 'order': None, 'note': '回踩到位'}}, 'bars': {}}


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
    assert client.post('/review/labels', json={'symbol': 'DOGE-USDT'}, headers=HEADERS).json() == {'labels': {}, 'bars': {}}


def test_missing_file_reads_as_no_labels(client, project):
    assert labels(client).json() == {'labels': {}, 'bars': {}}
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
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': None, 'note': '旧的标注'}}, 'bars': {}}
    # A new order mark lives next to the old trend mark instead of replacing it.
    label(client, kind='order', label='good', note='')
    assert labels(client).json() == {'labels': {KEY: {'trend': 'bad', 'order': 'good', 'note': '旧的标注'}}, 'bars': {}}
    # Neither the old lines nor the new one is rewritten.
    assert len(rows(project)) == 3


# A candle note: `bar|exchange|symbol|tf|time`, the same exchange / symbol as the signal above, on the 3m chart.
BAR_KEY = 'bar|Binance Perpetual Futures|BTC-USDT|3m|1763000000'
BAR = {'open': 64000.0, 'high': 64120.5, 'low': 63900.0, 'close': 64080.0, 'ma5': 64010.2, 'ma10': 63980.4,
       'atr': 120.75, 'bollUpper': 64300.0, 'bollMid': 64000.0, 'bollLower': 63700.0}


def bar_note(client, **overrides):
    body = {'key': BAR_KEY, 'kind': 'bar', 'note': '这里放量但没收上去', 'exchange': 'Binance Perpetual Futures',
            'symbol': 'BTC-USDT', 'tf': '3m', 'time': 1763000000, 'bar': BAR, 'signal': KEY}
    body.update(overrides)
    return client.post('/review/label', json=body, headers=HEADERS)


def test_a_bar_note_is_saved_like_a_note_with_its_candle(client, project):
    assert bar_note(client).status_code == 200
    saved = rows(project)[0]
    assert saved['kind'] == 'bar' and saved['note'] == '这里放量但没收上去'
    assert saved['time'] == 1763000000 and saved['tf'] == '3m'
    assert saved['bar'] == BAR
    # The selected signal is recorded so the reader knows which signal the person was looking at.
    assert saved['signal'] == KEY
    # A bar row carries no good / bad even if a label was sent: it is only the text.
    assert 'label' not in saved


def test_bar_notes_are_returned_separately_and_do_not_mix_into_labels(client, project):
    label(client)
    assert bar_note(client).status_code == 200
    data = labels(client).json()
    assert data['labels'] == {KEY: {'trend': 'good', 'order': None, 'note': '回踩到位'}}
    assert data['bars'] == {BAR_KEY: {'note': '这里放量但没收上去', 'tf': '3m', 'time': 1763000000}}
    # A label sent with kind=bar is ignored, and the bars never show up as signal entries.
    bar_note(client, label='good', note='改一句')
    assert labels(client).json()['labels'] == {KEY: {'trend': 'good', 'order': None, 'note': '回踩到位'}}
    assert labels(client).json()['bars'][BAR_KEY]['note'] == '改一句'


def test_an_empty_bar_note_deletes_it(client, project):
    bar_note(client)
    assert labels(client).json()['bars'][BAR_KEY]['note'] == '这里放量但没收上去'
    assert bar_note(client, note='').status_code == 200
    assert labels(client).json()['bars'] == {}
    # The delete row is kept in the file like every other row, so the history stays readable.
    assert [(row['kind'], row['note']) for row in rows(project)] == [('bar', '这里放量但没收上去'), ('bar', '')]
    # A note that is only whitespace is the same delete.
    bar_note(client)
    bar_note(client, note='   ')
    assert labels(client).json()['bars'] == {}


def test_bar_notes_are_filtered_by_symbol_and_not_by_factor(client, project):
    bar_note(client)
    bar_note(client, key='bar|Binance Perpetual Futures|ETH-USDT|3m|1763000000', symbol='ETH-USDT', note='另一个品种')
    # The factor does not narrow a candle note: the chart belongs to the exchange / symbol, not to a factor run.
    assert list(labels(client, factor='other').json()['bars']) == [BAR_KEY]
    assert list(labels(client).json()['bars']) == [BAR_KEY]
    other = client.post('/review/labels', json={'symbol': 'ETH-USDT'}, headers=HEADERS).json()
    assert list(other['bars']) == ['bar|Binance Perpetual Futures|ETH-USDT|3m|1763000000']
    assert client.post('/review/labels', json={'symbol': 'DOGE-USDT'}, headers=HEADERS).json() == {
        'labels': {}, 'bars': {}}


def test_a_bar_note_belongs_to_its_own_timeframe(client, project):
    bar_note(client)
    bar_note(client, key='bar|Binance Perpetual Futures|BTC-USDT|15m|1763000000', tf='15m', note='15m 的看法')
    bars = labels(client).json()['bars']
    assert sorted(bars) == sorted([BAR_KEY, 'bar|Binance Perpetual Futures|BTC-USDT|15m|1763000000'])
    assert bars[BAR_KEY]['tf'] == '3m'
    assert bars['bar|Binance Perpetual Futures|BTC-USDT|15m|1763000000']['tf'] == '15m'


def test_a_hand_written_bar_row_reads_tf_and_time_from_its_key(client, project):
    write_rows(project, [
        {'key': BAR_KEY, 'kind': 'bar', 'note': '手写的', 'exchange': 'Binance Perpetual Futures',
         'symbol': 'BTC-USDT'},
    ])
    assert labels(client).json()['bars'] == {BAR_KEY: {'note': '手写的', 'tf': '3m', 'time': 1763000000}}


def test_rejects_an_unknown_kind_even_with_a_bar_key(client, project):
    response = bar_note(client, kind='bars')
    assert response.status_code == 400
    assert 'bar' in response.json()['error']
    assert not (project / 'storage' / 'labels' / 'finder-labels.jsonl').exists()
    # kind=bar needs no label.
    assert bar_note(client, label=None).status_code == 200
    # The note is capped like every other note.
    assert bar_note(client, note='n' * 900).status_code == 200
    assert len(rows(project)[-1]['note']) == review_controller.MAX_LABEL_NOTE


# ---- 备注本 (label books) --------------------------------------------------
# The marks of one notebook live in storage/labels/<book>.jsonl. `finder-labels` is the default and the file every
# page wrote before books existed, so nothing old changes; a named book has to be created before anything is written
# into it, which is what keeps a typo from scattering rows into a fresh file.

def create_book(client, name):
    return client.post('/review/label-books/create', json={'name': name}, headers=HEADERS)


def book_file(project, name=review_controller.DEFAULT_BOOK):
    return project / 'storage' / 'labels' / f'{name}.jsonl'


def list_books(client):
    response = client.post('/review/label-books', json={}, headers=HEADERS)
    assert response.status_code == 200
    return response.json()


def test_the_default_book_is_the_file_the_pages_always_wrote(client, project):
    label(client)  # no book at all: an older page / script
    label(client, book='finder-labels')
    assert len(rows(project)) == 2
    # The book is the file name, so it is not stored inside the row (nothing rewrites the old format).
    assert 'book' not in rows(project)[0]
    # Reading without a book reads the same rows as reading the default by name.
    assert labels(client).json() == labels(client, book='finder-labels').json()


def test_a_named_book_keeps_its_rows_apart(client, project):
    assert create_book(client, '趋势实验').json() == {'ok': True, 'name': '趋势实验'}
    assert book_file(project, '趋势实验').read_text(encoding='utf-8') == ''
    label(client, book='趋势实验', note='新的本')
    assert labels(client, book='趋势实验').json()['labels'][KEY]['note'] == '新的本'
    # The default book knows nothing about it, and a row of the default book never shows up in the named one.
    assert labels(client).json() == {'labels': {}, 'bars': {}}
    assert create_book(client, 'candles').status_code == 200
    bar_note(client, book='candles')
    assert list(labels(client, book='candles').json()['bars']) == [BAR_KEY]
    assert labels(client).json()['bars'] == {}
    # Only the rows of the book that was written exist on disk.
    assert [json.loads(line)['note'] for line in book_file(project, '趋势实验').read_text(encoding='utf-8').splitlines()] == ['新的本']
    assert not book_file(project).exists()


def test_a_book_name_is_a_plain_file_name(client, project):
    for name in ('../x', 'a/b', '.', 'a.b', 'a b', '', '   ', 'x' * 41, 'a|b'):
        response = label(client, book=name)
        assert response.status_code == 400, name
        assert '备注本名字' in response.json()['error'], name
    # A 40-character name and a Chinese one are fine (the limit is the server's, and the file stays in the folder).
    long_name = 'x' * 40
    assert create_book(client, long_name).status_code == 200
    assert create_book(client, '中文备注本').status_code == 200
    assert book_file(project, long_name).exists()
    # Nothing above wrote a row, and the bad names never created a file anywhere.
    assert not book_file(project).exists()
    assert sorted(path.name for path in (project / 'storage' / 'labels').iterdir()) == [f'{long_name}.jsonl',
                                                                                       '中文备注本.jsonl']


def test_writing_to_a_missing_book_is_a_404(client, project):
    response = label(client, book='还没建')
    assert response.status_code == 404
    assert response.json()['error'] == '备注本不存在，先新建'
    assert not (project / 'storage' / 'labels').exists()
    # The default book is created by its first write: that is what every page did before books existed.
    assert label(client).status_code == 200
    assert book_file(project).exists()


def test_reading_a_missing_book_is_empty_not_an_error(client, project):
    assert labels(client, book='还没建').json() == {'labels': {}, 'bars': {}}
    assert not (project / 'storage' / 'labels').exists()


def test_label_books_lists_rows_and_the_most_recently_written_first(client, project):
    # Only the default book exists: it is listed even before its first write, so a page always has a book to show.
    assert list_books(client) == {'books': [{'name': 'finder-labels', 'rows': 0, 'updated': 0}],
                                  'default': 'finder-labels'}
    create_book(client, 'old')
    create_book(client, 'new')
    label(client, book='old')
    label(client, book='old')
    label(client, book='new')
    label(client, note='默认本')
    # The mtimes are set by hand: "most recent first" must not depend on how fast the test runs.
    os.utime(book_file(project, 'old'), (1763000000, 1763000000))
    os.utime(book_file(project, 'new'), (1763000300, 1763000300))
    os.utime(book_file(project), (1763000600, 1763000600))
    data = list_books(client)
    assert data['default'] == 'finder-labels'
    assert data['books'] == [
        {'name': 'finder-labels', 'rows': 1, 'updated': 1763000600},
        {'name': 'new', 'rows': 1, 'updated': 1763000300},
        {'name': 'old', 'rows': 2, 'updated': 1763000000},
    ]
    # A hand-copied file the API would refuse is not a book (it cannot be selected, so it must not be listed).
    (project / 'storage' / 'labels' / 'bad name.jsonl').write_text('', encoding='utf-8')
    (project / 'storage' / 'labels' / 'notes.txt').write_text('', encoding='utf-8')
    assert [book['name'] for book in list_books(client)['books']] == ['finder-labels', 'new', 'old']


def test_creating_an_existing_book_is_a_409_and_never_truncates(client, project):
    assert create_book(client, 'dup').status_code == 200
    label(client, book='dup', note='别丢')
    response = create_book(client, 'dup')
    assert response.status_code == 409
    assert '已存在' in response.json()['error']
    # The rows of the book that was already there are untouched.
    assert labels(client, book='dup').json()['labels'][KEY]['note'] == '别丢'
    # The default name can be created too (an explicit empty default book), and is then a duplicate as well.
    assert create_book(client, 'finder-labels').status_code == 200
    assert create_book(client, 'finder-labels').status_code == 409


def test_label_book_endpoints_require_auth(client, project):
    assert client.post('/review/label-books', json={}).status_code == 401
    assert client.post('/review/label-books/create', json={'name': 'x'}).status_code == 401
    assert not (project / 'storage' / 'labels').exists()
