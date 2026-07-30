"""Tests for centralized logging configuration (Phase 1.2)."""

import json
import logging
import os
from unittest.mock import patch

import pytest
from app.lib.logging_config import (
    JsonFormatter,
    RequestIdFilter,
    _parse_level_overrides,
    request_id_var,
    setup_logging,
)


@pytest.fixture(autouse=True)
def _reset_logging():
    """Reset root logger after each test."""
    yield
    root = logging.getLogger()
    for h in root.handlers[:]:
        root.removeHandler(h)
    root.setLevel(logging.WARNING)


def test_json_formatter_output():
    """JSON formatter produces valid JSON with required fields."""
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name='app.providers',
        level=logging.INFO,
        pathname='test.py',
        lineno=1,
        msg='Provider connected',
        args=None,
        exc_info=None,
    )
    record.request_id = 'test-uuid-123'  # type: ignore[attr-defined]

    output = formatter.format(record)
    data = json.loads(output)

    assert data['level'] == 'INFO'
    assert data['module'] == 'app.providers'
    assert data['msg'] == 'Provider connected'
    assert data['request_id'] == 'test-uuid-123'
    assert 'ts' in data


def test_json_formatter_omits_empty_request_id():
    """Request ID field is omitted when empty."""
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name='app.test',
        level=logging.WARNING,
        pathname='test.py',
        lineno=1,
        msg='no request',
        args=None,
        exc_info=None,
    )
    record.request_id = ''  # type: ignore[attr-defined]

    output = formatter.format(record)
    data = json.loads(output)
    assert 'request_id' not in data


def test_request_id_filter_injects_contextvar():
    """RequestIdFilter reads from the contextvar."""
    filt = RequestIdFilter()
    record = logging.LogRecord(
        name='x', level=logging.INFO, pathname='', lineno=0, msg='', args=None, exc_info=None
    )

    # Without setting contextvar
    filt.filter(record)
    assert record.request_id == ''  # type: ignore[attr-defined]

    # With contextvar set
    token = request_id_var.set('req-abc')
    filt.filter(record)
    assert record.request_id == 'req-abc'  # type: ignore[attr-defined]
    request_id_var.reset(token)


def test_parse_level_overrides():
    """AUGUST_LOG_LEVELS env var is parsed correctly."""
    with patch.dict(os.environ, {'AUGUST_LOG_LEVELS': 'providers:DEBUG,adapters:WARNING'}):
        overrides = _parse_level_overrides()
    assert overrides == {'providers': logging.DEBUG, 'adapters': logging.WARNING}


def test_parse_level_overrides_empty():
    """Empty env var returns empty dict."""
    with patch.dict(os.environ, {'AUGUST_LOG_LEVELS': ''}):
        overrides = _parse_level_overrides()
    assert overrides == {}


def test_parse_level_overrides_invalid_ignored():
    """Invalid level names are silently ignored."""
    with patch.dict(os.environ, {'AUGUST_LOG_LEVELS': 'foo:NOTALEVEL,bar:INFO'}):
        overrides = _parse_level_overrides()
    assert overrides == {'bar': logging.INFO}


def test_setup_logging_configures_root():
    """setup_logging replaces handlers and sets INFO level."""
    setup_logging()
    root = logging.getLogger()
    assert root.level == logging.INFO
    assert len(root.handlers) == 1
    assert isinstance(root.handlers[0].formatter, JsonFormatter)


def test_setup_logging_applies_module_overrides():
    """Per-module levels from env are applied."""
    with patch.dict(os.environ, {'AUGUST_LOG_LEVELS': 'app.providers:DEBUG'}):
        setup_logging()
    assert logging.getLogger('app.providers').level == logging.DEBUG


def test_setup_logging_idempotent():
    """Calling setup_logging twice doesn't duplicate handlers."""
    setup_logging()
    setup_logging()
    root = logging.getLogger()
    assert len(root.handlers) == 1


def test_setup_logging_text_format():
    """AUGUST_LOG_FORMAT=text uses TextFormatter."""
    with patch.dict(os.environ, {'AUGUST_LOG_FORMAT': 'text'}):
        setup_logging()
    root = logging.getLogger()
    from app.lib.logging_config import TextFormatter
    assert isinstance(root.handlers[0].formatter, TextFormatter)
