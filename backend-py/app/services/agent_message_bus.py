"""
In-process async pub/sub message bus for inter-agent communication.

Used by the subagent orchestrator to coordinate parallel sub-agents.

Topics follow the pattern ``task:{taskId}:{event_type}`` where event_type
is one of ``progress``, ``result``, ``failure``, or ``peer-help``.

The bus is bounded: if a topic's pending queue exceeds 256 messages the
oldest are dropped.  All operations are async-safe via ``asyncio.Condition``.

Usage
-----
    bus = AgentMessageBus()

    async def on_progress(msg):
        print(f"Progress: {msg}")

    sub = bus.subscribe("task:t1:progress", on_progress)
    await bus.publish("task:t1:progress", {"step": 1, "done": 50})
    sub.unsubscribe()
"""

from __future__ import annotations
import asyncio
import logging
from collections import defaultdict
from typing import Any, Callable, Coroutine, Optional

logger = logging.getLogger(__name__)
MAX_QUEUE_PER_TOPIC = 256
Handler = Callable[[dict[str, Any]], Coroutine[Any, Any, None] | None]


class Subscription:
    """Handle returned by ``subscribe()`` — call ``unsubscribe()`` to cancel."""

    def __init__(self, bus: AgentMessageBus, topic: str, handler: Handler) -> None:
        self._bus = bus
        self._topic = topic
        self._handler = handler

    def unsubscribe(self) -> None:
        self._bus._unsubscribe(self._topic, self._handler)


class AgentMessageBus:
    """In-process async pub/sub message bus."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[Handler]] = defaultdict(list)
        self._queues: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._condition = asyncio.Condition()
        self._closed = False

    def subscribe(self, topic: str, handler: Handler) -> Subscription:
        """Register *handler* to be called for every message published on *topic*.

        Returns a ``Subscription`` that can be used to unsubscribe.
        """
        self._handlers[topic].append(handler)
        logger.debug('[AgentMessageBus] subscribed to %s (total=%d)', topic, len(self._handlers[topic]))
        return Subscription(self, topic, handler)

    async def publish(self, topic: str, msg: dict[str, Any]) -> None:
        """Publish a message to all subscribers of *topic*.

        The message is also queued for late subscribers (up to
        ``MAX_QUEUE_PER_TOPIC`` per topic).  Stale messages beyond
        the limit are dropped (oldest first).
        """
        if self._closed:
            return
        q = self._queues[topic]
        q.append(msg)
        while len(q) > MAX_QUEUE_PER_TOPIC:
            q.pop(0)
        handlers = list(self._handlers.get(topic, []))
        if handlers:
            for handler in handlers:
                try:
                    result = handler(msg)
                    if result is not None:
                        await result
                except Exception:
                    logger.exception('[AgentMessageBus] handler error on %s', topic)
        async with self._condition:
            self._condition.notify_all()

    def get_topic_messages(self, topic: str) -> list[dict[str, Any]]:
        """Return all queued messages for *topic* (for late-joining consumers)."""
        return list(self._queues.get(topic, []))

    async def wait_for_message(self, topic: str, timeout: float | None = None) -> dict[str, Any] | None:
        """Block until a new message arrives on *topic*, then return it.

        If *timeout* is set and no message arrives, returns ``None``.
        """
        loopStart = asyncio.get_running_loop().time()
        async with self._condition:
            while True:
                q = self._queues.get(topic, [])
                if q:
                    return q[-1]
                if self._closed:
                    return None
                if timeout is not None:
                    elapsed = asyncio.get_running_loop().time() - loopStart
                    if elapsed >= timeout:
                        return None
                    remaining = timeout - elapsed
                else:
                    remaining = None
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    return None

    def close(self) -> None:
        """Shut down the bus, dropping all handlers and queued messages."""
        self._closed = True
        self._handlers.clear()
        self._queues.clear()

    def _unsubscribe(self, topic: str, handler: Handler) -> None:
        handlers = self._handlers.get(topic, [])
        if handler in handlers:
            handlers.remove(handler)
            logger.debug('[AgentMessageBus] unsubscribed from %s (remaining=%d)', topic, len(handlers))
