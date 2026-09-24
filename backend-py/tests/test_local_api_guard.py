"""Tests for the trusted-origin guard on the local management API.

Locks in the A1 fix: a page open in a browser on this machine must not be able
to drive ``/api/*`` (which can synthesize desktop input, register MCP servers,
reload hooks, purge memory), while the Tauri webview, non-browser callers and
the external ``/v1/*`` proxy keep working.

Also locks in the scoped-origin rule: the Surfer waveform viewer embed is a
separate program that needs exactly one read-only route and must NOT inherit
the rest of the management API.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from app.lib.local_api_guard import SCOPED_ORIGIN_RULES, trusted_origins
from app.main import app
from fastapi.testclient import TestClient

EVIL = 'https://evil.example'
TRUSTED = 'tauri://localhost'
SURFER = 'https://app.surfer-project.org'
RAW_FILE_ROUTE = '/api/workbench/files/raw'


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


# --- scoped origins (Surfer waveform embed) --------------------------------


@pytest.fixture()
def waveform_file() -> Iterator[Path]:
    """A file the raw-file route will serve: the temp dir is always a root."""
    import tempfile

    target = Path(tempfile.gettempdir()) / 'august-guard-scoped-test.vcd'
    target.write_text('$times 1ns $end\n$end\n', encoding='utf-8')
    yield target
    try:
        target.unlink()
    except OSError:
        pass


def test_scoped_origin_get_on_raw_file_route_is_allowed(client: TestClient, waveform_file: Path) -> None:
    """The embed is a separate program that exists to read waveform bytes —
    that exact read is what it is trusted for."""
    response = client.get(
        RAW_FILE_ROUTE,
        params={'path': str(waveform_file)},
        headers={'Origin': SURFER},
    )
    assert response.status_code == 200
    assert response.text.startswith('$times')


def test_scoped_origin_response_is_readable_by_cors(client: TestClient, waveform_file: Path) -> None:
    """CORS keeps the origin in allow_origins so the embed can read the bytes."""
    response = client.get(
        RAW_FILE_ROUTE,
        params={'path': str(waveform_file)},
        headers={'Origin': SURFER},
    )
    assert response.headers.get('access-control-allow-origin') == SURFER


def test_scoped_origin_head_passes_the_guard(client: TestClient, waveform_file: Path) -> None:
    """HEAD is in the read-only slice, so the guard must let it through to the
    router (which answers 405 itself — this route is registered GET-only)."""
    response = client.head(
        RAW_FILE_ROUTE,
        params={'path': str(waveform_file)},
        headers={'Origin': SURFER},
    )
    assert response.status_code != 403
    assert 'untrusted_origin' not in response.text


def test_scoped_origin_is_rejected_on_management_api(client: TestClient) -> None:
    """Being in the CORS allowlist is not trust for the whole API: a read-only
    embed must not be able to read state it never needed."""
    response = client.get('/api/health', headers={'Origin': SURFER})
    assert response.status_code == 403
    assert response.json()['code'] == 'untrusted_origin'
    assert 'access-control-allow-origin' not in {k.lower() for k in response.headers}


def test_scoped_origin_is_rejected_on_other_workbench_routes(client: TestClient) -> None:
    """The slice is one exact route — not the /files/ family, not the prefix."""
    response = client.get(
        '/api/workbench/files/read',
        params={'path': 'anything'},
        headers={'Origin': SURFER},
    )
    assert response.status_code == 403
    assert response.json()['code'] == 'untrusted_origin'


def test_scoped_origin_cannot_write_to_the_raw_route(client: TestClient, waveform_file: Path) -> None:
    """GET/HEAD only: a write-shaped verb on the same path is still a drive-by."""
    response = client.post(
        RAW_FILE_ROUTE,
        params={'path': str(waveform_file)},
        headers={'Origin': SURFER},
    )
    assert response.status_code == 403
    assert response.json()['code'] == 'untrusted_origin'


def test_scoped_origin_cannot_prefix_match_beyond_the_route(client: TestClient) -> None:
    response = client.get(f'{RAW_FILE_ROUTE}/extra', headers={'Origin': SURFER})
    assert response.status_code == 403
    assert response.json()['code'] == 'untrusted_origin'


def test_scoped_origin_preflight_is_answered_by_cors(client: TestClient) -> None:
    """A preflight carries no authority and must not turn into a guard 403 —
    otherwise the embed's fetch fails with an opaque error instead of a CORS
    denial the developer can see."""
    response = client.options(
        RAW_FILE_ROUTE,
        headers={
            'Origin': SURFER,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-august-request-id',
        },
    )
    assert response.status_code != 403
    assert response.headers.get('access-control-allow-origin') == SURFER


def test_scoped_origin_websocket_handshake_is_refused(client: TestClient) -> None:
    """The slice is HTTP GET/HEAD; a socket upgrade is never in it."""
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises((WebSocketDisconnect, RuntimeError, OSError)):
        with client.websocket_connect('/api/logs/stream', headers={'Origin': SURFER}):
            pytest.fail('a scoped read-only origin must not open a websocket')


def test_scoped_origin_is_not_full_trust_by_default() -> None:
    from app.lib.local_api_guard import resolve_origins

    assert SURFER not in resolve_origins()
    assert TRUSTED in resolve_origins()


def test_cors_origins_env_promotes_an_origin_to_full_trust(monkeypatch: pytest.MonkeyPatch) -> None:
    """AUGUST_CORS_ORIGINS stays a full-trust opt-in, including for an origin
    that is otherwise scoped."""
    from app.lib.local_api_guard import resolve_origins

    monkeypatch.setenv('AUGUST_CORS_ORIGINS', f'{SURFER}, https://tool.local')
    resolved = resolve_origins()
    assert SURFER in resolved
    assert 'https://tool.local' in resolved


def test_scoped_origin_opt_in_passes_the_guard_end_to_end(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once the operator lists the embed origin in AUGUST_CORS_ORIGINS it is a
    full-trust origin again, exactly as before this hardening."""
    monkeypatch.setenv('AUGUST_CORS_ORIGINS', SURFER)
    response = client.get('/api/health', headers={'Origin': SURFER})
    assert response.status_code == 200


def test_scoped_rule_shape_is_exact_and_read_only() -> None:
    rule = SCOPED_ORIGIN_RULES[SURFER]
    assert rule.methods == frozenset({'GET', 'HEAD'})
    assert rule.paths == (RAW_FILE_ROUTE,)
    assert rule.allows('GET', RAW_FILE_ROUTE) is True
    assert rule.allows('get', f'{RAW_FILE_ROUTE}/') is True
    assert rule.allows('POST', RAW_FILE_ROUTE) is False
    assert rule.allows('GET', '/api/workbench/files') is False
    assert rule.allows('GET', '/api/health') is False
    assert rule.allows('', RAW_FILE_ROUTE) is False
