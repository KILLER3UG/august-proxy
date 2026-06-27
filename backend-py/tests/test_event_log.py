"""EventLog fan-out tests."""
import asyncio

import pytest

from app.services.event_log import EventLog


@pytest.mark.asyncio
async def test_subscribe_replays_past_then_delivers_live():
    """Baseline: subscribe(since_seq=0) replays buffered events and then
    receives live appends in order."""
    log = EventLog()
    log.append("s1", "msg", {"n": 1})
    log.append("s1", "msg", {"n": 2})
    gen = log.subscribe("s1", since_seq=0)
    assert (await gen.__anext__())["payload"] == {"n": 1}
    assert (await gen.__anext__())["payload"] == {"n": 2}
    log.append("s1", "msg", {"n": 3})
    assert (await gen.__anext__())["payload"] == {"n": 3}
    await gen.aclose()


@pytest.mark.asyncio
async def test_subscribe_delivers_events_appended_during_replay():
    """Regression: a subscriber must not miss events appended while it is
    suspended mid-replay. Previously subscribe() materialised a snapshot of
    past events and yielded them, registering its queue only AFTER the
    replay loop. Any event appended during a yield-suspension landed in
    entry.events but was absent from both the already-materialised snapshot
    and the not-yet-registered queue — silently dropped. In the workbench
    this drops a tool result or terminal 'done' on SSE reconnect, leaving
    the UI stuck (e.g. a tool stuck 'running')."""
    log = EventLog()
    log.append("s1", "msg", {"n": 1})          # seq 1, in replay buffer
    gen = log.subscribe("s1", since_seq=0)
    # Drive to the first replayed event; the generator suspends at the
    # yield, before its queue is registered (in the buggy version).
    first = await gen.__anext__()
    assert first["seq"] == 1
    # Producer appends while the subscriber is suspended mid-replay.
    log.append("s1", "msg", {"n": 2})          # seq 2
    # Must deliver seq 2, not hang until the 30s keepalive. A 2s timeout
    # makes the buggy version fail fast instead of waiting for keepalive.
    nxt = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert nxt["seq"] == 2, "event appended during replay must be delivered"
    await gen.aclose()
