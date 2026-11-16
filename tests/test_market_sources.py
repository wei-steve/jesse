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
