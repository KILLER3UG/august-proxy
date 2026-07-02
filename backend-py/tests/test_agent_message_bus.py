"""Tests for the in-process async agent message bus."""
import asyncio
import pytest
from app.services.agent_message_bus import AgentMessageBus


@pytest.mark.asyncio
async def test_publish_subscribe():
    bus = AgentMessageBus()
    received: list[dict] = []

    async def handler(msg):
        received.append(msg)

    sub = bus.subscribe("task:t1:progress", handler)
    await bus.publish("task:t1:progress", {"step": 1, "pct": 50})

    # Small delay to let the handler run
    await asyncio.sleep(0.01)
    assert len(received) == 1
    assert received[0] == {"step": 1, "pct": 50}
    sub.unsubscribe()


@pytest.mark.asyncio
async def test_multi_subscriber():
    bus = AgentMessageBus()
    r1: list[dict] = []
    r2: list[dict] = []

    async def h1(msg):
        r1.append(msg)

    async def h2(msg):
        r2.append(msg)

    s1 = bus.subscribe("task:t1:result", h1)
    s2 = bus.subscribe("task:t1:result", h2)
    await bus.publish("task:t1:result", {"status": "done"})

    await asyncio.sleep(0.01)
    assert len(r1) == 1
    assert len(r2) == 1
    s1.unsubscribe()
    s2.unsubscribe()


@pytest.mark.asyncio
async def test_topic_isolation():
    bus = AgentMessageBus()
    r1: list[dict] = []
    r2: list[dict] = []

    async def h1(msg):
        r1.append(msg)

    async def h2(msg):
        r2.append(msg)

    s1 = bus.subscribe("task:t1:progress", h1)
    s2 = bus.subscribe("task:t2:progress", h2)
    await bus.publish("task:t1:progress", {"step": 1})

    await asyncio.sleep(0.01)
    assert len(r1) == 1
    assert len(r2) == 0  # t2 subscriber should not receive t1 messages
    s1.unsubscribe()
    s2.unsubscribe()


@pytest.mark.asyncio
async def test_unsubscribe_stops_delivery():
    bus = AgentMessageBus()
    received: list[dict] = []

    async def handler(msg):
        received.append(msg)

    sub = bus.subscribe("task:t1:progress", handler)
    await bus.publish("task:t1:progress", {"seq": 1})
    sub.unsubscribe()
    await bus.publish("task:t1:progress", {"seq": 2})

    await asyncio.sleep(0.01)
    assert len(received) == 1  # only the first message


@pytest.mark.asyncio
async def test_queue_bounded():
    bus = AgentMessageBus()
    topic = "task:t1:progress"
    # Publish more than MAX_QUEUE_PER_TOPIC messages
    for i in range(300):
        await bus.publish(topic, {"seq": i})

    msgs = bus.get_topic_messages(topic)
    assert len(msgs) <= 256  # bounded


@pytest.mark.asyncio
async def test_wait_for_message():
    bus = AgentMessageBus()

    async def delayed_publish():
        await asyncio.sleep(0.05)
        await bus.publish("task:t1:result", {"status": "done"})

    asyncio.create_task(delayed_publish())
    msg = await bus.wait_for_message("task:t1:result", timeout=1.0)
    assert msg is not None
    assert msg["status"] == "done"


@pytest.mark.asyncio
async def test_wait_for_message_timeout():
    bus = AgentMessageBus()
    msg = await bus.wait_for_message("task:unknown:result", timeout=0.1)
    assert msg is None


@pytest.mark.asyncio
async def test_close_drops_handlers():
    bus = AgentMessageBus()
    received: list[dict] = []

    async def handler(msg):
        received.append(msg)

    bus.subscribe("task:t1:progress", handler)
    bus.close()
    await bus.publish("task:t1:progress", {"step": 1})

    await asyncio.sleep(0.01)
    assert len(received) == 0  # closed bus drops messages


@pytest.mark.asyncio
async def test_sync_handler():
    """Handlers that are not async should also work."""
    bus = AgentMessageBus()
    received: list[dict] = []

    def sync_handler(msg):
        received.append(msg)

    sub = bus.subscribe("task:t1:progress", sync_handler)
    await bus.publish("task:t1:progress", {"step": 1})

    await asyncio.sleep(0.01)
    assert len(received) == 1
    sub.unsubscribe()
