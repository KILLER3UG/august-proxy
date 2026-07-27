"""UI customization service, routes, and the customize_ui model tool."""

import json

from app.main import app
from app.services import config_service
from app.services import ui_customization_service as ucs
from httpx import ASGITransport, AsyncClient

# ── color resolution ───────────────────────────────────────────────────


def test_resolve_color_accepts_hex_and_named():
    assert ucs.resolveColor('#123456') == '#123456'
    assert ucs.resolveColor('#abc') == '#abc'
    assert ucs.resolveColor('gray') == '#808080'
    assert ucs.resolveColor('Black') == '#000000'  # case-insensitive
    assert ucs.resolveColor('light gray') == '#d3d3d3'  # spaces ignored
    assert ucs.resolveColor('notacolor') is None
    assert ucs.resolveColor('') is None


# ── service ────────────────────────────────────────────────────────────


def test_replace_customization_persists_and_resolves_names(monkeypatch):
    events: list[tuple] = []
    monkeypatch.setattr(
        'app.services.realtime_bus.emit_realtime', lambda t, **kw: events.append((t, kw))
    )
    monkeypatch.setattr('app.services.realtime_bus.emit_invalidate', lambda *a, **kw: None)

    applied, errors = ucs.replaceCustomization(
        {'chatInputBackground': 'gray', 'chatBackground': '#000000', 'bogusToken': '#fff'},
        actor='test',
    )

    assert errors and 'bogusToken' in errors[0]
    assert applied['chatInputBackground'] == '#808080'
    assert applied['chatBackground'] == '#000000'
    # Persisted to config.json…
    stored = config_service.getConfig().get('uiCustomization')
    assert stored['chatInputBackground'] == '#808080'
    # …and broadcast for live recolor.
    assert events and events[0][0] == 'ui.customization'
    assert events[0][1]['customization']['chatBackground'] == '#000000'


def test_replace_customization_null_removes_token(monkeypatch):
    monkeypatch.setattr('app.services.realtime_bus.emit_realtime', lambda t, **kw: None)
    monkeypatch.setattr('app.services.realtime_bus.emit_invalidate', lambda *a, **kw: None)

    ucs.replaceCustomization({'primary': '#ff0000'}, actor='test')
    applied, errors = ucs.replaceCustomization({'primary': None}, actor='test')

    assert not errors
    assert 'primary' not in applied
    assert 'primary' not in ucs.getCustomization()


def test_clear_customization(monkeypatch):
    monkeypatch.setattr('app.services.realtime_bus.emit_realtime', lambda t, **kw: None)
    monkeypatch.setattr('app.services.realtime_bus.emit_invalidate', lambda *a, **kw: None)

    ucs.replaceCustomization({'accent': '#00ff00'}, actor='test')
    assert ucs.clearCustomization(actor='test') == {}
    assert ucs.getCustomization() == {}


# ── routes ─────────────────────────────────────────────────────────────


async def test_ui_customization_routes(monkeypatch):
    monkeypatch.setattr('app.services.realtime_bus.emit_realtime', lambda t, **kw: None)
    monkeypatch.setattr('app.services.realtime_bus.emit_invalidate', lambda *a, **kw: None)
    ucs.clearCustomization(actor='test')

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as client:
        put = await client.put(
            '/api/config/ui-customization',
            json={'changes': {'userBubble': 'navy', 'notAToken': '#000'}},
        )
        got = await client.get('/api/config/ui-customization')
        reset = await client.put('/api/config/ui-customization', json={'changes': {}, 'reset': True})

    assert put.status_code == 200
    body = put.json()
    assert body['customization']['userBubble'] == '#1e3a8a'
    assert body['errors'] and 'notAToken' in body['errors'][0]
    assert got.json()['customization']['userBubble'] == '#1e3a8a'
    assert reset.json()['customization'] == {}


# ── customize_ui tool ──────────────────────────────────────────────────


async def test_customize_ui_tool_applies_named_colors(monkeypatch):
    monkeypatch.setattr('app.services.realtime_bus.emit_realtime', lambda t, **kw: None)
    monkeypatch.setattr('app.services.realtime_bus.emit_invalidate', lambda *a, **kw: None)
    ucs.clearCustomization(actor='test')

    from app.services.self_config_tools import customizeUi

    result = json.loads(await customizeUi(changes={'chatBackground': 'black'}))
    assert result['status'] == 'success'
    assert result['applied']['chatBackground'] == '#000000'

    # Reset path restores defaults.
    result = json.loads(await customizeUi(reset=True))
    assert result['status'] == 'success'
    assert result['applied'] == {}

    # Missing changes → helpful error, not a crash.
    result = json.loads(await customizeUi())
    assert result['status'] == 'error'
