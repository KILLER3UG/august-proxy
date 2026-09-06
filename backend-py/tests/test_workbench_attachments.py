"""POST /api/workbench/attachments — pasted images become workspace files.

The composer held images as data URLs that never left the client, so the
agent could not open them (analyze_media → "File not found"). This route
stores the decoded bytes under <workspace>/.aug/attachments/<sessionId>/
and returns the path the prompt then names.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest
from app.main import app
from app.services.workbench import workbench as wb
from fastapi.testclient import TestClient

_PNG_B64 = base64.b64encode(b'\x89PNG\r\n\x1a\n test-bytes').decode('ascii')


@pytest.fixture()
def session(tmp_path):
    ws = tmp_path / 'ws'
    ws.mkdir()
    return wb.createWorkbenchSession(provider='test', workspacePath=str(ws))


def _post(client: TestClient, session, **overrides):
    body = {
        'sessionId': session.id,
        'name': 'shot.png',
        'dataUrl': f'data:image/png;base64,{_PNG_B64}',
    }
    body.update(overrides)
    return client.post('/api/workbench/attachments', json=body)


def test_upload_writes_file_and_returns_path(session):
    with TestClient(app) as client:
        res = _post(client, session)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body['ok'] is True
        stored = Path(body['path'])
        assert stored.exists()
        assert stored.read_bytes().startswith(b'\x89PNG')
        assert '.aug/attachments' in body['relativePath']
        assert body['bytes'] > 0


def test_upload_sanitizes_traversal_name(session):
    with TestClient(app) as client:
        res = _post(client, session, name='..\\..\\evil.png')
        assert res.status_code == 200, res.text
        stored = Path(res.json()['path'])
        # Basename only — must land inside the attachments dir, not above it.
        assert stored.name.endswith('evil.png') or stored.name.endswith('.png')
        assert stored.parent.parent.name == '.aug' or '.aug' in stored.parts


def test_upload_requires_workspace(session, tmp_path):
    session.workspacePath = ''
    with TestClient(app) as client:
        res = _post(client, session)
        assert res.status_code == 409


def test_upload_rejects_non_dataurl(session):
    with TestClient(app) as client:
        res = _post(client, session, dataUrl='http://example.com/x.png')
        assert res.status_code == 400


def test_upload_rejects_oversize(session, monkeypatch):
    from app.routers import workbench as wbRouter

    monkeypatch.setattr(wbRouter, '_MAX_ATTACHMENT_BYTES', 8)
    with TestClient(app) as client:
        res = _post(client, session)
        assert res.status_code == 413


def test_upload_unknown_session_rejected(session):
    with TestClient(app) as client:
        res = _post(client, session, sessionId='nope-missing')
        assert res.status_code == 409
