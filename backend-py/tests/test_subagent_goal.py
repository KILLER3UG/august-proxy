"""Workstreams, dispatch DAG, and sub-agent goal contracts."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from app.services.workstreams import (
    WorkstreamError,
    append_episode,
    format_episode_context,
    goal_contract_prompt,
    item_name,
    list_workstreams,
    plan_waves,
    weave_sources,
)


def test_plan_waves_parallel_when_independent():
    waves = plan_waves(
        [
            {'goal': 'a', 'name': 'explore'},
            {'goal': 'b', 'name': 'setup'},
        ]
    )
    assert len(waves) == 1
    assert {item_name(i, 0) for i in waves[0]} == {'explore', 'setup'}


def test_plan_waves_orders_dependencies():
    waves = plan_waves(
        [
            {'goal': 'profile', 'name': 'profile', 'dependsOn': ['setup']},
            {'goal': 'setup', 'name': 'setup'},
        ]
    )
    assert len(waves) == 2
    assert item_name(waves[0][0], 0) == 'setup'
    assert item_name(waves[1][0], 0) == 'profile'


def test_plan_waves_source_is_same_batch_edge():
    waves = plan_waves(
        [
            {'goal': 'use', 'name': 'impl', 'sourceWorkstreams': ['explore']},
            {'goal': 'look', 'name': 'explore'},
        ]
    )
    assert len(waves) == 2
    assert item_name(waves[0][0], 0) == 'explore'


def test_plan_waves_rejects_cycle():
    with pytest.raises(WorkstreamError, match='Cyclic'):
        plan_waves(
            [
                {'goal': 'a', 'name': 'a', 'dependsOn': ['b']},
                {'goal': 'b', 'name': 'b', 'dependsOn': ['a']},
            ]
        )


def test_plan_waves_rejects_duplicate_names():
    with pytest.raises(WorkstreamError, match='Duplicate'):
        plan_waves([{'goal': 'a', 'name': 't'}, {'goal': 'b', 'name': 't'}])


def test_goal_contract_prompt_includes_acceptance():
    text = goal_contract_prompt('tests pass', 'blocked on missing API', 12)
    assert 'Acceptance: tests pass' in text
    assert 'blocked on missing API' in text
    assert '12 rounds' in text


def test_workstream_episodes_roundtrip(brain_ready):
    append_episode(
        'sess1',
        'explore',
        task_id='t1',
        status='completed',
        summary='Found hot path in app.js',
        artifacts=['app.js'],
        next_action='profile it',
    )
    ctx = format_episode_context('sess1', 'explore')
    assert 'hot path' in ctx
    listed = list_workstreams('sess1')
    assert listed[0]['name'] == 'explore'
    assert listed[0]['latest']['summary'] == 'Found hot path in app.js'
    woven = weave_sources('sess1', ['explore'])
    assert 'app.js' in woven or 'hot path' in woven


@pytest.mark.asyncio
async def test_failed_dependency_skips_same_batch_target(brain_ready):
    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import SubagentOrchestrator
    from app.services.tools.spawn_subagents_tool import executeSpawnSubagents
    from app.services.workbench.sessions import create_workbench_session

    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=4)
    session = create_workbench_session()

    async def fake_run(**kwargs):
        goal = kwargs.get('goal') or ''
        if 'setup' in goal:
            return {'status': 'failed', 'error': 'boom', 'result': '', 'taskId': kwargs.get('taskId')}
        return {
            'status': 'completed',
            'result': '{"summary":"ok","status":"completed"}',
            'taskId': kwargs.get('taskId'),
        }

    with patch('app.services.subagent_worker.runSubagent', new=AsyncMock(side_effect=fake_run)):
        result = await executeSpawnSubagents(
            orch,
            session,
            [
                {'goal': 'setup env', 'name': 'setup'},
                {'goal': 'profile after setup', 'name': 'profile', 'dependsOn': ['setup']},
            ],
            mode='auto',
            background=False,
        )

    statuses = {r.get('status') for r in result['results']}
    assert 'failed' in statuses
    assert 'skipped' in statuses
    await orch.close()


@pytest.mark.asyncio
async def test_mailbox_steers_running_handle():
    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import SubagentHandle, SubagentOrchestrator

    orch = SubagentOrchestrator(AgentMessageBus(), max_workers=1)
    h = SubagentHandle('task_abc', 'general', 'g', sessionId='s')
    h.status = 'running'
    orch._handles[h.taskId] = h
    assert orch.enqueueMailbox('task_abc', 'stop and summarize')
    assert orch.drainMailbox('task_abc') == ['stop and summarize']
    assert orch.drainMailbox('task_abc') == []
    h.status = 'completed'
    assert not orch.enqueueMailbox('task_abc', 'too late')
    await orch.close()


@pytest.mark.asyncio
async def test_workstreams_http_list(brain_ready):
    from app.main import app
    from app.services.workstreams import append_episode
    from httpx import ASGITransport, AsyncClient

    append_episode('wb-sess', 'explore', summary='mapped repo', status='completed')
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        r = await ac.get('/api/subagents/workstreams', params={'sessionId': 'wb-sess'})
    assert r.status_code == 200
    names = [w['name'] for w in r.json()['workstreams']]
    assert 'explore' in names
