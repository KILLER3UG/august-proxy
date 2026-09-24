"""Backend integrity fixes: HTTP-automation URL hardening + MCP child env scrub.

* ``_run_http`` feeds a scheduled job's URL straight into ``urllib.request.urlopen``.
  Unguarded that is a live SSRF / local-file-read primitive (``file://`` is read by
  urlopen and echoed into the run log). It now allow-lists http(s) and reuses the
  vetted private-address guard, with an EXPLICIT localhost opt-in that relaxes
  only the network check (never the scheme rule).
* An MCP stdio child previously inherited the parent's entire ``os.environ``. It
  now starts from ``noninteractive_env`` (scrubs credentials + every ``AUGUST_*``
  pointer) plus only the server's configured env.
"""

from __future__ import annotations

import os
from unittest import mock

# ── HTTP automation URL guard ────────────────────────────────────────────────


def _run_http(job):
    from app.services import automations_store

    return automations_store._run_http(job)


def test_file_scheme_is_refused_without_any_request() -> None:
    """file:// must never be read — a local-file-read primitive."""
    with mock.patch('app.services.automations_store._open_http_url') as urlopen:
        status, out, code = _run_http({'url': 'file:///etc/passwd'})
    assert status == 'error'
    assert code is None
    assert 'http(s)' in out
    urlopen.assert_not_called()


def test_ftp_scheme_is_refused() -> None:
    with mock.patch('app.services.automations_store._open_http_url') as urlopen:
        status, out, _ = _run_http({'url': 'ftp://example.com/x'})
    assert status == 'error'
    assert 'http(s)' in out
    urlopen.assert_not_called()


def test_loopback_target_is_refused_by_default() -> None:
    with mock.patch('app.services.automations_store._open_http_url') as urlopen:
        status, out, _ = _run_http({'url': 'http://127.0.0.1:8080/admin'})
    assert status == 'error'
    assert 'private/loopback/metadata' in out
    urlopen.assert_not_called()


def test_metadata_target_is_refused_by_default() -> None:
    with mock.patch('app.services.automations_store._open_http_url') as urlopen:
        status, out, _ = _run_http({'url': 'http://169.254.169.254/latest/meta-data/'})
    assert status == 'error'
    assert 'private/loopback/metadata' in out
    urlopen.assert_not_called()


def test_explicit_job_optin_allows_localhost_but_never_file_scheme(monkeypatch) -> None:
    """allowLocalhost relaxes the network check; the http(s) rule always holds."""
    monkeypatch.delenv('AUGUST_AUTOMATION_ALLOW_LOCALHOST', raising=False)

    class _Resp:
        status = 200

        def read(self):
            return b'ok'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    # Opted in via the per-job flag → a loopback http URL is allowed.
    with mock.patch('app.services.automations_store._open_http_url', return_value=_Resp()) as urlopen:
        status, out, code = _run_http(
            {'url': 'http://127.0.0.1:8080/health', 'allowLocalhost': True}
        )
    assert status == 'idle'
    assert out == 'ok'
    assert code == 200
    urlopen.assert_called_once()

    # …but the opt-in never unlocks file://.
    with mock.patch('app.services.automations_store._open_http_url') as urlopen2:
        status, out, _ = _run_http({'url': 'file:///etc/passwd', 'allowLocalhost': True})
    assert status == 'error'
    assert 'http(s)' in out
    urlopen2.assert_not_called()


def test_env_optin_allows_localhost(monkeypatch) -> None:
    monkeypatch.setenv('AUGUST_AUTOMATION_ALLOW_LOCALHOST', '1')

    class _Resp:
        status = 200

        def read(self):
            return b'ok'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    with mock.patch('app.services.automations_store._open_http_url', return_value=_Resp()):
        status, out, _ = _run_http({'url': 'http://localhost:9000/ping'})
    assert status == 'idle'
    assert out == 'ok'


def test_public_http_url_is_allowed(monkeypatch) -> None:
    monkeypatch.delenv('AUGUST_AUTOMATION_ALLOW_LOCALHOST', raising=False)

    class _Resp:
        status = 200

        def read(self):
            return b'{"ok":true}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    # example.com resolves publicly → the guard lets it through and we fetch.
    with mock.patch('app.services.automations_store._open_http_url', return_value=_Resp()) as urlopen:
        status, out, _ = _run_http({'url': 'https://example.com/hook'})
    assert status == 'idle'
    assert 'ok' in out
    urlopen.assert_called_once()


# ── MCP child environment scrub ─────────────────────────────────────────────


def test_mcp_child_env_drops_credentials_and_august_pointers(monkeypatch) -> None:
    from app.services.tools import mcp_client

    monkeypatch.setenv('OPENAI_API_KEY', 'sk-should-not-leak')
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', '/secret/brain.sqlite')
    monkeypatch.setenv('MY_AUTH_TOKEN', 'tok-should-not-leak')
    monkeypatch.setenv('PATH', os.environ.get('PATH', '/usr/bin'))

    env = mcp_client._child_env({'command': 'node', 'args': [], 'env': {}})

    assert 'OPENAI_API_KEY' not in env
    assert 'AUGUST_BRAIN_SQLITE_FILE' not in env
    assert 'MY_AUTH_TOKEN' not in env
    # A non-credential var is preserved, and the noninteractive defaults apply.
    assert env.get('PATH')
    assert env.get('GIT_TERMINAL_PROMPT') == '0'
    assert env.get('TERM') == 'dumb'


def test_mcp_child_env_keeps_per_server_configured_env(monkeypatch) -> None:
    from app.services.tools import mcp_client

    monkeypatch.setenv('OPENAI_API_KEY', 'parent-key-should-not-leak')
    monkeypatch.setenv('AUGUST_DATA_DIR', '/parent/data')

    env = mcp_client._child_env(
        {
            'command': 'node',
            'args': [],
            # A server's own explicitly-set token must still reach it.
            'env': {'SERVER_TOKEN': 'server-token', 'NODE_ENV': 'production'},
        }
    )

    # Parent credentials still scrubbed…
    assert 'OPENAI_API_KEY' not in env
    assert 'AUGUST_DATA_DIR' not in env
    # …but the per-server config is layered on top.
    assert env['SERVER_TOKEN'] == 'server-token'
    assert env['NODE_ENV'] == 'production'


def test_mcp_child_env_never_uses_whole_os_environ(monkeypatch) -> None:
    """A benign parent var that is NOT a credential still rides the scrub base;
    what must never happen is the raw, unscrubbed os.environ reaching the child."""
    from app.services.tools import mcp_client

    monkeypatch.setenv('AUGUST_SECRET_SOMETHING', 'leak-me')
    env = mcp_client._child_env({'command': 'node', 'args': [], 'env': {}})
    # Every AUGUST_* key is stripped regardless of its name.
    assert not any(k.startswith('AUGUST_') for k in env)
