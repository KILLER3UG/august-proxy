"""Orchestrator ``on()`` subscriptions must unsubscribe from the local
handler list (the bus-backed Subscription was a silent no-op)."""

from __future__ import annotations

import pytest
from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import SubagentOrchestrator


@pytest.mark.asyncio
async def test_on_unsubscribe_removes_local_handler():
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=5)
    events: list[str] = []

    async def handler(data):
        events.append('fired')

    sub = orch.on('subagentCompleted', handler)
    assert orch._eventHandlers.get('subagentCompleted') == [handler]
    sub.unsubscribe()
    assert orch._eventHandlers.get('subagentCompleted') == []
    await orch._fireEvent('subagentCompleted', {'taskId': 't'})
    assert events == []


@pytest.mark.asyncio
async def test_multiple_unsubscribes_are_safe():
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=5)

    async def handler(data):
        pass

    sub = orch.on('subagentFailed', handler)
    sub.unsubscribe()
    sub.unsubscribe()  # second call must not raise
    assert orch._eventHandlers.get('subagentFailed') == []
