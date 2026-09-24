"""Truthful provider-native quota: header observations + opt-in endpoints.

What these tests protect:
  * Only standard x-ratelimit-* / ratelimit-* values ever become a quota.
  * A row reports source='native' only when a real limit was observed.
  * Everything else keeps the local-usage estimate (limit null, source local).
  * Declared endpoints are strictly opt-in, use the exact base URL, and a
    path that does not resolve yields nothing rather than a zero.
  * No provider-specific adapter is inferred: a provider nobody declared
    stays on local estimates forever.
"""

from __future__ import annotations

import json
import time

import pytest
from app.main import app
from app.providers.clients.base import ProviderResponse
from app.services.quota_endpoint import (
    apply_query_auth,
    build_quota_headers,
    extract_path,
    extract_quota,
    is_quota_endpoint_enabled,
    normalize_quota_endpoint_kind,
    resolve_quota_url,
)
from app.services.quota_observation import (
    QuotaObservationStore,
    parse_rate_limit_headers,
    parse_reset_seconds,
    quota_observations,
)
from fastapi.testclient import TestClient

# ── header parsing ──────────────────────────────────────────────────────


def test_parses_requests_and_tokens_buckets_separately():
    parsed = parse_rate_limit_headers(
        {
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '97',
            'x-ratelimit-reset-requests': '6m0s',
            'x-ratelimit-limit-tokens': '1000',
            'x-ratelimit-remaining-tokens': '900',
            'x-ratelimit-reset-tokens': '1m30s',
        }
    )
    assert parsed['requests']['limit'] == 100
    assert parsed['requests']['remaining'] == 97
    assert parsed['tokens']['limit'] == 1000
    assert parsed['tokens']['remaining'] == 900
    assert parsed['tokens']['reset'] > time.time()


def test_header_names_are_case_insensitive_and_ietf_spelling_counts():
    parsed = parse_rate_limit_headers({'X-RateLimit-Limit': '60', 'ratelimit-remaining': '12'})
    assert parsed['generic'] == {'limit': 60.0, 'remaining': 12.0}


def test_unrelated_headers_are_never_read_as_a_limit():
    assert parse_rate_limit_headers({'retry-after': '30', 'x-request-id': 'abc'}) == {}
    assert parse_rate_limit_headers(None) == {}
    assert parse_rate_limit_headers({'x-ratelimit-limit': 'not-a-number'}) == {}


def test_reset_accepts_duration_epoch_and_iso():
    now = 1_700_000_000.0
    assert parse_reset_seconds('6m0s', now=now) == pytest.approx(now + 360)
    assert parse_reset_seconds('90', now=now) == pytest.approx(now + 90)
    assert parse_reset_seconds('1700003600', now=now) == 1700003600
    assert parse_reset_seconds('2023-11-14T22:20:00Z', now=now) == 1700000400
    assert parse_reset_seconds('whenever', now=now) is None


# ── observation store ───────────────────────────────────────────────────


def test_store_prefers_tokens_bucket_and_computes_used():
    store = QuotaObservationStore(ttl_s=600)
    store.record_headers(
        {
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '10',
            'x-ratelimit-limit-tokens': '1000',
            'x-ratelimit-remaining-tokens': '250',
        },
        provider='P',
        model='m',
    )
    obs = store.best_for('P', 'm')
    assert obs is not None
    assert obs.bucket == 'tokens'
    assert obs.limit == 1000
    assert obs.remaining == 250
    assert obs.used == 750


def test_store_ignores_buckets_without_a_limit_for_row_selection():
    store = QuotaObservationStore(ttl_s=600)
    # A remaining-only header is real information but is not a quota row.
    store.record_headers({'x-ratelimit-remaining-tokens': '40'}, provider='P', model='m')
    assert store.best_for('P', 'm') is None
    assert store.get('P', 'm', 'tokens') is not None


def test_stale_observations_stop_counting():
    store = QuotaObservationStore(ttl_s=0.001)
    store.record_headers({'x-ratelimit-limit': '10'}, provider='P', model='m')
    time.sleep(0.01)
    assert store.get('P', 'm', 'generic') is None
    assert store.prune() == 1


def test_provider_response_exposes_and_captures_headers():
    from app.services.quota_observation import QuotaObservationStore

    store = QuotaObservationStore(ttl_s=600)
    resp = ProviderResponse(
        status=200,
        headers={'x-ratelimit-limit': '500', 'x-ratelimit-remaining': '480'},
        body={},
    )
    assert resp.rate_limit_observations == [{'bucket': 'generic', 'limit': 500.0, 'remaining': 480.0}]
    original = quota_observations
    try:
        import app.services.quota_observation as mod

        mod.quota_observations = store
        stored = resp.captureQuota('P', 'm')
    finally:
        import app.services.quota_observation as mod

        mod.quota_observations = original
    assert [o.limit for o in stored] == [500.0]
    assert store.best_for('P', 'm').remaining == 480


# ── declared endpoint: config + extractors ──────────────────────────────


def test_endpoint_kind_is_typed():
    assert normalize_quota_endpoint_kind('json') == 'json'
    assert normalize_quota_endpoint_kind('JSON') == 'json'
    assert normalize_quota_endpoint_kind('html') is None
    assert normalize_quota_endpoint_kind('') is None


def test_endpoint_is_opt_in_and_uses_the_exact_base():
    entry = {'name': 'P', 'baseUrl': 'https://api.example.com/v1'}
    assert is_quota_endpoint_enabled(entry) is False
    configured = {
        **entry,
        'quotaEndpoint': {'kind': 'json', 'url': 'usage', 'extract': {'limit': 'limit'}},
    }
    assert is_quota_endpoint_enabled(configured) is True
    # No invented /v1: the path joins the base exactly as pasted.
    assert resolve_quota_url('https://api.example.com/v1', {'url': 'usage'}) == 'https://api.example.com/v1/usage'
    assert resolve_quota_url('https://api.example.com', {'url': 'usage'}) == 'https://api.example.com/usage'
    # An absolute URL bypasses the base entirely, and is used verbatim.
    assert resolve_quota_url('https://api.example.com/v1', {'url': 'https://other.test/q'}) == 'https://other.test/q'


def test_extract_path_reads_dotted_and_indexed_paths():
    payload = {'data': {'items': [{'limit': 5}], 'quota': {'limit': 9}}}
    assert extract_path(payload, 'data.quota.limit') == 9
    assert extract_path(payload, 'data.items[0].limit') == 5
    assert extract_path(payload, 'data.missing') is None
    assert extract_path(payload, 'data.items[3].limit') is None
    assert extract_path(payload, '') is None


def test_extractors_only_read_stated_numbers():
    endpoint = {
        'extract': {'limit': 'data.limit', 'remaining': 'data.remaining', 'reset': 'data.reset'},
        '_payload': {'data': {'limit': 1000, 'remaining': 250, 'reset': 1700003600}},
    }
    obs = extract_quota(endpoint, provider='P', model='m')
    assert (obs.limit, obs.remaining, obs.used) == (1000, 250, 750)
    assert obs.reset_at == 1700003600

    # A path the provider does not publish is "not stated", never zero.
    partial = extract_quota(
        {'extract': {'limit': 'data.limit', 'remaining': 'data.nope'}, '_payload': {'data': {'limit': 10}}},
        provider='P',
        model='m',
    )
    assert partial.limit == 10
    assert partial.remaining is None
    assert partial.used is None

    # Nothing stated at all → no observation, so the row stays local.
    assert extract_quota({'extract': {'limit': 'data.limit'}, '_payload': {'data': {}}}, provider='P', model='m') is None


def test_used_only_payload_derives_limit_and_remaining():
    obs = extract_quota(
        {'extract': {'used': 'data.used', 'limit': 'data.limit'}, '_payload': {'data': {'used': 250, 'limit': 1000}}},
        provider='P',
        model='m',
    )
    assert (obs.limit, obs.remaining, obs.used) == (1000, 750, 250)


def test_auth_reuses_the_provider_key_by_default():
    entry = {'quotaAuth': {'type': 'bearer'}}
    assert build_quota_headers(entry, api_key='sk-test')['Authorization'] == 'Bearer sk-test'
    custom = {'quotaAuth': {'type': 'header', 'header': 'x-api-key', 'prefix': 'Key '}}
    assert build_quota_headers(custom, api_key='sk-test')['x-api-key'] == 'Key sk-test'
    assert 'Authorization' not in build_quota_headers({'quotaAuth': {'type': 'none'}}, api_key='sk-test')
    assert build_quota_headers({'quotaAuth': {'type': 'bearer'}}, api_key='') == {'Accept': 'application/json'}


def test_query_auth_appends_the_parameter():
    url = apply_query_auth('https://api.example.com/usage?a=1', {'type': 'query', 'param': 'key'}, api_key='sk-test')
    assert url == 'https://api.example.com/usage?a=1&key=sk-test'
    # Bearer auth never touches the URL.
    assert apply_query_auth('https://api.example.com/usage', {'type': 'bearer'}, api_key='sk') == 'https://api.example.com/usage'


# ── the API surface ─────────────────────────────────────────────────────


@pytest.fixture()
def store_providers(isolatedData):
    """Write a providers.json for the quota route and yield its path."""

    def _write(entries):
        path = isolatedData / 'providers.json'
        path.write_text(json.dumps({'providers': entries}), encoding='utf-8')
        from app.services import model_service

        model_service.invalidate_cache()
        return path

    return _write


def test_quota_row_is_local_without_any_provider_statement(isolatedData):
    quota_observations.clear()
    client = TestClient(app)
    body = client.get('/api/providers/quota?provider=Test OpenAI&model=gpt-4o-mini').json()
    assert body['source'] == 'local'
    assert body['limit'] is None
    assert body['nativeUsed'] is None
    assert body['observedAt'] is None


def test_quota_row_is_native_only_with_a_real_observed_limit(isolatedData):
    quota_observations.clear()
    quota_observations.record_headers(
        {'x-ratelimit-limit-tokens': '10000', 'x-ratelimit-remaining-tokens': '2500'},
        provider='Test OpenAI',
        model='gpt-4o-mini',
    )
    client = TestClient(app)
    body = client.get('/api/providers/quota?provider=Test OpenAI&model=gpt-4o-mini').json()
    assert body['source'] == 'native'
    assert body['limit'] == 10000
    assert body['remaining'] == 2500
    assert body['nativeUsed'] == 7500
    assert body['percent'] == 75.0
    assert body['observedAt'] is not None
    quota_observations.clear()


def test_native_observation_surfaces_for_a_model_with_no_local_usage(isolatedData):
    quota_observations.clear()
    quota_observations.record_headers(
        {'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '40'},
        provider='Test OpenAI',
        model='never-called-model',
    )
    client = TestClient(app)
    rows = client.get('/api/providers/quota?provider=Test OpenAI').json()['results']
    row = next(r for r in rows if r['model'] == 'never-called-model')
    assert row['source'] == 'native'
    assert row['limit'] == 100
    quota_observations.clear()


def test_declared_endpoint_populates_a_native_row(store_providers, monkeypatch, isolatedData):
    quota_observations.clear()
    store_providers(
        [
            {
                'id': 'p1',
                'name': 'Endpoint Co',
                'baseUrl': 'https://api.endpoint.test/v1',
                'apiFormat': 'openaiChat',
                'apiKey': 'sk-test',
                'enabled': True,
                'models': [{'id': 'm1', 'name': 'm1'}],
                'quotaEndpoint': {
                    'kind': 'json',
                    'url': 'usage',
                    'extract': {'limit': 'data.limit', 'remaining': 'data.remaining', 'model': 'data.model'},
                },
                'quotaAuth': {'type': 'bearer'},
            }
        ]
    )

    seen: dict = {}

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {'data': {'limit': 500, 'remaining': 125, 'model': 'm1'}}

    class _Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def request(self, method, url, headers=None, json=None):
            seen.update({'method': method, 'url': url, 'headers': headers or {}})
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, 'AsyncClient', _Client)

    client = TestClient(app)
    body = client.get('/api/providers/quota?provider=Endpoint Co&model=m1').json()
    assert body['source'] == 'native'
    assert body['limit'] == 500
    assert body['nativeUsed'] == 375
    # Exact base: the relative path joined /v1 once, and the stored key was reused.
    assert seen['url'] == 'https://api.endpoint.test/v1/usage'
    assert seen['headers']['Authorization'] == 'Bearer sk-test'
    quota_observations.clear()


def test_declared_endpoint_failure_leaves_the_row_local(store_providers, monkeypatch, isolatedData):
    quota_observations.clear()
    store_providers(
        [
            {
                'id': 'p1',
                'name': 'Broken Co',
                'baseUrl': 'https://api.broken.test/v1',
                'apiFormat': 'openaiChat',
                'apiKey': 'sk-test',
                'enabled': True,
                'models': [{'id': 'm1', 'name': 'm1'}],
                'quotaEndpoint': {'kind': 'json', 'url': 'usage', 'extract': {'limit': 'data.limit'}},
            }
        ]
    )

    class _Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def request(self, *_args, **_kwargs):
            raise RuntimeError('unreachable')

    import httpx

    monkeypatch.setattr(httpx, 'AsyncClient', _Client)

    client = TestClient(app)
    body = client.get('/api/providers/quota?provider=Broken Co&model=m1').json()
    assert body['source'] == 'local'
    assert body['limit'] is None
    quota_observations.clear()


def test_provider_config_roundtrips_quota_blocks_and_hides_the_token(isolatedData):
    client = TestClient(app)
    patched = client.patch(
        '/api/providers/test-openai',
        json={
            'quotaEndpoint': {'kind': 'json', 'url': 'usage', 'extract': {'limit': 'data.limit'}},
            'quotaAuth': {'type': 'header', 'header': 'x-api-key', 'token': 'quota-secret'},
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body['quotaEndpoint']['url'] == 'usage'
    assert body['quotaAuth']['tokenSet'] is True
    assert 'quota-secret' not in patched.text

    listed = client.get('/api/providers').json()
    entry = next(p for p in listed if p['id'] == 'test-openai')
    assert entry['quotaEndpoint']['extract']['limit'] == 'data.limit'
    assert 'quota-secret' not in json.dumps(listed)

    cleared = client.patch('/api/providers/test-openai', json={'quotaEndpoint': None, 'quotaAuth': None})
    assert cleared.json()['quotaEndpoint'] is None
    assert cleared.json()['quotaAuth'] is None


def test_unsupported_quota_kind_is_rejected_at_the_write_door(isolatedData):
    client = TestClient(app)
    resp = client.patch('/api/providers/test-openai', json={'quotaEndpoint': {'kind': 'html', 'url': 'usage'}})
    assert resp.status_code == 422
