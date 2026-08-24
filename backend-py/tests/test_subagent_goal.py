"""Workstreams, dispatch DAG, and sub-agent goal contracts."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from app.services.workstreams import (
    WorkstreamError,
    append_episode,
    continue_goal,
    format_episode_context,
    goal_contract_prompt,
    item_name,
    judge_episode_status,
    list_workstreams,
    parse_episode_payload,
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


def test_acceptance_without_criteria_met_is_partial():
    parsed = parse_episode_payload('{"summary":"wrote files","status":"completed"}')
    judged = judge_episode_status(parsed, acceptance_criteria='pytest -q exits 0')
    assert judged['status'] == 'partial'
    assert 'pytest' in judged['unmet'] or 'pytest' in judged['next']


def test_criteria_met_flag_keeps_completed():
    parsed = parse_episode_payload(
        '{"summary":"green","status":"completed","criteriaMet":true}'
    )
    judged = judge_episode_status(parsed, acceptance_criteria='pytest -q exits 0')
    assert judged['status'] == 'completed'


def test_continue_goal_uses_episode_card(brain_ready):
    append_episode(
        'sess-card',
        'auth',
        status='partial',
        summary='Login form only',
        next_action='Add session cookie',
        raw_json='{"skills":["webapp"],"unmet":"tests"}',
    )
    text = continue_goal('sess-card', 'auth', 'keep going')
    assert 'EPISODE CARD' in text
    assert 'Login form' in text
    assert 'keep going' in text
    assert 'session cookie' in text.lower() or 'next:' in text.lower()


def test_should_auto_continue_caps_hops():
    from app.services.harness_playbook import MAX_AUTO_HOPS, should_auto_continue

    assert should_auto_continue('silent', status='completed', next_action='more', hops=0)
    assert not should_auto_continue('silent', status='completed', next_action='more', hops=MAX_AUTO_HOPS)
    assert not should_auto_continue('ask', status='completed', next_action='more', hops=0)
    assert not should_auto_continue('silent', status='blocked', next_action='more', hops=0)
    from app.services.harness_playbook import should_ping

    assert should_ping('ask', status='completed', next_action='more')
    assert not should_ping('silent', status='completed', next_action='more')
    assert should_ping('silent', status='blocked')
    assert not should_ping('on_fail', status='completed', next_action='more')
    assert should_ping('on_fail', status='partial')


def test_specialist_and_routine_roundtrip(brain_ready):
    from app.services.harness_playbook import (
        continue_work_item,
        save_routine_from_episode,
        specialist_for_workstream,
        upsert_specialist,
    )
    from app.services.workstreams import append_episode, list_workstreams

    upsert_specialist(
        'sess-play',
        {
            'name': 'auth',
            'workstream': 'auth',
            'skills': ['webapp'],
            'acceptance': 'tests pass',
            'autonomy': 'silent',
            'workspacePath': '/repo',
        },
    )
    spec = specialist_for_workstream('sess-play', 'auth', '/repo')
    assert spec and spec['autonomy'] == 'silent'
    append_episode(
        'sess-play',
        'auth',
        status='completed',
        summary='Tokens persist',
        next_action='Add refresh path',
        raw_json='{"skills":["webapp"]}',
    )
    rows = list_workstreams('sess-play')
    assert rows[0]['name'] == 'auth'
    assert rows[0]['dirty'] is False
    item = continue_work_item('sess-play', 'auth', '')
    assert 'refresh' in item['goal'].lower() or 'Continue' in item['goal']
    assert 'webapp' in item['skills']
    assert item['acceptanceCriteria'] == 'tests pass'
    rtn = save_routine_from_episode('sess-play', 'auth')
    assert rtn['workstream'] == 'auth'
    assert rtn['sourceSeq'] == 1


def test_mark_read_and_attention(brain_ready):
    from app.services.harness_ops import annotate_attention, last_seen_seq, mark_read

    append_episode('sess-att', 'auth', status='completed', summary='done', next_action='')
    rows = list_workstreams('sess-att')
    assert rows[0].get('attention') in ('unread', 'idle', 'needs', 'working')
    mark_read('sess-att', 'auth', int((rows[0].get('latest') or {}).get('seq') or 1))
    assert last_seen_seq('sess-att', 'auth') >= 1
    again = annotate_attention('sess-att', list_workstreams('sess-att'))
    assert again[0]['attention'] in ('idle', 'needs')
    assert again[0]['unread'] is False


def test_search_harness_hits_episode(brain_ready):
    from app.services.harness_ops import search_harness

    append_episode('sess-q', 'auth', status='partial', summary='oauth tokens', next_action='refresh')
    found = search_harness('sess-q', 'oauth')
    kinds = {h.get('kind') for h in found.get('hits') or []}
    assert 'episode' in kinds or 'workstream' in kinds


def test_unattended_skips_auto_continue(brain_ready, monkeypatch):
    from app.services.harness_playbook import schedule_auto_continue

    monkeypatch.setattr('app.services.harness_ops.is_unattended', lambda: True)
    events = []
    schedule_auto_continue(type('S', (), {'id': 's', 'workspacePath': ''})(), events.append, 'auth', 'next', 0)
    assert events and events[0].get('kind') == 'harnessLaneDone'


def test_routine_schedule_roundtrip(brain_ready):
    from app.services.harness_ops import set_routine_schedule
    from app.services.harness_playbook import save_routine_from_episode

    append_episode('sess-sched', 'auth', status='completed', summary='ok', next_action='more')
    rtn = save_routine_from_episode('sess-sched', 'auth')
    updated = set_routine_schedule(rtn['id'], '0 9 * * *', paused=False)
    assert updated.get('schedule') == '0 9 * * *'
    paused = set_routine_schedule(rtn['id'], '0 9 * * *', paused=True)
    assert paused.get('paused') is True

