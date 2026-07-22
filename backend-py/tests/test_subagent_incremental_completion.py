"""Tests for parallel subagent dispatch + incremental completion delivery."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import SubagentOrchestrator, SubagentSpawnRequest
from app.services.tools.spawn_subagents_tool import executeSpawnSubagents
from app.services.workbench import workbench as wb
from app.services.workbench.parallel_tools import is_parallel_safe
from app.services.workbench.sessions import create_workbench_session


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.services.workbench import sessions as sess

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    sess._sessions.clear()
    yield
    sess._sessions.clear()


def test_spawn_tools_are_parallel_safe():
    assert is_parallel_safe('spawn_subagent')
    assert is_parallel_safe('spawn_subagents')


def test_edit_mode_allows_file_asks_for_shell():
    s = create_workbench_session(guardMode='edit')
    s.guardMode = 'edit'
    assert wb._checkToolGuard(s, 'write_file', {'path': '/tmp/a.txt', 'content': 'x'}) is None
    blocked = wb._checkToolGuard(s, 'run_command', {'command': 'ls'})
    assert blocked is not None
    assert len(s.pendingMutations) == 1


def test_normalize_edit_aliases():
    assert wb.normalizeGuardMode('edit') == 'edit'
    assert wb.normalizeGuardMode('Edit Automatically') == 'edit'
    assert wb.normalizeGuardMode('full-access') == 'full'


@pytest.mark.asyncio
async def test_wait_for_each_yields_incrementally():
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=4)
    order: list[str] = []

    async def fake_run(**kwargs):
        tid = kwargs.get('taskId') or ''
        delay = 0.05 if 'fast' in (kwargs.get('goal') or '') else 0.15
        await asyncio.sleep(delay)
        return {'status': 'completed', 'result': f'done-{tid}', 'taskId': tid}

    with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=fake_run)):
        session = create_workbench_session()
        handles = await orch.spawn(
            SubagentSpawnRequest(
                session=session,
                workItems=[
                    {'goal': 'slow explore', 'agentId': 'explore'},
                    {'goal': 'fast explore', 'agentId': 'explore'},
                ],
            )
        )
        async for result in orch.waitForEach(handles):
            order.append(str(result.get('goal') or ''))

    assert order[0].startswith('fast')
    assert len(order) == 2
    await orch.close()


@pytest.mark.asyncio
async def test_background_spawn_returns_started_and_enqueues():
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=4)
    session = create_workbench_session()
    emitted: list[dict] = []

    async def fake_run(**kwargs):
        await asyncio.sleep(0.05)
        return {
            'status': 'completed',
            'result': 'findings',
            'taskId': kwargs.get('taskId'),
            'agentId': kwargs.get('agentId'),
        }

    with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=fake_run)):
        result = await executeSpawnSubagents(
            orch,
            session,
            [{'goal': 'explore structure', 'agentId': 'explore'}],
            mode='auto',
            emit=emitted.append,
            background=True,
        )
        assert result['status'] == 'started'
        assert result['background'] is True
        assert len(result['handles']) == 1
        # Allow watch task to settle
        await asyncio.sleep(0.2)

    queued = getattr(session, 'queuedUserMessages', None) or []
    assert any(as_str_kind(q) == 'subagent' for q in queued)
    await orch.close()


def as_str_kind(entry: dict) -> str:
    return str(entry.get('kind') or '')
