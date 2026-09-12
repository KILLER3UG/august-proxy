"""modelMemoryRead toggle (plan 2026-08-28 Bug 8a).

The read gate stops the automatic <memory> injection and the boot fact
index when off; explicit brain_query lookups stay available (it reads
sessions/messages, not the facts store). Default is True — flipping it
off is a deliberate user choice.
"""

from __future__ import annotations

import pytest
from app.services import brain_config_service as bcs


def testModelMemoryReadRegistered():
    assert 'modelMemoryRead' in bcs.boolKeys
    assert 'modelMemoryRead' in bcs.allowedKeys
    entry = next(e for e in bcs.fieldTable if e[0] == 'modelMemoryRead')
    assert entry == ('modelMemoryRead', 'model_memory_read', True, 'bool')


def testDefaultsIncludeModelMemoryReadTrue():
    assert bcs.getDefaults().get('modelMemoryRead') is True


@pytest.mark.asyncio
async def testPutPersistsModelMemoryRead(isolatedData):
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        resp = await ac.put('/api/brain/config', json={'modelMemoryRead': False})
        assert resp.status_code == 200
        assert resp.json()['config']['modelMemoryRead'] is False
        body = (await ac.get('/api/brain/config')).json()
        assert body['config']['modelMemoryRead'] is False
        # Runtime view (what the turn loop reads) agrees.
        assert bcs.getRuntimeConfig().get('modelMemoryRead') is False


def _promptWithToggle(monkeypatch, autoInjectOn: bool) -> str:
    from app.services import brain_config_service as _bcs
    from app.services import memory_store
    from app.services.workbench import workbench as wb

    # Per-turn auto-injection is gated by memoryAutoInject (decoupled from
    # modelMemoryRead, which gates the read tool). modelMemoryRead stays on so
    # the on-demand tools remain advertised in both cases. The BOOT INDEX is
    # not gated by memoryAutoInject (ZCode-parity 044) — it rides every
    # session once the read door advertises memory tools.
    monkeypatch.setattr(
        _bcs, 'getRuntimeConfig',
        lambda: {'modelMemoryRead': True, 'memoryAutoInject': autoInjectOn},
    )
    # Seed a fact so the boot index has content — the toggle must not be
    # what hides it, not an empty store.
    memory_store.save_fact(
        'model:dark-mode', 'The user prefers dark mode',
        category='general', source='model', title='Dark mode preference',
        description='UI preference for every chat',
    )
    session = wb.createWorkbenchSession()
    return wb.buildSystemPrompt(
        session, tools=[{'name': 'brain_query'}, {'name': 'remember'}]
    )


def testIntakeAdvertisesAutoInjectionWhenOn(monkeypatch):
    prompt = _promptWithToggle(monkeypatch, True)
    assert 'relevant stored facts auto-inject each turn' in prompt
    assert 'auto-injection is OFF' not in prompt
    # Seeded fact shows up in the boot index with its description hook.
    assert 'Memory index (' in prompt
    assert 'Dark mode preference' in prompt
    assert 'UI preference for every chat' in prompt


def testIntakeDropsAutoInjectionButKeepsIndexWhenOff(monkeypatch):
    prompt = _promptWithToggle(monkeypatch, False)
    assert 'auto-injection is OFF (memoryAutoInject)' in prompt
    assert 'relevant stored facts auto-inject each turn' not in prompt
    # ZCode-parity 044: the boot index is ALWAYS loaded (frozen per session)
    # — the model knows what it remembers even when per-turn recall is off.
    assert 'Memory index (' in prompt
    assert 'Dark mode preference' in prompt
    assert 'model:dark-mode' in prompt
    # On-demand lookups stay advertised (the read tool is gated by
    # modelMemoryRead, which is independent of auto-injection).
    assert 'brain_query' in prompt
