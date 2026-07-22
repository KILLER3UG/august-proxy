"""Characterization tests for CamelModel on the sessions router."""
from __future__ import annotations

import pytest
from app.main import app
from app.routers.sessions import MessageCreate
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_message_create_accepts_fields():
    body = MessageCreate(role='user', content='hello')
    dumped = body.model_dump(by_alias=True)
    assert dumped['role'] == 'user'
    assert dumped['content'] == 'hello'


def test_message_create_model_validate():
    body = MessageCreate.model_validate({'role': 'assistant', 'content': 'hi'})
    assert body.role == 'assistant'
    assert body.content == 'hi'


@pytest.mark.asyncio
async def test_post_session_message_accepts_json(client, isolatedData):
    create = await client.post('/api/sessions')
    assert create.status_code == 200
    sid = create.json()['id']

    resp = await client.post(
        f'/api/sessions/{sid}/messages',
        json={'role': 'user', 'content': 'camel-session-msg'},
    )
    assert resp.status_code == 200
    assert resp.json()['status'] == 'ok'
    assert 'id' in resp.json()
