import json
import time
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jesse.controllers import review_controller
from jesse.services import auth

PASSWORD = 'review-prefs-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}
# The keys the pages actually write (settings.mjs, market-data.mjs MARKET_KEYS, labels.mjs, finder-data.mjs).
DISPLAY = 'jesse.review.display.v1'
WATCHLIST = 'jesse.market.watchlist.v1'


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


def save(client, items):
    return client.post('/review/prefs/save', json={'items': items}, headers=HEADERS)


def read(client):
    response = client.post('/review/prefs', json={}, headers=HEADERS)
    assert response.status_code == 200
    return response.json()


def prefs_file(project):
    return project / 'storage' / 'review-prefs.json'


def test_endpoints_require_auth(client, project):
    assert client.post('/review/prefs', json={}).status_code == 401
    assert client.post('/review/prefs/save', json={'items': {DISPLAY: 'x'}}).status_code == 401
    # Nothing was written for an unauthenticated request.
    assert not (project / 'storage').exists()


def test_a_project_that_never_synced_reads_empty(client, project):
    assert read(client) == {'prefs': {}, 'updated': {}}
    # Reading must not create the folder / file: there is nothing to explain to a page that has only local settings.
    assert not (project / 'storage').exists()


def test_saved_keys_are_read_back_with_a_second_stamp(client, project):
    before = int(time.time())
    assert save(client, {DISPLAY: '{"version":1}', WATCHLIST: '[]'}).json() == {'ok': True, 'saved': 2, 'removed': 0}
    data = read(client)
    assert data['prefs'] == {DISPLAY: '{"version":1}', WATCHLIST: '[]'}
    # `updated` is seconds since the epoch (the unit every timestamp of these pages uses), not ISO and not millis.
    assert set(data['updated']) == {DISPLAY, WATCHLIST}
    for stamp in data['updated'].values():
        assert isinstance(stamp, int) and before - 5 <= stamp <= int(time.time()) + 5
    # The value is stored verbatim (it is the page's own serialised JSON), so reading it back is lossless.
    assert json.loads(data['prefs'][DISPLAY]) == {'version': 1}


def test_null_deletes_one_key_and_keeps_the_others(client, project):
    save(client, {DISPLAY: 'a', WATCHLIST: 'b'})
    assert save(client, {DISPLAY: None}).json() == {'ok': True, 'saved': 0, 'removed': 1}
    assert read(client)['prefs'] == {WATCHLIST: 'b'}
    # Deleting a key that is not there (another tab already deleted it) is not an error and does not write a file.
    assert save(client, {DISPLAY: None}).json() == {'ok': True, 'saved': 0, 'removed': 0}
    # One batch can write one key and forget another.
    assert save(client, {DISPLAY: 'c', WATCHLIST: None}).json() == {'ok': True, 'saved': 1, 'removed': 1}
    assert read(client)['prefs'] == {DISPLAY: 'c'}


def test_saving_one_key_replaces_only_that_key(client, project):
    save(client, {DISPLAY: 'old', WATCHLIST: '["BTCUSDT"]'})
    save(client, {WATCHLIST: '["ETHUSDT"]'})
    assert read(client)['prefs'] == {DISPLAY: 'old', WATCHLIST: '["ETHUSDT"]'}


def test_rejects_keys_that_are_not_jesse_page_settings(client, project):
    for key in ('main', 'jesse/../x', 'jesse.../../etc/passwd', '', 'jesse.', 'jesse .a', 'Jesse.a', 'x' + DISPLAY,
                'jesse.' + 'x' * 81, 'jesse.a b'):
        response = save(client, {key: 'v'})
        assert response.status_code == 400, key
        assert '设置名不合法' in response.json()['error'], key
    # A rejected batch writes nothing at all (not even its valid keys).
    assert not prefs_file(project).exists()
    # The length limit is the server's 80 characters after the prefix; the longest allowed key is a real key.
    longest = 'jesse.' + 'x' * 80
    assert save(client, {longest: 'v'}).status_code == 200
    assert read(client)['prefs'] == {longest: 'v'}


def test_rejects_a_value_that_is_not_a_string_or_too_large(client, project):
    response = save(client, {DISPLAY: 5})
    assert response.status_code == 400
    assert '字符串' in response.json()['error']
    # The limit is 256 KB of UTF-8: an ASCII value of exactly the limit fits, one byte more does not.
    limit = review_controller.MAX_PREF_VALUE_BYTES
    assert save(client, {DISPLAY: 'x' * limit}).status_code == 200
    response = save(client, {DISPLAY: 'x' * (limit + 1)})
    assert response.status_code == 400
    assert '太大' in response.json()['error']
    # A Chinese character is three bytes: 90 000 of them already exceed the limit while being fewer than 262 144
    # characters, which is why the check counts bytes.
    assert save(client, {WATCHLIST: '字' * (limit // 3 + 1)}).status_code == 400
    # The refused batches did not touch the file: the first (allowed) value is still there.
    assert len(read(client)['prefs'][DISPLAY]) == limit


def test_rejects_a_batch_above_fifty_items(client, project):
    too_many = {f'jesse.k{index}': 'v' for index in range(review_controller.MAX_PREF_ITEMS + 1)}
    response = save(client, too_many)
    assert response.status_code == 400
    assert '最多' in response.json()['error']
    assert not prefs_file(project).exists()
    exact = {f'jesse.k{index}': 'v' for index in range(review_controller.MAX_PREF_ITEMS)}
    assert save(client, exact).status_code == 200
    assert len(read(client)['prefs']) == review_controller.MAX_PREF_ITEMS


def test_the_file_is_replaced_atomically_and_holds_plain_json(client, project):
    save(client, {DISPLAY: '{"periods":[5,7]}', WATCHLIST: '["BTCUSDT"]'})
    path = prefs_file(project)
    assert path.exists()
    # The stored shape: {key: {value, updated}} — what a reader (Claude, a script) finds on disk.
    stored = json.loads(path.read_text(encoding='utf-8'))
    assert set(stored) == {DISPLAY, WATCHLIST}
    assert stored[DISPLAY]['value'] == '{"periods":[5,7]}'
    assert isinstance(stored[DISPLAY]['updated'], int)
    # Rewriting goes through a temp file + os.replace: after a successful save the folder holds the file only (no
    # half-written or leftover .tmp files).
    save(client, {DISPLAY: 'changed'})
    folder = project / 'storage'
    assert sorted(item.name for item in folder.iterdir()) == ['review-prefs.json']
    assert json.loads(path.read_text(encoding='utf-8'))[DISPLAY]['value'] == 'changed'


def test_a_hand_edited_file_reads_as_what_it_can_and_never_raises(client, project):
    folder = project / 'storage'
    folder.mkdir()
    path = prefs_file(project)
    # Broken JSON: the pages get an empty answer instead of a 500 (and the next save rewrites the file).
    path.write_text('{not json', encoding='utf-8')
    assert read(client) == {'prefs': {}, 'updated': {}}
    # A hand-written file: keys the API would refuse, a value that is not a string, an entry of the wrong shape are
    # dropped, the usable entry is returned.
    path.write_text(json.dumps({
        'main': {'value': 'secret', 'updated': 1},
        DISPLAY: {'value': '{"version":1}', 'updated': 1763000000},
        'jesse.wrong': {'value': 5, 'updated': 1},
        'jesse.shape': 'not an object',
        'jesse.nostamp': {'value': 'v'},
    }, ensure_ascii=False), encoding='utf-8')
    data = read(client)
    assert data['prefs'] == {DISPLAY: '{"version":1}', 'jesse.nostamp': 'v'}
    # An entry without a stamp is usable but unknown, so its stamp is 0 rather than missing.
    assert data['updated'] == {DISPLAY: 1763000000, 'jesse.nostamp': 0}
    # Saving keeps the usable entries and drops nothing else.
    save(client, {WATCHLIST: '[]'})
    assert read(client)['prefs'] == {DISPLAY: '{"version":1}', 'jesse.nostamp': 'v', WATCHLIST: '[]'}
