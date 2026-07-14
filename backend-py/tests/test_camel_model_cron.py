"""Characterization tests for CamelModel on the cron router."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers.cron import CronJobCreate


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_cron_job_create_serializes():
    body = CronJobCreate(name='nightly', schedule='0 0 * * *', command='backup', enabled=True)
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 'nightly'
    assert dumped['schedule'] == '0 0 * * *'
    assert dumped['command'] == 'backup'
    assert dumped['enabled'] is True


def test_cron_job_create_accepts_json():
    body = CronJobCreate.model_validate(
        {'name': 'j', 'schedule': '* * * * *', 'command': 'echo', 'enabled': False}
    )
    assert body.name == 'j'
    assert body.enabled is False


@pytest.mark.asyncio
async def test_post_api_cron_accepts_json(client, isolatedData):
    resp = await client.post(
        '/api/cron',
        json={'name': 'camel-cron', 'schedule': '*/5 * * * *', 'command': 'true', 'enabled': True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data['name'] == 'camel-cron'
    assert data['status'] == 'idle'
    assert data['id'].startswith('cron_')
