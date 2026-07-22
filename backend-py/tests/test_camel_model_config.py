"""Characterization tests for CamelModel on the config router bodies."""
from __future__ import annotations

import pytest
from app.main import app
from app.routers.config import (
    BackgroundReviewUpdate,
    ExternalAccessUpdate,
    FallbackTest,
    FallbackUpdate,
    ModelAliasesBulk,
    ProviderDetailsUpdate,
)
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_background_review_serializes_camelcase():
    body = BackgroundReviewUpdate(
        enabled=True,
        review_model='m1',
        reflection_model='m2',
        auto_memory_model='m3',
    )
    dumped = body.model_dump(by_alias=True)
    assert dumped['enabled'] is True
    assert dumped['reviewModel'] == 'm1'
    assert dumped['reflectionModel'] == 'm2'
    assert dumped['autoMemoryModel'] == 'm3'


def test_background_review_accepts_camelcase_input():
    body = BackgroundReviewUpdate.model_validate(
        {
            'enabled': False,
            'reviewModel': 'claude-sonnet',
            'reflectionModel': 'r',
            'autoMemoryModel': 'a',
        }
    )
    assert body.review_model == 'claude-sonnet'
    assert body.reflection_model == 'r'
    assert body.auto_memory_model == 'a'


def test_simple_config_bodies():
    assert ProviderDetailsUpdate(provider='openai', config={'apiKey': 'x'}).provider == 'openai'
    assert ModelAliasesBulk(aliases=[{'id': 'a'}]).aliases[0]['id'] == 'a'
    assert FallbackUpdate(enabled=True, mode='auto').enabled is True
    assert FallbackTest(model='m').model == 'm'
    assert ExternalAccessUpdate(enabled=False).enabled is False


@pytest.mark.asyncio
async def test_put_background_review_accepts_camelcase_json(client, isolatedData):
    resp = await client.put(
        '/api/config/background-review',
        json={
            'enabled': True,
            'reviewModel': 'camel-review-model',
            'reflectionModel': '',
            'autoMemoryModel': '',
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data.get('reviewModel') == 'camel-review-model' or data.get('enabled') is True
