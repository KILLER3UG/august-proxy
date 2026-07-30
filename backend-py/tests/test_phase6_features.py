"""Tests for Phase 6: Developer Velocity features."""

import os

import pytest
from app.lib.features import _parse_features, get_all, is_enabled, reset
from app.lib.tracing import RequestTrace, TraceBuffer

# ─── Feature Flags (6.3) ──────────────────────────────────────────────────────


class TestFeatureFlags:
    def setup_method(self):
        reset()

    def test_all_enabled_by_default(self, monkeypatch):
        monkeypatch.delenv('AUGUST_FEATURES', raising=False)
        reset()
        assert is_enabled('browser') is True
        assert is_enabled('desktop') is True
        assert is_enabled('gateway_telegram') is True
        assert is_enabled('delta_engine') is True

    def test_selective_enable(self, monkeypatch):
        monkeypatch.setenv('AUGUST_FEATURES', 'browser,delta_engine')
        reset()
        assert is_enabled('browser') is True
        assert is_enabled('delta_engine') is True
        assert is_enabled('desktop') is False
        assert is_enabled('gateway_telegram') is False

    def test_empty_string_all_enabled(self, monkeypatch):
        monkeypatch.setenv('AUGUST_FEATURES', '')
        reset()
        assert all(get_all().values())

    def test_unknown_feature_returns_false(self, monkeypatch):
        monkeypatch.setenv('AUGUST_FEATURES', 'browser')
        reset()
        assert is_enabled('nonexistent_feature') is False

    def test_get_all_returns_dict(self, monkeypatch):
        monkeypatch.delenv('AUGUST_FEATURES', raising=False)
        reset()
        flags = get_all()
        assert isinstance(flags, dict)
        assert len(flags) == 6  # All known features

    def test_case_insensitive(self, monkeypatch):
        monkeypatch.setenv('AUGUST_FEATURES', 'Browser,DELTA_ENGINE')
        reset()
        assert is_enabled('browser') is True
        assert is_enabled('delta_engine') is True


# ─── Request Tracing (6.4) ────────────────────────────────────────────────────


class TestRequestTracing:
    def test_record_and_retrieve(self):
        buf = TraceBuffer(maxlen=10)
        trace = RequestTrace(
            request_id='req-1', method='POST', path='/v1/chat/completions',
            provider='openai', model='gpt-4o',
            route_resolve_ms=2.0, provider_connect_ms=150.0,
            first_token_ms=320.0, total_ms=1200.0, status_code=200,
        )
        buf.record(trace)
        recent = buf.get_recent(5)
        assert len(recent) == 1
        assert recent[0]['requestId'] == 'req-1'
        assert recent[0]['timing']['totalMs'] == 1200.0

    def test_ring_buffer_eviction(self):
        buf = TraceBuffer(maxlen=5)
        for i in range(10):
            buf.record(RequestTrace(request_id=f'req-{i}', method='GET', path='/v1/models'))
        recent = buf.get_recent(20)
        assert len(recent) == 5  # Only last 5 kept
        assert recent[0]['requestId'] == 'req-9'  # Newest first

    def test_stats_empty(self):
        buf = TraceBuffer()
        stats = buf.get_stats()
        assert stats['count'] == 0
        assert stats['avgTotalMs'] == 0

    def test_stats_with_data(self):
        buf = TraceBuffer()
        for i in range(10):
            buf.record(RequestTrace(
                request_id=f'r{i}', method='POST', path='/v1/chat',
                total_ms=100.0 + i * 10, first_token_ms=50.0 + i * 5,
            ))
        stats = buf.get_stats()
        assert stats['count'] == 10
        assert stats['avgTotalMs'] > 100
        assert stats['p95TotalMs'] >= stats['avgTotalMs']

    def test_to_dict_shape(self):
        trace = RequestTrace(request_id='x', method='POST', path='/v1/messages')
        d = trace.to_dict()
        assert 'requestId' in d
        assert 'timing' in d
        assert 'routeResolveMs' in d['timing']
        assert 'providerConnectMs' in d['timing']
        assert 'firstTokenMs' in d['timing']
        assert 'totalMs' in d['timing']


# ─── Doc Link Integrity (6.2) ─────────────────────────────────────────────────


class TestDocLinks:
    def test_script_exists(self):
        """The check-doc-links script exists and is runnable."""
        script_path = os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'check-doc-links.mjs')
        assert os.path.exists(script_path)
