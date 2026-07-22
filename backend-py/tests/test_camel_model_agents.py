"""Characterization tests for CamelModel on the agents router bodies.

Proves multi-word field boundaries: snake_case Python fields, camelCase JSON
in (frontend contract), and that agent create/update still work over HTTP.
"""
from __future__ import annotations

import pytest
from app.main import app
from app.routers.agents import AgentCreate, AgentJob, AgentUpdate
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_agent_create_serializes_camelcase():
    body = AgentCreate(
        name='Worker',
        parent_id='agent_parent',
        parent_agent='',
        permissions=['read'],
        model_alias='fast',
    )
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 'Worker'
    assert dumped['parentId'] == 'agent_parent'
    assert dumped['parentAgent'] == ''
    assert dumped['permissions'] == ['read']
    assert dumped['modelAlias'] == 'fast'


def test_agent_create_accepts_camelcase_input():
    body = AgentCreate.model_validate(
        {
            'name': 'Child',
            'parentId': 'agent_root',
            'parentAgent': '',
            'modelAlias': 'smart',
            'role': 'helper',
        }
    )
    assert body.name == 'Child'
    assert body.parent_id == 'agent_root'
    assert body.model_alias == 'smart'
    assert body.role == 'helper'


def test_agent_update_serializes_camelcase():
    body = AgentUpdate(name='Renamed', parent_id='agent_new_parent', model_alias='pro')
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 'Renamed'
    assert dumped['parentId'] == 'agent_new_parent'
    assert dumped['modelAlias'] == 'pro'


def test_agent_update_accepts_camelcase_input():
    body = AgentUpdate.model_validate(
        {
            'name': 'Updated',
            'parentId': 'agent_p',
            'modelAlias': 'lite',
        }
    )
    assert body.name == 'Updated'
    assert body.parent_id == 'agent_p'
    assert body.model_alias == 'lite'


def test_agent_job_serializes_and_accepts_camelcase():
    body = AgentJob(agent_id='agent_1', goal='do work', context='ctx')
    dumped = body.model_dump(by_alias=True)
    assert dumped['agentId'] == 'agent_1'
    assert dumped['goal'] == 'do work'
    assert dumped['context'] == 'ctx'

    parsed = AgentJob.model_validate(
        {'agentId': 'agent_2', 'goal': 'ship', 'context': ''}
    )
    assert parsed.agent_id == 'agent_2'
    assert parsed.goal == 'ship'


def test_agent_create_accepts_snake_via_populate_by_name():
    body = AgentCreate(name='Snake', parent_id='p1', model_alias='m1')
    assert body.parent_id == 'p1'
    assert body.model_alias == 'm1'


@pytest.mark.asyncio
async def test_post_api_agents_accepts_camelcase_json(client, isolatedData):
    """HTTP contract: frontend posts camelCase; agent is created and updatable."""
    create = await client.post(
        '/api/agents',
        json={
            'name': 'CamelAgent',
            'parentId': '',
            'role': 'tester',
            'description': 'camel characterization',
            'modelAlias': 'default',
        },
    )
    assert create.status_code == 200
    data = create.json()
    assert data['name'] == 'CamelAgent'
    assert data['role'] == 'tester'
    agent_id = data['id']

    update = await client.put(
        f'/api/agents/{agent_id}',
        json={'name': 'CamelAgentUpdated', 'parentId': '', 'role': 'updated'},
    )
    assert update.status_code == 200
    assert update.json()['name'] == 'CamelAgentUpdated'
    assert update.json()['role'] == 'updated'
