"""
Safety-net CHARACTERIZATION tests for ``app.services.subagent_orchestrator``.

This file is ADDITIVE: ``tests/test_subagent_orchestrator.py`` already exists
and covers spawn/list/terminate/events/close. This module pins a couple of
additional current-behavior facts, including one pre-existing source bug.

Observed CURRENT behavior captured here:

  * ``SubagentHandle`` and the module constants are usable directly (no event
    loop / provider imports required).
  * ``SubagentOrchestrator.on(event, handler)`` constructs a ``Subscription``
    with ``(bus, topic, handler)`` and registers the handler without raising.
    (Previously the source constructed ``Subscription(lambda: ...)`` which
    raised ``TypeError`` because ``Subscription.__init__`` requires
    ``(bus, topic, handler)``.)

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


def test_on_subscribes_with_topic_and_handler():
    # FIXED behavior: on() builds a Subscription with (bus, topic, handler),
    # registering the handler without raising.
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus)

    def handler(data):
        pass

    sub = orch.on('failure', handler)
    # The returned handle is a Subscription tied to the topic and handler.
    assert sub is not None
    assert sub._topic == 'failure'
    assert sub._handler is handler
    # The handler is now registered and will be invoked when the event fires.
    assert handler in orch._eventHandlers['failure']


async def test_spawn_returns_one_handle_per_work_item():
    # spawn() returns one handle per work item immediately (the actual
    # sub-agent run happens in a background task that is internally
    # error-handled). No model/provider stack is required for this check.
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus, max_workers=5)
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
