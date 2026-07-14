"""Feature Flow bus + monitor API + AUG inject config (out-of-phase workstreams)."""

from __future__ import annotations

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
