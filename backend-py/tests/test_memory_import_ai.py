"""Tests for the AI-arranged memory import endpoint.

The endpoint calls the user-selected model, so the model + provider + memory
reads are monkeypatched; what we lock here is the normalization: JSON-array
parsing (with code fences), category clamping, and the guard that a model
referencing a non-existent key gets its phantom delete dropped and its
phantom update downgraded to an add.
"""
from __future__ import annotations

import json

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def _patch(monkeypatch, answer: str, existing_keys: list[str]):
    import app.services.memory_store as ms
    import app.services.workbench.providers as prov

    monkeypatch.setattr(prov, 'resolve_chat_llm', lambda **kw: ({'name': 'P', 'id': 'p'}, 'model-x'))
    monkeypatch.setattr(prov, 'is_openai_provider', lambda p: True)
    monkeypatch.setattr(prov, 'is_anthropic_provider', lambda p: False)
    monkeypatch.setattr(prov, 'extract_text', lambda blocks: '')

    async def _fake_call(**kwargs):
        return {'text': answer}

    monkeypatch.setattr(prov, 'call_openai_workbench', _fake_call)
    monkeypatch.setattr(
        ms, 'list_facts', lambda **kw: [{'factKey': k} for k in existing_keys]
    )


@pytest.mark.asyncio
async def test_ai_import_parses_fenced_json_and_clamps_category(client, monkeypatch, isolatedData):
    ops = [
        {'action': 'add', 'key': 'prefers-dark', 'value': 'Prefers dark mode', 'category': 'preference'},
        {'action': 'add', 'key': 'no-value', 'value': '   ', 'category': 'user'},
    ]
    _patch(monkeypatch, '```json\n' + json.dumps(ops) + '\n```', [])
    resp = await client.post(
        '/api/august/memory/import/ai',
        json={'text': 'some export', 'model': 'model-x', 'provider': 'p'},
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()['operations']
    # Empty-value add dropped; unknown category clamped to 'general'.
    assert len(out) == 1
    assert out[0]['key'] == 'prefers-dark'
    assert out[0]['category'] == 'general'


@pytest.mark.asyncio
async def test_ai_import_guards_phantom_update_and_delete(client, monkeypatch, isolatedData):
    ops = [
        {'action': 'update', 'key': 'real-key', 'value': 'improved', 'category': 'user'},
        {'action': 'update', 'key': 'ghost-key', 'value': 'newish', 'category': 'user'},
        {'action': 'delete', 'key': 'ghost-key', 'value': '', 'category': 'user'},
        {'action': 'delete', 'key': 'real-key', 'value': '', 'category': 'user'},
    ]
    _patch(monkeypatch, json.dumps(ops), ['real-key'])
    resp = await client.post(
        '/api/august/memory/import/ai',
        json={'text': 'export', 'model': 'model-x', 'provider': 'p'},
    )
    assert resp.status_code == 200, resp.text
    by = {(o['action'], o['key']): o for o in resp.json()['operations']}
    assert ('update', 'real-key') in by
    # Phantom update → downgraded to add; phantom delete → dropped.
    assert ('add', 'ghost-key') in by
    assert ('delete', 'ghost-key') not in by
    # Real delete kept.
    assert ('delete', 'real-key') in by


@pytest.mark.asyncio
async def test_ai_import_rejects_non_json(client, monkeypatch, isolatedData):
    _patch(monkeypatch, 'I could not parse this at all', [])
    resp = await client.post(
        '/api/august/memory/import/ai',
        json={'text': 'export', 'model': 'model-x', 'provider': 'p'},
    )
    assert resp.status_code == 502
