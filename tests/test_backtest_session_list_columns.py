import importlib

import peewee

from jesse.services import transformers

backtest_session_model = importlib.import_module('jesse.models.BacktestSession')

HEAVY_COLUMNS = ('chart_data', 'equity_curve', 'trades')


def _capture_list_sql(monkeypatch, **filters) -> str:
    """Build the list query and record its SQL; iterating it returns no rows, so no database is read."""
    captured = []

    def fake_iter(self):
        captured.append(self.sql()[0])
        return iter([])

    monkeypatch.setattr(peewee.ModelSelect, '__iter__', fake_iter)
    assert backtest_session_model.get_backtest_sessions(**filters) == []
    return captured[0]


def test_list_query_skips_the_heavy_result_columns(monkeypatch):
    sql = _capture_list_sql(monkeypatch, limit=100, title_search='x', status_filter='finished', date_filter='7_days')
    for column in HEAVY_COLUMNS:
        assert f'"{column}"' not in sql


def test_list_query_keeps_every_column_the_list_and_reconcile_read(monkeypatch):
    sql = _capture_list_sql(monkeypatch)
    needed = ('id', 'status', 'metrics', 'state', 'title', 'description', 'strategy_codes', 'exception',
              'execution_duration', 'created_at', 'updated_at', 'claimed_by', 'claim_id', 'heartbeat_at')
    for column in needed:
        assert f'"{column}"' in sql


def test_list_item_fields_are_unchanged():
    # A row as the list query returns it: the heavy columns are never loaded, so they stay None.
    row = backtest_session_model.BacktestSession(
        id='11111111-1111-1111-1111-111111111111', status='finished', metrics='{"net_profit_percentage": 12.5}',
        state='{"form": {}}', title='t', description='d', strategy_codes='{"A": "code"}',
        execution_duration=3.0, created_at=1, updated_at=2,
    )
    assert transformers.get_backtest_session(row) == {
        'id': '11111111-1111-1111-1111-111111111111', 'status': 'finished', 'created_at': 1, 'updated_at': 2,
        'execution_duration': 3.0, 'net_profit_percentage': 12.5, 'state': {'form': {}},
        'title': 't', 'description': 'd', 'strategy_codes': {'A': 'code'},
    }
