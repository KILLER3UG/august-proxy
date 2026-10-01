"""A managed-tool failure must leave a trace (triage #89).

`_record_tool_failure` was `return None` — a no-op with two call sites, both
handing it a real `{tool_name, args, error, phase}` dict that went nowhere. A
proxy managed tool that failed left nothing behind: not the log, not the turn
row, not the guardrail digest. The proxy path is where a failure is easiest to
lose, because there is no workbench session to hang an interception off.

These tests assert the failure is *visible* — and that it does not become the
leak it is reporting.
"""

from __future__ import annotations

import logging

import pytest
from app.adapters.proxy_tools import _record_tool_failure


class TestFailuresAreRecorded:
    def test_a_failure_reaches_the_log(self, caplog):
        with caplog.at_level(logging.WARNING, logger='app.adapters.proxy_tools'):
            _record_tool_failure(
                {
                    'tool_name': 'write_file',
                    'args': {'path': 'a.py'},
                    'error': 'stale write rejected',
                    'phase': 'proxy-managed-tool',
                }
            )
        assert any(r.levelno == logging.WARNING for r in caplog.records), (
            'a managed-tool failure was dropped without a trace'
        )

    def test_the_record_identifies_the_tool_and_the_cause(self, caplog):
        with caplog.at_level(logging.WARNING, logger='app.adapters.proxy_tools'):
            _record_tool_failure(
                {
                    'tool_name': 'run_command',
                    'args': {},
                    'error': 'sandbox denied',
                    'phase': 'openai-managed-tool',
                }
            )
        text = '\n'.join(r.getMessage() for r in caplog.records)
        assert 'run_command' in text, 'the record does not name the tool'
        assert 'sandbox denied' in text, 'the record does not carry the cause'
        assert 'openai-managed-tool' in text, 'the record does not carry the phase'

    def test_a_missing_field_does_not_raise(self, caplog):
        """Telemetry must never be the thing that breaks the proxy path."""
        with caplog.at_level(logging.WARNING, logger='app.adapters.proxy_tools'):
            _record_tool_failure({})
            _record_tool_failure({'tool_name': None, 'error': None, 'args': object()})

    def test_it_returns_none_so_callers_are_unchanged(self):
        assert _record_tool_failure({'tool_name': 'x'}) is None


class TestItDoesNotBecomeTheLeak:
    def test_a_large_argument_list_is_truncated(self, caplog):
        """A tool argument can be a whole file. The log must not become it."""
        with caplog.at_level(logging.WARNING, logger='app.adapters.proxy_tools'):
            _record_tool_failure(
                {
                    'tool_name': 'write_file',
                    'args': {'content': 'X' * 200_000},
                    'error': 'boom',
                    'phase': 'p',
                }
            )
        text = '\n'.join(r.getMessage() for r in caplog.records)
        assert len(text) < 2000, f'the record is {len(text)} chars — it copied the payload'
        assert 'X' * 5000 not in text

    def test_a_long_error_is_truncated(self, caplog):
        with caplog.at_level(logging.WARNING, logger='app.adapters.proxy_tools'):
            _record_tool_failure(
                {'tool_name': 't', 'args': {}, 'error': 'E' * 100_000, 'phase': 'p'}
            )
        text = '\n'.join(r.getMessage() for r in caplog.records)
        assert len(text) < 2000

    def test_unserialisable_args_do_not_raise(self, caplog):
        with caplog.at_level(logging.WARNING, logger='app.adapters.proxy_tools'):
            _record_tool_failure(
                {'tool_name': 't', 'args': {'f': object()}, 'error': 'boom', 'phase': 'p'}
            )
        assert caplog.records, 'an unserialisable payload swallowed the record entirely'