"""Characterization tests for CamelModel on the subagent router bodies."""
from __future__ import annotations

from app.routers.subagent import ProposeBreakdownRequest, SpawnRequest, WorkItem


def test_work_item_serializes_camelcase():
    item = WorkItem(goal='do thing', agent_id='build', restricted_tools=['shell'], context='ctx')
    dumped = item.model_dump(by_alias=True)
    assert dumped['goal'] == 'do thing'
    assert dumped['agentId'] == 'build'
    assert dumped['restrictedTools'] == ['shell']
    assert dumped['context'] == 'ctx'


def test_spawn_request_accepts_camelcase_input():
    body = SpawnRequest.model_validate(
        {
            'workItems': [
                {'goal': 'a', 'agentId': 'general', 'restrictedTools': ['read']},
            ],
            'mode': 'auto',
        }
    )
    assert len(body.work_items) == 1
    assert body.work_items[0].agent_id == 'general'
    assert body.work_items[0].restricted_tools == ['read']
    assert body.mode == 'auto'


def test_propose_breakdown_accepts_camelcase_input():
    body = ProposeBreakdownRequest.model_validate({'proposalId': 'p1', 'approved': False})
    assert body.proposal_id == 'p1'
    assert body.approved is False
    assert body.model_dump(by_alias=True)['proposalId'] == 'p1'
