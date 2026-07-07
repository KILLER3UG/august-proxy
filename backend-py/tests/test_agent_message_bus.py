"""Tests for the in-process async agent message bus."""
import asyncio
import pytest
from app.services.agent_message_bus import AgentMessageBus

@pytest.mark.asyncio
async def testPublishSubscribe():
    bus = AgentMessageBus()
    received: list[dict] = []

    async def handler(msg):
        received.append(msg)
    sub = bus.subscribe('task:t1:progress', handler)
    await bus.publish('task:t1:progress', {'step': 1, 'pct': 50})
    await asyncio.sleep(0.01)
    assert len(received) == 1
    assert received[0] == {'step': 1, 'pct': 50}
    sub.unsubscribe()

@pytest.mark.asyncio
async def testMultiSubscriber():
    bus = AgentMessageBus()
    r1: list[dict] = []
    r2: list[dict] = []

    async def h1(msg):
        r1.append(msg)

    async def h2(msg):
        r2.append(msg)
    s1 = bus.subscribe('task:t1:result', h1)
    s2 = bus.subscribe('task:t1:result', h2)
    await bus.publish('task:t1:result', {'status': 'done'})
    await asyncio.sleep(0.01)
    assert len(r1) == 1
    assert len(r2) == 1
    s1.unsubscribe()
    s2.unsubscribe()

@pytest.mark.asyncio
async def testTopicIsolation():
    bus = AgentMessageBus()
    r1: list[dict] = []
    r2: list[dict] = []

    async def h1(msg):
        r1.append(msg)

    async def h2(msg):
        r2.append(msg)
    s1 = bus.subscribe('task:t1:progress', h1)
    s2 = bus.subscribe('task:t2:progress', h2)
    await bus.publish('task:t1:progress', {'step': 1})
    await asyncio.sleep(0.01)
    assert len(r1) == 1
    assert len(r2) == 0
    s1.unsubscribe()
    s2.unsubscribe()

@pytest.mark.asyncio
async def testUnsubscribeStopsDelivery():
    bus = AgentMessageBus()
    received: list[dict] = []

    async def handler(msg):
        received.append(msg)
    sub = bus.subscribe('task:t1:progress', handler)
    await bus.publish('task:t1:progress', {'seq': 1})
    sub.unsubscribe()
    await bus.publish('task:t1:progress', {'seq': 2})
    await asyncio.sleep(0.01)
    assert len(received) == 1

@pytest.mark.asyncio
async def testQueueBounded():
    bus = AgentMessageBus()
    topic = 'task:t1:progress'
    for i in range(300):
        await bus.publish(topic, {'seq': i})
    msgs = bus.get_topic_messages(topic)
    assert len(msgs) <= 256

@pytest.mark.asyncio
async def testWaitForMessage():
    bus = AgentMessageBus()

    async def delayedPublish():
        await asyncio.sleep(0.05)
        await bus.publish('task:t1:result', {'status': 'done'})
    asyncio.create_task(delayedPublish())
    msg = await bus.wait_for_message('task:t1:result', timeout=1.0)
    assert msg is not None
    assert msg['status'] == 'done'

@pytest.mark.asyncio
async def testWaitForMessageTimeout():
    bus = AgentMessageBus()
    msg = await bus.wait_for_message('task:unknown:result', timeout=0.1)
    assert msg is None

@pytest.mark.asyncio
async def testCloseDropsHandlers():
    bus = AgentMessageBus()
    received: list[dict] = []

    async def handler(msg):
        received.append(msg)
    bus.subscribe('task:t1:progress', handler)
    bus.close()
    await bus.publish('task:t1:progress', {'step': 1})
    await asyncio.sleep(0.01)
    assert len(received) == 0

@pytest.mark.asyncio
async def testSyncHandler():
    """Handlers that are not async should also work."""
    bus = AgentMessageBus()
    received: list[dict] = []

    def syncHandler(msg):
        received.append(msg)
    sub = bus.subscribe('task:t1:progress', syncHandler)
    await bus.publish('task:t1:progress', {'step': 1})
    await asyncio.sleep(0.01)
    assert len(received) == 1
    sub.unsubscribe()