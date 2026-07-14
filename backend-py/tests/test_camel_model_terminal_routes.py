"""Characterization tests for CamelModel on the terminal_routes UI bodies."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers.terminal_routes import (
    ApproveBody,
    CommandBody,
    CreateSessionBody,
    ResizeBody,
)


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_create_session_body_serializes_camelcase():
    body = CreateSessionBody(
        title='T',
        cwd='/tmp',
        approved_interactive=True,
        cols=100,
        rows=40,
    )
    dumped = body.model_dump(by_alias=True)
    assert dumped['approvedInteractive'] is True
    assert dumped['cols'] == 100
    assert dumped['rows'] == 40


def test_create_session_body_accepts_camelcase_input():
    body = CreateSessionBody.model_validate(
        {
            'title': 'X',
            'approvedInteractive': True,
            'cols': 90,
            'rows': 30,
        }
    )
    assert body.approved_interactive is True
    assert body.cols == 90


def test_resize_command_approve_multiword_fields():
    resize = ResizeBody.model_validate({'sessionId': 'term_1', 'cols': 80, 'rows': 24})
    assert resize.session_id == 'term_1'
    cmd = CommandBody.model_validate({'command': 'ls', 'timeoutMs': 5000})
    assert cmd.timeout_ms == 5000
    assert cmd.model_dump(by_alias=True)['timeoutMs'] == 5000
    approve = ApproveBody.model_validate({'requestId': 'apr_1', 'approve': False})
    assert approve.request_id == 'apr_1'
    assert approve.approve is False


@pytest.mark.asyncio
async def test_post_api_terminal_sessions_accepts_camelcase_json(client, isolatedData):
    resp = await client.post(
        '/api/terminal/sessions',
        json={
            'title': 'CamelTerm',
            'cwd': '',
            'approvedInteractive': False,
            'cols': 80,
            'rows': 24,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert 'id' in data
    assert data.get('title') == 'CamelTerm' or data.get('id', '').startswith('term_')
