"""Feature Flow bus + monitor API + AUG inject config (out-of-phase workstreams)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.feature_flow import (
    FEATURE_INVENTORY,
    emit_feature_flow,
    feature_flow_bus,
    list_feature_inventory,
)
from app.routers import monitor_feature_flow, config as config_router


def test_inventory_has_core_features():
    ids = {f['id'] for f in list_feature_inventory()}
    assert 'proxy' in ids
    assert 'workbench' in ids
    assert 'memory' in ids
    assert len(FEATURE_INVENTORY) >= 6


def test_emit_and_recent():
    feature_flow_bus._events.clear()
    e = emit_feature_flow(
        feature='proxy',
        stage='start',
        summary='test start',
        status='running',
        trace_id='tr-1',
    )
    assert e['traceId'] == 'tr-1'
    assert e['feature'] == 'proxy'
    recent = feature_flow_bus.recent(10)
    assert recent[0]['id'] == e['id']


def test_emit_error_status():
    feature_flow_bus._events.clear()
    e = emit_feature_flow(
        feature='proxy',
        stage='error',
        summary='boom',
        status='error',
        error='fail-reason',
        trace_id='tr-err',
    )
    assert e['status'] == 'error'
    assert e['error'] == 'fail-reason'
    errs = feature_flow_bus.recent(10, status='error')
    assert any(x['id'] == e['id'] for x in errs)


def test_monitor_routes():
    app = FastAPI()
    app.include_router(monitor_feature_flow.router)
    client = TestClient(app)
    feature_flow_bus._events.clear()
    emit_feature_flow(feature='tools', stage='exec', summary='ran tool', status='ok')
    inv = client.get('/api/monitor/features')
    assert inv.status_code == 200
    body = inv.json()
    assert body['count'] >= 6
    assert any(f['id'] == 'proxy' for f in body['features'])
    ev = client.get('/api/monitor/events?limit=50')
    assert ev.status_code == 200
    assert isinstance(ev.json(), list)
    assert len(ev.json()) >= 1


def test_inject_aug_config_roundtrip(isolatedData, monkeypatch):
    """Default false; PUT enables injectAugOnProxy in config.json."""
    from app.services import config_service

    app = FastAPI()
    app.include_router(config_router.router)
    client = TestClient(app)

    # Ensure clean
    cfg = config_service.getConfig()
    cfg.pop('injectAugOnProxy', None)
    cfg.pop('inject_aug_on_proxy', None)
    config_service.saveConfig(cfg)

    got = client.get('/api/config/inject-aug-on-proxy')
    assert got.status_code == 200
    assert got.json()['enabled'] is False

    put = client.put('/api/config/inject-aug-on-proxy', json={'enabled': True})
    assert put.status_code == 200
    assert put.json()['enabled'] is True
    assert config_service.getConfig().get('injectAugOnProxy') is True

    put2 = client.put('/api/config/inject-aug-on-proxy', json={'enabled': False})
    assert put2.json()['enabled'] is False


def test_maybe_inject_aug_into_body_off_by_default(isolatedData):
    from app.routers.proxy import _maybe_inject_aug_into_body
    from app.services import config_service

    cfg = config_service.getConfig()
    cfg['injectAugOnProxy'] = False
    config_service.saveConfig(cfg)
    body = {'model': 'x', 'messages': [{'role': 'user', 'content': 'hi'}]}
    out = _maybe_inject_aug_into_body(body, 'chat/completions')
    assert out['messages'][0]['role'] == 'user'


def test_maybe_inject_aug_into_body_when_enabled(isolatedData, tmp_path, monkeypatch):
    from app.routers import proxy as proxy_mod
    from app.services import config_service, aug_directive_service

    cfg = config_service.getConfig()
    cfg['injectAugOnProxy'] = True
    config_service.saveConfig(cfg)

    aug = tmp_path / 'AUG.md'
    aug.write_text('# Project\n\nAlways prefer tests.', encoding='utf-8')
    monkeypatch.setattr(aug_directive_service, '_resolveAugPath', lambda _ws: aug)

    body = {
        'model': 'x',
        'messages': [{'role': 'user', 'content': 'hi'}],
    }
    out = proxy_mod._maybe_inject_aug_into_body(body, 'chat/completions')
    assert out['messages'][0]['role'] == 'system'
    assert 'aug_directives' in out['messages'][0]['content']
    assert 'prefer tests' in out['messages'][0]['content']


@pytest.mark.asyncio
async def test_feature_flow_sse_stream():
    """SSE route yields ``: connected`` then a ``data:`` JSON frame on emit.

    Drives the StreamingResponse body iterator directly (with timeout) so the
    infinite SSE stream cannot hang the suite.
    """
    import asyncio
    import json

    feature_flow_bus._events.clear()
    resp = await monitor_feature_flow.stream_feature_flow_events()
    assert resp.media_type == 'text/event-stream'
    assert resp.headers.get('Cache-Control') == 'no-cache'

    body_iter = resp.body_iterator

    async def _read_chunk() -> str:
        chunk = await body_iter.__anext__()
        if isinstance(chunk, bytes):
            return chunk.decode('utf-8')
        return str(chunk)

    first = await asyncio.wait_for(_read_chunk(), timeout=1.0)
    assert 'connected' in first

    # The route only enters feature_flow_bus.stream() after the connected
    # yield is consumed — start the next read first so the subscriber attaches,
    # then emit.
    second_task = asyncio.create_task(_read_chunk())
    await asyncio.sleep(0.05)
    emit_feature_flow(
        feature='proxy',
        stage='start',
        summary='sse-live',
        status='running',
        trace_id='sse-1',
    )
    second = await asyncio.wait_for(second_task, timeout=1.0)
    assert second.startswith('data:') or 'data:' in second
    raw = second.split('data:', 1)[-1].strip()
    payload = json.loads(raw)
    assert payload['summary'] == 'sse-live'
    assert payload['feature'] == 'proxy'
    assert payload['traceId'] == 'sse-1'

    # Close the generator so subscribers are cleaned up.
    if hasattr(body_iter, 'aclose'):
        await body_iter.aclose()



def _enable_proxy_auth(isolatedData, monkeypatch, key: str = 'test-key') -> None:
    """Enable external access + set gateway key so /v1/* is reachable."""
    import json
    from pathlib import Path

    from app.config import settings
    from app.services import config_service

    cfg = config_service.getConfig()
    gw = dict(cfg.get('gateway') or {}) if isinstance(cfg.get('gateway'), dict) else {}
    ea = dict(gw.get('externalAccess') or {}) if isinstance(gw.get('externalAccess'), dict) else {}
    ea['enabled'] = True
    gw['externalAccess'] = ea
    cfg['gateway'] = gw
    config_service.saveConfig(cfg)
    # Mirror into isolated data dir file (config_service already writes there under isolatedData).
    settings.reload()
    settings.gatewayApiKey = key
    # Also keep gateway enabled in settings.config if cached
    try:
        if isinstance(settings.config, dict):
            settings.config.setdefault('gateway', {})['externalAccess'] = {'enabled': True}
    except Exception:
        pass


def test_http_inject_aug_chat_completions(isolatedData, tmp_path, monkeypatch):
    """POST /v1/chat/completions injects AUG.md into the body seen by the adapter."""
    from app.routers import proxy as proxy_mod
    from app.services import config_service, aug_directive_service
    from app.adapters import openai as openai_adapter

    _enable_proxy_auth(isolatedData, monkeypatch)
    cfg = config_service.getConfig()
    cfg['injectAugOnProxy'] = True
    config_service.saveConfig(cfg)

    aug = tmp_path / 'AUG.md'
    aug.write_text('# Project\n\nPrefer HTTP-level inject.', encoding='utf-8')
    monkeypatch.setattr(aug_directive_service, '_resolveAugPath', lambda _ws: aug)

    captured: dict[str, object] = {}

    async def fake_handle(body, request):
        captured['body'] = body
        return {'id': 'chatcmpl-test', 'choices': []}, None

    monkeypatch.setattr(openai_adapter, 'handleChatCompletions', fake_handle)
    # proxy imports openai as openaiAdapter at module level
    monkeypatch.setattr(proxy_mod, 'openaiAdapter', openai_adapter)

    app = FastAPI()
    app.include_router(proxy_mod.router)
    client = TestClient(app)
    r = client.post(
        '/v1/chat/completions',
        headers={'Authorization': 'Bearer test-key', 'Content-Type': 'application/json'},
        json={'model': 'gpt-test', 'messages': [{'role': 'user', 'content': 'hi'}]},
    )
    assert r.status_code == 200, r.text
    body = captured.get('body')
    assert isinstance(body, dict)
    messages = body.get('messages')
    assert isinstance(messages, list) and messages
    assert messages[0].get('role') == 'system'
    assert 'aug_directives' in str(messages[0].get('content'))
    assert 'HTTP-level inject' in str(messages[0].get('content'))


def test_http_inject_aug_messages(isolatedData, tmp_path, monkeypatch):
    """POST /v1/messages injects AUG.md into Anthropic system field."""
    from app.routers import proxy as proxy_mod
    from app.services import config_service, aug_directive_service
    from app.adapters import anthropic as anthropic_adapter

    _enable_proxy_auth(isolatedData, monkeypatch)
    cfg = config_service.getConfig()
    cfg['injectAugOnProxy'] = True
    config_service.saveConfig(cfg)

    aug = tmp_path / 'AUG.md'
    aug.write_text('# Project\n\nAnthropic path inject.', encoding='utf-8')
    monkeypatch.setattr(aug_directive_service, '_resolveAugPath', lambda _ws: aug)

    captured: dict[str, object] = {}

    async def fake_handle(body, request):
        captured['body'] = body
        return {'id': 'msg-test', 'content': []}, None

    monkeypatch.setattr(anthropic_adapter, 'handleMessages', fake_handle)
    monkeypatch.setattr(proxy_mod, 'anthropicAdapter', anthropic_adapter)

    app = FastAPI()
    app.include_router(proxy_mod.router)
    client = TestClient(app)
    r = client.post(
        '/v1/messages',
        headers={'Authorization': 'Bearer test-key', 'Content-Type': 'application/json'},
        json={
            'model': 'claude-test',
            'max_tokens': 16,
            'messages': [{'role': 'user', 'content': 'hi'}],
        },
    )
    assert r.status_code == 200, r.text
    body = captured.get('body')
    assert isinstance(body, dict)
    system = body.get('system')
    # Inject may produce string or list of blocks
    if isinstance(system, str):
        assert 'aug_directives' in system
        assert 'Anthropic path inject' in system
    else:
        assert isinstance(system, list)
        text = ' '.join(
            str(b.get('text', '')) if isinstance(b, dict) else str(b) for b in system
        )
        assert 'aug_directives' in text
        assert 'Anthropic path inject' in text


def test_http_no_inject_when_disabled(isolatedData, tmp_path, monkeypatch):
    """When injectAugOnProxy is false, chat completions body is unchanged."""
    from app.routers import proxy as proxy_mod
    from app.services import config_service, aug_directive_service
    from app.adapters import openai as openai_adapter

    _enable_proxy_auth(isolatedData, monkeypatch)
    cfg = config_service.getConfig()
    cfg['injectAugOnProxy'] = False
    config_service.saveConfig(cfg)

    aug = tmp_path / 'AUG.md'
    aug.write_text('# Project\n\nShould not inject.', encoding='utf-8')
    monkeypatch.setattr(aug_directive_service, '_resolveAugPath', lambda _ws: aug)

    captured: dict[str, object] = {}

    async def fake_handle(body, request):
        captured['body'] = body
        return {'id': 'chatcmpl-test', 'choices': []}, None

    monkeypatch.setattr(openai_adapter, 'handleChatCompletions', fake_handle)
    monkeypatch.setattr(proxy_mod, 'openaiAdapter', openai_adapter)

    app = FastAPI()
    app.include_router(proxy_mod.router)
    client = TestClient(app)
    r = client.post(
        '/v1/chat/completions',
        headers={'Authorization': 'Bearer test-key', 'Content-Type': 'application/json'},
        json={'model': 'gpt-test', 'messages': [{'role': 'user', 'content': 'hi'}]},
    )
    assert r.status_code == 200, r.text
    body = captured['body']
    assert isinstance(body, dict)
    messages = body['messages']
    assert messages[0]['role'] == 'user'
    assert 'aug_directives' not in str(messages)
