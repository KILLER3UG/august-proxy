"""Regression tests for the Observability + Memory black-screen fix.

Locks in the response-shape contract that the frontend relies on:

- /api/activity MUST be a bare array (a wrapper object like {entries: [...]}
  bypassed the hook's `?? []` guard and crashed the renderer with
  "activity is not iterable" — the Traffic & Logs black screen).
- /api/requests MUST have {pending, completed} arrays (the old {requests: [...]}
  wrapper made both undefined, producing empty tables forever).
- /api/stats MUST expose the full StatsResponse field set the UI reads.
- /api/logs/recent, /api/details, /api/conversations return their Node shapes.
- /api/brain/* (the Memory & Knowledge dashboard endpoints) return data
  instead of 404, so the tab is populated from the Python backend. These were
  renamed from the legacy /ui/memory/* + /ui/brain/* paths to a single unified
  /api/brain/* namespace with resource sub-paths (no "memory" nesting inside
  "brain").
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services import logger as traffic
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def _seedTraffic():
    """Seed one completed request and an activity entry."""
    rid = traffic.startRequest(
        {
            'model': 'claude-sonnet-4-7',
            'provider': 'anthropic',
            'clientType': 'anthropic',
            'endpoint': '/v1/messages',
            'method': 'POST',
            'path': '/v1/messages',
            'sessionId': 's1',
        }
    )
    traffic.captureRequest(rid, {'model': 'claude-sonnet-4-7'})
    traffic.endRequest(rid, {'usage': {'prompt_tokens': 5, 'completion_tokens': 3}})
    traffic.logActivity('request_complete', 'regression test entry')
    return rid


@pytest.mark.asyncio
async def testApiActivityReturnsBareArray(client):
    """GET /api/activity must be a JSON array, not a wrapper object."""
    _seedTraffic()
    r = await client.get('/api/activity')
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list), f'expected bare array, got {type(body).__name__}'
    assert len(body) >= 1
    e = body[0]
    assert 'time' in e and 'type' in e and ('detail' in e)


@pytest.mark.asyncio
async def testApiRequestsHasPendingAndCompleted(client):
    """GET /api/requests must return {pending: [], completed: []}."""
    _seedTraffic()
    r = await client.get('/api/requests?period=all')
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, dict)
    assert isinstance(body.get('pending'), list)
    assert isinstance(body.get('completed'), list)
    assert len(body['completed']) >= 1
    entry = body['completed'][0]
    for k in ('reqId', 'clientType', 'endpoint', 'model', 'status', 'timestamp'):
        assert k in entry, f'missing {k} in completed entry'


@pytest.mark.asyncio
async def testApiStatsHasFullShape(client):
    """GET /api/stats must expose the full StatsResponse field set."""
    _seedTraffic()
    r = await client.get('/api/stats?period=all')
    assert r.status_code == 200
    body = r.json()
    for k in (
        'totalRequests',
        'completedRequests',
        'errorRequests',
        'totalInputTokens',
        'totalOutputTokens',
        'totalTokens',
        'estimatedInputCost',
        'estimatedOutputCost',
        'estimatedTotalCost',
        'avgDurationMs',
        'pendingRequests',
        'mostUsedModel',
        'mostUsedCount',
        'modelBreakdown',
        'profileStats',
    ):
        assert k in body, f'missing {k} in stats'


@pytest.mark.asyncio
async def testApiLogsRecentShape(client):
    r = await client.get('/api/logs/recent?limit=10')
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body.get('events'), list)
    assert body.get('count') == len(body['events'])


@pytest.mark.asyncio
async def testApiDetailsIsArray(client):
    r = await client.get('/api/details?period=all')
    assert r.status_code == 200
    assert isinstance(r.json(), list)


@pytest.mark.asyncio
async def testApiConversationsIsDict(client):
    _seedTraffic()
    r = await client.get('/api/conversations?period=all')
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, dict)


@pytest.mark.asyncio
async def testApiBrainStatus(client, isolatedData):
    from app.services import memory_store

    memory_store.save_memory('k1', {'summary': 'v1'})
    r = await client.get('/api/brain/status')
    assert r.status_code == 200
    body = r.json()
    assert body.get('available') is True
    assert body.get('driver') == 'sqlite'
    assert isinstance(body.get('count'), int)


@pytest.mark.asyncio
async def testApiBrainItems(client, isolatedData):
    from app.services import memory_store

    memory_store.save_memory('k1', {'summary': 'hello'})
    r = await client.get('/api/brain/items')
    assert r.status_code == 200
    items = r.json().get('items', [])
    assert isinstance(items, list)
    assert any((it.get('key') == 'k1' for it in items))


@pytest.mark.asyncio
async def testApiBrainVectors(client):
    r = await client.get('/api/brain/vectors')
    assert r.status_code == 200
    assert isinstance(r.json().get('entries'), list)


@pytest.mark.asyncio
async def testApiBrainPrompt(client):
    r = await client.get('/api/brain/prompt')
    assert r.status_code == 200
    body = r.json()
    assert 'prompt' in body and isinstance(body.get('length'), int)


@pytest.mark.asyncio
async def testApiBrainSearch(client, isolatedData):
    from app.services import memory_store

    memory_store.save_memory('greeting', {'summary': 'hello world'})
    r = await client.get('/api/brain/search?q=hello')
    assert r.status_code == 200
    results = r.json().get('results', [])
    assert isinstance(results, list)


@pytest.mark.asyncio
async def testApiBrainLearning(client):
    r = await client.get('/api/brain/learning')
    assert r.status_code == 200
    body = r.json()
    assert 'status' in body


@pytest.mark.asyncio
async def testApiBrainGuidelines(client, isolatedData):
    from app.services import memory_store

    memory_store.save_fact('g1', {'text': 'Be concise'}, category='guideline')
    r = await client.get('/api/brain/guidelines')
    assert r.status_code == 200
    guidelines = r.json().get('guidelines', [])
    assert isinstance(guidelines, list)
    assert any((g.get('id') == 'g1' for g in guidelines))


@pytest.mark.asyncio
async def testApiBrainGraph(client):
    r = await client.get('/api/brain/graph')
    assert r.status_code == 200
    body = r.json()
    assert 'stats' in body
    assert 'counts' in body['stats']


@pytest.mark.asyncio
async def testApiBrainDiagnostics(client):
    r = await client.get('/api/brain/diagnostics')
    assert r.status_code == 200
    body = r.json()
    for k in ('injectedChars', 'maxChars', 'guidelines', 'semanticFacts', 'vectorEntries'):
        assert k in body, f'missing {k} in diagnostics'


@pytest.mark.asyncio
async def testLegacyUiRoutesAreGone(client):
    """The old misleading /ui/* paths must not serve brain JSON.

    After the rename to /api/brain/*, the legacy /ui/memory/* and /ui/brain/*
    paths have no matching API route. They fall through to the SPA fallback,
    which returns index.html (HTML), not a brain JSON payload. Asserting that
    confirms no stale router still serves the old namespace.
    """
    for path in ('/ui/memory/store/status', '/ui/brain/diagnostics'):
        r = await client.get(path)
        ct = r.headers.get('content-type', '')
        body = r.text or ''
        isHtml = 'text/html' in ct or '<!doctype' in body.lower() or '<html' in body.lower()
        isApi404 = r.status_code == 404 and 'application/json' in ct
        assert isHtml or isApi404, f'{path} should be SPA HTML or a JSON 404, got {r.status_code} ({ct})'
        assert not ('"driver"' in body and '"available"' in body), (
            f'{path} is still serving brain JSON — a stale /ui/* router remains'
        )
