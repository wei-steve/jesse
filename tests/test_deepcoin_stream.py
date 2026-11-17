"""The private Deepcoin push of the owner's own fills (T-63), with fake keys, fake frames and a fake socket only.

Every value here is invented (`test-key-0000` …) and every fill is generated, so nothing is a real trade, a real account
or a real listenKey. No socket is opened: `FakeSocket` scripts the frames a connection would receive, `FakeStop` stands
in for the worker's `threading.Event` (its `wait` records the backoff instead of sleeping), and the clock of the
idle / rotation tests is a counter. The store (when a test needs one) lives in a tmp_path the test chdirs into.

The last group drives the routes through a FastAPI app with the review router and the usual password header, so the
long poll's 25-second limit is tested with a fake clock too (the real route would hold the test for 25 seconds).
"""
import asyncio
import json
from pathlib import Path
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from websocket import WebSocketTimeoutException

from jesse.controllers import review_controller
from jesse.services import auth, deepcoin_private, deepcoin_stream

PASSWORD = 'review-stream-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}

KEY = 'test-key-0000'
SECRET = 'test-secret-1111'
PASSPHRASE = 'test-passphrase-2222'
SECRETS = (KEY, SECRET, PASSPHRASE)
CREDENTIALS = {'DEEPCOIN_API_KEY': KEY, 'DEEPCOIN_API_SECRET': SECRET, 'DEEPCOIN_API_PASSPHRASE': PASSPHRASE}
LISTEN_KEY = 'test-listen-key-3333'
INST = 'BTC-USDT-SWAP'

# One Trade row as the venue pushes it (every number a string) and one REST row of the same fill, so the two views can be
# compared: `TI` is the venue's trade number, `tradeId` the REST endpoint's id of the same fill.
TRADE_ROW = {'I': 'BTCUSDT', 'D': '0', 'o': '0', 'p': '0', 'P': '64320.5', 'V': '2', 'TT': '1794839700000',
             'F': '0.01', 'f': 'USDT', 'm': '1', 'OS': '7001', 'TI': '9001'}
REST_FILL = {'time': 1794839700, 'price': 64320.5, 'size': 2.0, 'side': 'buy', 'posSide': 'long', 'execType': 'T',
             'fee': 0.01, 'feeCcy': 'USDT', 'ordId': '7001', 'tradeId': '9001'}


@pytest.fixture(autouse=True)
def clean_stream():
    """Every test starts with an empty realtime layer, no worker and no recent-sync mark (all process-wide)."""
    deepcoin_stream.reset_for_tests()
    deepcoin_private.clear_cache()
    yield
    deepcoin_stream.reset_for_tests()
    deepcoin_private.clear_cache()


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project folder the store and `.env.deepcoin` are read from (its cwd)."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def configured(project):
    """The project with a fake `.env.deepcoin` (the real one is never touched)."""
    lines = [f'{name}={value}' for name, value in CREDENTIALS.items()]
    (project / deepcoin_private.ENV_FILE).write_text('\n'.join(lines) + '\n', encoding='utf-8')
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


# --- Fakes --------------------------------------------------------------------------------------------------------

class FakeResponse:
    """What requests.get() answers, without a socket."""

    def __init__(self, status, payload):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeStop:
    """A `threading.Event` whose `wait` records the backoff instead of blocking the test."""

    def __init__(self):
        self.flag = False
        self.waits = []

    def is_set(self):
        return self.flag

    def set(self):
        self.flag = True

    def wait(self, delay=None):
        self.waits.append(delay)
        return self.flag


class FakeSocket:
    """One scripted private socket: `send` / `ping` are recorded, `recv` replays the script.

    A script item is a message string, an exception instance (raised), or a callable (its result returned).
    """

    def __init__(self, script, stop=None):
        self.script = list(script)
        self.stop = stop
        self.sent, self.pings = [], []
        self.closed = False
        self.timeout = None
        self.url = ''

    def send(self, text):
        self.sent.append(text)

    def ping(self):
        self.pings.append(True)

    def settimeout(self, seconds):
        self.timeout = seconds

    def close(self):
        self.closed = True

    def recv(self):
        if not self.script:
            if self.stop is not None:
                self.stop.set()
            raise ConnectionError('fake socket closed')
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            return item()
        return item


class FakeClock:
    """A monotonic clock the test moves by hand."""

    def __init__(self, start=1000.0):
        self.value = float(start)

    def monotonic(self):
        return self.value

    def advance(self, seconds):
        self.value += float(seconds)
        return self.value


def trade_frame(rows, table='Trade', action='PushTrade'):
    """One pushed frame with `rows` (an object or a list) of `table`."""
    return json.dumps({'action': action, 'result': [{'table': table, 'data': rows}]}, ensure_ascii=False)


def one_fill(**overrides):
    """A parsed pushed fill (the shape the layer and the page use)."""
    row = dict(REST_FILL, tradeId='9001')
    row.update(overrides)
    return row


def store_with(fills, inst_id=INST):
    """A complete store (`history_end`) of `fills`, written where the module reads it (the test's cwd)."""
    store = deepcoin_private.empty_store()
    store['fills'] = sorted(fills, key=lambda fill: fill['time'])
    store['newest_bill'] = '8001'
    store['oldest_bill'] = '8001'
    store['history_end'] = True
    deepcoin_private.write_store(inst_id, store)
    return store


# --- The listenKey ------------------------------------------------------------------------------------------------

def test_the_listen_key_is_read_from_an_object_or_a_one_element_array():
    assert deepcoin_stream.listen_key_of({'code': '0', 'data': {'listenkey': LISTEN_KEY}}) == LISTEN_KEY
    assert deepcoin_stream.listen_key_of({'data': [{'listenkey': 'k1'}]}) == 'k1'
    # The field name is not stable in the docs: both spellings are accepted.
    assert deepcoin_stream.listen_key_of({'data': [{'listenKey': 'k2'}]}) == 'k2'
    assert deepcoin_stream.listen_key_of({'data': {'listenKey': '  k3  '}}) == 'k3'


def test_a_missing_listen_key_is_an_error_that_does_not_echo_the_body():
    for payload in [None, {}, {'data': None}, {'data': []}, {'data': [None]}, {'data': {}}, {'data': {'listenkey': ''}}]:
        with pytest.raises(deepcoin_stream.StreamError) as error:
            deepcoin_stream.listen_key_of(payload)
        assert 'listenKey' in str(error.value)
    # A key the reader cannot use is not printed either: the body is never part of the message.
    with pytest.raises(deepcoin_stream.StreamError) as error:
        deepcoin_stream.listen_key_of({'data': {'unexpected': LISTEN_KEY}})
    assert LISTEN_KEY not in str(error.value)


def test_the_acquire_request_is_signed_like_every_private_get(monkeypatch):
    seen = []

    def fake_get(url, headers=None, timeout=None):
        seen.append((url, dict(headers or {}), timeout))
        return FakeResponse(200, {'code': '0', 'data': {'listenkey': LISTEN_KEY}})

    key = deepcoin_stream.acquire_listen_key(CREDENTIALS, get=fake_get)
    assert key == LISTEN_KEY
    url, headers, timeout = seen[0]
    # No query, no body: the signed path is the bare endpoint.
    assert url == f'{deepcoin_stream.BASE}{deepcoin_stream.LISTENKEY_PATH}' == \
        'https://api.deepcoin.com/deepcoin/listenkey/acquire'
    assert timeout == deepcoin_private.TIMEOUT
    assert headers['DC-ACCESS-KEY'] == KEY and headers['DC-ACCESS-PASSPHRASE'] == PASSPHRASE
    assert headers['DC-ACCESS-SIGN'] == \
        deepcoin_private.sign(SECRET, headers['DC-ACCESS-TIMESTAMP'], 'GET', deepcoin_stream.LISTENKEY_PATH)


def test_a_rate_limited_acquire_waits_a_second_and_retries_twice():
    waits = []
    calls = []

    def limited_then_ok(url, headers=None, timeout=None):
        calls.append(url)
        if len(calls) <= 2:
            return FakeResponse(401, {'code': '50000', 'msg': 'Trigger the api frequency limiting'})
        return FakeResponse(200, {'code': '0', 'data': [{'listenkey': LISTEN_KEY}]})

    assert deepcoin_stream.acquire_listen_key(CREDENTIALS, get=limited_then_ok, wait=waits.append) == LISTEN_KEY
    # Two rate-limited answers, one second apart, then the third attempt succeeds.
    assert waits == [deepcoin_stream.RATE_LIMIT_BACKOFF] * 2 == [1.0, 1.0]
    assert len(calls) == 3

    always = []
    with pytest.raises(deepcoin_stream.StreamError) as error:
        deepcoin_stream.acquire_listen_key(
            CREDENTIALS, get=lambda *a, **k: always.append(1) or FakeResponse(401, {'code': '50000'}),
            wait=lambda seconds: None)
    assert '限流' in str(error.value)
    # Two retries, no endless loop against a limited key.
    assert len(always) == deepcoin_stream.RATE_LIMIT_RETRIES + 1 == 3


def test_a_refused_key_and_an_upstream_message_never_carry_the_key(monkeypatch):
    with pytest.raises(deepcoin_stream.StreamError) as refused:
        deepcoin_stream.acquire_listen_key(CREDENTIALS, get=lambda *a, **k: FakeResponse(401, {'code': '40004'}))
    assert '401' in str(refused.value) and 'API' in str(refused.value)
    with pytest.raises(deepcoin_stream.StreamError) as message:
        deepcoin_stream.acquire_listen_key(CREDENTIALS, get=lambda *a, **k: FakeResponse(200, {
            'code': '40004', 'msg': f'bad passphrase {PASSPHRASE} for key {KEY} ({SECRET})'}))
    assert '40004' in str(message.value)
    for secret in SECRETS:
        assert secret not in str(refused.value)
        assert secret not in str(message.value)


def test_a_lost_connection_is_reported_by_its_type_and_never_by_the_bearer_url(monkeypatch):
    import requests as requests_module

    def timeout(url, headers=None, timeout=None):
        raise requests_module.Timeout(f'https://stream.deepcoin.com/v1/private?listenKey={LISTEN_KEY}')

    with pytest.raises(deepcoin_stream.StreamError) as error:
        deepcoin_stream.acquire_listen_key(CREDENTIALS, get=timeout)
    assert 'Timeout' in str(error.value)
    assert LISTEN_KEY not in str(error.value)


def test_the_private_url_carries_the_key_and_the_subscription_is_only_the_trade_table():
    url = deepcoin_stream.private_url(LISTEN_KEY)
    assert url == f'wss://stream.deepcoin.com/v1/private?listenKey={LISTEN_KEY}'
    assert json.loads(deepcoin_stream.subscribe_frame()) == {'action': 'subscribe', 'tables': ['Trade']}


# --- Trade frames -------------------------------------------------------------------------------------------------

def test_the_four_actions_of_a_trade_frame_become_the_fill_rows_the_page_draws():
    rows = [
        dict(TRADE_ROW, D='0', o='0', p='0', TI='1'),  # 开多
        dict(TRADE_ROW, D='1', o='0', p='1', TI='2'),  # 开空
        dict(TRADE_ROW, D='1', o='5', p='0', TI='3'),  # 平多
        dict(TRADE_ROW, D='0', o='5', p='1', TI='4'),  # 平空
    ]
    fills = deepcoin_stream.trade_fills(json.loads(trade_frame(rows)), now=1794839800)
    assert [(fill['side'], fill['posSide']) for _, fill in fills] == \
        [('buy', 'long'), ('sell', 'short'), ('sell', 'long'), ('buy', 'short')]
    inst_id, fill = fills[0]
    assert inst_id == INST
    # The pushed row keeps the venue's own field meanings: V is in contracts like REST fillSz, m is the role as sent.
    assert fill == {'time': 1794839700, 'price': 64320.5, 'size': 2.0, 'side': 'buy', 'posSide': 'long',
                    'execType': '1', 'fee': 0.01, 'feeCcy': 'USDT', 'ordId': '7001', 'tradeId': '1'}
    # `8` is another kind of close: it is not needed for the mapping (side + posSide decide the action).
    other = deepcoin_stream.trade_fills(json.loads(trade_frame(dict(TRADE_ROW, o='8'))), now=1794839800)
    assert other[0][1]['side'] == 'buy' and other[0][1]['posSide'] == 'long'


def test_a_frame_data_is_an_object_or_an_array_and_other_tables_are_ignored():
    payload = {'result': [
        {'table': 'Trade', 'data': dict(TRADE_ROW, TI='1')},
        {'table': 'Trade', 'data': [dict(TRADE_ROW, TI='2'), dict(TRADE_ROW, TI='3')]},
        {'table': 'Order', 'data': dict(TRADE_ROW, TI='4')},
        {'table': 'Trade'},
        None,
    ]}
    assert [fill['tradeId'] for _, fill in deepcoin_stream.trade_fills(payload, now=1794839800)] == ['1', '2', '3']
    # Text is the only thing the venue sends; a binary frame decodes the same way and junk is skipped.
    assert len(deepcoin_stream.trade_fills(json.loads(trade_frame(dict(TRADE_ROW))))) == 1
    assert deepcoin_stream.decode_frame('not json') is None
    assert deepcoin_stream.decode_frame(b'[]') is None
    assert deepcoin_stream.decode_frame(None) is None
    assert deepcoin_stream.trade_fills(None) == []
    assert deepcoin_stream.trade_fills({'result': 'nope'}) == []


def test_the_trade_time_is_milliseconds_seconds_or_the_local_receive_time():
    assert deepcoin_stream.trade_time('1794839700000', now=1794900000) == 1794839700
    assert deepcoin_stream.trade_time(1794839700, now=1794900000) == 1794839700
    assert deepcoin_stream.trade_time('1794839700.9', now=1794900000) == 1794839700
    # Missing / unreadable / too small to be a stamp: the moment the frame was received, never 1970.
    for value in [None, '', 'soon', 0, -1, 12345, True]:
        assert deepcoin_stream.trade_time(value, now=1794900000) == 1794900000


def test_an_unknown_instrument_or_a_row_without_numbers_is_dropped():
    assert deepcoin_stream.instrument_of('BTCUSDT') == INST
    assert deepcoin_stream.instrument_of('1000PEPEUSDT') == '1000PEPE-USDT-SWAP'
    for code in ['BTCEUR', 'BTC-USDT-SWAP', 'BTCUSDC', '', None, 'btc/usdt']:
        assert deepcoin_stream.instrument_of(code) is None
    bad = [
        dict(TRADE_ROW, I='BTCEUR'),
        dict(TRADE_ROW, P='not-a-price'),
        dict(TRADE_ROW, P='0'),
        dict(TRADE_ROW, V='0'),
        dict(TRADE_ROW, V=None),
        dict(TRADE_ROW, D='2'),
        dict(TRADE_ROW, D=None),
        None,
        'nope',
    ]
    for row in bad:
        assert deepcoin_stream.parse_trade(row, now=1794839800) is None
    # A missing posSide keeps an empty one (a fill whose direction the venue did not push is still drawable).
    inst_id, fill = deepcoin_stream.parse_trade(dict(TRADE_ROW, p=None, F=None, f=None), now=1794839800)
    assert inst_id == INST and fill['posSide'] == '' and fill['fee'] == 0.0 and fill['feeCcy'] == ''


def test_an_expired_key_frame_is_the_rotation_reason():
    assert deepcoin_stream.expired({'code': '50118', 'event': 'error',
                                    'msg': 'listen key expired, connection closing'}) is True
    assert deepcoin_stream.expired({'code': 50118}) is True
    assert deepcoin_stream.expired({'code': '50119'}) is False
    assert deepcoin_stream.expired({'result': []}) is False
    assert deepcoin_stream.expired(None) is False


# --- The realtime layer -------------------------------------------------------------------------------------------

def test_a_pushed_fill_the_rest_store_already_has_is_not_shown_twice():
    store = {'fills': [one_fill(time=1794839700, tradeId='9001')]}
    # Anything at or before the newest stored second is the store's own data (the push and REST are two views of it).
    assert deepcoin_stream.covered_by_store([one_fill(time=1794839700, tradeId='9002')], store) == []
    assert deepcoin_stream.covered_by_store([one_fill(time=1794839600, tradeId='9003')], store) == []
    # The same id, even on a later second (the two ids are not interchangeable, so a match is dropped as well).
    assert deepcoin_stream.covered_by_store([one_fill(time=1794839800, tradeId='9001')], store) == []
    # A genuinely new fill survives; a row without a usable second is dropped instead of raising.
    newer = one_fill(time=1794839800, tradeId='9004')
    assert deepcoin_stream.covered_by_store([newer, {'tradeId': 'x'}, 'nope', None], store) == [newer]
    # An empty store covers nothing, so every pushed fill is shown.
    assert deepcoin_stream.covered_by_store([newer], deepcoin_private.empty_store()) == [newer]


def test_the_realtime_layer_keeps_two_hours_and_two_thousand_fills_per_instrument():
    now = 1794900000
    rows = [{'seq': index, 'at': now, 'fill': one_fill()} for index in range(1, 6)]
    rows.insert(0, {'seq': 0, 'at': now - deepcoin_stream.RETENTION_SECONDS - 1, 'fill': one_fill(time=1)})
    kept = deepcoin_stream.trim_rows(rows, now)
    assert [row['seq'] for row in kept] == [1, 2, 3, 4, 5]
    many = [{'seq': index, 'at': now, 'fill': one_fill()} for index in range(deepcoin_stream.MAX_FILLS + 5)]
    trimmed = deepcoin_stream.trim_rows(many, now)
    assert len(trimmed) == deepcoin_stream.MAX_FILLS
    assert trimmed[0]['seq'] == 5 and trimmed[-1]['seq'] == deepcoin_stream.MAX_FILLS + 4
    # The layer applies the same trim while it fills, so a long session cannot grow without bound.
    for index in range(deepcoin_stream.MAX_FILLS + 3):
        deepcoin_stream.push(INST, one_fill(time=now, tradeId=f'{index}'))
    assert len(deepcoin_stream.realtime_fills(INST)) == deepcoin_stream.MAX_FILLS


def test_every_pushed_fill_takes_the_next_seq_and_a_page_only_gets_its_own_instrument():
    assert deepcoin_stream.seq() == 0
    assert deepcoin_stream.push(INST, one_fill(time=1794839700, tradeId='a')) == 1
    assert deepcoin_stream.push(INST, one_fill(time=1794839710, tradeId='b')) == 2
    assert deepcoin_stream.push('ETH-USDT-SWAP', one_fill(time=1794839720, tradeId='c')) == 3
    assert deepcoin_stream.seq() == 3
    # Asked from the start: both fills of this instrument, oldest first, and only this instrument's.
    assert [fill['tradeId'] for fill in deepcoin_stream.realtime_fills(INST)] == ['a', 'b']
    # Asked from seq 1: only what is newer (a page that already drew `a` never sees it again).
    assert [fill['tradeId'] for fill in deepcoin_stream.realtime_fills(INST, 1)] == ['b']
    assert deepcoin_stream.realtime_fills(INST, 3) == []
    assert deepcoin_stream.realtime_fills('SOL-USDT-SWAP') == []


def test_a_key_is_rotated_fifteen_minutes_before_it_hard_expires():
    opened = 1000.0
    assert deepcoin_stream.rotation_due(opened, opened + 2699) is False
    assert deepcoin_stream.rotation_due(opened, opened + 2700) is True
    assert deepcoin_stream.ROTATE_SECONDS == 2700
    # A test may rotate faster, and 50118 never depends on the clock at all.
    assert deepcoin_stream.rotation_due(opened, opened + 5, rotate_every=5) is True


def test_the_reconnect_delays_are_one_two_five_ten_thirty_sixty():
    assert [deepcoin_stream.backoff_delay(attempt) for attempt in range(8)] == \
        [1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 60.0, 60.0]
    assert deepcoin_stream.backoff_delay(-3) == 1.0


def test_the_worker_stops_three_minutes_after_the_last_page_asked(monkeypatch):
    monkeypatch.setattr(deepcoin_stream, 'monotonic', FakeClock(1000.0).monotonic)
    deepcoin_stream.register(INST)
    assert deepcoin_stream.IDLE_SECONDS == 180
    assert deepcoin_stream.idle_due(deepcoin_stream.idle_deadline(), 1179.9) is False
    assert deepcoin_stream.idle_due(deepcoin_stream.idle_deadline(), 1180.0) is True
    # A worker that was never asked for anything does not stop by itself (the deadline is 0).
    assert deepcoin_stream.idle_due(0.0, 10 ** 9) is False


def test_a_worker_with_no_page_waiting_closes_its_socket_after_the_idle_limit(monkeypatch):
    clock = FakeClock(1000.0)
    monkeypatch.setattr(deepcoin_stream, 'monotonic', clock.monotonic)
    monkeypatch.setattr(deepcoin_private, 'read_credentials', lambda folder=None: CREDENTIALS)
    monkeypatch.setattr(deepcoin_stream, 'acquire_listen_key', lambda credentials: LISTEN_KEY)
    deepcoin_stream.register(INST)
    socket = FakeSocket([lambda: clock.advance(30) or (_ for _ in ()).throw(WebSocketTimeoutException())] * 20)
    monkeypatch.setattr(deepcoin_stream, 'open_socket', lambda url: socket)
    monkeypatch.setattr(deepcoin_stream, 'sync_instruments', lambda inst_ids: None)
    stop = FakeStop()
    worker = deepcoin_stream.Worker(stop)
    assert worker.run() == 'idle'
    # 180 seconds of one-second reads: the socket never delivered a frame and was closed on the way out.
    assert socket.closed is True and socket.timeout == deepcoin_stream.READ_TIMEOUT
    assert stop.waits == []
    assert deepcoin_stream.status()['state'] in ('connecting', 'live')


# --- The worker against a scripted socket -------------------------------------------------------------------------

def test_the_worker_subscribes_pushes_reconnects_with_backoff_and_syncs_after_each_connect(monkeypatch):
    monkeypatch.setattr(deepcoin_private, 'read_credentials', lambda folder=None: CREDENTIALS)
    keys = []

    def acquire(credentials):
        keys.append(1)
        return LISTEN_KEY

    monkeypatch.setattr(deepcoin_stream, 'acquire_listen_key', acquire)
    synced = []
    stop = FakeStop()
    sockets = []

    def factory(url):
        socket = FakeSocket([], stop=stop if sockets else None)
        if not sockets:
            socket.script = [trade_frame(dict(TRADE_ROW)), ConnectionError('fake drop')]
        else:
            # The second connection is opened only to prove the reconnect happens: the test stops the worker right here.
            stop.set()
        sockets.append(socket)
        return socket

    monkeypatch.setattr(deepcoin_stream, 'open_socket', factory)
    deepcoin_stream.register(INST)
    worker = deepcoin_stream.Worker(stop, sync=lambda inst_ids: synced.append(list(inst_ids)))
    assert worker.run() == 'stop'

    # One acquire per connection (a rotation, a 50118 or a reconnect always acquires a new key; nothing is renewed).
    assert len(keys) == 2 and len(sockets) == 2
    # Each connection is subscribed to the Trade table and nothing else; the key stays inside the URL the factory got.
    for socket in sockets:
        assert [json.loads(text) for text in socket.sent] == [{'action': 'subscribe', 'tables': ['Trade']}]
    # The dropped connection waited one second, and both connects ran the authoritative REST increment.
    assert stop.waits == [1.0]
    assert synced == [[INST], [INST]]
    # The pushed fill is in the realtime layer, which is what the page's long poll wakes up on.
    fills = deepcoin_stream.realtime_fills(INST)
    assert [fill['tradeId'] for fill in fills] == ['9001']
    assert fills[0] == deepcoin_stream.parse_trade(TRADE_ROW, now=1794900000)[1] == \
        dict(REST_FILL, execType='1')
    # The state says a reconnect happened, and never carries the key.
    assert json.dumps(deepcoin_stream.status(), ensure_ascii=False).find(LISTEN_KEY) == -1
    assert deepcoin_stream.status()['reconnects'] == 1
    assert sockets[0].closed is True


def test_an_expired_key_frame_reconnects_at_once_without_a_backoff(monkeypatch):
    monkeypatch.setattr(deepcoin_private, 'read_credentials', lambda folder=None: CREDENTIALS)
    monkeypatch.setattr(deepcoin_stream, 'acquire_listen_key', lambda credentials: LISTEN_KEY)
    monkeypatch.setattr(deepcoin_stream, 'sync_instruments', lambda inst_ids: None)
    stop = FakeStop()
    sockets = []

    def factory(url):
        socket = FakeSocket([], stop=stop if sockets else None)
        if not sockets:
            socket.script = [json.dumps({'code': '50118', 'event': 'error',
                                         'msg': 'listen key expired, connection closing'})]
        else:
            stop.set()
        sockets.append(socket)
        return socket

    monkeypatch.setattr(deepcoin_stream, 'open_socket', factory)
    assert deepcoin_stream.Worker(stop).run() == 'stop'
    assert len(sockets) == 2 and stop.waits == []
    assert sockets[0].closed is True


def test_a_worker_rotates_its_key_before_the_sixty_minute_hard_expiry(monkeypatch):
    clock = FakeClock(1000.0)
    monkeypatch.setattr(deepcoin_stream, 'monotonic', clock.monotonic)
    monkeypatch.setattr(deepcoin_private, 'read_credentials', lambda folder=None: CREDENTIALS)
    monkeypatch.setattr(deepcoin_stream, 'acquire_listen_key', lambda credentials: LISTEN_KEY)
    monkeypatch.setattr(deepcoin_stream, 'sync_instruments', lambda inst_ids: None)
    deepcoin_stream.register(INST)
    stop = FakeStop()
    sockets = []

    def timeout_that_ages_the_clock():
        clock.advance(deepcoin_stream.ROTATE_SECONDS)
        raise WebSocketTimeoutException('no frame')

    def factory(url):
        socket = FakeSocket([], stop=stop if sockets else None)
        if not sockets:
            socket.script = [timeout_that_ages_the_clock]
        else:
            stop.set()
        sockets.append(socket)
        return socket

    monkeypatch.setattr(deepcoin_stream, 'open_socket', factory)
    assert deepcoin_stream.Worker(stop).run() == 'stop'
    # Two connections, and the rotation did not back off (the key is simply replaced).
    assert len(sockets) == 2 and stop.waits == []
    assert sockets[0].closed is True


def test_a_waiting_page_is_woken_by_a_push(monkeypatch, project):
    calls = []

    async def pause(seconds):
        calls.append(seconds)
        if len(calls) == 1:
            deepcoin_stream.push(INST, one_fill(time=1794839800, tradeId='9001'))

    monkeypatch.setattr(deepcoin_stream, '_pause', pause)
    fills, current = asyncio.run(deepcoin_stream.wait_fills(INST, 0))
    assert [fill['tradeId'] for fill in fills] == ['9001']
    assert current == 1
    # The wait slept once before the fill arrived, and the poll interval is the route's own 0.3 seconds.
    assert calls == [deepcoin_stream.WAIT_POLL] == [0.3]


def test_a_push_the_store_already_has_wakes_nothing_but_still_advances_the_seq(monkeypatch, project):
    store_with([one_fill(time=1794839800, tradeId='9001')])
    clock = FakeClock()
    monkeypatch.setattr(deepcoin_stream, 'monotonic', clock.monotonic)
    deepcoin_stream.push(INST, one_fill(time=1794839800, tradeId='9002'))

    async def pause(seconds):
        clock.advance(deepcoin_stream.WAIT_LIMIT)

    monkeypatch.setattr(deepcoin_stream, '_pause', pause)
    fills, current = asyncio.run(deepcoin_stream.wait_fills(INST, 0))
    # Covered by the REST store, so nothing is drawn twice; the counter moved past it, so the page never asks again.
    assert fills == [] and current == deepcoin_stream.seq() == 1


# --- The routes ---------------------------------------------------------------------------------------------------

def test_the_wait_route_times_out_after_twenty_five_seconds(client, configured, monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(deepcoin_stream, 'monotonic', clock.monotonic)
    monkeypatch.setattr(deepcoin_stream, 'touch', lambda inst_id: True)
    sleeps = []

    async def pause(seconds):
        sleeps.append(seconds)
        clock.advance(seconds)

    monkeypatch.setattr(deepcoin_stream, '_pause', pause)
    response = client.post('/review/market/fills/wait',
                           json={'market': 'swap', 'symbol': 'BTC-USDT', 'seq': 0}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body['fills'] == [] and body['seq'] == 0
    assert body['stream'] == deepcoin_stream.status()
    assert set(body['stream']) == {'state', 'since', 'last_frame_at', 'reconnects'}
    # A 25-second hold at one look every 0.3 seconds, and no thread-pool thread while it waits.
    assert len(sleeps) == 84 and all(seconds == 0.3 for seconds in sleeps)
    assert clock.value >= 25.0


def test_the_wait_route_answers_a_pushed_fill_at_once(client, configured, monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(deepcoin_stream, 'monotonic', clock.monotonic)
    monkeypatch.setattr(deepcoin_stream, 'touch', lambda inst_id: True)

    async def pause(seconds):
        # Nothing new ever arrives after the first answer: the second wait runs into the limit, on the fake clock.
        clock.advance(deepcoin_stream.WAIT_LIMIT)

    monkeypatch.setattr(deepcoin_stream, '_pause', pause)
    deepcoin_stream.push(INST, one_fill(time=1794839800, tradeId='9001'))
    response = client.post('/review/market/fills/wait',
                           json={'market': 'swap', 'symbol': 'BTC-USDT', 'seq': 0}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert [fill['tradeId'] for fill in body['fills']] == ['9001']
    assert body['seq'] == 1
    # The old seq already has it: no second copy of the same fill.
    again = client.post('/review/market/fills/wait',
                        json={'market': 'swap', 'symbol': 'BTC-USDT', 'seq': 1}, headers=HEADERS)
    assert again.status_code == 200 and again.json()['fills'] == []
    assert again.json()['seq'] == 1


def test_the_wait_route_answers_the_spot_market_without_a_stream(client):
    response = client.post('/review/market/fills/wait',
                           json={'market': 'spot', 'symbol': 'BTC-USDT', 'seq': 0}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {'seq': 0, 'fills': [], 'stream': {'state': 'off', 'reason': '现货暂不支持实时'}}
    # A market outside the page's two is a readable 400, and a symbol outside the whitelist too.
    assert client.post('/review/market/fills/wait', json={'market': 'margin', 'symbol': 'BTC-USDT'},
                       headers=HEADERS).status_code == 400
    assert client.post('/review/market/fills/wait', json={'market': 'swap', 'symbol': 'BTCUSD'},
                       headers=HEADERS).status_code == 400
    assert client.post('/review/market/fills/wait', json={'market': 'swap', 'symbol': 'BTC-USDT', 'seq': 'later'},
                       headers=HEADERS).status_code == 400


def test_an_unconfigured_project_starts_nothing_and_says_so(client, project, monkeypatch):
    def never(*_args, **_kwargs):
        raise AssertionError('an unconfigured project must not reach the venue')

    monkeypatch.setattr(deepcoin_stream, 'open_socket', never)
    response = client.post('/review/market/fills/wait',
                           json={'market': 'swap', 'symbol': 'BTC-USDT', 'seq': 0}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body['fills'] == [] and body['stream']['state'] == 'off'
    assert body['stream']['reason'] == '未配置 Deepcoin API'
    assert deepcoin_stream.status()['state'] == 'off'


def test_the_fills_route_merges_the_pushed_fills_and_says_what_the_stream_is_doing(client, configured, monkeypatch):
    store_with([one_fill(time=1794839700, tradeId='9001')])
    monkeypatch.setattr(deepcoin_private, 'fetch_page', lambda credentials, query: [])
    # One fill the store does not have yet (newer than its newest second) and one it already has.
    deepcoin_stream.push(INST, one_fill(time=1794839800, tradeId='9002'))
    deepcoin_stream.push(INST, one_fill(time=1794839700, tradeId='9003'))
    deepcoin_private.clear_cache()
    response = client.post('/review/market/fills',
                           json={'market': 'swap', 'symbol': 'BTC-USDT', 'begin': 1794835200}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert [fill['tradeId'] for fill in body['fills']] == ['9001', '9002']
    assert body['seq'] == 2
    assert body['stream']['state'] == 'off'
    assert set(body['stream']) == {'state', 'since', 'last_frame_at', 'reconnects'}
    # A pushed fill outside the window the page asked for is not drawn.
    deepcoin_stream.push(INST, one_fill(time=1794839900, tradeId='9004'))
    deepcoin_private.clear_cache()
    narrow = client.post('/review/market/fills', json={'market': 'swap', 'symbol': 'BTC-USDT',
                                                       'begin': 1794835200, 'end': 1794839800}, headers=HEADERS)
    assert [fill['tradeId'] for fill in narrow.json()['fills']] == ['9001', '9002']
    for secret in SECRETS + (LISTEN_KEY,):
        assert secret not in response.text
        assert secret not in narrow.text


def test_the_wait_route_requires_the_dashboard_token(client):
    assert client.post('/review/market/fills/wait',
                       json={'market': 'swap', 'symbol': 'BTC-USDT'}).status_code == 401
