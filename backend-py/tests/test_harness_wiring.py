"""Planner mode, transcript archive, harness jobs, MCP, dirty flag."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from app.services.harness_mode import (
    filter_planner_tools,
    is_orchestrator_mode,
    planner_block_message,
)


def test_planner_filters_shell_and_write():
    tools = [
        {'name': 'run_command'},
        {'name': 'write_file'},
        {'name': 'spawn_subagents'},
        {'name': 'list_workstreams'},
        {'type': 'function', 'function': {'name': 'read_file'}},
    ]
    names = []
    for t in filter_planner_tools(tools):
        n = t.get('name')
        if isinstance(n, str):
            names.append(n)
        else:
            names.append(t['function']['name'])  # type: ignore[index]
    assert 'spawn_subagents' in names
    assert 'read_file' in names
    assert 'run_command' not in names
    assert 'write_file' not in names
    assert 'Orchestrator' in planner_block_message('run_command')


def test_orchestrator_mode_aliases():
    assert is_orchestrator_mode(SimpleNamespace(agent_mode='planner'))
    assert is_orchestrator_mode(SimpleNamespace(agent_mode='orchestrator'))
    assert not is_orchestrator_mode(SimpleNamespace(agent_mode='agent'))


def test_transcript_archive_then_derive(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.services.transcript_archive import archive_messages, derive_messages

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    full = [{'role': 'user', 'content': 'keep me'}, {'role': 'assistant', 'content': 'ok'}]
    archive_messages('sess-a', full, reason='compact')
    projection = [{'role': 'user', 'content': 'summary'}]
    derived = derive_messages('sess-a', projection)
    assert derived[0]['content'] == 'keep me'


@pytest.mark.asyncio
async def test_harness_jobs_create_list_dirty(brain_ready):
    from app.services.harness_jobs import create_job, list_jobs, mark_dirty

    jid = create_job('sess-j', waves=[[{'goal': 'a', 'name': 'explore'}]])
    mark_dirty(jid, 'mutated without episode')
    rows = list_jobs('sess-j')
    assert rows[0]['id'] == jid
    assert rows[0]['dirty'] is True
    assert rows[0]['waves'] == [['explore']]


@pytest.mark.asyncio
async def test_harness_mcp_list_and_jobs(brain_ready):
    from app.main import app
    from app.services.harness_jobs import create_job
    from httpx import ASGITransport, AsyncClient

    create_job('mcp-sess', waves=[[{'name': 'w1', 'goal': 'g'}]])
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        listed = await ac.post('/mcp/harness', json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        assert listed.status_code == 200
        names = [t['name'] for t in listed.json()['result']['tools']]
        assert 'harness_list_jobs' in names
        called = await ac.post(
            '/mcp/harness',
            json={
                'jsonrpc': '2.0',
                'id': 2,
                'method': 'tools/call',
                'params': {'name': 'harness_list_jobs', 'arguments': {'sessionId': 'mcp-sess'}},
            },
        )
        body = called.json()['result']['content'][0]['text']
        data = json.loads(body)
        assert data[0]['waves'] == [['w1']]


@pytest.mark.asyncio
async def test_jobs_http_list(brain_ready):
    from app.main import app
    from app.services.harness_jobs import create_job
    from httpx import ASGITransport, AsyncClient

    create_job('http-sess', waves=[[{'name': 'n1', 'goal': 'g'}]])
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        r = await ac.get('/api/subagents/jobs', params={'sessionId': 'http-sess'})
        assert r.status_code == 200
        assert r.json()['jobs'][0]['waves'] == [['n1']]


@pytest.mark.asyncio
async def test_agent_mode_http(brain_ready, tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.main import app
    from app.services.workbench.sessions import create_workbench_session
    from httpx import ASGITransport, AsyncClient

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    s = create_workbench_session()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        r = await ac.post('/api/workbench/agent-mode', json={'sessionId': s.id, 'agentMode': 'orchestrator'})
        assert r.status_code == 200
        assert r.json().get('agentMode') == 'orchestrator'
        bad = await ac.post('/api/workbench/agent-mode', json={'sessionId': s.id, 'agentMode': 'nope'})
        assert bad.status_code == 400
