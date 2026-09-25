"""Settings → Memory "What the model sees" preview.

The claim this endpoint sells is that the text in the Settings card IS the text
a chat turn receives. That is only true if nothing between the two diverges: no
second renderer, no re-derived gate. So every assertion below compares the
preview against the same builder the workbench calls, rather than against a
hand-written expected string that would happily keep passing after the block
shape changed.

  1. the turn block is byte-identical to ``build_memory_block`` for that message
  2. with ``memoryAutoInject`` off it is byte-identical to the profile lane
     alone — and the flag is reported so the UI can say WHY
  3. the boot index is byte-identical to ``brain_index_snippet``
  4. an empty store previews as empty rather than as an error
  5. a write through the Settings door shows up in the next preview (the cached
     BM25 corpus is busted, so the preview cannot serve a stale block)
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services import brain_config_service as bc
from app.services import memory_store
from app.services.memory_store.fact_retrieval import (
    build_memory_block,
    build_profile_memory_block,
    invalidate_fact_index,
)
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client(isolatedData):
    invalidate_fact_index()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac
    invalidate_fact_index()


_MESSAGE = 'how should I configure the connection pool for my postgres app'


def _profile(key: str, body: str, title: str) -> None:
    memory_store.save_fact(
        key, {'fact': body}, title=title, kind=memory_store.PROFILE_FACT_KIND
    )


@pytest.mark.asyncio
async def testTurnBlockIsWhatTheBuilderRenders(client):
    """No second renderer: the previewed block equals the one a turn gets."""
    _profile('profile:db', 'The user runs Postgres 16 on a laptop.', 'Where the data lives')
    memory_store.save_fact(
        'ops:pool', {'fact': 'Set the pool size to 10 for the postgres app.'}, title='Pool size'
    )
    await client.put('/api/brain/config', json={'memoryAutoInject': True})

    resp = await client.get('/api/brain/memory/preview', params={'query': _MESSAGE})
    assert resp.status_code == 200
    body = resp.json()
    expected, _injected = build_memory_block(_MESSAGE)
    assert body['turnBlock'] == expected
    assert 'Pool size' in body['turnBlock'], 'the message should recall the matching fact'
    assert body['autoInject'] is True


@pytest.mark.asyncio
async def testAutoInjectOffPreviewsTheLaneAndSaysSo(client):
    """The gate is the caller's, and the preview must not hide which side of it
    produced an empty-looking block."""
    _profile('profile:who', 'The user is a backend engineer in Seoul.', 'Who')
    memory_store.save_fact(
        'ops:pool2', {'fact': 'Set the pool size to 10 for the postgres app.'}, title='Pool two'
    )
    await client.put('/api/brain/config', json={'memoryAutoInject': False})

    resp = await client.get('/api/brain/memory/preview', params={'query': _MESSAGE})
    body = resp.json()
    lane, _rows = build_profile_memory_block()
    assert body['turnBlock'] == lane
    assert body['autoInject'] is False
    assert 'Who' in body['turnBlock']
    assert 'Pool two' not in body['turnBlock'], 'keyword recall must stay gated off'


@pytest.mark.asyncio
async def testBootIndexIsTheSnippetsBytes(client):
    """The system-prompt index is a different shape from the block (title (key) —
    hook); the preview shows that shape verbatim, not the block re-listed."""
    memory_store.save_fact(
        'user:plant', {'fact': 'Owns a monstera named Gerald.'}, title='Gerald'
    )
    from app.services.memory_store.brain import brain_index_snippet

    resp = await client.get('/api/brain/memory/preview')
    body = resp.json()
    assert body['bootIndex'] == brain_index_snippet().strip()
    assert 'Gerald' in body['bootIndex']
    assert body['modelMemoryRead'] is True


@pytest.mark.asyncio
async def testEmptyStorePreviewsEmptyNotError(client):
    resp = await client.get('/api/brain/memory/preview', params={'query': 'anything at all here'})
    assert resp.status_code == 200
    body = resp.json()
    assert body['turnBlock'] == ''
    assert body['bootIndex'] == ''
    assert body['injectedFacts'] == []


@pytest.mark.asyncio
async def testAWriteShowsUpInThenextPreview(client):
    """A stale preview would be worse than none: it tells the user the model is
    not seeing a fact they can see in the list."""
    await client.put('/api/brain/config', json={'memoryAutoInject': True})
    before = (await client.get('/api/brain/memory/preview', params={'query': _MESSAGE})).json()
    assert before['turnBlock'] == ''

    memory_store.save_fact(
        'ops:pool3', {'fact': 'Rotate the postgres credentials weekly.'}, title='Rotation'
    )
    after = (await client.get('/api/brain/memory/preview', params={'query': _MESSAGE})).json()
    assert 'Rotation' in after['turnBlock']
    assert [f['key'] for f in after['injectedFacts']] == ['ops:pool3']


@pytest.mark.asyncio
async def testProjectBlockOnlyAppearsWithAWorkspace(client, tmp_path):
    """With no workspace the card must not invent a project section; with one it
    carries the same frozen boot block a bound session gets."""
    plain = (await client.get('/api/brain/memory/preview')).json()
    assert plain['projectBlock'] == ''

    ws = tmp_path / 'blog'
    ws.mkdir()
    mem = ws / '.aug' / 'memory'
    mem.mkdir(parents=True)
    (mem / 'memory.md').write_text('## NSIS is legacy here\n\nUse WiX for installers.\n', 'utf-8')

    from app.services import project_memory as pm

    got = (await client.get('/api/brain/memory/preview', params={'workspace': str(ws)})).json()
    assert got['projectBlock'] == pm.project_block(str(ws))
    assert 'NSIS is legacy here' in got['projectBlock']


@pytest.mark.asyncio
async def testRuntimeConfigKeysAreReportedNotGuessed(client):
    """The UI's copy branches on these two booleans; if the endpoint stopped
    returning them the card would render real text under a wrong explanation."""
    body = (await client.get('/api/brain/memory/preview')).json()
    assert set(body) >= {'autoInject', 'modelMemoryRead', 'turnBlock', 'bootIndex', 'injectedFacts'}
    assert body['autoInject'] == bool(
        bc.getRuntimeConfig().get('memoryAutoInject', False)
    )
