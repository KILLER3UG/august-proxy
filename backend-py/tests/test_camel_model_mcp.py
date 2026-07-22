"""Characterization tests for CamelModel on the mcp router."""
from __future__ import annotations

import pytest
from app.main import app
from app.routers.mcp import MCPServerCreate
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_mcp_server_create_serializes():
    body = MCPServerCreate(name='s', command='npx', args=['-y', 'x'], transport='stdio')
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 's'
    assert dumped['command'] == 'npx'
    assert dumped['args'] == ['-y', 'x']
    assert dumped['transport'] == 'stdio'


def test_mcp_server_create_accepts_json():
    body = MCPServerCreate.model_validate(
        {'name': 'local', 'url': 'http://localhost:3000', 'transport': 'sse'}
    )
    assert body.name == 'local'
    assert body.url == 'http://localhost:3000'
    assert body.transport == 'sse'


@pytest.mark.asyncio
async def test_post_api_mcp_servers_accepts_json(client, isolatedData):
    resp = await client.post(
        '/api/mcp/servers',
        json={'name': 'camel-mcp', 'command': 'echo', 'args': ['hi'], 'env': {}},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data['name'] == 'camel-mcp'
    assert data['status'] == 'registered'
    assert data['id'].startswith('mcp_')
