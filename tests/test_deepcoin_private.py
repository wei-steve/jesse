"""The owner's private Deepcoin fills (T-59), with fake credentials and fake answers only: no network, no real key.

Every value below is invented (`test-key-0000` …). The fake `.env.deepcoin` lives in a tmp_path the test chdirs into,
so nothing here reads the project's own file, and the tests that check "the secret never leaks" assert on these fake
strings.
"""
import base64
import hashlib
import hmac
import json
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jesse.controllers import review_controller
from jesse.services import auth, deepcoin_private

PASSWORD = 'review-fills-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}

KEY = 'test-key-0000'
SECRET = 'test-secret-1111'
PASSPHRASE = 'test-passphrase-2222'
SECRETS = (KEY, SECRET, PASSPHRASE)

# Two fills of one order in the same candle, one of another instrument, one of another day, and one broken row — the
# shape the venue's `data` array has (every number a string).
FILLS = [
    {'instType': 'SWAP', 'instId': 'BTC-USDT-SWAP', 'tradeId': '9002', 'ordId': '7001', 'billId': '8002',
     'fillPx': '64320.5', 'fillSz': '200', 'side': 'buy', 'posSide': 'long', 'execType': 'T',
     'feeCcy': 'USDT', 'fee': '0.08', 'ts': '1794839850000'},
    {'instType': 'SWAP', 'instId': 'BTC-USDT-SWAP', 'tradeId': '9001', 'ordId': '7001', 'billId': '8001',
     'fillPx': '64320', 'fillSz': '100', 'side': 'buy', 'posSide': 'long', 'execType': 'T',
     'feeCcy': 'USDT', 'fee': '0.04', 'ts': '1794839700000'},
    {'instType': 'SWAP', 'instId': 'ETH-USDT-SWAP', 'tradeId': '9101', 'ordId': '7101', 'billId': '8101',
     'fillPx': '1800', 'fillSz': '1', 'side': 'sell', 'posSide': 'long', 'execType': 'M',
     'feeCcy': 'USDT', 'fee': '0.01', 'ts': '1794839700000'},
    {'instType': 'SWAP', 'instId': 'BTC-USDT-SWAP', 'tradeId': '9003', 'ordId': '7002', 'billId': '8003',
     'fillPx': '65000', 'fillSz': '50', 'side': 'sell', 'posSide': 'short', 'execType': 'T',
     'feeCcy': 'USDT', 'fee': '0.02', 'ts': '1794750000000'},
    {'instType': 'SWAP', 'instId': 'BTC-USDT-SWAP', 'tradeId': '9004', 'billId': '8004',
     'fillPx': 'not-a-price', 'fillSz': '1', 'side': 'buy', 'posSide': '', 'ts': '1794839700000'},
]


@pytest.fixture(autouse=True)
def empty_cache():
    """Every test starts without a cached answer (the cache is process-wide)."""
    deepcoin_private.clear_cache()
    yield
    deepcoin_private.clear_cache()


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project folder the module reads `.env.deepcoin` from (its cwd). No file unless the test writes one."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


def write_env(folder, **values):
    """Write the fake `.env.deepcoin` of a test (the real one is never touched)."""
    lines = [f'{name}={value}' for name, value in values.items()]
    (folder / deepcoin_private.ENV_FILE).write_text('\n'.join(lines) + '\n', encoding='utf-8')


@pytest.fixture
def configured(project):
    write_env(project, DEEPCOIN_API_KEY=KEY, DEEPCOIN_API_SECRET=SECRET, DEEPCOIN_API_PASSPHRASE=PASSPHRASE)
    return project


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(auth.ENV_VALUES, 'PASSWORD', PASSWORD)
    app = FastAPI()

    @app.exception_handler(auth.InvalidAuthError)
    async def invalid_auth_handler(_request, _exc):
        return auth.unauthorized_response()

    app.include_router(review_controller.router)
    return TestClient(app)


def ask(client, **body):
    payload = {'market': 'swap', 'symbol': 'BTC-USDT', 'begin': 1794835200}
    payload.update(body)
    return client.post('/review/market/fills', json=payload, headers=HEADERS)


class FakeResponse:
    """What requests.get() answers, without a socket."""

    def __init__(self, status, payload):
        self.status_code = status
        self.ok = status == 200
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


# --- The env file -------------------------------------------------------------------------------------------------

def test_the_env_file_is_read_like_a_person_types_it():
    text = (
        '# Deepcoin API: fill the three values in\n'
        '\n'
        '  DEEPCOIN_API_KEY = "quoted-key"  \n'
        "DEEPCOIN_API_SECRET='quoted-secret'\n"
        'DEEPCOIN_API_PASSPHRASE= pass-with-a#hash\n'
        'NOT_THE_VENUE=ignored\n'
        'this line has no equals sign\n'
        '=empty-key\n'
    )
    values = deepcoin_private.parse_env(text)
    assert values['DEEPCOIN_API_KEY'] == 'quoted-key'
    assert values['DEEPCOIN_API_SECRET'] == 'quoted-secret'
    # An inline '#' belongs to the value: only a whole-line '#' is a comment.
    assert values['DEEPCOIN_API_PASSPHRASE'] == 'pass-with-a#hash'
    assert values['NOT_THE_VENUE'] == 'ignored'
    assert '' not in values
    assert deepcoin_private.parse_env(None) == {}


def test_a_missing_or_incomplete_env_file_means_unconfigured(project):
    assert deepcoin_private.read_credentials() is None
    assert deepcoin_private.is_configured() is False
    # Two of the three is not configured: an empty value counts as missing.
    write_env(project, DEEPCOIN_API_KEY=KEY, DEEPCOIN_API_SECRET=SECRET)
    assert deepcoin_private.read_credentials() is None
    write_env(project, DEEPCOIN_API_KEY=KEY, DEEPCOIN_API_SECRET=SECRET, DEEPCOIN_API_PASSPHRASE='')
    assert deepcoin_private.read_credentials() is None
    write_env(project, DEEPCOIN_API_KEY=KEY, DEEPCOIN_API_SECRET=SECRET, DEEPCOIN_API_PASSPHRASE='""')
    assert deepcoin_private.read_credentials() is None


def test_the_three_values_are_read_from_the_cwd_on_every_call(configured):
    credentials = deepcoin_private.read_credentials()
    assert credentials == {'DEEPCOIN_API_KEY': KEY, 'DEEPCOIN_API_SECRET': SECRET,
                           'DEEPCOIN_API_PASSPHRASE': PASSPHRASE}
    assert deepcoin_private.is_configured() is True
    # Nothing was exported into the environment: the values only exist for the length of one call.
    import os
    assert 'DEEPCOIN_API_KEY' not in os.environ
    # Filling the file in later works without a restart: the next call reads the new values.
    write_env(configured, DEEPCOIN_API_KEY='test-key-9999', DEEPCOIN_API_SECRET=SECRET,
              DEEPCOIN_API_PASSPHRASE=PASSPHRASE)
    assert deepcoin_private.read_credentials()['DEEPCOIN_API_KEY'] == 'test-key-9999'


# --- Signing ------------------------------------------------------------------------------------------------------

def expected_signature(secret, timestamp, request_path, body=''):
    message = f'{timestamp}GET{request_path}{body}'.encode('utf-8')
    return base64.b64encode(hmac.new(secret.encode('utf-8'), message, hashlib.sha256).digest()).decode('ascii')


def test_the_signature_is_the_documented_base64_hmac_of_the_request():
    timestamp = '2020-12-08T09:08:57.715Z'
    path = '/deepcoin/trade/fills?instType=SWAP&instId=BTC-USDT-SWAP&limit=100'
    assert deepcoin_private.sign(SECRET, timestamp, 'GET', path) == expected_signature(SECRET, timestamp, path)
    # A fixed vector, computed once by hand from the formula (so a refactor cannot quietly change the message order).
    assert deepcoin_private.sign('secret', '2020-12-08T09:08:57.715Z', 'GET', '/deepcoin/trade/fills?limit=100') == \
        'muY9Hd4E/yaEpJUJi3cJ/1UO4RM4EWtzo3YsS4tM48U='
    # The query string and the method are part of the message: neither can be changed after signing.
    assert deepcoin_private.sign(SECRET, timestamp, 'GET', path) != \
        deepcoin_private.sign(SECRET, timestamp, 'POST', path)
    assert deepcoin_private.sign(SECRET, timestamp, 'GET', path) != \
        deepcoin_private.sign(SECRET, timestamp, 'GET', '/deepcoin/trade/fills')
    assert deepcoin_private.sign(SECRET, timestamp, 'GET', path, '{}') != \
        deepcoin_private.sign(SECRET, timestamp, 'GET', path)


def test_the_timestamp_is_iso_utc_with_milliseconds():
    assert deepcoin_private.timestamp_text(1607418537715) == '2020-12-08T09:08:57.715Z'
    assert deepcoin_private.timestamp_text(1607418537001) == '2020-12-08T09:08:57.001Z'


# --- The request --------------------------------------------------------------------------------------------------

def test_swap_maps_to_the_perpetual_and_spot_to_the_pair():
    swap = deepcoin_private.resolve_request('swap', 'btc-usdt', 1794835200)
    assert swap == {'market': 'swap', 'instType': 'SWAP', 'symbol': 'BTC-USDT', 'instId': 'BTC-USDT-SWAP',
                    'begin': 1794835200, 'end': None}
    spot = deepcoin_private.resolve_request('spot', 'BTC-USDT', 1794835200, 1794841200)
    assert spot['instType'] == 'SPOT' and spot['instId'] == 'BTC-USDT' and spot['end'] == 1794841200
    # The page may name the perpetual itself; the market still decides.
    assert deepcoin_private.resolve_request('swap', 'BTC-USDT-SWAP', '1794835200')['instId'] == 'BTC-USDT-SWAP'


def test_anything_outside_the_whitelist_is_a_readable_400():
    cases = [
        {'market': 'margin', 'symbol': 'BTC-USDT', 'begin': 1794835200},
        {'market': 'swap', 'symbol': 'BTCUSD', 'begin': 1794835200},
        {'market': 'swap', 'symbol': '', 'begin': 1794835200},
        {'market': 'swap', 'symbol': 'btc/usdt/swap', 'begin': 1794835200},
        {'market': 'swap', 'symbol': 'BTC-USDT', 'begin': 0},
        {'market': 'swap', 'symbol': 'BTC-USDT', 'begin': -60},
        {'market': 'swap', 'symbol': 'BTC-USDT', 'begin': 'yesterday'},
        {'market': 'swap', 'symbol': 'BTC-USDT', 'begin': True},
        {'market': 'swap', 'symbol': 'BTC-USDT', 'begin': 1794835200, 'end': 1794835100},
    ]
    for case in cases:
        with pytest.raises(deepcoin_private.DeepcoinError) as error:
            deepcoin_private.resolve_request(**case)
        assert error.value.status_code == 400, case
        assert any(word in str(error.value) for word in ('只能', '不支持', '必须', '不能')), str(error.value)


def test_the_first_page_carries_the_window_and_older_pages_only_the_cursor():
    first = deepcoin_private.fills_query('SWAP', 'BTC-USDT-SWAP', 1794835200, 1794841200)
    assert first == 'instType=SWAP&instId=BTC-USDT-SWAP&begin=1794835200000&end=1794841200000&limit=100'
    older = deepcoin_private.fills_query('SWAP', 'BTC-USDT-SWAP', 1794835200, 1794841200, older_than='7999001')
    # The cursor alone (sent as `after`, the venue's real older-page parameter): it never has to combine it with the window (the window is enforced locally).
    assert older == 'instType=SWAP&instId=BTC-USDT-SWAP&after=7999001&limit=100'


def test_one_page_goes_out_signed_with_the_query_in_the_signed_path(monkeypatch):
    seen = []

    def fake_get(url, headers=None, timeout=None):
        seen.append((url, dict(headers or {}), timeout))
        return FakeResponse(200, {'code': '0', 'msg': '', 'data': FILLS})

    credentials = {'DEEPCOIN_API_KEY': KEY, 'DEEPCOIN_API_SECRET': SECRET, 'DEEPCOIN_API_PASSPHRASE': PASSPHRASE}
    monkeypatch.setattr(deepcoin_private.requests, 'get', fake_get)
    query = deepcoin_private.fills_query('SWAP', 'BTC-USDT-SWAP', 1794835200)
    rows = deepcoin_private.fetch_page(credentials, query)
    assert rows == FILLS
    assert len(seen) == 1
    url, headers, timeout = seen[0]
    assert timeout == deepcoin_private.TIMEOUT == 10
    path = url[len(deepcoin_private.BASE):]
    assert path == f'/deepcoin/trade/fills?{query}'
    assert headers['DC-ACCESS-KEY'] == KEY
    assert headers['DC-ACCESS-PASSPHRASE'] == PASSPHRASE
    assert headers['Content-Type'] == 'application/json'
    assert headers['DC-ACCESS-SIGN'] == expected_signature(SECRET, headers['DC-ACCESS-TIMESTAMP'], path)
    # Signing the bare path (without the query) would be a different signature: the query really is in the message.
    assert headers['DC-ACCESS-SIGN'] != \
        expected_signature(SECRET, headers['DC-ACCESS-TIMESTAMP'], '/deepcoin/trade/fills')


# --- Parsing ------------------------------------------------------------------------------------------------------

def test_only_sane_fills_of_that_instrument_inside_the_window_survive():
    fills = deepcoin_private.parse_fills(FILLS, 'BTC-USDT-SWAP', 1794835200, 1794841200)
    # The ETH row is another instrument, the broken row has no price, the 1794750000 fill is before `begin`.
    assert [fill['tradeId'] for fill in fills] == ['9001', '9002']
    assert fills[0] == {'time': 1794839700, 'price': 64320.0, 'size': 100.0, 'side': 'buy', 'posSide': 'long',
                        'execType': 'T', 'fee': 0.04, 'feeCcy': 'USDT', 'ordId': '7001', 'tradeId': '9001'}
    # Newest first in, oldest first out; one row per trade id.
    assert fills == sorted(fills, key=lambda fill: fill['time'])
    assert deepcoin_private.parse_fills([FILLS[0], FILLS[0]], 'BTC-USDT-SWAP') == \
        deepcoin_private.parse_fills([FILLS[0]], 'BTC-USDT-SWAP')


def test_a_fill_without_pos_side_keeps_an_empty_one_and_broken_rows_are_dropped():
    rows = [
        {'instId': 'BTC-USDT', 'tradeId': '1', 'fillPx': '10', 'fillSz': '2', 'side': 'buy', 'posSide': '',
         'fee': None, 'ts': '1794839700000'},
        {'instId': 'BTC-USDT', 'tradeId': '2', 'fillPx': '10', 'fillSz': '2', 'side': 'hold', 'ts': '1794839700000'},
        {'instId': 'BTC-USDT', 'tradeId': '3', 'fillPx': None, 'fillSz': '2', 'side': 'buy', 'ts': '1794839700000'},
        None, 'nope',
    ]
    fills = deepcoin_private.parse_fills(rows, 'BTC-USDT')
    assert len(fills) == 1
    assert fills[0]['posSide'] == '' and fills[0]['fee'] == 0.0
    for broken in [None, {}, 'nope', [[]]]:
        assert deepcoin_private.parse_fills(broken) == []


# --- Paging -------------------------------------------------------------------------------------------------------

def page(count, oldest_bill, oldest_ts, inst_id='BTC-USDT-SWAP'):
    """One page of `count` fake fills whose oldest row is at `oldest_ts` with bill `oldest_bill`."""
    return [{'instId': inst_id, 'tradeId': f'{oldest_bill}-{index}', 'billId': str(int(oldest_bill) - index),
             'ordId': '1', 'fillPx': '64000', 'fillSz': '1', 'side': 'buy', 'posSide': 'long',
             'execType': 'T', 'feeCcy': 'USDT', 'fee': '0.01',
             'ts': str(oldest_ts - index * 1000)}
            for index in range(count)]


def test_paging_stops_on_a_short_page(monkeypatch):
    queries = []

    def fake_page(credentials, query):
        queries.append(query)
        return page(3, oldest_bill=8000, oldest_ts=1794839700000)

    monkeypatch.setattr(deepcoin_private, 'fetch_page', fake_page)
    fills = deepcoin_private.fetch_fills(deepcoin_private.resolve_request('swap', 'BTC-USDT', 1794835200),
                                         {'DEEPCOIN_API_KEY': KEY})
    assert len(queries) == 1
    assert 'begin=1794835200000' in queries[0]
    assert len(fills) == 3


def test_paging_follows_the_oldest_bill_id_until_the_page_reaches_past_begin(monkeypatch):
    queries = []

    def fake_page(credentials, query):
        queries.append(query)
        if len(queries) == 1:
            return page(100, oldest_bill=8000, oldest_ts=1794839700000)
        # A page that already runs past `begin` (1794835200): the older fills could not be drawn anyway.
        return page(100, oldest_bill=7300, oldest_ts=1794835100000)

    monkeypatch.setattr(deepcoin_private, 'fetch_page', fake_page)
    deepcoin_private.fetch_fills(deepcoin_private.resolve_request('swap', 'BTC-USDT', 1794835200), {'KEY': KEY})
    assert len(queries) == 2
    # The second page asks for what is older than the oldest bill of the first, and only that.
    assert 'after=7901' in queries[1] and 'begin=' not in queries[1] and 'end=' not in queries[1]


def test_paging_never_runs_more_than_max_pages(monkeypatch):
    queries = []

    def fake_page(credentials, query):
        queries.append(query)
        # Always a full page that stays inside the window: only MAX_PAGES ends this.
        return page(100, oldest_bill=100000 - len(queries) * 100, oldest_ts=1794839000000)

    monkeypatch.setattr(deepcoin_private, 'fetch_page', fake_page)
    deepcoin_private.fetch_fills(deepcoin_private.resolve_request('swap', 'BTC-USDT', 1794835200), {'KEY': KEY})
    assert len(queries) == deepcoin_private.MAX_PAGES == 20


def test_paging_stops_when_the_cursor_cannot_move(monkeypatch):
    queries = []

    def fake_page(credentials, query):
        queries.append(query)
        # A full page without bill ids: there is nothing to page from, so asking again would repeat the same page.
        return page(100, oldest_bill=8000, oldest_ts=1794839000000) if len(queries) == 1 else \
            [dict(row, billId='') for row in page(100, oldest_bill=8000, oldest_ts=1794839000000)]

    monkeypatch.setattr(deepcoin_private, 'fetch_page', fake_page)
    deepcoin_private.fetch_fills(deepcoin_private.resolve_request('swap', 'BTC-USDT', 1794835200), {'KEY': KEY})
    assert len(queries) == 2


def test_the_oldest_bill_of_a_page_is_its_smallest_id():
    assert deepcoin_private.page_oldest_bill([{'billId': '8002'}, {'billId': '8000'}, {'billId': '8001'}]) == '8000'
    assert deepcoin_private.page_oldest_bill([{'billId': 'a'}, {'billId': 'b'}]) == 'b'
    assert deepcoin_private.page_oldest_bill([{}, None, 'nope']) is None
    assert deepcoin_private.page_oldest_time([{'ts': '1794839700000'}, {'ts': '1794839000000'}]) == 1794839000000
    assert deepcoin_private.page_oldest_time([]) is None


# --- Errors -------------------------------------------------------------------------------------------------------

def test_an_upstream_error_names_the_code_and_the_message_but_never_a_credential(monkeypatch):
    credentials = {'DEEPCOIN_API_KEY': KEY, 'DEEPCOIN_API_SECRET': SECRET, 'DEEPCOIN_API_PASSPHRASE': PASSPHRASE}
    # The venue's own message quotes back everything it was sent: the scrub is what keeps the key out of the page.
    monkeypatch.setattr(deepcoin_private.requests, 'get',
                        lambda url, headers=None, timeout=None: FakeResponse(200, {
                            'code': '40004', 'msg': f'bad passphrase {PASSPHRASE} for key {KEY} ({SECRET})',
                            'data': None}))
    with pytest.raises(deepcoin_private.DeepcoinError) as error:
        deepcoin_private.fetch_page(credentials, 'instType=SWAP&instId=BTC-USDT-SWAP&limit=100')
    message = str(error.value)
    assert error.value.status_code == 502
    assert 'Deepcoin 返回错误：40004' in message and 'bad passphrase' in message
    for secret in SECRETS:
        assert secret not in message


def test_a_transport_failure_is_a_502_that_carries_no_request_text(monkeypatch):
    import requests as requests_module

    def timeout(url, headers=None, timeout=None):
        raise requests_module.Timeout('https://api.deepcoin.com/deepcoin/trade/fills?key=' + KEY)

    monkeypatch.setattr(deepcoin_private.requests, 'get', timeout)
    with pytest.raises(deepcoin_private.DeepcoinError) as error:
        deepcoin_private.fetch_page({'DEEPCOIN_API_KEY': KEY, 'DEEPCOIN_API_SECRET': SECRET,
                                     'DEEPCOIN_API_PASSPHRASE': PASSPHRASE}, 'limit=100')
    assert error.value.status_code == 502
    for secret in SECRETS:
        assert secret not in str(error.value)


def test_a_refused_key_is_explained_without_echoing_it(monkeypatch):
    monkeypatch.setattr(deepcoin_private.requests, 'get',
                        lambda url, headers=None, timeout=None: FakeResponse(403, {}))
    with pytest.raises(deepcoin_private.DeepcoinError) as error:
        deepcoin_private.fetch_page({'DEEPCOIN_API_KEY': KEY, 'DEEPCOIN_API_SECRET': SECRET,
                                     'DEEPCOIN_API_PASSPHRASE': PASSPHRASE}, 'limit=100')
    assert error.value.status_code == 502 and '403' in str(error.value)
    assert any(word in str(error.value) for word in ('检查', 'API 密钥'))
    for secret in SECRETS:
        assert secret not in str(error.value)


# --- The route ----------------------------------------------------------------------------------------------------

def test_the_route_requires_auth(client, project):
    assert client.post('/review/market/fills',
                       json={'market': 'swap', 'symbol': 'BTC-USDT', 'begin': 1794835200}).status_code == 401


def test_an_unconfigured_project_answers_configured_false_without_a_request(client, project, monkeypatch):
    def never(*_args, **_kwargs):
        raise AssertionError('an unconfigured project must not reach the venue')

    monkeypatch.setattr(deepcoin_private.requests, 'get', never)
    response = ask(client)
    assert response.status_code == 200
    assert response.json() == {'configured': False, 'fills': []}
    # A whitelist failure is still a 400, configured or not.
    assert ask(client, symbol='BTCUSD').status_code == 400


def test_the_route_returns_the_fills_of_the_whitelisted_instrument(client, configured, monkeypatch):
    calls = []

    def fake_fills(request, credentials):
        calls.append((request, credentials))
        return deepcoin_private.parse_fills(FILLS, request['instId'], request['begin'], request['end'])

    monkeypatch.setattr(deepcoin_private, 'fetch_fills', fake_fills)
    response = ask(client, begin=1794835200, end=1794841200)
    assert response.status_code == 200
    body = response.json()
    assert body['configured'] is True
    assert [fill['tradeId'] for fill in body['fills']] == ['9001', '9002']
    assert body['market'] == 'swap' and body['symbol'] == 'BTC-USDT'
    assert body['cached'] is False and body['fetched_at'] > 0
    request, credentials = calls[0]
    assert request['instId'] == 'BTC-USDT-SWAP' and request['instType'] == 'SWAP'
    assert credentials['DEEPCOIN_API_KEY'] == KEY
    # The answer is JSON-serialisable as sent and carries no credential anywhere.
    assert json.loads(json.dumps(body)) == body
    for secret in SECRETS:
        assert secret not in json.dumps(body, ensure_ascii=False)
    # The same window within 15 seconds is one request (the page polls every 30 seconds, two tabs poll together).
    second = ask(client, begin=1794835200, end=1794841200)
    assert second.json()['cached'] is True and len(calls) == 1
    # Another window / market is another key.
    assert ask(client, begin=1794835200, end=1794841200, market='spot', symbol='BTC-USDT').status_code == 200
    assert len(calls) == 2


def test_a_venue_error_is_a_502_with_a_chinese_reason_and_no_credential(client, configured, monkeypatch):
    def failing(*_args, **_kwargs):
        raise deepcoin_private.DeepcoinError('Deepcoin 返回错误：40004 bad passphrase', status_code=502)

    monkeypatch.setattr(deepcoin_private, 'fetch_fills', failing)
    response = ask(client)
    assert response.status_code == 502
    error = response.json()['error']
    assert 'Deepcoin 返回错误：40004' in error
    for secret in SECRETS:
        assert secret not in error


def test_a_missing_login_token_never_reaches_the_venue(client, configured):
    # The page always sends the dashboard token; the route is behind require_auth like every other review endpoint.
    response = client.post('/review/market/fills', json={'market': 'swap', 'symbol': 'BTC-USDT',
                                                         'begin': 1794835200})
    assert response.status_code == 401
