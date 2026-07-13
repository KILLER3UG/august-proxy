"""Characterization tests for CamelModel on the usage router.

Proves the usage request boundary: snake_case Python fields, camelCase JSON
in (frontend contract), and that POST /api/usage still records correctly.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers.usage import UsageRecord


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_usage_record_serializes_camelcase():
    record = UsageRecord(
        session_id='s1',
        model='claude-sonnet',
        input_tokens=10,
        output_tokens=5,
        context_tokens=100,
    )
    dumped = record.model_dump(by_alias=True)
    assert dumped['sessionId'] == 's1'
    assert dumped['inputTokens'] == 10
    assert dumped['outputTokens'] == 5
    assert dumped['contextTokens'] == 100
    assert dumped['model'] == 'claude-sonnet'


def test_usage_record_accepts_camelcase_input():
    record = UsageRecord.model_validate(
        {
            'sessionId': 's2',
            'model': 'm',
            'inputTokens': 1,
            'outputTokens': 2,
            'contextTokens': 3,
        }
    )
    assert record.session_id == 's2'
    assert record.input_tokens == 1
    assert record.output_tokens == 2
    assert record.context_tokens == 3


def test_usage_record_accepts_snake_case_via_populate_by_name():
    record = UsageRecord(
        session_id='s3',
        model='m',
        input_tokens=7,
    )
    assert record.session_id == 's3'
    assert record.input_tokens == 7


@pytest.mark.asyncio
async def test_post_api_usage_accepts_camelcase_json(client, isolatedData):
    """HTTP contract: frontend posts camelCase; endpoint records the event."""
    from app.services import memory_store

    sid = 'camel-usage-post'
    resp = await client.post(
        '/api/usage',
        json={
            'sessionId': sid,
            'model': 'claude-sonnet',
            'inputTokens': 11,
            'outputTokens': 4,
            'contextTokens': 99,
        },
    )
    assert resp.status_code == 200
    assert 'id' in resp.json()

    usage = memory_store.get_usage(sid)
    assert usage['totalInputTokens'] == 11
    assert usage['totalOutputTokens'] == 4
    assert usage['contextTokens'] == 99
    assert usage['totalEvents'] == 1
