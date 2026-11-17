"""The owner's private Deepcoin fills (T-59 / T-60), with fake credentials, fake venue pages and fake fills only.

Every value below is invented (`test-key-0000` …) and every fill is generated, so nothing here is a real trade or a real
account. The fake `.env.deepcoin` and the store (`storage/deepcoin-fills/`) live in a tmp_path the test chdirs into, so
nothing reads the project's own files, and the tests that check "the secret never leaks" assert on these fake strings.

`FakeVenue` is the venue's fills endpoint itself: newest row first, `after=<billId>` for the older pages, a full page of
`PAGE_LIMIT` rows until the account's history runs out. No socket is opened and nothing is signed.
"""
import base64
import hashlib
import hmac
import json
import os
import re
from hashlib import sha256
from pathlib import Path

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
    """Every test starts without a recent-sync mark (it is process-wide)."""
    deepcoin_private.clear_cache()
    yield
    deepcoin_private.clear_cache()


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project folder the module reads `.env.deepcoin` from and writes the store into (its cwd)."""
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


# --- The fake venue ------------------------------------------------------------------------------------------------

def venue_rows(count, first_bill=1, first_ts=1794000000, inst_id='BTC-USDT-SWAP'):
    """`count` fake fills whose bill ids and times both grow: the newest fill has the highest bill (the venue's order)."""
    return [{'instType': 'SWAP', 'instId': inst_id, 'tradeId': f'{inst_id}-{first_bill + index}',
             'billId': str(first_bill + index), 'ordId': '7001', 'fillPx': '64000', 'fillSz': '1',
             'side': 'buy', 'posSide': 'long', 'execType': 'T', 'feeCcy': 'USDT', 'fee': '0.01',
             'ts': str((first_ts + index) * 1000)}
            for index in range(count)]


class FakeVenue:
    """The fills endpoint of one instrument: newest row first, `after=<billId>` for the page of older fills."""

    def __init__(self, rows):
        self.rows = self._sorted(rows)
        self.queries = []

    @staticmethod
    def _sorted(rows):
        return sorted((dict(row) for row in rows), key=lambda row: int(row['billId']), reverse=True)

    def add(self, rows):
        """Newer fills arriving between two polls."""
        self.rows = self._sorted(self.rows + list(rows))

    def __call__(self, credentials, query):
        self.queries.append(query)
        match = re.search(r'(?:^|&)after=(\d+)', query)
        after = int(match.group(1)) if match else None
        asked = [row for row in self.rows if after is None or int(row['billId']) < after]
        return asked[: deepcoin_private.PAGE_LIMIT]


def store_after(count, first_bill=1, first_ts=1794000000, inst_id='BTC-USDT-SWAP'):
    """What the store of a first read of `venue_rows(count)` looks like: its fills and its two bill cursors."""
    rows = venue_rows(count, first_bill=first_bill, first_ts=first_ts, inst_id=inst_id)
    return {'fills': deepcoin_private.parse_fills(rows, inst_id),
            'newest_bill': str(first_bill + count - 1), 'oldest_bill': str(first_bill),
            'history_end': False}


def write_existing_store(count, first_bill=1, first_ts=1794000000, inst_id='BTC-USDT-SWAP'):
    """A store written before the read under test (the state of a project whose page was open yesterday)."""
    store = store_after(count, first_bill=first_bill, first_ts=first_ts, inst_id=inst_id)
    deepcoin_private.write_store(inst_id, {**deepcoin_private.empty_store(), **store, 'updated': 5})
    return store


def store_path(inst_id='BTC-USDT-SWAP'):
    return Path(deepcoin_private.store_path(inst_id))


def read_swap(begin=1794000000, end=None):
    """One read without the 5-second window in the way (that window has its own test)."""
    deepcoin_private.clear_cache()
    return deepcoin_private.read_fills('swap', 'BTC-USDT', begin, end)


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
                    'begin': 1794835200, 'end': None, 'have_from': None, 'have_to': None}
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


def test_a_newest_page_has_no_window_and_an_older_page_only_the_cursor():
    # The first page of a sync asks for nothing but the instrument and the page size: the store wants every fill since
    # the last poll, not only the part of the history the chart shows.
    assert deepcoin_private.fills_query('SWAP', 'BTC-USDT-SWAP') == 'instType=SWAP&instId=BTC-USDT-SWAP&limit=100'
    first = deepcoin_private.fills_query('SWAP', 'BTC-USDT-SWAP', 1794835200, 1794841200)
    assert first == 'instType=SWAP&instId=BTC-USDT-SWAP&begin=1794835200000&end=1794841200000&limit=100'
    older = deepcoin_private.fills_query('SWAP', 'BTC-USDT-SWAP', 1794835200, 1794841200, older_than='7999001')
    # The cursor alone (sent as `after`, the venue's real older-page parameter): it never has to combine it with the window.
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


def test_the_oldest_bill_of_a_page_is_its_smallest_id():
    assert deepcoin_private.page_oldest_bill([{'billId': '8002'}, {'billId': '8000'}, {'billId': '8001'}]) == '8000'
    assert deepcoin_private.page_oldest_bill([{'billId': 'a'}, {'billId': 'b'}]) == 'b'
    assert deepcoin_private.page_oldest_bill([{}, None, 'nope']) is None
    # Only numeric bill ids can page or be compared as cursors.
    assert deepcoin_private.page_bills([{'billId': '12'}, {'billId': '9'}, {'billId': 'x'}, {}, None]) == [12, 9]
    assert deepcoin_private.page_bills([]) == []
    assert deepcoin_private.bill_cursor(['9', '120', None, 'x'], max) == '120'
    assert deepcoin_private.bill_cursor(['9', '120', None, 'x'], min) == '9'
    assert deepcoin_private.bill_cursor([None, 'x'], max) is None


# --- The store ----------------------------------------------------------------------------------------------------

def test_the_first_read_stores_the_history_and_answers_it(configured, monkeypatch):
    venue = FakeVenue(venue_rows(150))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    answer = read_swap()
    # Two pages: the newest 100 fills, then the 50 that are left (a short page = the venue's own end of the account).
    assert venue.queries == ['instType=SWAP&instId=BTC-USDT-SWAP&limit=100',
                             'instType=SWAP&instId=BTC-USDT-SWAP&after=51&limit=100']
    assert [fill['tradeId'] for fill in answer['fills']] == \
        [f'BTC-USDT-SWAP-{bill}' for bill in range(1, 151)]
    assert answer['configured'] is True and answer['cached'] is False and answer['fetched_at'] > 0
    # Every fill of the account is stored, and there is nothing older to look for.
    assert answer['history_end'] is True and answer['complete'] is True and answer['covered_from'] is None
    stored = deepcoin_private.read_store('BTC-USDT-SWAP')
    assert len(stored['fills']) == 150 and stored['history_end'] is True and stored['updated'] > 0
    assert stored['newest_bill'] == '150' and stored['oldest_bill'] == '1'
    data = json.loads(store_path().read_text(encoding='utf-8'))
    assert set(data) == {'fills', 'newest_bill', 'oldest_bill', 'history_end', 'updated'}
    # Oldest first inside the file, and no temp file left behind by the atomic write.
    assert [fill['time'] for fill in data['fills']] == sorted(fill['time'] for fill in data['fills'])
    assert sorted(os.listdir(store_path().parent)) == ['BTC-USDT-SWAP.json']


def test_a_second_read_asks_one_page_and_stops_at_the_stored_bill(configured, monkeypatch):
    rows = venue_rows(150)
    venue = FakeVenue(rows)
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    read_swap()
    # 40 fills arrived since: one page of 100 still carries bill 91, which is older than the stored newest (150), so the
    # new and the stored ranges touch and one page is all the venue is asked for.
    venue.add(venue_rows(40, first_bill=151, first_ts=1794000150))
    venue.queries.clear()
    answer = read_swap()
    assert venue.queries == ['instType=SWAP&instId=BTC-USDT-SWAP&limit=100']
    assert len(answer['fills']) == 190
    stored = deepcoin_private.read_store('BTC-USDT-SWAP')
    assert stored['newest_bill'] == '190'
    # The overlapping page (bills 91..150) is merged, not appended: one copy of every fill.
    assert len(stored['fills']) == 190
    assert len({fill['tradeId'] for fill in stored['fills']}) == 190


def test_backfill_walks_ten_pages_a_poll_and_stops_there(configured, monkeypatch):
    rows = venue_rows(2000)
    venue = FakeVenue(rows)
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    # A store from an earlier poll: the newest 100 fills, and a history that is not complete yet.
    write_existing_store(100, first_bill=1901)
    answer = read_swap(begin=1794000000)
    # One page of new fills (the newest page already carries the stored newest bill), then BACKFILL_PAGES pages older.
    assert len(venue.queries) == 1 + deepcoin_private.BACKFILL_PAGES == 11
    assert 'after=' not in venue.queries[0]
    assert [re.search(r'after=(\d+)', query).group(1) for query in venue.queries[1:]] == \
        ['1901', '1801', '1701', '1601', '1501', '1401', '1301', '1201', '1101', '1001']
    stored = deepcoin_private.read_store('BTC-USDT-SWAP')
    assert len(stored['fills']) == 1100
    assert stored['oldest_bill'] == '901' and stored['newest_bill'] == '2000'
    # Ten pages a poll: the requested `begin` is still not reached, so the answer says how far the store goes instead.
    assert stored['history_end'] is False
    assert answer['complete'] is False
    assert answer['covered_from'] == stored['fills'][0]['time'] == 1794000900
    # The window really is not sent to the venue: it is enforced on what the store has.
    assert all('begin=' not in query and 'end=' not in query for query in venue.queries)


def test_a_short_page_into_the_past_marks_the_history_end(configured, monkeypatch):
    venue = FakeVenue(venue_rows(130))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    # The store holds the newest 100 fills (bills 31..130) and knows nothing older.
    write_existing_store(100, first_bill=31)
    answer = read_swap(begin=1)
    assert len(venue.queries) == 2
    # 30 fills came back where 100 were asked for: the account starts there, so nothing older will ever be missing.
    assert re.search(r'after=(\d+)', venue.queries[1]).group(1) == '31'
    stored = deepcoin_private.read_store('BTC-USDT-SWAP')
    assert len(stored['fills']) == 130 and stored['history_end'] is True
    assert stored['oldest_bill'] == '1'
    # A complete history has no edge to report, so the page never shows a 「补历史」 line for it.
    assert answer['covered_from'] is None and answer['complete'] is True
    assert len(answer['fills']) == 130


def test_a_store_too_old_for_one_walk_is_started_over(configured, monkeypatch):
    venue = FakeVenue(venue_rows(2500))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    stale = {**deepcoin_private.empty_store(), 'history_end': True, 'updated': 5, 'newest_bill': '10',
             'oldest_bill': '9',
             'fills': [{'time': 1793000000, 'price': 1.0, 'size': 1.0, 'side': 'buy', 'posSide': '',
                        'execType': '', 'fee': 0.0, 'feeCcy': '', 'ordId': '', 'tradeId': 'stale'}]}
    deepcoin_private.write_store('BTC-USDT-SWAP', stale)
    answer = read_swap(begin=1794000500)
    # 20 full pages and still no fill the store knows: the two ranges do not touch, so the old store is dropped.
    assert len(venue.queries) == deepcoin_private.MAX_PAGES == 20
    stored = deepcoin_private.read_store('BTC-USDT-SWAP')
    assert [fill['tradeId'] for fill in stored['fills']].count('stale') == 0
    # What the walk did return is kept, and the history has to be learned again.
    assert len(stored['fills']) == 2000 and stored['history_end'] is False
    assert stored['newest_bill'] == '2500' and stored['oldest_bill'] == '501'
    # The dropped store does not leave a window the page would be told is complete by accident: the pulled range covers
    # a begin newer than its own oldest fill, so this answer is complete, but only for that part.
    assert len(answer['fills']) == 2000 and answer['complete'] is True
    assert answer['covered_from'] == 1794000500


def test_covered_from_and_complete_say_how_much_of_the_window_the_store_has(configured, monkeypatch):
    venue = FakeVenue(venue_rows(2000))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    write_existing_store(100, first_bill=1901)
    # A begin at the oldest stored fill: the whole window is in the store, so nothing is missing and nothing is fetched
    # beyond the newest page.
    inside = read_swap(begin=1794001900)
    assert inside['complete'] is True and inside['covered_from'] == 1794001900
    assert inside['history_end'] is False
    # A begin far older than the store: the backfill walks ten pages and the answer points at where it got to.
    deepcoin_private.clear_cache()
    older = deepcoin_private.read_fills('swap', 'BTC-USDT', 1794000000)
    assert older['complete'] is False
    assert older['covered_from'] == 1794000900 == deepcoin_private.read_store('BTC-USDT-SWAP')['fills'][0]['time']


def test_the_answer_is_only_the_window_the_page_asked_for(configured, monkeypatch):
    venue = FakeVenue(venue_rows(150))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    answer = read_swap(begin=1794000010, end=1794000019)
    assert [fill['time'] for fill in answer['fills']] == list(range(1794000010, 1794000020))
    assert answer['begin'] == 1794000010
    # The store keeps the whole account; the window is cut here, so no request carries begin / end.
    assert all('begin=' not in query and 'end=' not in query for query in venue.queries)
    assert len(deepcoin_private.read_store('BTC-USDT-SWAP')['fills']) == 150


def test_each_instrument_has_its_own_file(configured, monkeypatch):
    swap = FakeVenue(venue_rows(30))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', swap)
    swap_answer = read_swap()
    spot = FakeVenue(venue_rows(20, first_bill=500, inst_id='BTC-USDT'))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', spot)
    deepcoin_private.clear_cache()
    spot_answer = deepcoin_private.read_fills('spot', 'BTC-USDT', 1794000000)
    # Each instrument only ever asked for its own instrument (20 fills fit in one page), and the swap store was not
    # touched by the spot read.
    assert spot.queries == ['instType=SPOT&instId=BTC-USDT&limit=100']
    assert len(swap.queries) == 1
    assert [fill['tradeId'] for fill in spot_answer['fills']] == [f'BTC-USDT-{bill}' for bill in range(500, 520)]
    assert sorted(os.listdir(store_path().parent)) == ['BTC-USDT-SWAP.json', 'BTC-USDT.json']
    assert len(deepcoin_private.read_store('BTC-USDT-SWAP')['fills']) == 30
    assert len(deepcoin_private.read_store('BTC-USDT')['fills']) == 20
    assert swap_answer['market'] == 'swap' and spot_answer['market'] == 'spot'


def test_a_refused_request_still_answers_with_the_stored_fills(configured, monkeypatch):
    venue = FakeVenue(venue_rows(120))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    first = read_swap()
    assert len(first['fills']) == 120
    before = store_path().read_text(encoding='utf-8')

    def refused(credentials, query):
        raise deepcoin_private.DeepcoinError('Deepcoin 请求失败（HTTP 429），稍后再试', status_code=502)

    monkeypatch.setattr(deepcoin_private, 'fetch_page', refused)
    answer = read_swap()
    # A rate limit is not a failed page: the stored fills are still drawn, and the reason rides along in `error`.
    assert answer['configured'] is True and len(answer['fills']) == 120
    assert 'HTTP 429' in answer['error']
    assert answer['complete'] is True
    # Nothing was written on the failure: the store on disk is the one from the last good sync.
    assert store_path().read_text(encoding='utf-8') == before


def test_two_reads_within_five_seconds_share_one_sync(configured, monkeypatch):
    venue = FakeVenue(venue_rows(150))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    first = deepcoin_private.read_fills('swap', 'BTC-USDT', 1794000000)
    assert first['cached'] is False
    calls = len(venue.queries)
    # The next caller (a second tab, or the page's window growing left) is answered from the store alone.
    second = deepcoin_private.read_fills('swap', 'BTC-USDT', 1793900000)
    assert second['cached'] is True and len(venue.queries) == calls
    assert second['fills'] == first['fills']
    # Once the window has passed, the venue is asked again.
    monkeypatch.setattr(deepcoin_private, 'SYNC_TTL', 0.0)
    deepcoin_private.clear_cache()
    third = deepcoin_private.read_fills('swap', 'BTC-USDT', 1794000000)
    assert third['cached'] is False and len(venue.queries) == calls + 1


def test_a_broken_or_hand_edited_store_file_reads_as_what_it_can(project):
    path = store_path('BTC-USDT')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"fills": [', encoding='utf-8')
    assert deepcoin_private.read_store('BTC-USDT') == deepcoin_private.empty_store()
    path.write_text(json.dumps({'fills': [
        {'time': 1794000000, 'price': 64000, 'size': 1, 'side': 'buy', 'tradeId': 'ok'},
        {'time': 'yesterday', 'price': 64000, 'size': 1, 'side': 'buy'},
        {'time': 1794000100, 'price': 0, 'size': 1, 'side': 'sell'},
        {'time': 1794000200, 'price': 1, 'size': 1, 'side': 'hold'},
        'nope',
    ], 'newest_bill': 'x', 'oldest_bill': 1794000000, 'history_end': 'yes', 'updated': 'soon'}), encoding='utf-8')
    store = deepcoin_private.read_store('BTC-USDT')
    assert [fill['tradeId'] for fill in store['fills']] == ['ok']
    assert store['newest_bill'] is None and store['oldest_bill'] == '1794000000'
    assert store['history_end'] is False and store['updated'] == 0


def test_the_store_keeps_one_copy_of_a_fill():
    fill = deepcoin_private.parse_fills(FILLS[:1], 'BTC-USDT-SWAP')[0]
    assert deepcoin_private.merge_fills([fill], [dict(fill)], [None, 'nope']) == [fill]
    # A venue row without a trade id is still identified by its own numbers, so it is not duplicated either.
    anonymous = deepcoin_private.parse_fills([dict(FILLS[1], tradeId='')], 'BTC-USDT-SWAP')[0]
    assert len(deepcoin_private.merge_fills([anonymous], [dict(anonymous)])) == 1


# --- The increment a page that already drew a range asks for (T-61) ------------------------------------------------

def spaced_fills(times, inst_id='BTC-USDT-SWAP'):
    """Fills at exactly `times` (seconds), oldest first: what a store of spread-out trades looks like."""
    rows = [{'instType': 'SWAP', 'instId': inst_id, 'tradeId': f't{time}', 'billId': str(index + 1), 'ordId': '7001',
             'fillPx': '64000', 'fillSz': '1', 'side': 'buy', 'posSide': 'long', 'execType': 'T',
             'feeCcy': 'USDT', 'fee': '0.01', 'ts': str(time * 1000)}
            for index, time in enumerate(times)]
    return deepcoin_private.parse_fills(rows, inst_id)


def spaced_store(times, inst_id='BTC-USDT-SWAP'):
    """A complete store (`history_end`) of fills at `times`, as an earlier sync would have left it."""
    fills = spaced_fills(times, inst_id)
    return {**deepcoin_private.empty_store(), 'fills': fills, 'newest_bill': str(len(times)),
            'oldest_bill': '1', 'history_end': True}


# 10 minutes apart, so 'a fill inside the 2-minute overlap' really is a distinct one.
SPACED_TIMES = [1794000000 + index * 600 for index in range(7)]


def answer_for(store, begin, end=None, have_from=None, have_to=None):
    """The store's answer for one request, without a venue, a credential or a file."""
    request = deepcoin_private.resolve_request('swap', 'BTC-USDT', begin, end, have_from, have_to)
    return deepcoin_private.store_answer(store, request)


def times_of(answer):
    return [fill['time'] for fill in answer['fills']]


def test_without_a_have_range_the_answer_is_the_whole_window():
    store = spaced_store(SPACED_TIMES)
    answer = answer_for(store, SPACED_TIMES[0])
    assert answer['partial'] is False
    assert times_of(answer) == SPACED_TIMES
    # begin / end keep cutting the window exactly as before (the have range only narrows what is left of it).
    window = answer_for(store, SPACED_TIMES[1], SPACED_TIMES[4])
    assert window['partial'] is False
    assert times_of(window) == SPACED_TIMES[1:5]


def test_a_have_range_answers_new_fills_and_older_history_only():
    store = spaced_store(SPACED_TIMES)
    answer = answer_for(store, SPACED_TIMES[0], have_from=SPACED_TIMES[2], have_to=SPACED_TIMES[4])
    assert answer['partial'] is True
    # Older than the page's oldest (the backfill just pulled them) or newer than its newest edge minus the overlap.
    # A fill at exactly `have_from` is already drawn and is not sent again.
    assert times_of(answer) == SPACED_TIMES[:2] + SPACED_TIMES[4:]
    # The 2-minute overlap re-sends the edge the page may have missed because of clock skew: 1794002340 == have_to - 60.
    overlap = answer_for(store, SPACED_TIMES[0], have_from=SPACED_TIMES[2], have_to=SPACED_TIMES[4] + 60)
    assert times_of(overlap) == SPACED_TIMES[:2] + SPACED_TIMES[4:]
    # Nothing newer and nothing older than the page's range: only the newest edge is re-sent (a page de-duplicates it).
    caught_up = answer_for(store, SPACED_TIMES[0], have_from=SPACED_TIMES[0], have_to=SPACED_TIMES[-1])
    assert caught_up['partial'] is True and times_of(caught_up) == [SPACED_TIMES[-1]]
    # How much of the window the store covers is about the store, not about the increment.
    assert caught_up['complete'] is True and caught_up['history_end'] is True


def test_a_have_range_still_respects_begin_and_end():
    store = spaced_store(SPACED_TIMES)
    # The window starts at the third fill: the two older ones are outside it even though they are older than have_from.
    # The one at have_from itself is already on the page; the third fill is older than have_from and inside `begin`.
    answer = answer_for(store, SPACED_TIMES[2], have_from=SPACED_TIMES[3], have_to=SPACED_TIMES[5])
    assert times_of(answer) == [SPACED_TIMES[2]] + SPACED_TIMES[5:]
    # An end inside the page's range leaves nothing newer than it, so only the older part of the window can come back.
    closed = answer_for(store, SPACED_TIMES[0], SPACED_TIMES[3], have_from=SPACED_TIMES[2], have_to=SPACED_TIMES[5])
    assert times_of(closed) == SPACED_TIMES[:2]
    assert closed['partial'] is True and closed['begin'] == SPACED_TIMES[0]


def test_a_half_a_have_range_or_a_broken_one_is_a_readable_400():
    store = spaced_store(SPACED_TIMES)
    cases = [
        {'have_from': SPACED_TIMES[2]},
        {'have_to': SPACED_TIMES[2]},
        {'have_from': 'yesterday', 'have_to': SPACED_TIMES[2]},
        {'have_from': SPACED_TIMES[0], 'have_to': 'yesterday'},
        {'have_from': 0, 'have_to': SPACED_TIMES[2]},
        {'have_from': -60, 'have_to': SPACED_TIMES[2]},
        {'have_from': SPACED_TIMES[0], 'have_to': -60},
        {'have_from': True, 'have_to': SPACED_TIMES[2]},
    ]
    for case in cases:
        with pytest.raises(deepcoin_private.DeepcoinError) as error:
            answer_for(store, SPACED_TIMES[0], **case)
        assert error.value.status_code == 400, case
        assert any(word in str(error.value) for word in ('秒数', '正数', '一起给')), str(error.value)


def test_the_route_passes_the_have_range_through(client, configured, monkeypatch):
    times = [1794835200 + index * 600 for index in range(40)]
    rows = [{'instType': 'SWAP', 'instId': 'BTC-USDT-SWAP', 'tradeId': f'row{time}', 'billId': str(index + 1),
             'ordId': '7001', 'fillPx': '64000', 'fillSz': '1', 'side': 'buy', 'posSide': 'long', 'ts': str(time * 1000)}
            for index, time in enumerate(times)]
    venue = FakeVenue(rows)
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    whole = ask(client, begin=times[0])
    assert whole.status_code == 200 and whole.json()['partial'] is False
    assert len(whole.json()['fills']) == 40
    # The second poll names the range the page already has: the fills older than it and the newer ones, never the rest.
    increment = ask(client, begin=times[0], have_from=times[3], have_to=times[5])
    assert increment.status_code == 200
    body = increment.json()
    assert body['partial'] is True
    assert [fill['time'] for fill in body['fills']] == times[:3] + times[5:]
    # A wider window (an older begin) is sent with the same have range: the store answers the older part it has.
    deepcoin_private.clear_cache()
    older = ask(client, begin=times[0] - 3600, have_from=times[3], have_to=times[5])
    assert [fill['time'] for fill in older.json()['fills']] == times[:3] + times[5:]
    # A bad have range is still a 400 at the route, before any venue request.
    assert ask(client, have_from=times[0]).status_code == 400
    assert ask(client, have_from='yesterday', have_to=times[5]).status_code == 400


def test_a_sync_that_changes_nothing_does_not_rewrite_the_store(configured, monkeypatch):
    venue = FakeVenue(venue_rows(30))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    writes = []
    real_write = deepcoin_private.write_store

    def counting_write(inst_id, store, folder=None):
        writes.append(inst_id)
        return real_write(inst_id, store, folder)

    monkeypatch.setattr(deepcoin_private, 'write_store', counting_write)
    first = read_swap()
    assert len(first['fills']) == 30 and writes == ['BTC-USDT-SWAP']
    written = store_path().read_text(encoding='utf-8')
    # The next poll finds the newest page it already has: nothing new, no backfill (the account history is complete),
    # so the file is left exactly as it was instead of being rewritten every 30 seconds.
    read_swap()
    assert len(writes) == 1
    assert store_path().read_text(encoding='utf-8') == written
    assert json.loads(written)['updated'] == json.loads(store_path().read_text(encoding='utf-8'))['updated']
    # A fill that really arrived is written (and pulls the older history along, if the window asks for it).
    venue.add(venue_rows(3, first_bill=31, first_ts=1794000030))
    answer = read_swap()
    assert len(answer['fills']) == 33 and len(writes) == 2
    assert len(deepcoin_private.read_store('BTC-USDT-SWAP')['fills']) == 33


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

    monkeypatch.setattr(deepcoin_private, 'fetch_page', never)
    response = ask(client)
    assert response.status_code == 200
    assert response.json() == {'configured': False, 'fills': []}
    assert not store_path().exists()
    # A whitelist failure is still a 400, configured or not.
    assert ask(client, symbol='BTCUSD').status_code == 400


def test_the_route_answers_the_window_from_the_store(client, configured, monkeypatch):
    venue = FakeVenue(venue_rows(120, first_ts=1794839700))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    response = ask(client)
    assert response.status_code == 200
    body = response.json()
    assert body['configured'] is True
    assert len(body['fills']) == 120
    assert body['fills'][0]['tradeId'] == 'BTC-USDT-SWAP-1'
    assert body['market'] == 'swap' and body['symbol'] == 'BTC-USDT'
    # 120 generated fills are the whole account, so the window is covered and there is no edge to report.
    assert body['covered_from'] is None and body['complete'] is True and body['history_end'] is True
    assert body['cached'] is False and body['fetched_at'] > 0
    # The answer is JSON-serialisable as sent and carries no credential anywhere.
    assert json.loads(json.dumps(body)) == body
    for secret in SECRETS:
        assert secret not in json.dumps(body, ensure_ascii=False)
    # The same window within 5 seconds is one sync (the page polls every 30 seconds, two tabs poll together).
    calls = len(venue.queries)
    second = ask(client)
    assert second.json()['cached'] is True and len(venue.queries) == calls
    # Another market is another store (120 fills = two pages), not an answer from the swap store.
    assert ask(client, market='spot', symbol='BTC-USDT').status_code == 200
    assert [query.split('&')[1] for query in venue.queries[calls:]] == ['instId=BTC-USDT', 'instId=BTC-USDT']


def test_a_refused_venue_is_an_answer_with_an_error_and_not_a_502(client, configured, monkeypatch):
    venue = FakeVenue(venue_rows(120, first_ts=1794839700))
    monkeypatch.setattr(deepcoin_private, 'fetch_page', venue)
    assert ask(client).status_code == 200

    def refused(credentials, query):
        raise deepcoin_private.DeepcoinError('Deepcoin 返回错误：40004 bad passphrase', status_code=502)

    monkeypatch.setattr(deepcoin_private, 'fetch_page', refused)
    deepcoin_private.clear_cache()
    response = ask(client)
    # The stored markers are still drawn; the reason is in the answer, in Chinese, without a credential.
    assert response.status_code == 200
    body = response.json()
    assert len(body['fills']) == 120
    assert 'Deepcoin 返回错误：40004' in body['error']
    for secret in SECRETS:
        assert secret not in response.text


def test_a_missing_login_token_never_reaches_the_venue(client, configured):
    # The page always sends the dashboard token; the route is behind require_auth like every other review endpoint.
    response = client.post('/review/market/fills', json={'market': 'swap', 'symbol': 'BTC-USDT',
                                                         'begin': 1794835200})
    assert response.status_code == 401


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
