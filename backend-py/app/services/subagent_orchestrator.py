"""
Sub-agent orchestrator — manages parallel sub-agent execution with a capped
worker pool.

Design
------
- Singleton (one per app process), attached to ``app.state`` via lifespan.
- Worker pool capped at 5 via ``asyncio.Semaphore``.
- Each sub-agent task publishes lifecycle events to the shared
  ``AgentMessageBus`` under topics ``task:{taskId}:{progress|result|failure}``.

Peer-help (measured — do not design as recovery)
------------------------------------------------
On **unhandled Exception** in the worker slot only, ``_handleFailure`` publishes
``task:{id}:failure`` and waits up to ``PEER_HELP_WINDOW_SECONDS`` for a
``task:{id}:peerHelp`` signal.  A claim ends the wait early but does **not**
re-run the task or change the result.  No claim only logs.  There is no
automatic re-spawn or escalation path.

Worker-returned ``status: failed`` dicts are marked failed on the handle (they
must not count as completed).  They do **not** currently open the peer-help
wait (no recovery would run anyway).

See docs/REFACTOR_PROGRESS.md decision table + Phase 6 **B27**.

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
                handle.finishedAt = time.time()
                # runSubagent always returns a dict (truthy). Never use `if result`
                # alone — a failed worker returns {status: 'failed', ...} which is
                # still truthy and used to be mis-marked completed (B27).
                if self._result_is_failure(result):
                    handle.status = 'failed'
                    if isinstance(result, dict):
                        err = str(result.get('error') or '').strip()
                        if not err and not self._result_payload_text(result):
                            err = 'empty result payload with success status'
                        handle.error = err or handle.error
                    await self._fireEvent('subagentFailed', handle.toDict())
                elif (
                    isinstance(result, dict)
                    and str(result.get('status') or '').lower() == 'partial'
                ):
                    # Not equivalent to full completion for tallies (see spawn_subagents).
                    handle.status = 'partial'
                    await self._fireEvent('subagentCompleted', handle.toDict())
                else:
                    handle.status = 'completed'
                    await self._fireEvent('subagentCompleted', handle.toDict())
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

    @staticmethod
    def _result_payload_text(result: dict[str, Any]) -> str:
        """Primary text payload from a worker result dict."""
        return str(result.get('result') or result.get('output') or '').strip()

    @classmethod
    def _result_is_failure(cls, result: object) -> bool:
        """True when the worker reported failure or 'success' with no usable content.

        Same bug family as the truthy-dict status lie: ``{status: completed,
        result: ''}`` must not tally as multi-agent success.
        """
        if result is None or result is False or result == '':
            return True
        if isinstance(result, dict):
            status = str(result.get('status') or '').lower()
            if status in ('failed', 'error', 'cancelled'):
                return True
            # partial = mixed outcomes; allow empty text (aggregated status only)
            if status == 'partial':
                return False
            if status in ('completed', 'success', 'ok', ''):
                # Explicit success requires non-empty, non-whitespace payload
                if not cls._result_payload_text(result):
                    return True
                return False
            if result.get('error') and status not in ('completed', 'success', 'ok'):
                return True
            return False
        return False

    async def _handleFailure(self, handle: SubagentHandle, request: SubagentSpawnRequest) -> None:
        """Publish failure and wait for optional peerHelp signal (does not re-run work).

        A claim ends the wait early but does **not** re-spawn the task or alter
        ``handle.result``. No claim only logs. This is not automatic recovery.
        """
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
            logger.info(
                'Peer claimed failed task %s (signal only — work is NOT re-run)',
                taskId,
            )
        except asyncio.TimeoutError:
            logger.info(
                'No peer claimed failed task %s within %.1fs (no automatic re-spawn)',
                taskId,
                PEER_HELP_WINDOW_SECONDS,
            )
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
