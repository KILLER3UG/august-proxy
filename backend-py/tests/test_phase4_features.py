"""Tests for Phase 4: Product Features (health, errors, envelope).

(The project_readiness tests were removed with Part 25 Phase 6 — the
project_readiness/guidance/automation_gate/provider_detect/august_api service
cluster had zero production importers and was deleted.)"""

import pytest
from app.lib.api_envelope import error, paginated, success
from app.lib.error_messages import map_provider_error
from app.services.health_monitor import HealthMonitor, ProbeResult, ProviderHealth

# ─── Health Monitor (4.2) ─────────────────────────────────────────────────────


class TestHealthMonitor:
    def test_register_and_status(self):
        monitor = HealthMonitor()
        monitor.register_provider('p1', 'OpenAI', 'https://api.openai.com/v1')
        health = monitor.get_provider_health('p1')
        assert health is not None
        assert health['status'] == 'unknown'  # No probes yet

    def test_healthy_after_successful_probes(self):
        monitor = HealthMonitor()
        monitor.register_provider('p1', 'Test', 'http://localhost')
        # Simulate successful probes
        for _ in range(3):
            monitor._providers['p1'].probes.append(
                ProbeResult(provider_id='p1', success=True, latency_ms=100)
            )
        assert monitor._providers['p1'].status == 'healthy'

    def test_degraded_after_mixed_probes(self):
        monitor = HealthMonitor()
        monitor.register_provider('p1', 'Test', 'http://localhost')
        probes = monitor._providers['p1'].probes
        probes.append(ProbeResult(provider_id='p1', success=True, latency_ms=100))
        probes.append(ProbeResult(provider_id='p1', success=True, latency_ms=100))
        probes.append(ProbeResult(provider_id='p1', success=False, latency_ms=5000, error='timeout'))
        assert monitor._providers['p1'].status == 'degraded'

    def test_unreachable_after_all_failures(self):
        monitor = HealthMonitor()
        monitor.register_provider('p1', 'Test', 'http://localhost')
        for _ in range(3):
            monitor._providers['p1'].probes.append(
                ProbeResult(provider_id='p1', success=False, latency_ms=5000, error='refused')
            )
        assert monitor._providers['p1'].status == 'unreachable'

    def test_get_all_health(self):
        monitor = HealthMonitor()
        monitor.register_provider('p1', 'A', 'http://a')
        monitor.register_provider('p2', 'B', 'http://b')
        all_health = monitor.get_all_health()
        assert len(all_health) == 2

    def test_unregister(self):
        monitor = HealthMonitor()
        monitor.register_provider('p1', 'A', 'http://a')
        monitor.unregister_provider('p1')
        assert monitor.get_provider_health('p1') is None


# ─── Error Messages (4.3) ─────────────────────────────────────────────────────


class TestErrorMessages:
    def test_401_maps_to_settings(self):
        result = map_provider_error(401, 'OpenAI')
        assert result['action']['type'] == 'settings_link'
        assert 'key' in result['message'].lower()

    def test_429_includes_retry(self):
        result = map_provider_error(429, 'Anthropic', detail='retry after 30 seconds')
        assert result['action']['type'] == 'retry'
        assert result['action']['delayS'] == 30

    def test_404_model_includes_switch_format(self):
        result = map_provider_error(404, 'OpenRouter', model='claude-3', api_format='chat/completions')
        assert result['action']['type'] == 'switch_format'
        assert 'claude-3' in result['message']

    def test_400_session_id_null(self):
        result = map_provider_error(400, 'OpenCode', detail='session_id: Invalid input: expected string, received null')
        assert 'session_id' in result['message']

    def test_500_server_error(self):
        result = map_provider_error(502, 'Provider')
        assert result['action']['type'] == 'retry'
        assert result['severity'] == 'warning'

    def test_timeout(self):
        result = map_provider_error(0, 'Slow Provider')
        assert 'timed out' in result['message']
        assert result['action']['type'] == 'check_network'


# ─── API Envelope (4.8) ───────────────────────────────────────────────────────


class TestApiEnvelope:
    def test_success_envelope(self):
        result = success({'key': 'value'})
        assert result['ok'] is True
        assert result['formatVersion'] == '1.0'
        assert result['data'] == {'key': 'value'}

    def test_error_envelope(self):
        result = error('NOT_FOUND', 'Provider not found', hint='Check the ID')
        assert result['ok'] is False
        assert result['error']['code'] == 'NOT_FOUND'
        assert result['error']['hint'] == 'Check the ID'

    def test_paginated_envelope(self):
        result = paginated([1, 2, 3], total=10, offset=0, limit=3)
        assert result['ok'] is True
        assert result['meta']['pagination']['hasMore'] is True
        assert result['meta']['pagination']['total'] == 10

    def test_paginated_no_more(self):
        result = paginated([1, 2], total=2, offset=0, limit=5)
        assert result['meta']['pagination']['hasMore'] is False
