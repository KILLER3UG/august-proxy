"""Characterization tests for CamelModel on the august router.

Proves the alias-manage request boundary: snake_case Python fields, camelCase
JSON in (frontend contract), and that POST /api/august/aliases/manage still
works with action list (and camelCase upsert payloads).
"""
from __future__ import annotations

import pytest
from app.main import app
from app.routers.august import AliasManageItem, AliasManageRequest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_alias_manage_item_serializes_camelcase():
    item = AliasManageItem(
        alias='fast',
        target_model='claude-sonnet',
        target_provider='anthropic',
        display_alias='Fast',
    )
    dumped = item.model_dump(by_alias=True)
    assert dumped['alias'] == 'fast'
    assert dumped['targetModel'] == 'claude-sonnet'
    assert dumped['targetProvider'] == 'anthropic'
    assert dumped['displayAlias'] == 'Fast'


def test_alias_manage_request_serializes_camelcase():
    body = AliasManageRequest(
        action='upsert',
        alias='fast',
        target_model='claude-sonnet',
        target_provider='anthropic',
        display_alias='Fast',
    )
    dumped = body.model_dump(by_alias=True)
    assert dumped['action'] == 'upsert'
    assert dumped['alias'] == 'fast'
    assert dumped['targetModel'] == 'claude-sonnet'
    assert dumped['targetProvider'] == 'anthropic'
    assert dumped['displayAlias'] == 'Fast'


def test_alias_manage_request_accepts_camelcase_input():
    body = AliasManageRequest.model_validate(
        {
            'action': 'upsert',
            'alias': 'fast',
            'targetModel': 'claude-sonnet',
            'targetProvider': 'anthropic',
            'displayAlias': 'Fast',
        }
    )
    assert body.action == 'upsert'
    assert body.alias == 'fast'
    assert body.target_model == 'claude-sonnet'
    assert body.target_provider == 'anthropic'
    assert body.display_alias == 'Fast'


def test_alias_manage_request_accepts_snake_case_via_populate_by_name():
    body = AliasManageRequest(
        action='upsert',
        alias='fast',
        target_model='m',
        target_provider='p',
        display_alias='D',
    )
    assert body.target_model == 'm'
    assert body.target_provider == 'p'
    assert body.display_alias == 'D'


def test_alias_manage_item_nested_camelcase():
    body = AliasManageRequest.model_validate(
        {
            'action': 'list',
            'items': [
                {
                    'alias': 'a',
                    'targetModel': 'm',
                    'targetProvider': 'p',
                    'displayAlias': 'A',
                }
            ],
        }
    )
    assert body.items is not None
    assert len(body.items) == 1
    assert body.items[0].target_model == 'm'
    assert body.items[0].display_alias == 'A'


@pytest.mark.asyncio
async def test_post_aliases_manage_list(client, isolatedData):
    """HTTP contract: action list still works after CamelModel conversion."""
    resp = await client.post(
        '/api/august/aliases/manage',
        json={'action': 'list'},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert 'aliases' in data
    assert isinstance(data['aliases'], list)


@pytest.mark.asyncio
async def test_post_aliases_manage_upsert_accepts_camelcase_body(client, isolatedData):
    """HTTP contract: camelCase body is parsed (not 422); snake_case attrs reach service.

    Provider validation may still return 400 when the provider is unknown in an
    isolated data dir — that is independent of CamelModel field aliases.
    """
    resp = await client.post(
        '/api/august/aliases/manage',
        json={
            'action': 'upsert',
            'alias': 'camel-test-alias',
            'targetModel': 'claude-sonnet',
            'targetProvider': 'anthropic',
            'displayAlias': 'Camel Test',
        },
    )
    # Must not be a request-body schema failure (422). 200 or domain 400 is fine.
    assert resp.status_code != 422
    if resp.status_code == 200:
        data = resp.json()
        assert 'alias' in data
    else:
        assert resp.status_code == 400
        detail = resp.json().get('detail') or {}
        # Proves body.alias / body.target_* were populated (validation ran).
        assert detail.get('code') in ('validation', 'bad_request')
