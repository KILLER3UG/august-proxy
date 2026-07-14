"""Characterization tests for CamelModel on the memory router.

Proves multi-word field boundaries: snake_case Python fields, camelCase JSON
in (frontend contract), and that key memory POST routes still work.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers.memory import (
    FactSave,
    FactSearch,
    MemorySave,
    ProposalCreate,
    ProposalDecide,
)


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_fact_save_serializes_camelcase():
    body = FactSave(
        fact_key='pref.theme',
        fact_value='dark',
        category='prefs',
        source='user',
        confidence=0.9,
    )
    dumped = body.model_dump(by_alias=True)
    assert dumped['factKey'] == 'pref.theme'
    assert dumped['factValue'] == 'dark'
    assert dumped['category'] == 'prefs'
    assert dumped['source'] == 'user'
    assert dumped['confidence'] == 0.9


def test_fact_save_accepts_camelcase_input():
    body = FactSave.model_validate(
        {
            'factKey': 'lang',
            'factValue': 'en',
            'category': 'general',
            'source': 'auto',
            'confidence': 0.5,
        }
    )
    assert body.fact_key == 'lang'
    assert body.fact_value == 'en'
    assert body.confidence == 0.5


def test_proposal_create_accepts_camelcase_input():
    body = ProposalCreate.model_validate(
        {
            'sessionId': 'sess-1',
            'proposalType': 'plan',
            'content': {'steps': [1, 2]},
        }
    )
    assert body.session_id == 'sess-1'
    assert body.proposal_type == 'plan'
    assert body.content == {'steps': [1, 2]}


def test_proposal_decide_serializes_camelcase():
    body = ProposalDecide(status='approved', decided_by='user')
    dumped = body.model_dump(by_alias=True)
    assert dumped['status'] == 'approved'
    assert dumped['decidedBy'] == 'user'


def test_memory_save_and_fact_search_snake_case_via_populate_by_name():
    mem = MemorySave(key='k', value='v', category='c', source='s')
    assert mem.key == 'k'
    assert mem.value == 'v'
    search = FactSearch(query='q', category='c')
    assert search.query == 'q'
    assert search.category == 'c'


@pytest.mark.asyncio
async def test_post_api_memory_facts_accepts_camelcase_json(client, isolatedData):
    """HTTP contract: frontend posts camelCase; fact is stored."""
    from app.services import memory_store

    resp = await client.post(
        '/api/memory/facts',
        json={
            'factKey': 'camel.memory.fact',
            'factValue': {'ok': True},
            'category': 'test',
            'source': 'camel-test',
            'confidence': 0.8,
        },
    )
    assert resp.status_code == 200
    assert resp.json()['status'] == 'ok'

    fact = memory_store.get_fact('camel.memory.fact')
    assert fact is not None
    assert fact['factKey'] == 'camel.memory.fact'
    assert fact['category'] == 'test'


@pytest.mark.asyncio
async def test_post_api_memory_proposals_accepts_camelcase_json(client, isolatedData):
    """HTTP contract: proposal create/decide via camelCase JSON."""
    from app.services import memory_store

    create = await client.post(
        '/api/memory/proposals',
        json={
            'sessionId': 'camel-mem-sess',
            'proposalType': 'mutation',
            'content': {'action': 'rename'},
        },
    )
    assert create.status_code == 200
    data = create.json()
    assert data['status'] == 'pending'
    pid = data['id']

    decide = await client.post(
        f'/api/memory/proposals/{pid}/decide',
        json={'status': 'approved', 'decidedBy': 'tester'},
    )
    assert decide.status_code == 200
    assert decide.json()['status'] == 'approved'

    proposal = memory_store.get_proposal(pid)
    assert proposal is not None
    assert proposal['status'] == 'approved'
    assert proposal['decidedBy'] == 'tester'
