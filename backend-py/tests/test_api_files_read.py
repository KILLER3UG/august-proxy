"""GET /api/workbench/files/read — right-drawer viewer fallback (Bug 7a).

Dev / backend-only runs have no Tauri FS API, so the frontend reads files
through this route. Policy under test:

- files inside the requesting session's workspace → 200 + base64 payload
- files inside ANY live workbench session's workspace → 200 (no sessionId)
- files under the system temp area → 200
- files outside every workspace and the temp area → 403
- hardline credential reads (id_rsa & friends) → 403 even inside a workspace
- missing file → 404, missing path param → 400, >25MB → 413
"""

from __future__ import annotations

import base64

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    from app.services.workbench import workbench as wb

    wb._sessions.clear()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac
    wb._sessions.clear()


@pytest.fixture
def layout(tmp_path, monkeypatch):
    """Workspace + temp area + outside dir. The temp root is pinned so the
    pytest tmp dir itself does not silently count as the temp area."""
    import tempfile as _tf

    ws = tmp_path / 'ws'
    temparea = tmp_path / 'temparea'
    outside = tmp_path / 'elsewhere'
    for d in (ws, temparea, outside):
        d.mkdir()
    monkeypatch.setattr(_tf, 'gettempdir', lambda: str(temparea))
    (ws / 'report.html').write_text('<html><body>hi</body></html>', 'utf-8')
    (ws / 'id_rsa').write_text('PRIVATE KEY MATERIAL', 'utf-8')
    (temparea / 'scratch.txt').write_text('temp file', 'utf-8')
    (outside / 'secret.txt').write_text('outside every workspace', 'utf-8')
    return {'ws': ws, 'temparea': temparea, 'outside': outside}


def _makeSession(workspace: str) -> str:
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession(workspacePath=workspace)
    return session.id


@pytest.mark.asyncio
async def testReadsFileInsideSessionWorkspace(client, layout):
    sid = _makeSession(str(layout['ws']))
    target = layout['ws'] / 'report.html'
    resp = await client.get(
        '/api/workbench/files/read', params={'path': str(target), 'sessionId': sid}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body['ok'] is True
    assert body['name'] == 'report.html'
    assert body['mimeType'] == 'text/html'
    assert base64.b64decode(body['data']).decode('utf-8') == '<html><body>hi</body></html>'


@pytest.mark.asyncio
async def testReadsFileInsideAnyWorkbenchWorkspaceWithoutSessionId(client, layout):
    _makeSession(str(layout['ws']))
    target = layout['ws'] / 'report.html'
    resp = await client.get('/api/workbench/files/read', params={'path': str(target)})
    assert resp.status_code == 200
    assert resp.json()['ok'] is True


@pytest.mark.asyncio
async def testReadsFileUnderTempArea(client, layout):
    target = layout['temparea'] / 'scratch.txt'
    resp = await client.get('/api/workbench/files/read', params={'path': str(target)})
    assert resp.status_code == 200
    body = resp.json()
    assert base64.b64decode(body['data']).decode('utf-8') == 'temp file'


@pytest.mark.asyncio
async def testRefusesFileOutsideEveryWorkspace(client, layout):
    _makeSession(str(layout['ws']))
    target = layout['outside'] / 'secret.txt'
    resp = await client.get('/api/workbench/files/read', params={'path': str(target)})
    assert resp.status_code == 403
    assert 'outside' in resp.json()['detail']


@pytest.mark.asyncio
async def testRefusesHardlineCredentialReadEvenInsideWorkspace(client, layout):
    sid = _makeSession(str(layout['ws']))
    target = layout['ws'] / 'id_rsa'
    resp = await client.get(
        '/api/workbench/files/read', params={'path': str(target), 'sessionId': sid}
    )
    assert resp.status_code == 403
    assert 'hardline' in resp.json()['detail']


@pytest.mark.asyncio
async def testMissingFileIs404(client, layout):
    sid = _makeSession(str(layout['ws']))
    resp = await client.get(
        '/api/workbench/files/read',
        params={'path': str(layout['ws'] / 'nope.txt'), 'sessionId': sid},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def testMissingPathParamIs400(client, layout):
    resp = await client.get('/api/workbench/files/read')
    assert resp.status_code == 400


@pytest.mark.asyncio
async def testOversizedFileIs413(client, layout):
    sid = _makeSession(str(layout['ws']))
    big = layout['ws'] / 'big.bin'
    big.write_bytes(b'\0' * (25 * 1024 * 1024 + 1))
    resp = await client.get(
        '/api/workbench/files/read', params={'path': str(big), 'sessionId': sid}
    )
    assert resp.status_code == 413


# ── /api/workbench/files/raw — Surfer iframe CORS feed (P2.3) ──────────────
# Same sandbox contract as /files/read, but raw bytes + waveform mime, so
# the embedded Surfer viewer (separate origin) can fetch workspace VCDs.


@pytest.mark.asyncio
async def testRawServesWorkspaceVcdAsTextPlain(client, layout):
    sid = _makeSession(str(layout['ws']))
    vcd = layout['ws'] / 'digital.vcd'
    vcd.write_text('$date today $end\n$var wire 1 ! dout $end\n', 'utf-8')
    resp = await client.get(
        '/api/workbench/files/raw', params={'path': str(vcd), 'sessionId': sid}
    )
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('text/plain')
    assert b'$var wire 1 ! dout' in resp.content


@pytest.mark.asyncio
async def testRawRefusesOutsideWorkspaceAndMissingPath(client, layout):
    _makeSession(str(layout['ws']))
    resp = await client.get(
        '/api/workbench/files/raw', params={'path': str(layout['outside'] / 'secret.txt')}
    )
    assert resp.status_code == 403
    resp = await client.get('/api/workbench/files/raw')
    assert resp.status_code == 400
