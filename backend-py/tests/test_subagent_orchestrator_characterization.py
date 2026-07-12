"""
Safety-net CHARACTERIZATION tests for ``app.services.subagent_orchestrator``.

This file is ADDITIVE: ``tests/test_subagent_orchestrator.py`` already exists
and covers spawn/list/terminate/events/close. This module pins a couple of
additional current-behavior facts, including one pre-existing source bug.

Observed CURRENT behavior captured here:

  * ``SubagentHandle`` and the module constants are usable directly (no event
    loop / provider imports required).
  * ``SubagentOrchestrator.on(event, handler)`` currently RAISES ``TypeError``.
    The source constructs ``Subscription(lambda: ...)`` but
    ``Subscription.__init__`` requires ``(topic, handler)`` positional args, so
    event subscription is currently broken. This test pins that behavior; when
    the refactor fixes ``on()`` this assertion must change.

Run with:  python -m pytest tests/test_subagent_orchestrator_characterization.py -q
"""
from __future__ import annotations
import pytest

from app.services.agent_message_bus import AgentMessageBus
from app.services.subagent_orchestrator import (
    SubagentHandle,
    SubagentOrchestrator,
    SubagentSpawnRequest,
    MAX_CONCURRENT_WORKERS,
    PEER_HELP_WINDOW_SECONDS,
)


def test_module_constants_are_exposed():
    assert MAX_CONCURRENT_WORKERS == 5
    assert PEER_HELP_WINDOW_SECONDS == 5.0


def test_subagent_handle_to_dict_and_elapsed():
    # SubagentHandle is a plain constructible value object — safe to exercise
    # without any running orchestrator or event loop.
    h = SubagentHandle('t1', 'agent', 'do the thing', sessionId='s1')
    d = h.toDict()
    assert d['taskId'] == 't1'
    assert d['agentId'] == 'agent'
    assert d['goal'] == 'do the thing'
    assert d['sessionId'] == 's1'
    assert d['status'] == 'pending'
    assert isinstance(h.elapsed, float)


def test_on_raises_typeerror_currently():
    # CURRENT behavior: on() builds Subscription with only an unsubscribe
    # callable, but Subscription requires (topic, handler), so it raises.
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus)
    with pytest.raises(TypeError):
        orch.on('failure', lambda data: None)


async def test_spawn_returns_one_handle_per_work_item():
    # spawn() returns one handle per work item immediately (the actual
    # sub-agent run happens in a background task that is internally
    # error-handled). No model/provider stack is required for this check.
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, maxWorkers=5)
    request = SubagentSpawnRequest(
        session=None,
        workItems=[{'goal': 'a', 'agentId': 'general'}, {'goal': 'b', 'agentId': 'coder'}],
        mode='auto',
    )
    handles = await orch.spawn(request)
    assert len(handles) == 2
    assert handles[0].agentId == 'general'
    assert handles[1].agentId == 'coder'
    # Clean up the spawned background tasks.
    await orch.close()
