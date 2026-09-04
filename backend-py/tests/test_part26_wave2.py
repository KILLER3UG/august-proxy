"""Part 26 Wave 2 — the 500-class fixes.

End-to-end through the real turn loop (canonical isolation from
tests/test_workbench_tool_loop.py / test_early_dispatch_telemetry.py):

  * tools-fallback (1.1): an upstream that rejects any body carrying
    ``tools`` with a 500 gets exactly one stripped retry — no ``tools`` key,
    tool-role history flattened — and the turn completes with the model's
    plain-text answer. Knob off → the old identical-body retries and the
    surfaced error. Partial emission → no fallback retry.
  * progressive disclosure on the OpenAI path (1.2): a tiny context window
    activates BM25 assembly, keeps core tools, and returns OpenAI shapes.
  * chat mode ships no tool array upstream (1.4).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest


def _iso_env(monkeypatch, tmp_path):
    from app.services.memory_store import init

    init()
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services.workbench import sessions as sessions_mod
    from app.services.workbench import workbench as wb

    empty_sessions: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty_sessions)
    monkeypatch.setattr(wb, '_sessions', empty_sessions)
    return wb


def _stub_resolution(monkeypatch, wb):
    stub_provider = {
        'name': 'stub-openai',
        'apiMode': 'openai',
        'default_model': 'stub-model',
        'model_profiles': {},
    }
    monkeypatch.setattr(
        'app.services.workbench.providers.resolve_workbench_provider',
        lambda *a, **kw: stub_provider,
    )
    monkeypatch.setattr(
        'app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-model'
    )
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod

    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    return clientsMod


class _ToolsRejectingStream:
    """Upstream that 500s any request carrying `tools`, answers without them.

    Records every body so the test can assert the stripped retry actually
    dropped the tools array AND flattened tool-role history.
    """

    def __init__(self, bodies: list[dict]):
        self.bodies = bodies

    def resolveApiKey(self) -> str:
        return 'stub-key'

    async def chat_completions_stream(self, body):
        self.bodies.append(json.loads(json.dumps(body, default=str)))
        if body.get('tools'):
            yield {'type': 'error', 'status': 500, 'body': b'{"error": {"message": "Internal server error"}}'}
            return
        yield {
            'id': 'ok1',
            'object': 'chat.completion.chunk',
            'choices': [
                {'index': 0, 'delta': {'role': 'assistant', 'content': 'plain text answer'}, 'finish_reason': None}
            ],
        }
        yield {
            'id': 'ok1',
            'object': 'chat.completion.chunk',
            'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
        }
        yield {
            'id': 'ok1',
            'object': 'chat.completion.chunk',
            'choices': [],
            'usage': {'prompt_tokens': 8, 'completion_tokens': 4, 'total_tokens': 12},
        }


def _register_echo_tool():
    from app.services.tool_registry import register as reg

    async def fakeTool(*, text: str = ''):
        return f'echo: {text}'

    reg('echo_probe', 'test echo tool', fakeTool, {'type': 'object', 'properties': {}})


@pytest.mark.asyncio
async def test_tools_fallback_recovers_from_500_with_tools(isolatedData, monkeypatch, tmp_path):
    wb = _iso_env(monkeypatch, tmp_path)
    clientsMod = _stub_resolution(monkeypatch, wb)
    _register_echo_tool()

    bodies: list[dict] = []
    fake = _ToolsRejectingStream(bodies)
    monkeypatch.setattr(clientsMod, 'getClient', lambda provider: fake)
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: fake)

    events: list[dict[str, object]] = []
    await wb.sendWorkbenchMessageStream(
        sessionId='p26-fallback', message='use the echo tool please', model='stub-model', emit=events.append
    )

    assert len(bodies) >= 2, f'expected tools attempt + stripped attempt, got {len(bodies)}'
    first, second = bodies[0], bodies[1]
    assert first.get('tools'), 'first attempt must carry tools'
    assert not second.get('tools'), 'stripped attempt must not carry tools'
    # Tool-role history must be flattened away in the stripped request.
    assert all(m.get('role') != 'tool' for m in second.get('messages', []))
    flat = json.dumps(second.get('messages', []))
    assert 'tool_calls' not in flat, 'assistant tool_calls must be dropped in the stripped request'
    assert 'Proxy Self-Heal' in flat, 'the model must be told tools are unavailable'
    # The turn completes with the tool-less answer.
    finalTexts = [
        str(e.get('text') or e.get('content') or '')
        for e in events
        if e.get('type') == 'finalOutput'
    ]
    assert any('plain text answer' in t for t in finalTexts), events
    # And the user was told what happened.
    assert any('without tools' in str(e.get('message', '')) for e in events if e.get('type') == 'warning')
    # Only ONE stripped retry: remaining attempts keep the stripped shape but
    # never re-introduce tools.
    assert all(not b.get('tools') for b in bodies[1:])


@pytest.mark.asyncio
async def test_tools_fallback_disabled_keeps_old_behavior(isolatedData, monkeypatch, tmp_path):
    wb = _iso_env(monkeypatch, tmp_path)
    clientsMod = _stub_resolution(monkeypatch, wb)
    _register_echo_tool()
    monkeypatch.setattr(
        wb, '_modelRetryPolicy', lambda: {'maxRetries': 1, 'baseDelayMs': 1, 'maxDelayMs': 2, 'toolsFallback': 0}
    )

    bodies: list[dict] = []
    fake = _ToolsRejectingStream(bodies)
    monkeypatch.setattr(clientsMod, 'getClient', lambda provider: fake)
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: fake)

    events: list[dict[str, object]] = []
    await wb.sendWorkbenchMessageStream(
        sessionId='p26-nofb', message='use the echo tool please', model='stub-model', emit=events.append
    )

    assert bodies, 'at least one attempt expected'
    assert all(b.get('tools') for b in bodies), 'knob off → every attempt keeps tools'
    assert any(e.get('type') == 'error' for e in events), 'error surfaces instead of recovering'


@pytest.mark.asyncio
async def test_chat_mode_ships_no_tools(isolatedData, monkeypatch, tmp_path):
    wb = _iso_env(monkeypatch, tmp_path)
    clientsMod = _stub_resolution(monkeypatch, wb)
    _register_echo_tool()

    bodies: list[dict] = []
    fake = _ToolsRejectingStream(bodies)
    monkeypatch.setattr(clientsMod, 'getClient', lambda provider: fake)
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: fake)

    events: list[dict[str, object]] = []
    # Session A: default agent mode — the tool array ships.
    await wb.sendWorkbenchMessageStream(
        sessionId='p26-agentmode', message='hello', model='stub-model', emit=events.append
    )
    assert bodies[0].get('tools'), 'agent mode still offers tools'

    # Session B: chat mode set before any turn — no tool array upstream.
    agentless = wb.createWorkbenchSession(provider='stub-openai', agentId='build')
    agentless.agent_mode = 'chat'
    before = len(bodies)
    await wb.sendWorkbenchMessageStream(
        sessionId=agentless.id, message='hello again', model='stub-model', emit=events.append
    )
    assert len(bodies) > before, 'chat-mode turn must reach the model'
    assert not bodies[-1].get('tools'), 'chat mode must not ship the tool array'


@pytest.mark.asyncio
async def test_openai_progressive_disclosure_activates(isolatedData, monkeypatch, tmp_path):
    _iso_env(monkeypatch, tmp_path)
    from app.services.tool_registrations import register_all

    register_all()
    import app.services.workbench.workbench as wbmod

    s = SimpleNamespace(
        model='stub-model',
        provider='stub-openai',
        guardMode='full',
        id='p26-disclosure',
        messages=[{'role': 'user', 'content': 'run the circuit simulator sweep on the design'}],
        metadata={},
        agent_mode='',
        workspacePath='',
        subagent_depth=0,
        _text_tool_protocol=False,
        _tool_assembly=None,
    )
    orig = wbmod._resolveModelContextWindow
    monkeypatch.setattr(wbmod, '_resolveModelContextWindow', lambda m, p=None: 8000)
    try:
        defs = wbmod.openaiToolDefinitions(s)
    finally:
        wbmod._resolveModelContextWindow = orig
    names = [t.get('function', {}).get('name') or t.get('name') for t in defs]
    assert defs, 'expected a non-empty tool list'
    assert all(t.get('function') for t in defs), 'defs must stay OpenAI-shaped'
    assert 'read_file' in names and 'run_command' in names, 'core tools must survive the budget'
    assert getattr(s, '_tool_assembly', None) is not None, 'assembly metadata stored on the session'
    totalChars = sum(len(json.dumps(t)) for t in defs)
    assert totalChars < 60000, f'budgeted surface should be far below the full registry: {totalChars}'
