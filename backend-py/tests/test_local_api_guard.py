"""Tests for the trusted-origin guard on the local management API.

Locks in the A1 fix: a page open in a browser on this machine must not be able
to drive ``/api/*`` (which can synthesize desktop input, register MCP servers,
reload hooks, purge memory), while the Tauri webview, non-browser callers and
the external ``/v1/*`` proxy keep working.
"""

from __future__ import annotations

import pytest
from app.lib.local_api_guard import trusted_origins
from app.main import app
from fastapi.testclient import TestClient

EVIL = 'https://evil.example'
TRUSTED = 'tauri://localhost'


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


# --- the guard itself -------------------------------------------------------


def test_localhost_client_without_origin_is_allowed(client: TestClient) -> None:
    """curl / SDKs / the test suite send no Origin and must pass untouched."""
    assert client.get('/api/health').status_code == 200


def test_trusted_webview_origin_is_allowed(client: TestClient) -> None:
    response = client.get('/api/health', headers={'Origin': TRUSTED})
    assert response.status_code == 200


def test_foreign_origin_get_is_rejected(client: TestClient) -> None:
    response = client.get('/api/health', headers={'Origin': EVIL})
    assert response.status_code == 403
    body = response.json()
    assert body['code'] == 'untrusted_origin'
    # The reply must not be readable by the foreign page that asked for it.
    assert 'access-control-allow-origin' not in {k.lower() for k in response.headers}


def test_foreign_origin_state_changing_call_is_rejected(client: TestClient) -> None:
    """The dangerous surface is POST — assert it never reaches a handler."""
    response = client.post(
        '/api/desktop-automation/action',
        json={'action': 'click', 'params': {'x': 1, 'y': 1}},
        headers={'Origin': EVIL},
    )
    assert response.status_code == 403
    assert response.json()['code'] == 'untrusted_origin'


def test_cross_site_sec_fetch_site_is_rejected_without_origin(client: TestClient) -> None:
    """Some browsers omit Origin on a navigation-shaped request; Sec-Fetch-Site
    is the fallback signal for the same drive-by."""
    response = client.get('/api/health', headers={'Sec-Fetch-Site': 'cross-site'})
    assert response.status_code == 403


def test_same_origin_sec_fetch_site_passes(client: TestClient) -> None:
    response = client.get('/api/health', headers={'Sec-Fetch-Site': 'same-origin'})
    assert response.status_code == 200


def test_preflight_is_not_consumed_by_the_guard(client: TestClient) -> None:
    """CORS answers preflight outside this middleware; a foreign preflight must
    not turn into a 403 from us (it is harmless and would confuse debugging)."""
    response = client.options('/api/health', headers={'Origin': EVIL})
    assert response.status_code != 403


def test_v1_proxy_surface_is_not_guarded(client: TestClient) -> None:
    """/v1/* is the *external* endpoint and is gated by the gateway bearer key;
    Claude Code / SDK clients send no Origin and must not be treated as
    drive-by browsers."""
    response = client.get('/v1/models', headers={'Origin': EVIL})
    assert response.status_code != 403 or response.json().get('code') != 'untrusted_origin'


def test_websocket_handshake_from_foreign_origin_is_refused(client: TestClient) -> None:
    """The log stream carries prompt bodies — a cross-site WS upgrade is the
    worst single leak on this surface, so the guard must cover the WS scope."""
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises((WebSocketDisconnect, RuntimeError, OSError)):
        with client.websocket_connect('/api/logs/stream', headers={'Origin': EVIL}):
            pytest.fail('handshake from an untrusted origin must not complete')


# --- allowlist normalization ------------------------------------------------


def test_origin_comparison_ignores_case_and_trailing_slash() -> None:
    allowed = trusted_origins(['Tauri://localhost/', 'http://127.0.0.1:8756/'])
    assert 'tauri://localhost' in allowed
    assert 'http://127.0.0.1:8756' in allowed
    assert 'http://127.0.0.1:8756/' not in allowed


def test_blank_allowlist_entries_are_dropped() -> None:
    assert trusted_origins(['', '  ', 'https://a']) == frozenset({'https://a'})


def test_unprefixed_path_is_not_guarded() -> None:
    """/apifoo must not be swept up by the /api/ prefix test."""
    from app.lib.local_api_guard import TrustedOriginGuard

    assert TrustedOriginGuard._is_guarded('/api/health') is True
    assert TrustedOriginGuard._is_guarded('/mcp/harness') is True
    assert TrustedOriginGuard._is_guarded('/apifoo') is False
    assert TrustedOriginGuard._is_guarded('/v1/models') is False
