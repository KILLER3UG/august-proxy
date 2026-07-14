"""MCP SSE parsing + session JSON export admin toggle."""

from __future__ import annotations

import json

import pytest


def test_parse_sse_events_and_json_rpc():
    from app.services.tools.mcp_client import _iter_sse_events, _json_from_sse_body

    body = (
        'event: endpoint\n'
        'data: /message\n'
        '\n'
        'event: message\n'
        'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}\n'
        '\n'
    )
    events = _iter_sse_events(body)
    assert ('endpoint', '/message') in events
    parsed = _json_from_sse_body(body, prefer_id=1)
    assert parsed is not None
    assert parsed['result']['tools'][0]['name'] == 'a'


def test_json_from_sse_prefers_matching_id():
    from app.services.tools.mcp_client import _json_from_sse_body

    body = (
        'data: {"jsonrpc":"2.0","id":"old","result":{"tools":[]}}\n\n'
        'data: {"jsonrpc":"2.0","id":"want","result":{"tools":[{"name":"x"}]}}\n\n'
    )
    parsed = _json_from_sse_body(body, prefer_id='want')
    assert parsed is not None
    assert parsed['id'] == 'want'
    assert parsed['result']['tools'][0]['name'] == 'x'


@pytest.fixture
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    monkeypatch.delenv('AUGUST_SESSION_JSON_EXPORT', raising=False)
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    yield tmp_path
    settings.reload()


def test_session_export_config_toggle(_iso, monkeypatch):
    from app.services.workbench import sessions as sess
    from app.lib.paths import dataPath

    monkeypatch.delenv('AUGUST_SESSION_JSON_EXPORT', raising=False)
    assert sess.is_session_json_export_enabled() is False
    status = sess.set_session_json_export_enabled(True)
    assert status['enabled'] is True
    assert status['source'] == 'config'
    assert sess.is_session_json_export_enabled() is True

    # Env overrides config
    monkeypatch.setenv('AUGUST_SESSION_JSON_EXPORT', '0')
    assert sess.is_session_json_export_enabled() is False
    monkeypatch.setenv('AUGUST_SESSION_JSON_EXPORT', '1')
    assert sess.is_session_json_export_enabled() is True
    monkeypatch.delenv('AUGUST_SESSION_JSON_EXPORT', raising=False)

    # Continuous save writes JSON when enabled
    s = sess.WorkbenchSession(
        id='wb_export_toggle',
        title='export-me',
        messages=[{'role': 'user', 'content': 'hi'}],
        messageCount=1,
        createdAt='2026-01-01T00:00:00Z',
        updatedAt='2026-01-01T00:00:00Z',
        startedAt='2026-01-01T00:00:00Z',
    )
    sess._sessions[s.id] = s
    sess.set_session_json_export_enabled(True)
    sess.save_sessions()
    path = dataPath('workbench-sessions.json')
    assert path.exists()
    data = json.loads(path.read_text('utf-8'))
    assert any(isinstance(x, dict) and x.get('id') == 'wb_export_toggle' for x in data)


def test_parallel_policy_single_stack():
    from app.services.workbench.parallel_tools import is_parallel_safe
    from app.services.workbench.managed_tool_policy import is_parallel_safe as policy_safe

    assert is_parallel_safe('web_search') is True
    assert is_parallel_safe('list_skills') is True
    assert is_parallel_safe('write_file') is False
    assert policy_safe('web_search') is True
    assert policy_safe('run_command') is False
    # MCP leaf name pattern
    assert policy_safe('mcp__srv__list_things') is True
    assert policy_safe('mcp__srv__write_file') is False
