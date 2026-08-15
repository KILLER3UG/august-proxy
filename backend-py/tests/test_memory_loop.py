"""Memory loop: correction suggestions, continue recap, pending distill."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.services.workbench.workbench import _extract_memory_suggestions
from app.services.workstreams import continue_goal


def test_correction_phrases_become_save_chips():
    session = SimpleNamespace(
        messages=[{'role': 'user', 'content': 'Actually I prefer pytest not unittest for this repo.'}],
    )
    got = _extract_memory_suggestions(session)
    assert any('pytest' in g.lower() for g in got)


def test_continue_goal_without_episodes_keeps_user_text():
    assert continue_goal('sess-none', 'auth', 'keep going') == 'keep going'


def test_continue_goal_default_message():
    assert 'Continue from the last episode' in continue_goal('sess-none', 'auth', '  ')


@pytest.mark.asyncio
async def test_empty_dispatch_returns_error():
    from app.services.tools.spawn_subagents_tool import executeSpawnSubagents

    events: list[dict] = []
    result = await executeSpawnSubagents(None, SimpleNamespace(id='s'), [], emit=events.append)
    assert result['status'] == 'error'
    assert result['total'] == 0
    assert events and events[0].get('type') == 'error'


@pytest.mark.asyncio
async def test_sleep_cycle_stashes_plan_instead_of_applying(monkeypatch):
    from app.services import consolidation_daemon as cd

    plan = {
        'merge': [{'keepId': 1, 'removeIds': [2], 'mergedRule': 'x'}],
        'promote': [],
        'delete': [],
        'archiveMemories': [],
    }
    applied = {'n': 0}

    async def fake_build():
        return plan

    async def fake_apply(_plan):
        applied['n'] += 1
        return {'merged': 1, 'promoted': 0, 'deleted_stale': 0, 'errors': []}

    monkeypatch.setattr(cd, '_build_consolidation_plan', fake_build)
    monkeypatch.setattr(cd, '_apply_consolidation_plan', fake_apply)

    stats = await cd.runConsolidation(apply=False)
    assert applied['n'] == 0
    assert stats.get('pending') is True
    assert cd.get_pending_consolidation() == plan

    stats2 = await cd.runConsolidation(apply=True)
    assert applied['n'] == 1
    assert not stats2.get('pending')


def test_list_and_take_pending_actions():
    from app.services.consolidation_daemon import list_pending_actions, take_pending_action

    plan = {
        'merge': [
            {'keepId': 1, 'removeIds': [2], 'mergedRule': 'Keep A'},
            {'keepId': 3, 'removeIds': [4], 'mergedRule': 'Keep B'},
        ],
        'promote': [{'factKey': 'tone', 'factValue': 'direct'}],
        'delete': [9],
        'archiveMemories': [],
    }
    actions = list_pending_actions(plan)
    assert [a['id'] for a in actions] == ['merge:0', 'merge:1', 'promote:0', 'delete:0']
    slice_plan, remaining = take_pending_action(plan, 'merge:0')
    assert slice_plan['merge'][0]['keepId'] == 1
    assert len(remaining['merge']) == 1
    assert remaining['merge'][0]['keepId'] == 3
    leftover = list_pending_actions(remaining)
    assert leftover[0]['id'] == 'merge:0'
