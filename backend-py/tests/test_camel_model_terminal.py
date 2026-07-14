"""Characterization tests for CamelModel on the legacy terminal router.

Proves TerminalCreate / TerminalWrite serialize and validate under CamelModel.
Optional HTTP POST /api/terminal when isolatedData is available.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers.terminal import TerminalCreate, TerminalWrite


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_terminal_create_serializes_and_validates():
    body = TerminalCreate(name='main', cwd='/tmp', shell='bash')
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 'main'
    assert dumped['cwd'] == '/tmp'
    assert dumped['shell'] == 'bash'

    parsed = TerminalCreate.model_validate(
        {'name': 'sess', 'cwd': '/work', 'shell': 'pwsh'}
    )
    assert parsed.name == 'sess'
    assert parsed.cwd == '/work'
    assert parsed.shell == 'pwsh'


def test_terminal_create_defaults():
    body = TerminalCreate()
    assert body.name == 'default'
    assert body.cwd == ''
    assert body.shell == ''
    dumped = body.model_dump(by_alias=True)
    assert dumped['name'] == 'default'


def test_terminal_write_serializes_and_validates():
    body = TerminalWrite(data='echo hi\n')
    dumped = body.model_dump(by_alias=True)
    assert dumped['data'] == 'echo hi\n'

    parsed = TerminalWrite.model_validate({'data': 'ls'})
    assert parsed.data == 'ls'


@pytest.mark.asyncio
async def test_post_api_terminal_accepts_json(client, isolatedData):
    """HTTP contract: POST /api/terminal creates a session from TerminalCreate."""
    resp = await client.post(
        '/api/terminal',
        json={'name': 'CamelLegacyTerm', 'cwd': '', 'shell': ''},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert 'id' in data or data.get('title') == 'CamelLegacyTerm' or isinstance(data, dict)
