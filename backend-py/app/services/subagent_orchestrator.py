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
from typing import Any, Callable

from app.json_narrowing import as_int, as_str
from app.services.agent_message_bus import AgentMessageBus, Handler, Subscription

logger = logging.getLogger(__name__)
MAX_CONCURRENT_WORKERS = 5
PEER_HELP_WINDOW_SECONDS = 5.0
# A worker that hangs (e.g. a provider call that never returns) must not
# occupy a slot forever — and a queued sub-agent must not wait forever for
# a slot while hung workers hold them all.
SLOT_ACQUIRE_TIMEOUT_SECONDS = 600
_MAX_RETAINED_HANDLES = 12


def _record_run(handle: SubagentHandle) -> None:
    """Persist one run row (fire-and-forget, never raises).

    Inserts on first sight of the task; updates the same row on status
    transitions. Best-effort — a missing table or busy DB must not break
    orchestration.
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        status = handle.status or 'pending'
        summary = ''
        if isinstance(handle.result, dict):
            summary = str(
                handle.result.get('result')
                or handle.result.get('output')
                or handle.result.get('summary')
                or ''
            ).strip()
        elif isinstance(handle.result, str):
            summary = handle.result
        existing = conn.execute(
            'SELECT id FROM subagent_runs WHERE task_id = ?', (handle.taskId,)
        ).fetchone()
        if existing:
            conn.execute(
                'UPDATE subagent_runs SET status = ?, result_summary = ?, error = ?, '
                "finished_at = COALESCE(?, finished_at) WHERE task_id = ?",
                (
                    status,
                    summary[:500],
                    (handle.error or '')[:500],
                    time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(handle.finishedAt)) if handle.finishedAt else None,
                    handle.taskId,
                ),
            )
        else:
            conn.execute(
                'INSERT INTO subagent_runs '
                '(task_id, session_id, agent_id, goal, status, started_at) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (
                    handle.taskId,
                    handle.sessionId,
                    handle.agentId,
                    (handle.goal or '')[:500],
                    status,
                    time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(handle.startedAt)),
                ),
            )
        conn.commit()
    except Exception:
        logger.debug('subagent run record failed (non-fatal)', exc_info=True)


class SubagentSpawnRequest:
    """Parameters for spawning one or more sub-agents."""

    def __init__(
        self,
        session: object,
        workItems: list[dict[str, Any]],
        mode: str = 'auto',
        emit: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.session = session
        self.workItems = workItems
        self.mode = mode
        # Optional parent SSE emitter. Live sub-agent output (text / tool
        # calls / tool results) is forwarded to it so the chat thread shows
        # progress instead of only start + done. Start/done events are NOT
        # forwarded — the spawn tool owns those (keyed by taskId).
        self.emit = emit


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


class _OrchestratorSubscription(Subscription):
    """Subscription whose ``unsubscribe`` removes the handler from the
    orchestrator's own ``_eventHandlers`` list.

    ``on()`` registers handlers locally (never on the AgentMessageBus), so the
    generic bus-backed Subscription was a silent no-op — the handler list grew
    unbounded for every caller that unsubscribed (audit finding). ``_topic`` /
    ``_handler`` mirror the bus Subscription's shape for characterization.
    """

    def __init__(self, orchestrator: SubagentOrchestrator, event: str, handler: Handler) -> None:
        self._orchestrator = orchestrator
        self._topic = event
        self._event = event
        self._handler = handler

    def unsubscribe(self) -> None:
        handlers = self._orchestrator._eventHandlers.get(self._event)
        if handlers and self._handler in handlers:
            handlers.remove(self._handler)


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
            yieldSchema = item.get('yieldSchema')
            effort = as_str(item.get('effort'), 'medium') or 'medium'
            model = as_str(item.get('model'), '')
            # Runtime recursion depth: children of a sub-agent run at
            # parent_depth + 1; root spawns default to 0.
            depth = as_int(getattr(request.session, 'subagent_depth', 0), 0) + 1
            taskId = f'task_{uuid.uuid4().hex[:12]}'
            sid = ''
            if hasattr(request.session, 'id'):
                sid = str(request.session.id)
            elif isinstance(request.session, dict):
                sid = str(request.session.get('id', ''))
            handle = SubagentHandle(taskId, agentId, goal, sessionId=sid)
            self._handles[taskId] = handle
            _record_run(handle)
            handles.append(handle)
            task = asyncio.create_task(
                self._runWithSlot(
                    handle=handle,
                    request=request,
                    agentId=agentId,
                    goal=goal,
                    context=context,
                    restrictedTools=restrictedTools,
                    yieldSchema=yieldSchema,
                    effort=effort,
                    model=model,
                    depth=depth,
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
        _record_run(handle)
        try:
            await task
        except asyncio.CancelledError:
            pass
        return True

    def terminateForSession(self, sessionId: str) -> int:
        """Cancel every in-flight sub-agent task for a session and drop it from
        ``_tasks`` (session-delete path).

        Sync on purpose — the delete path is synchronous; the cancelled tasks
        settle in the event loop. Handles are marked ``cancelled`` so the Runs
        tab reflects the abort. Returns the number of tasks cancelled.
        """
        cancelled = 0
        for taskId in list(self._tasks.keys()):
            handle = self._handles.get(taskId)
            if handle is None or handle.sessionId != sessionId:
                continue
            task = self._tasks.pop(taskId, None)
            if task is None:
                continue
            if not task.done():
                task.cancel()
                cancelled += 1
            handle.status = 'cancelled'
            handle.finishedAt = time.time()
            _record_run(handle)
        return cancelled

    def listActive(self, sessionId: str | None = None) -> list[dict[str, Any]]:
        """List recent sub-agents (active + recently finished), optionally filtered by session.

        Finished handles are pruned (capped at ``_MAX_RETAINED_HANDLES`` per
        session, 8× that for the unfiltered view) so a long-lived backend
        does not accumulate them in memory forever — the Runs tab holds the
        durable history. The roster UI still needs recently-finished rows
        (to show completion chips), so they are only pruned past the cap.
        """
        max_retained = _MAX_RETAINED_HANDLES
        if sessionId:
            finished = [
                tid
                for tid, h in self._handles.items()
                if h.sessionId == sessionId and h.status not in ('pending', 'running')
            ]
            if len(finished) > max_retained:
                for tid in finished[: len(finished) - max_retained]:
                    self._handles.pop(tid, None)
                    self._tasks.pop(tid, None)
        else:
            finished = [tid for tid, h in self._handles.items() if h.status not in ('pending', 'running')]
            cap = max_retained * 8
            if len(finished) > cap:
                for tid in finished[: len(finished) - cap]:
                    self._handles.pop(tid, None)
                    self._tasks.pop(tid, None)
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

    async def waitForEach(self, handles: list[SubagentHandle]):
        """Yield each handle's dict as that subagent settles (incremental).

        Already-finished handles are yielded first (stable order), then
        remaining futures complete via ``asyncio.wait(FIRST_COMPLETED)``.
        Callers can emit per-subagent results to the model/UI without
        blocking on the full batch.
        """
        pending: dict[asyncio.Future, SubagentHandle] = {}
        for h in handles:
            fut = h._future
            if fut is None or fut.done():
                yield h.toDict()
            else:
                pending[fut] = h
        while pending:
            done, _ = await asyncio.wait(set(pending.keys()), return_when=asyncio.FIRST_COMPLETED)
            for fut in done:
                # done ⊆ pending.keys(), so the pop always hits.
                h = pending.pop(fut)
                yield h.toDict()

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
        return _OrchestratorSubscription(self, event, handler)

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
        yieldSchema: dict[str, Any] | None = None,
        effort: str = 'medium',
        model: str = '',
        depth: int = 0,
    ) -> None:
        """Acquire semaphore, run the sub-agent task, release."""
        try:
            await asyncio.wait_for(self._semaphore.acquire(), timeout=SLOT_ACQUIRE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            handle.status = 'failed'
            handle.error = 'Timed out waiting for a worker slot (all sub-agent slots busy).'
            handle.finishedAt = time.time()
            _record_run(handle)
            await self._fireEvent('subagentFailed', handle.toDict())
            return
        try:
            handle.status = 'running'
            _record_run(handle)
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
                    yieldSchema=yieldSchema,
                    effort=effort,
                    model=model,
                    taskId=handle.taskId,
                    emit=request.emit,
                    depth=depth,
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
                    _record_run(handle)
                    await self._fireEvent('subagentFailed', handle.toDict())
                elif (
                    isinstance(result, dict)
                    and str(result.get('status') or '').lower() == 'partial'
                ):
                    # Not equivalent to full completion for tallies (see spawn_subagents).
                    handle.status = 'partial'
                    _record_run(handle)
                    await self._fireEvent('subagentCompleted', handle.toDict())
                else:
                    handle.status = 'completed'
                    _record_run(handle)
                    await self._fireEvent('subagentCompleted', handle.toDict())
            except asyncio.CancelledError:
                handle.status = 'cancelled'
                handle.finishedAt = time.time()
                _record_run(handle)
                raise
            except Exception as exc:
                handle.status = 'failed'
                handle.error = str(exc)
                handle.finishedAt = time.time()
                _record_run(handle)
                logger.exception('[Orchestrator] unexpected error for task %s', handle.taskId)
                await self._handleFailure(handle, request)
                await self._fireEvent('subagentFailed', handle.toDict())
        finally:
            self._semaphore.release()

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
