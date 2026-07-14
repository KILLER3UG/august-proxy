"""Gateway SessionBridge must accumulate workbench camelCase finalOutput."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_gateway_accumulates_finalOutput_camel():
    from app.services.gateway.session_bridge import SessionBridge

    async def fake_runner(**kwargs):
        emit = kwargs['emit']
        emit({'type': 'started', 'sessionId': 'x'})
        emit({'type': 'finalOutput', 'content': 'Hello'})
        emit({'type': 'finalOutput', 'content': ' world'})
        emit({'type': 'done', 'sessionId': 'x'})

    bridge = SessionBridge.__new__(SessionBridge)
    bridge._map = {}
    bridge._mapPath = None
    bridge._sessionFactory = lambda **kw: type('S', (), {'id': 'wb_1'})()
    bridge._runner = fake_runner
    bridge._provider = ''
    bridge._agentId = ''
    bridge._model = ''
    bridge._modelProvider = ''
    bridge._guardMode = 'agent'
    bridge._cancels = {}

    result = await bridge.invokeAgent('plat:chat1', 'hi')
    assert result.text == 'Hello world'


@pytest.mark.asyncio
async def test_gateway_accepts_legacy_snake_final_output():
    from app.services.gateway.session_bridge import SessionBridge

    async def fake_runner(**kwargs):
        emit = kwargs['emit']
        emit({'type': 'final_output', 'content': 'legacy'})

    bridge = SessionBridge.__new__(SessionBridge)
    bridge._map = {}
    bridge._mapPath = None
    bridge._sessionFactory = lambda **kw: type('S', (), {'id': 'wb_1'})()
    bridge._runner = fake_runner
    bridge._provider = ''
    bridge._agentId = ''
    bridge._model = ''
    bridge._modelProvider = ''
    bridge._guardMode = 'agent'
    bridge._cancels = {}

    result = await bridge.invokeAgent('plat:chat2', 'hi')
    assert result.text == 'legacy'


def test_workbench_emit_types_are_camelCase():
    workbench_emit_types = {
        'started',
        'finalOutput',
        'thinking',
        'toolCall',
        'toolResult',
        'done',
        'error',
    }
    assert 'final_output' not in workbench_emit_types
    assert 'finalOutput' in workbench_emit_types
