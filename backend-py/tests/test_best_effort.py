"""best_effort(site) — named swallows (audit B1 / P0#4)."""

from __future__ import annotations

import asyncio
import logging

import pytest
from app.services import best_effort as be


def test_swallow_logs_site_and_traceback(caplog):
    with caplog.at_level(logging.DEBUG, logger=be.logger.name):
        with be.best_effort('test.site'):
            raise ValueError('boom')
    record = next(r for r in caplog.records if r.getMessage().startswith('best_effort[test.site]'))
    assert record.exc_info is not None
    assert isinstance(record.exc_info[1], ValueError)


def test_no_exception_logs_nothing(caplog):
    with caplog.at_level(logging.DEBUG, logger=be.logger.name):
        with be.best_effort('test.quiet'):
            pass
    assert not [r for r in caplog.records if 'best_effort' in r.getMessage()]


def test_strict_env_reraises(monkeypatch):
    monkeypatch.setenv('AUGUST_STRICT_BEST_EFFORT', '1')
    with pytest.raises(ValueError, match='boom'):
        with be.best_effort('test.strict'):
            raise ValueError('boom')


def test_strict_env_false_values_still_swallow(monkeypatch, caplog):
    for raw in ('', '0', 'false', 'False'):
        monkeypatch.setenv('AUGUST_STRICT_BEST_EFFORT', raw)
        with caplog.at_level(logging.DEBUG, logger=be.logger.name):
            with be.best_effort('test.lenient'):
                raise ValueError('boom')
    assert any('best_effort[test.lenient]' in r.getMessage() for r in caplog.records)


def test_cancellation_is_never_swallowed():
    async def main() -> None:
        with be.best_effort('test.cancel'):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main())


def test_log_level_is_configurable(caplog):
    with caplog.at_level(logging.INFO, logger=be.logger.name):
        with be.best_effort('test.level', level=logging.INFO):
            raise ValueError('boom')
    assert any('best_effort[test.level]' in r.getMessage() for r in caplog.records)
