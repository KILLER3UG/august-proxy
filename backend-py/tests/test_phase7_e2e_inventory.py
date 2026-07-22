"""Phase 7 — full automated E2E inventory gate (no live external credentials).

Proves each Feature Inventory surface via in-process HTTP/unit paths that CI
runs on every push. Real-provider / live bot credentials stay env-gated
elsewhere; this file is the permanent non-network inventory proof.
"""

from __future__ import annotations

import pytest
from app.routers import config as config_router
from app.routers import monitor_feature_flow
from app.routers import proxy as proxy_mod
from app.services.feature_flow import (
    FEATURE_INVENTORY,
    emit_feature_flow,
    feature_flow_bus,
    list_feature_inventory,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ── Inventory completeness ────────────────────────────────────────────


def test_phase7_inventory_catalog_covers_all_handoff_areas():
    ids = {str(f['id']) for f in list_feature_inventory()}
    required = {
        'proxy',
        'memory',
        'tools',
        'cognitive',
        'gateway',
        'skills',
        'security',
        'workbench',
    }
    assert required <= ids, f'missing inventory ids: {required - ids}'
    assert len(FEATURE_INVENTORY) >= 8


# ── 1. Proxy / adapters (HTTP with stub adapters) ─────────────────────


def _enable_proxy(isolatedData, monkeypatch, key: str = 'e2e-key') -> None:
    from app.config import settings
    from app.services import config_service

    cfg = config_service.getConfig()
    gw = dict(cfg.get('gateway') or {}) if isinstance(cfg.get('gateway'), dict) else {}
    ea = dict(gw.get('externalAccess') or {}) if isinstance(gw.get('externalAccess'), dict) else {}
    ea['enabled'] = True
    gw['externalAccess'] = ea
    cfg['gateway'] = gw
    config_service.saveConfig(cfg)
    settings.reload()
    settings.gatewayApiKey = key


def test_phase7_proxy_chat_completions_http_e2e(isolatedData, monkeypatch):
    from app.adapters import openai as openai_adapter

    _enable_proxy(isolatedData, monkeypatch)
    feature_flow_bus._events.clear()
    captured: dict[str, object] = {}

    async def fake_handle(body, request):
        captured['body'] = body
        return {'id': 'cmpl-e2e', 'choices': []}, None

    monkeypatch.setattr(openai_adapter, 'handleChatCompletions', fake_handle)
    monkeypatch.setattr(proxy_mod, 'openaiAdapter', openai_adapter)

    app = FastAPI()
    app.include_router(proxy_mod.router)
    client = TestClient(app)
    r = client.post(
        '/v1/chat/completions',
        headers={'Authorization': 'Bearer e2e-key', 'Content-Type': 'application/json'},
        json={'model': 'gpt-e2e', 'messages': [{'role': 'user', 'content': 'ping'}]},
    )
    assert r.status_code == 200
    assert isinstance(captured.get('body'), dict)
    # Feature flow instrumentation fired for the proxy hop
    feats = [e for e in feature_flow_bus.recent(50) if e.get('feature') == 'proxy']
    assert feats, 'expected proxy feature_flow events during /v1 hop'


def test_phase7_proxy_messages_http_e2e(isolatedData, monkeypatch):
    from app.adapters import anthropic as anthropic_adapter

    _enable_proxy(isolatedData, monkeypatch)
    captured: dict[str, object] = {}

    async def fake_handle(body, request):
        captured['body'] = body
        return {'id': 'msg-e2e', 'content': []}, None

    monkeypatch.setattr(anthropic_adapter, 'handleMessages', fake_handle)
    monkeypatch.setattr(proxy_mod, 'anthropicAdapter', anthropic_adapter)

    app = FastAPI()
    app.include_router(proxy_mod.router)
    client = TestClient(app)
    r = client.post(
        '/v1/messages',
        headers={'Authorization': 'Bearer e2e-key', 'Content-Type': 'application/json'},
        json={
            'model': 'claude-e2e',
            'max_tokens': 8,
            'messages': [{'role': 'user', 'content': 'ping'}],
        },
    )
    assert r.status_code == 200
    assert isinstance(captured.get('body'), dict)


# ── 2. Memory ─────────────────────────────────────────────────────────


def test_phase7_memory_auto_save_emits_feature_flow(isolatedData):
    from app.services.memory.auto_memory import saveAutoMemory

    feature_flow_bus._events.clear()
    saveAutoMemory('e2e_mem_key', 'User prefers short answers', category='e2e', importance=0.9)
    recent = feature_flow_bus.recent(20, feature='memory')
    assert any(e.get('stage') == 'write' and 'e2e_mem_key' in str(e.get('summary')) for e in recent)


# ── 3. Tools + live backend (feature_flow during tool stage) ──────────


@pytest.mark.asyncio
async def test_phase7_tools_emit_live_backend_feature_flow():
    """CI proof: tool execution stages emit feature_flow (live backend action)."""
    from app.services.workbench.chat_stages import run_regular_tools_stage

    feature_flow_bus._events.clear()

    async def run_one(name, inp, tid):
        return {'tool_call_id': tid, 'role': 'tool', 'content': f'ok:{name}'}

    results = await run_regular_tools_stage(
        [('read_file', {'path': 'x'}, 'tu-1')],
        run_one,
    )
    assert results and results[0]['content'] == 'ok:read_file'
    tools = [e for e in feature_flow_bus.recent(20) if e.get('feature') == 'tools']
    stages = {e.get('stage') for e in tools}
    assert 'exec' in stages
    assert 'result' in stages


# ── 4. Gateway platforms (slack / discord without live network) ───────


@pytest.mark.asyncio
async def test_phase7_slack_normalize_and_connect_gate(monkeypatch):
    from app.services.gateway.platforms.slack import SlackAdapter

    monkeypatch.delenv('AUGUST_SLACK_BOT_TOKEN', raising=False)
    monkeypatch.delenv('AUGUST_SLACK_APP_TOKEN', raising=False)
    a = SlackAdapter()
    assert await a.connect() is False

    monkeypatch.setenv('AUGUST_SLACK_BOT_TOKEN', 'xoxb-fake')
    monkeypatch.setenv('AUGUST_SLACK_APP_TOKEN', 'xapp-fake')
    a2 = SlackAdapter()
    event = await a2.normalize(
        {
            'event': {
                'type': 'message',
                'text': 'hello from slack',
                'channel': 'C1',
                'user': 'U1',
                'ts': '1.2',
                'channel_type': 'im',
            },
            'team_id': 'T1',
        }
    )
    assert event is not None
    assert event.text == 'hello from slack'
    assert event.source.platform == 'slack'
    assert event.source.chat_id == 'C1'
    assert event.source.user_id == 'U1'


@pytest.mark.asyncio
async def test_phase7_discord_normalize_and_connect_gate(monkeypatch):
    """Discord path without live network.

    ``discord.py`` is an optional runtime dep; when missing we still prove the
    adapter module is load-gated (ImportError) so CI without the extra stays green.
    """
    discord = pytest.importorskip('discord', reason='discord.py optional; skip normalize if not installed')

    from datetime import datetime, timezone
    from unittest.mock import MagicMock

    from app.services.gateway.platforms.discord import DiscordAdapter

    monkeypatch.delenv('AUGUST_DISCORD_BOT_TOKEN', raising=False)
    a = DiscordAdapter()
    assert await a.connect() is False

    monkeypatch.setenv('AUGUST_DISCORD_BOT_TOKEN', 'fake-token')
    a2 = DiscordAdapter()

    msg = MagicMock()
    msg.content = 'hello from discord'
    msg.author.id = 99
    msg.id = 1001
    msg.created_at = datetime.now(timezone.utc)
    # Use a real DMChannel-ish mock so isinstance checks stay stable.
    channel = MagicMock(spec=discord.DMChannel)
    channel.id = 55
    msg.channel = channel

    event = await a2.normalize({'message': msg})
    assert event is not None
    assert event.text == 'hello from discord'
    assert event.source.platform == 'discord'
    assert event.source.chat_id == '55'
    assert event.source.user_id == '99'


def test_phase7_discord_adapter_module_import_gate():
    """Without discord.py, importing the platform module must fail cleanly."""
    try:
        import discord  # noqa: F401

        pytest.skip('discord.py installed — import-gate N/A')
    except ImportError:
        with pytest.raises(ModuleNotFoundError):
            from app.services.gateway.platforms import discord as _discord_mod  # noqa: F401


# ── 5. Security: SSRF / private URL block + browser allowlist + CORS ──


@pytest.mark.asyncio
async def test_phase7_ssrf_private_url_blocked():
    from app.services.tool_registrations.web_tools import _fetchUrlContent

    out = await _fetchUrlContent('http://127.0.0.1:8080/secret')
    assert 'blocked' in out.lower()
    out2 = await _fetchUrlContent('http://192.168.1.1/admin')
    assert 'blocked' in out2.lower()
    out3 = await _fetchUrlContent('http://localhost/x')
    assert 'blocked' in out3.lower()


def test_phase7_browser_allowlist_blocks_unknown_host(isolatedData, monkeypatch):
    from app.config import settings
    from app.services.browser import handlers as browser_handlers

    # Force a non-empty allowlist
    monkeypatch.setitem(settings.config, 'browserAllowlist', ['example.com'])
    err = browser_handlers._checkUrlAllowlist('https://evil.example.net/page')
    assert err is not None
    assert 'not in the browser allowlist' in err
    ok = browser_handlers._checkUrlAllowlist('https://www.example.com/ok')
    assert ok is None


def test_phase7_cors_middleware_registered():
    from app.main import app

    names = [type(m).__name__ for m in app.user_middleware]
    # Starlette wraps middleware; look at options or class names
    cors_ok = any('CORS' in n for n in names) or any(
        getattr(m, 'cls', None) and 'CORS' in getattr(m.cls, '__name__', '')
        for m in app.user_middleware
    )
    # Fallback: middleware stack string
    if not cors_ok:
        stack = str(app.user_middleware)
        cors_ok = 'CORSMiddleware' in stack
    assert cors_ok, f'CORSMiddleware not found in {app.user_middleware!r}'


def test_phase7_log_stream_redacts_secrets():
    from app.services.log_stream import buildEvent

    ev = buildEvent(
        category='security',
        level='info',
        message='auth',
        metadata={'api_key': 'sk-secret', 'ok': True},
    )
    assert ev['metadata']['api_key'] == '[REDACTED]'
    assert ev['metadata']['ok'] is True


# ── 6. Skills feature_flow ────────────────────────────────────────────


def test_phase7_skills_feature_flow_emit():
    feature_flow_bus._events.clear()
    emit_feature_flow(
        feature='skills',
        stage='apply',
        summary='Evolving skill created for you: e2e-skill',
        status='ok',
        meta={'name': 'e2e-skill', 'action': 'create'},
    )
    recent = feature_flow_bus.recent(5, feature='skills')
    assert recent and recent[0]['summary'].startswith('Evolving skill')


# ── 7. Monitor API (inventory + events) used by Feature Flow UI ───────


def test_phase7_monitor_api_for_feature_flow_ui():
    app = FastAPI()
    app.include_router(monitor_feature_flow.router)
    client = TestClient(app)
    feature_flow_bus._events.clear()
    emit_feature_flow(feature='workbench', stage='prompt', summary='e2e prompt', status='ok')
    inv = client.get('/api/monitor/features')
    assert inv.status_code == 200
    assert inv.json()['count'] >= 8
    ev = client.get('/api/monitor/events?limit=10')
    assert ev.status_code == 200
    assert any(e.get('summary') == 'e2e prompt' for e in ev.json())


def test_phase7_inject_aug_config_endpoint(isolatedData):
    app = FastAPI()
    app.include_router(config_router.router)
    client = TestClient(app)
    assert client.get('/api/config/inject-aug-on-proxy').json()['enabled'] in (False, True)
    r = client.put('/api/config/inject-aug-on-proxy', json={'enabled': True})
    assert r.status_code == 200 and r.json()['enabled'] is True
    r2 = client.put('/api/config/inject-aug-on-proxy', json={'enabled': False})
    assert r2.json()['enabled'] is False
