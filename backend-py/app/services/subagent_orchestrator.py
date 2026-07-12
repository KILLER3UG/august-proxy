"""
Sub-agent orchestrator — manages parallel sub-agent execution with a capped
worker pool and failure recovery via peer-help.

Design
------
- Singleton (one per app process), attached to ``app.state`` via lifespan.
- Worker pool capped at 5 via ``asyncio.Semaphore``.
- Each sub-agent task publishes lifecycle events to the shared
  ``AgentMessageBus`` under topics ``task:{taskId}:{progress|result|failure}``.
- On failure: broadcasts to ``task:{taskId}:failure`` and opens a 5-second
  ``peer-help`` claim window.  If no peer claims the failed task within
  5 seconds, the failure is escalated.

API
---
    orchestrator = SubagentOrchestrator(bus)
    handle = await orchestrator.spawn(request)
    await orchestrator.terminate(taskId)
    active = orchestrator.listActive(sessionId)
    sub = orchestrator.on("failure", handler)
"""

from __future__ import annotations
import asyncio
import logging
import time
import uuid
from typing import Any
from app.services.agent_message_bus import AgentMessageBus, Subscription, Handler

logger = logging.getLogger(__name__)
MAX_CONCURRENT_WORKERS = 5
PEER_HELP_WINDOW_SECONDS = 5.0


class SubagentSpawnRequest:
    """Parameters for spawning one or more sub-agents."""

    def __init__(self, session: object, workItems: list[dict[str, Any]], mode: str = 'auto') -> None:
        self.session = session
        self.workItems = workItems
        self.mode = mode


class SubagentHandle:
    """Handle returned by ``spawn()`` for tracking a sub-agent task."""

    def __init__(self, taskId: str, agentId: str, goal: str, sessionId: str = '') -> None:
        self.taskId = taskId
        self.agentId = agentId
        self.goal = goal
        self.sessionId = sessionId
        self.status: str = 'pending'
        self.result: dict[str, object] | str = ''
        self.error: str = ''
        self.startedAt: float = time.time()
        self.finishedAt: float | None = None
        self._future: asyncio.Future | None = None

    @property
    def elapsed(self) -> float:
        if self.finishedAt:
            return round(self.finishedAt - self.startedAt, 2)
        return round(time.time() - self.startedAt, 2)

    def toDict(self) -> dict[str, Any]:
        return {
            'taskId': self.taskId,
            'agentId': self.agentId,
            'goal': self.goal,
            'sessionId': self.sessionId,
            'status': self.status,
            'result': self.result,
            'error': self.error,
            'startedAt': self.startedAt,
            'finishedAt': self.finishedAt,
            'elapsed': self.elapsed,
        }


class SubagentOrchestrator:
    """Manages concurrent sub-agent execution with failure recovery."""

    def __init__(self, bus: AgentMessageBus, max_workers: int = MAX_CONCURRENT_WORKERS) -> None:
        self._bus = bus
        self._semaphore = asyncio.Semaphore(max_workers)
        self._handles: dict[str, SubagentHandle] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._eventHandlers: dict[str, list[Handler]] = {}
        self._closed = False

    async def spawn(self, request: SubagentSpawnRequest) -> list[SubagentHandle]:
        """Spawn one or more sub-agents concurrently.

        Returns a list of handles (one per work item).
        """
        if self._closed:
            raise RuntimeError('Orchestrator is closed')
        handles: list[SubagentHandle] = []
        tasks: list[asyncio.Task] = []
        for item in request.workItems:
            goal = item.get('goal', '')
            agentId = item.get('agentId', 'general')
            context = item.get('context', '')
            restrictedTools = item.get('restrictedTools')
            taskId = f'task_{uuid.uuid4().hex[:12]}'
            sid = ''
            if hasattr(request.session, 'id'):
                sid = str(request.session.id)
            elif isinstance(request.session, dict):
                sid = str(request.session.get('id', ''))
            handle = SubagentHandle(taskId, agentId, goal, sessionId=sid)
            self._handles[taskId] = handle
            handles.append(handle)
            task = asyncio.create_task(
                self._runWithSlot(
                    handle=handle,
                    request=request,
                    agentId=agentId,
                    goal=goal,
                    context=context,
                    restrictedTools=restrictedTools,
                )
            )
            self._tasks[taskId] = task
            handle._future = task
            tasks.append(task)
        return handles

    async def terminate(self, taskId: str) -> bool:
        """Terminate a running sub-agent by taskId. Returns True if found."""
        task = self._tasks.get(taskId)
        handle = self._handles.get(taskId)
        if not task or not handle:
            return False
        task.cancel()
        handle.status = 'cancelled'
        handle.finishedAt = time.time()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return True

    def listActive(self, sessionId: str | None = None) -> list[dict[str, Any]]:
        """List active (running/pending) sub-agents, optionally filtered by session."""
        result = []
        for h in self._handles.values():
            if sessionId and h.sessionId != sessionId:
                continue
            result.append(h.toDict())
        return result

    async def waitForAll(self, handles: list[SubagentHandle]) -> list[dict[str, Any]]:
        """Wait for all given handles to complete and return their dicts."""
        futures = []
        for h in handles:
            if h._future is not None:
                futures.append(h._future)
        if futures:
            await asyncio.gather(*futures, return_exceptions=True)
        return [h.toDict() for h in handles]

    def getHandle(self, taskId: str) -> SubagentHandle | None:
        """Get a handle by taskId."""
        return self._handles.get(taskId)

    def on(self, event: str, handler: Handler) -> Subscription:
        """Subscribe to orchestrator events.

        Event types:
            - ``"subagentStarted"`` — when a sub-agent begins
            - ``"subagentCompleted"`` — when a sub-agent finishes successfully
            - ``"subagentFailed"`` — when a sub-agent fails
        """
        if event not in self._eventHandlers:
            self._eventHandlers[event] = []
        self._eventHandlers[event].append(handler)
        return Subscription(self._bus, event, handler)

    async def _fireEvent(self, event: str, data: dict[str, Any]) -> None:
        """Fire an event to all registered handlers."""
        for handler in self._eventHandlers.get(event, []):
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(data)
                else:
                    handler(data)
            except Exception:
                logger.exception('Subagent event handler failed for %s', event)

    async def _runWithSlot(
        self,
        handle: SubagentHandle,
        request: SubagentSpawnRequest,
        agentId: str,
        goal: str,
        context: str,
        restrictedTools: list[str] | None,
    ) -> None:
        """Acquire semaphore, run the sub-agent task, release."""
        async with self._semaphore:
            handle.status = 'running'
            await self._fireEvent('subagentStarted', {'taskId': handle.taskId, 'agentId': agentId, 'goal': goal})
            try:
                from app.services.subagent_worker import runSubagent

                result = await runSubagent(
                    bus=self._bus,
                    session=request.session,
                    agentId=agentId,
                    goal=goal,
                    context=context,
                    restrictedTools=restrictedTools,
                    taskId=handle.taskId,
                )
                handle.result = result
                handle.status = 'completed'
                handle.finishedAt = time.time()
                if result:
                    await self._fireEvent('subagentCompleted', handle.toDict())
                else:
                    handle.status = 'failed'
                    await self._fireEvent('subagentFailed', handle.toDict())
            except asyncio.CancelledError:
                handle.status = 'cancelled'
                handle.finishedAt = time.time()
                raise
            except Exception as exc:
                handle.status = 'failed'
                handle.error = str(exc)
                handle.finishedAt = time.time()
                logger.exception('[Orchestrator] unexpected error for task %s', handle.taskId)
                await self._handleFailure(handle, request)
                await self._fireEvent('subagentFailed', handle.toDict())

    async def _handleFailure(self, handle: SubagentHandle, request: SubagentSpawnRequest) -> None:
        """Broadcast a failure and open a peer-help window."""
        taskId = handle.taskId
        await self._bus.publish(
            f'task:{taskId}:failure',
            {'taskId': taskId, 'agentId': handle.agentId, 'goal': handle.goal, 'error': handle.error},
        )
        claimed = asyncio.Event()

        def onPeerClaim(msg: dict[str, Any]) -> None:
            claimed.set()

        unsub = self._bus.subscribe(f'task:{taskId}:peerHelp', onPeerClaim)
        try:
            await asyncio.wait_for(claimed.wait(), timeout=PEER_HELP_WINDOW_SECONDS)
        except asyncio.TimeoutError:
            logger.info('No peer claimed failed task %s', taskId)
        finally:
            unsub.unsubscribe()

    async def close(self) -> None:
        """Cancel all running tasks and release resources."""
        self._closed = True
        for task in self._tasks.values():
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._handles.clear()
        self._tasks.clear()
        self._eventHandlers.clear()
