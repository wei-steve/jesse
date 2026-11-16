import json
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jesse.controllers import review_controller
from jesse.services import auth, market_sources

PASSWORD = 'review-market-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}

# Yahoo's chart answer, trimmed to the fields this code reads: `timestamp` plus `indicators.quote[0]`. A minute
# outside the session has nulls (a bond session is not 24 hours).
YAHOO = {
    'chart': {
        'result': [{
            'meta': {'symbol': '^TNX'},
            'timestamp': [1763178600, 1763178660, 1763178720],
            'indicators': {'quote': [{
                'open': [4.11, None, 4.13],
                'high': [4.13, None, 4.16],
                'low': [4.09, None, 4.12],
                'close': [4.12, None, 4.15],
            }]},
        }],
        'error': None,
    }
}

FRED = (
    'observation_date,DGS2,DGS10\n'
    '2026-11-12,3.58,4.11\n'
    '2026-11-13,.,4.09\n'
    '2026-11-14,3.61,\n'
)


@pytest.fixture(autouse=True)
def empty_cache():
    """Every test starts without a cached upstream answer."""
    market_sources.clear_cache()
    yield
    market_sources.clear_cache()


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
    payload = {'source': 'us-yields', 'symbol': 'US10Y', 'interval': '5m'}
    payload.update(body)
    return client.post('/review/market/candles', json=payload, headers=HEADERS)


# --- Parsing (no network) ---------------------------------------------------------------------------------------

def test_yahoo_chart_becomes_utc_candles_and_drops_the_null_minutes():
    candles = market_sources.parse_yahoo_chart(YAHOO)
    assert [candle['time'] for candle in candles] == [1763178600, 1763178720]
    assert candles[0] == {'time': 1763178600, 'open': 4.11, 'high': 4.13, 'low': 4.09, 'close': 4.12, 'volume': 0.0}
    # A bar with a null close is a minute outside the session: nothing to draw.
    assert all(candle['close'] is not None for candle in candles)


def test_a_yahoo_bar_with_missing_edges_keeps_the_close_for_them():
    payload = {'chart': {'result': [{'timestamp': [1763178600],
                                     'indicators': {'quote': [{'open': [None], 'high': [None], 'low': None,
                                                               'close': [4.2]}]}}]}}
    assert market_sources.parse_yahoo_chart(payload) == [
        {'time': 1763178600, 'open': 4.2, 'high': 4.2, 'low': 4.2, 'close': 4.2, 'volume': 0.0}]


def test_a_broken_yahoo_payload_reads_as_no_candles():
    for broken in [None, {}, {'chart': None}, {'chart': {'result': []}}, {'chart': {'result': [None]}},
                   {'chart': {'result': [{}]}}, {'chart': {'result': [{'timestamp': []}]}},
                   {'chart': {'result': [{'timestamp': ['x'], 'indicators': {'quote': [{'close': [4.1]}]}}]}}]:
        assert market_sources.parse_yahoo_chart(broken) == [], broken


def test_fred_csv_becomes_daily_candles_with_open_equal_to_close():
    candles = market_sources.parse_fred_csv(FRED)
    # The header row is not a date and is skipped; 2026-11-13 is a '.' (holiday) and is skipped too, not drawn as a
    # bar nobody traded. o = h = l = c: the value of that day is all the official series says.
    assert candles == [
        {'time': 1794441600, 'open': 3.58, 'high': 3.58, 'low': 3.58, 'close': 3.58, 'volume': 0.0},
        {'time': 1794614400, 'open': 3.61, 'high': 3.61, 'low': 3.61, 'close': 3.61, 'volume': 0.0},
    ]


def test_fred_csv_skips_the_header_and_junk():
    for broken in [None, '', 'observation_date,DGS2\n', 'not a date,4.1\n2026-11-12,', 'a,b\nc,d\n']:
        assert market_sources.parse_fred_csv(broken) == [], broken


# --- Whitelist ----------------------------------------------------------------------------------------------------

def test_each_yield_maps_to_its_provider_and_upstream_url():
    ten = market_sources.resolve_request('us-yields', 'US10Y', '1h')
    assert ten['provider'] == 'Yahoo' and ten['symbol'] == 'US10Y' and ten['interval'] == '1h'
    assert 'chart/%5ETNX' in ten['url'] and 'interval=60m' in ten['url'] and 'range=1y' in ten['url']
    assert ten['daily_only'] is False and 'Yahoo' in ten['note']

    two = market_sources.resolve_request('us-yields', 'US02Y', '1D')
    assert two['provider'] == 'FRED' and 'id=DGS2' in two['url'] and '&cosd=' in two['url']
    assert two['daily_only'] is True and 'FRED' in two['note']

    for symbol, index in [('US03M', '%5EIRX'), ('US05Y', '%5EFVX'), ('US30Y', '%5ETYX')]:
        assert f'chart/{index}' in market_sources.resolve_request('us-yields', symbol, '1D')['url']
        assert market_sources.resolve_request('us-yields', symbol, '5m')['provider'] == 'Yahoo'
    # The 2 and the 20 year have no Cboe index, so FRED's own series is the only source they have.
    for symbol, series in [('US02Y', 'DGS2'), ('US20Y', 'DGS20')]:
        resolved = market_sources.resolve_request('us-yields', symbol, '1D')
        assert resolved['provider'] == 'FRED' and f'id={series}' in resolved['url']


def test_the_default_range_follows_the_interval():
    def default(**kwargs):
        return market_sources.resolve_request('us-yields', kwargs['symbol'], kwargs['interval'])['range']

    assert default(symbol='US10Y', interval='1m') == '5d'
    assert default(symbol='US10Y', interval='15m') == '1mo'
    assert default(symbol='US10Y', interval='1h') == '1y'
    assert default(symbol='US10Y', interval='1D') == '10y'
    # FRED has its own set (no intraday ranges at all).
    assert default(symbol='US02Y', interval='1D') == '10y'
    # An explicit range is kept.
    assert market_sources.resolve_request('us-yields', 'US10Y', '1D', 'max')['range'] == 'max'


def test_only_daily_candles_exist_for_the_two_and_the_twenty_year():
    with pytest.raises(market_sources.MarketSourceError) as error:
        market_sources.resolve_request('us-yields', 'US02Y', '5m')
    assert error.value.status_code == 400 and '1D' in str(error.value)
    # The Yahoo-backed ones keep their intraday intervals.
    assert market_sources.resolve_request('us-yields', 'US30Y', '5m')['provider'] == 'Yahoo'


def test_anything_outside_the_whitelist_is_a_readable_400():
    cases = [
        {'source': 'binance-perp', 'symbol': 'US10Y', 'interval': '5m'},
        {'source': 'us-yields', 'symbol': 'US07Y', 'interval': '5m'},
        {'source': 'us-yields', 'symbol': '', 'interval': '5m'},
        {'source': 'us-yields', 'symbol': 'US10Y', 'interval': '3m'},
        {'source': 'us-yields', 'symbol': 'US10Y', 'interval': '4h'},
        {'source': 'us-yields', 'symbol': 'US10Y', 'interval': ''},
        {'source': 'us-yields', 'symbol': 'US10Y', 'interval': '5m', 'range': '5y'},
        {'source': 'us-yields', 'symbol': 'US02Y', 'interval': '1D', 'range': '5d'},
    ]
    for case in cases:
        with pytest.raises(market_sources.MarketSourceError) as error:
            market_sources.resolve_request(case.pop('source'), case.pop('symbol'), case.pop('interval'),
                                           case.pop('range', None))
        assert error.value.status_code == 400, case
        # Every message is Chinese and names what is allowed, so the page can show it as it is.
        assert any(word in str(error.value) for word in ('只能', '不支持', '可选', '只有')), str(error.value)


# --- The route ----------------------------------------------------------------------------------------------------

def test_each_provider_gets_the_user_agent_it_accepts():
    # Yahoo 429s anything that is not a browser; FRED's edge resets connections that claim to be one.
    assert market_sources.user_agent('Yahoo').startswith('Mozilla/5.0')
    assert market_sources.user_agent('FRED').startswith('python-requests/')
    assert 'steven' not in market_sources.user_agent('Yahoo').lower()


def test_the_route_requires_auth(client):
    assert client.post('/review/market/candles',
                       json={'source': 'us-yields', 'symbol': 'US10Y', 'interval': '5m'}).status_code == 401


def test_the_route_returns_the_candles_of_the_whitelisted_series(client, monkeypatch):
    candles = [{'time': 1763178600, 'open': 4.11, 'high': 4.13, 'low': 4.09, 'close': 4.12, 'volume': 0.0}]
    calls = []

    def fake_fetch(request):
        calls.append(request)
        return candles

    monkeypatch.setattr(market_sources, 'fetch_candles', fake_fetch)
    response = ask(client)
    assert response.status_code == 200
    body = response.json()
    assert body['candles'] == candles
    assert body['provider'] == 'Yahoo' and body['delayed'] is True
    assert 'Yahoo' in body['note'] and '延迟' in body['note']
    assert body['symbol'] == 'US10Y' and body['interval'] == '5m'
    assert body['cached'] is False and calls and calls[0]['provider'] == 'Yahoo'


def test_the_same_series_is_cached_for_thirty_seconds(client, monkeypatch):
    calls = []

    def fake_fetch(request):
        calls.append(request)
        return [{'time': 1763178600, 'open': 4.1, 'high': 4.1, 'low': 4.1, 'close': 4.1, 'volume': 0.0}]

    monkeypatch.setattr(market_sources, 'fetch_candles', fake_fetch)
    assert ask(client).status_code == 200
    second = ask(client)
    assert second.status_code == 200 and second.json()['cached'] is True
    assert len(calls) == 1, 'the second answer must come from the cache'
    # A different range is a different series.
    assert ask(client, range='5d').status_code == 200
    assert len(calls) == 2


def test_an_upstream_failure_is_a_502_with_a_chinese_reason(client, monkeypatch):
    def failing_fetch(request):
        raise market_sources.MarketSourceError('从 Yahoo 取美债数据失败：timeout', status_code=502)

    monkeypatch.setattr(market_sources, 'fetch_candles', failing_fetch)
    response = ask(client)
    assert response.status_code == 502
    assert 'Yahoo' in response.json()['error']


def test_a_bad_request_is_a_400_before_any_upstream_call(client, monkeypatch):
    def never(_request):
        raise AssertionError('a rejected request must not reach the upstream')

    monkeypatch.setattr(market_sources, 'fetch_candles', never)
    for body in [{'symbol': 'US07Y'}, {'interval': '3m'}, {'source': 'binance-spot'}, {'range': '5y'}]:
        response = ask(client, **body)
        assert response.status_code == 400, body
        assert response.json()['error']
    assert ask(client, symbol='US02Y', interval='5m').status_code == 400


def test_the_fred_answer_says_it_is_daily(client, monkeypatch):
    monkeypatch.setattr(market_sources, 'fetch_candles',
                        lambda request: [{'time': 1794441600, 'open': 3.58, 'high': 3.58, 'low': 3.58,
                                          'close': 3.58, 'volume': 0.0}])
    body = ask(client, symbol='US02Y', interval='1D', range='1mo').json()
    assert body['provider'] == 'FRED' and body['daily_only'] is True
    assert '日线' in body['note']
    # JSON-serializable as sent: ints stay ints, floats stay floats.
    assert json.loads(json.dumps(body['candles'])) == body['candles']


# --- Deepcoin (T-54) ---------------------------------------------------------------------------------------------
# The owner's own venue: it sends no CORS header, so the page asks Jesse for its candles and its product list. The
# fixture below is a trimmed answer of `api.deepcoin.com/deepcoin/market/candles` (newest first, strings).

DEEPCOIN_CANDLES = {
    'code': '0',
    'msg': '',
    'data': [
        ['1794841200000', '65140.1', '65149.3', '64763.6', '64800', '431405', '27999710.226200007'],
        ['1794840300000', '65263.9', '65380.5', '65016.1', '65140.1', '896382', '58420148.78910008'],
        ['1794839400000', '64459.2', '65666', '64388.8', '65263.9', '4099036', '267155383.96530026'],
    ],
}

DEEPCOIN_TICKERS = {
    'code': '0',
    'data': [
        {'instType': 'SWAP', 'instId': 'BCH-USD-SWAP', 'last': '206.68', 'open24h': '207.76', 'volCcy24h': '29722.5'},
        {'instType': 'SWAP', 'instId': 'ETH-USDT-SWAP', 'last': '1821', 'open24h': '1808.85', 'volCcy24h': '1167'},
        {'instType': 'SWAP', 'instId': 'BTC-USDT-SWAP', 'last': '64800', 'open24h': '64720.1', 'volCcy24h': '2100'},
        {'instType': 'SWAP', 'instId': 'DEAD-USDT-SWAP', 'last': '0', 'open24h': '1', 'volCcy24h': '9'},
        {'instType': 'SWAP', 'instId': 'NOVOL-USDT-SWAP', 'last': '5', 'open24h': None, 'volCcy24h': None},
    ],
}


def ask_deepcoin(client, **body):
    payload = {'source': 'deepcoin', 'market': 'swap', 'symbol': 'BTC-USDT-SWAP', 'interval': '15m'}
    payload.update(body)
    return client.post('/review/market/candles', json=payload, headers=HEADERS)


def test_deepcoin_candles_are_reversed_and_the_unfinished_bar_is_split_off():
    # 1794841200000 + 15 minutes is still in the future for this clock: that newest row is the forming bar.
    answer = market_sources.parse_deepcoin_candles(DEEPCOIN_CANDLES['data'], '15m', now_ms=1794841300000)
    assert [candle['time'] for candle in answer['closed']] == [1794839400, 1794840300]
    assert answer['closed'][0] == {'time': 1794839400, 'open': 64459.2, 'high': 65666.0, 'low': 64388.8,
                                   'close': 65263.9, 'volume': 4099036.0}
    assert answer['forming'] == {'time': 1794841200, 'open': 65140.1, 'high': 65149.3, 'low': 64763.6,
                                 'close': 64800.0, 'volume': 431405.0}
    # A minute after that window closed, the same row is closed data and nothing is forming.
    later = market_sources.parse_deepcoin_candles(DEEPCOIN_CANDLES['data'], '15m', now_ms=1794842200000)
    assert later['forming'] is None
    assert len(later['closed']) == 3


def test_broken_deepcoin_rows_are_dropped_instead_of_drawn():
    rows = DEEPCOIN_CANDLES['data'] + [
        None, [], ['x', '1', '1', '1', '1', '1'],
        ['1794842100000', '1', '0.5', '2', '1', '1'],   # high below the open
        ['1794842100000', '1', '2', '0.5', '1', '-3'],  # negative volume becomes 0
    ]
    answer = market_sources.parse_deepcoin_candles(rows, '15m', now_ms=1794842200000)
    assert [candle['time'] for candle in answer['closed']] == sorted(
        [1794839400, 1794840300, 1794841200, 1794842100])
    assert answer['closed'][-1]['volume'] == 0.0
    for broken in [None, {}, 'nope', [[]]]:
        assert market_sources.parse_deepcoin_candles(broken, '15m', now_ms=0) == {'closed': [], 'forming': None}


def test_each_deepcoin_request_is_built_from_the_whitelist():
    request = market_sources.resolve_deepcoin_request('swap', 'BTC-USDT-SWAP', '1H', 1000)
    assert request['url'] == ('https://api.deepcoin.com/deepcoin/market/candles'
                              '?instId=BTC-USDT-SWAP&bar=1H&limit=1000')
    assert request['symbol'] == 'BTC-USDT-SWAP' and request['market'] == 'swap' and request['limit'] == 1000
    # An older page: `before` is the open time in seconds, Deepcoin's `after` in milliseconds. One millisecond is
    # taken off because the venue answers with that very bar too (checked 2026-11-16) and a page that only repeats
    # the bar already loaded would look like the end of the history.
    older = market_sources.resolve_deepcoin_request('spot', 'eth-usdt', '1m', 300, 1794841200.7)
    assert older['url'].endswith('?instId=ETH-USDT&bar=1m&limit=300&after=1794841199999')
    # The default page size is 300: enough for a chart, small enough for the 2-second cache.
    assert market_sources.resolve_deepcoin_request('swap', 'BTC-USDT-SWAP', '5m')['limit'] == 300


def test_anything_outside_the_deepcoin_whitelist_is_a_readable_400():
    cases = [
        {'market': 'margin', 'symbol': 'BTC-USDT-SWAP', 'interval': '15m'},
        {'market': 'swap', 'symbol': 'BTCUSD', 'interval': '15m'},
        {'market': 'swap', 'symbol': 'BTC-USDT', 'interval': '15m'},      # a spot pair asked for as a swap
        {'market': 'spot', 'symbol': 'BTC-USDT-SWAP', 'interval': '15m'},
        {'market': 'swap', 'symbol': 'btc/usdt/swap', 'interval': '15m'},
        {'market': 'swap', 'symbol': 'BTC-USDT-SWAP', 'interval': '3m'},  # the venue has no 3m bar
        {'market': 'swap', 'symbol': 'BTC-USDT-SWAP', 'interval': '1h'},  # the venue spells it 1H
        {'market': 'swap', 'symbol': 'BTC-USDT-SWAP', 'interval': '15m', 'limit': 0},
        {'market': 'swap', 'symbol': 'BTC-USDT-SWAP', 'interval': '15m', 'limit': 5000},
        {'market': 'swap', 'symbol': 'BTC-USDT-SWAP', 'interval': '15m', 'before': 0},
    ]
    for case in cases:
        with pytest.raises(market_sources.MarketSourceError) as error:
            market_sources.resolve_deepcoin_request(**case)
        assert error.value.status_code == 400, case
        assert any(word in str(error.value) for word in ('只能', '不支持', '应为', '必须')), str(error.value)


def test_the_deepcoin_product_list_keeps_usdt_pairs_of_that_market_only():
    rows = market_sources.parse_deepcoin_tickers(DEEPCOIN_TICKERS, 'swap')
    # BCH-USD-SWAP is not USDT, DEAD-USDT-SWAP has no price: both drop out. Biggest turnover first.
    assert [row['symbol'] for row in rows] == ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'NOVOL-USDT-SWAP']
    assert rows[0] == {'symbol': 'BTC-USDT-SWAP', 'last': 64800.0, 'open24h': 64720.1, 'quoteVolume24h': 2100.0}
    # A missing 24h open / turnover is null / 0, never a made-up number.
    assert rows[2]['open24h'] is None and rows[2]['quoteVolume24h'] == 0.0
    # The spot list of the same answer: the perpetuals are not spot pairs, so they are not listed.
    assert market_sources.parse_deepcoin_tickers(DEEPCOIN_TICKERS, 'spot') == []
    for broken in [None, {}, {'data': None}, {'data': [None, {}]}, 'nope']:
        assert market_sources.parse_deepcoin_tickers(broken, 'swap') == []


def test_the_route_returns_deepcoin_candles_and_caches_them_for_two_seconds(client, monkeypatch):
    calls = []
    candles = [{'time': 1794839400, 'open': 64459.2, 'high': 65666.0, 'low': 64388.8, 'close': 65263.9,
                'volume': 4099036.0}]
    forming = {'time': 1794841200, 'open': 65140.1, 'high': 65149.3, 'low': 64763.6, 'close': 64800.0,
               'volume': 431405.0}

    def fake_fetch(request):
        calls.append(request)
        return {'closed': candles, 'forming': forming}

    monkeypatch.setattr(market_sources, 'fetch_deepcoin_candles', fake_fetch)
    response = ask_deepcoin(client)
    assert response.status_code == 200
    body = response.json()
    assert body['candles'] == candles and body['forming'] == forming
    assert body['source'] == 'deepcoin' and body['market'] == 'swap' and body['symbol'] == 'BTC-USDT-SWAP'
    assert body['interval'] == '15m' and body['cached'] is False and body['fetched_at'] > 0
    # The page polls every 3 seconds; the answer is cached for 2, so a second panel poll is free.
    second = ask_deepcoin(client)
    assert second.status_code == 200 and second.json()['cached'] is True
    assert len(calls) == 1
    # Another market / interval / page is another key.
    assert ask_deepcoin(client, interval='1H').status_code == 200
    assert ask_deepcoin(client, before=1794839400).status_code == 200
    assert len(calls) == 3


def test_the_route_returns_the_deepcoin_product_list(client, monkeypatch):
    monkeypatch.setattr(market_sources, 'fetch_deepcoin_tickers',
                        lambda market: [{'symbol': 'BTC-USDT-SWAP', 'last': 64800.0, 'open24h': 64720.1,
                                         'quoteVolume24h': 2100.0}])
    response = client.post('/review/market/tickers', json={'source': 'deepcoin', 'market': 'swap'}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body['market'] == 'swap' and body['cached'] is False
    assert body['tickers'][0]['symbol'] == 'BTC-USDT-SWAP'
    assert body['tickers'][0]['quoteVolume24h'] == 2100.0
    # A venue the browser reads directly is not proxied, and the market is whitelisted.
    for payload in [{'source': 'binance', 'market': 'swap'}, {'source': 'deepcoin', 'market': 'margin'},
                    {'source': 'deepcoin', 'market': None}]:
        bad = client.post('/review/market/tickers', json=payload, headers=HEADERS)
        assert bad.status_code == 400, payload
        assert bad.json()['error']


def test_the_deepcoin_routes_require_auth(client):
    assert client.post('/review/market/candles', json={'source': 'deepcoin', 'market': 'swap',
                                                       'symbol': 'BTC-USDT-SWAP', 'interval': '15m'}).status_code == 401
    assert client.post('/review/market/tickers', json={'source': 'deepcoin', 'market': 'swap'}).status_code == 401


def test_a_deepcoin_request_goes_out_anonymously_and_retries_with_a_browser_string(monkeypatch):
    class FakeResponse:
        def __init__(self, status, payload):
            self.status_code = status
            self.ok = status == 200
            self._payload = payload

        def json(self):
            return self._payload

    seen = []

    def refused_then_ok(url, headers=None, timeout=None):
        seen.append((url, (headers or {}).get('User-Agent')))
        return FakeResponse(403, {}) if len(seen) == 1 else FakeResponse(200, DEEPCOIN_CANDLES)

    monkeypatch.setattr(market_sources.requests, 'get', refused_then_ok)
    request = market_sources.resolve_deepcoin_request('swap', 'BTC-USDT-SWAP', '15m')
    answer = market_sources.fetch_deepcoin_candles(request)
    assert len(answer['closed']) == 3, 'the retried answer is the one that is parsed'
    # The first try sends no User-Agent of its own (requests' default), the retry the bare browser token.
    assert seen[0][1] is None
    assert seen[1][1] == market_sources.DEEPCOIN_FALLBACK_USER_AGENT == 'Mozilla/5.0'

    def always_502(url, headers=None, timeout=None):
        return FakeResponse(502, {})

    monkeypatch.setattr(market_sources.requests, 'get', always_502)
    with pytest.raises(market_sources.MarketSourceError) as error:
        market_sources.fetch_deepcoin_candles(request)
    assert error.value.status_code == 502 and 'Deepcoin' in str(error.value)

    def venue_error(url, headers=None, timeout=None):
        return FakeResponse(200, {'code': '51', 'msg': 'The bar value `3m` is not in acceptable range', 'data': None})

    monkeypatch.setattr(market_sources.requests, 'get', venue_error)
    with pytest.raises(market_sources.MarketSourceError) as error:
        market_sources.fetch_deepcoin_candles(request)
    assert error.value.status_code == 502 and '3m' in str(error.value)


def test_an_empty_deepcoin_page_is_a_502_instead_of_a_chart(client, monkeypatch):
    def empty(_request):
        raise market_sources.MarketSourceError('Deepcoin 这次没有返回 BTC-USDT-SWAP 的 K 线，稍后再试', status_code=502)

    monkeypatch.setattr(market_sources, 'fetch_deepcoin_candles', empty)
    response = ask_deepcoin(client)
    assert response.status_code == 502
    assert 'Deepcoin' in response.json()['error']
    # A whitelist failure is a 400 and never reaches the venue.
    def never(_request):
        raise AssertionError('a rejected request must not reach the upstream')

    monkeypatch.setattr(market_sources, 'fetch_deepcoin_candles', never)
    for body in [{'interval': '3m'}, {'market': 'margin'}, {'symbol': 'BTCUSD'}, {'limit': 5000}]:
        assert ask_deepcoin(client, **body).status_code == 400, body
