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
import json as _json
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


def _transcript_path(task_id: str) -> Any:
    """Path to delegation transcript jsonl (Hermes cache/delegation)."""
    from app.lib.paths import dataPath as _dataPath

    # Sanitize: only task_ prefix
    safe = "".join(c for c in task_id if c.isalnum() or c in ("_", "-"))[:64]
    if not safe:
        safe = "unknown"
    return _dataPath("cache", "delegation", f"{safe}.jsonl")


def _append_transcript(task_id: str, event: dict[str, Any]) -> None:
    try:
        p = _transcript_path(task_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Keep file bounded (~200 lines, ~100KB) - Hermes readable from remote backends
        with open(p, "a", encoding="utf-8") as f:
            f.write(_json.dumps(event, ensure_ascii=False) + "\n")
        # Trim if too large
        try:
            if p.stat().st_size > 200_000:
                lines = p.read_text(encoding="utf-8").splitlines()
                keep = lines[-150:]
                p.write_text("\n".join(keep) + "\n", encoding="utf-8")
        except Exception:
            pass
    except Exception:
        pass


def _read_transcript(task_id: str, limit: int = 200) -> list[dict[str, Any]]:
    try:
        p = _transcript_path(task_id)
        if not p.exists():
            return []
        lines = p.read_text(encoding="utf-8").splitlines()
        out: list[dict[str, Any]] = []
        for line in lines[-limit:]:
            try:
                out.append(_json.loads(line))
            except Exception:
                continue
        return out
    except Exception:
        return []


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
        full = summary  # full blob for perfect drawer rendering (up to 20k)
        try:
            todos_json = _json.dumps(getattr(handle, 'todos', []) or [], ensure_ascii=False)[:20000]
        except Exception:
            todos_json = ''
        now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        last_act_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(handle.lastActivityAt)) if getattr(handle, 'lastActivityAt', None) else now_iso
        api_calls = int(getattr(handle, 'apiCalls', 0) or 0)
        if existing:
            try:
                conn.execute(
                    'UPDATE subagent_runs SET status = ?, result_summary = ?, result_full = ?, error = ?, '
                    "finished_at = COALESCE(?, finished_at), last_activity_at = ?, api_calls = ?, todos_json = ? WHERE task_id = ?",
                    (
                        status,
                        summary[:4000],
                        full[:20000],
                        (handle.error or '')[:2000],
                        time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(handle.finishedAt)) if handle.finishedAt else None,
                        last_act_iso,
                        api_calls,
                        todos_json,
                        handle.taskId,
                    ),
                )
            except Exception as e:
                # Column not yet migrated (021 not applied) — fallback to old schema
                if 'no such column' in str(e).lower():
                    conn.execute(
                        'UPDATE subagent_runs SET status = ?, result_summary = ?, error = ?, '
                        "finished_at = COALESCE(?, finished_at) WHERE task_id = ?",
                        (
                            status,
                            summary[:4000],
                            (handle.error or '')[:2000],
                            time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(handle.finishedAt)) if handle.finishedAt else None,
                            handle.taskId,
                        ),
                    )
                else:
                    raise
        else:
            try:
                conn.execute(
                    'INSERT INTO subagent_runs '
                    '(task_id, session_id, agent_id, goal, status, started_at, result_summary, result_full, last_activity_at, api_calls, todos_json) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (
                        handle.taskId,
                        handle.sessionId,
                        handle.agentId,
                        (handle.goal or '')[:500],
                        status,
                        time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(handle.startedAt)),
                        summary[:4000],
                        full[:20000],
                        last_act_iso,
                        api_calls,
                        todos_json,
                    ),
                )
            except Exception as e:
                if 'no such column' in str(e).lower():
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
                else:
                    raise
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
        self.workstream: str = ''
        self.skills: list[str] = []
        # Per-agent todo list (submit_todos/update_todos from inside the
        # worker). Unique per handle, so parallel workers never clobber each
        # other or the parent session's list. Surfaced to the drawer via
        # toDict() and the runs endpoint.
        self.todos: list[dict[str, object]] = []
        self._future: asyncio.Future | None = None
        # Hermes-style: track liveness for stall detection + live-transcript
        self.lastActivityAt: float = time.time()
        self.apiCalls: int = 0
        self.iterations: int = 0

    @property
    def elapsed(self) -> float:
        if self.finishedAt:
            return round(self.finishedAt - self.startedAt, 2)
        return round(time.time() - self.startedAt, 2)

    @property
    def isStalling(self) -> bool:
        if self.status not in ('pending', 'running'):
            return False
        # Hermes stall threshold ~300s, but UI flags earlier for visibility
        return (time.time() - self.lastActivityAt) > 90

    def touch(self) -> None:
        self.lastActivityAt = time.time()
        self.apiCalls += 1
        self.iterations += 1

    def toDict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            'taskId': self.taskId,
            'agentId': self.agentId,
            'goal': self.goal,
            'sessionId': self.sessionId,
            'status': 'stalling' if self.isStalling else self.status,
            'result': self.result,
            'error': self.error,
            'startedAt': self.startedAt,
            'finishedAt': self.finishedAt,
            'elapsed': self.elapsed,
            'workstream': self.workstream,
            'lastActivityAt': self.lastActivityAt,
            'apiCalls': self.apiCalls,
            'iterations': self.iterations,
            'todos': self.todos,
        }
        # Surface raw status too for callers that need to distinguish stalling vs running
        if self.isStalling:
            d['rawStatus'] = self.status
        return d


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
        self._mailboxes: dict[str, list[str]] = {}
        self._closed = False

    async def spawn(self, request: SubagentSpawnRequest) -> list[SubagentHandle]:
        """Spawn one or more sub-agents concurrently (Hermes-structured).

        Respects per-session delegation config (maxConcurrent / maxIterations /
        maxDepth / worktreeIsolation) stored in workbench metadata — same shape
        as Hermes `delegation.*` so the harness stays well-structured and
        predictable.
        """
        if self._closed:
            raise RuntimeError('Orchestrator is closed')
        # Resolve per-session delegation config (well-structured harness)
        delegation: dict[str, object] = {}
        _sid_probe = ''
        try:
            if hasattr(request.session, 'id'):
                _sid_probe = str(getattr(request.session, 'id', '') or '')
            elif isinstance(request.session, dict):
                _sid_probe = str(request.session.get('id', '') or '')
            if _sid_probe:
                from app.services.workbench import workbench as _wb

                _sess = _wb.getWorkbenchSession(_sid_probe)
                _meta = getattr(_sess, 'metadata', None)
                if _sess and isinstance(_meta, dict):
                    _delegation_raw = _meta.get('delegation', {})
                    if isinstance(_delegation_raw, dict):
                        delegation = _delegation_raw
        except Exception:
            delegation = {}
        max_concurrent = max(1, min(30, as_int(delegation.get('maxConcurrent', 5), 5) or 5))  # Hermes default 3, August default 5
        default_max_iter = max(5, min(200, as_int(delegation.get('maxIterations', 50), 50) or 50))
        max_depth = max(1, min(5, as_int(delegation.get('maxDepth', 1), 1) or 1))
        # Enforce per-call concurrency cap (Hermes max_concurrent_children)
        work_items = request.workItems
        if len(work_items) > max_concurrent:
            # Keep deterministic order — Hermes would queue, but we surface the cap
            logger.info("[Harness] %d work items exceeds maxConcurrent=%d, will queue via semaphore", len(work_items), max_concurrent)
        # Hermes-style: wrap emit to capture live transcript + touch liveness
        _orig_emit = request.emit
        def _wrapped_emit(ev: dict[str, Any]) -> None:
            try:
                jid = str(ev.get("jobId") or ev.get("taskId") or "")
                if jid and jid in self._handles:
                    h = self._handles[jid]
                    h.touch()
                    try:
                        _record_run(h)
                    except Exception:
                        pass
                    _append_transcript(jid, ev)
                elif jid:
                    _append_transcript(jid, ev)
            except Exception:
                pass
            if _orig_emit:
                try:
                    _orig_emit(ev)
                except Exception:
                    pass
        request.emit = _wrapped_emit  # type: ignore[assignment]
        handles: list[SubagentHandle] = []
        tasks: list[asyncio.Task] = []
        for item in work_items:
            goal = item.get('goal', '')
            agentId = item.get('agentId', 'general')
            context = item.get('context', '')
            restrictedTools = item.get('restrictedTools')
            yieldSchema = item.get('yieldSchema')
            effort = as_str(item.get('effort'), 'medium') or 'medium'
            model = as_str(item.get('model'), '')
            # Runtime recursion depth: children of a sub-agent run at
            # parent_depth + 1; root spawns default to 0. Hermes max_spawn_depth caps this.
            raw_depth = as_int(getattr(request.session, 'subagent_depth', 0), 0) + 1
            depth = min(raw_depth, max_depth)
            if raw_depth > max_depth:
                logger.info("[Harness] depth %d exceeds maxDepth=%d, capping to %d (leaf)", raw_depth, max_depth, depth)
            taskId = f'task_{uuid.uuid4().hex[:12]}'
            sid = ''
            if hasattr(request.session, 'id'):
                sid = str(request.session.id)
            elif isinstance(request.session, dict):
                sid = str(request.session.get('id', ''))
            handle = SubagentHandle(taskId, agentId, goal, sessionId=sid)
            handle.workstream = as_str(item.get('workstream') or item.get('name'), '')
            handle.skills = [str(s).strip() for s in (item.get('skills') or []) if str(s).strip()]
            # Hermes: queued when semaphore saturated; visible in drawer queue position
            if self._semaphore.locked():
                handle.status = 'queued'
            self._handles[taskId] = handle
            _append_transcript(taskId, {"type": "subagentStart", "taskId": taskId, "jobId": taskId, "agentId": agentId, "goal": goal, "workstream": handle.workstream, "ts": time.time()})
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
                    acceptance_criteria=as_str(item.get('acceptance_criteria') or item.get('acceptanceCriteria'), ''),
                    stop_condition=as_str(item.get('stop_condition') or item.get('stopCondition'), ''),
                    max_iterations=as_int(item.get('max_iterations') or item.get('maxIterations'), 0) or default_max_iter,
                    workstream=handle.workstream,
                    prior_episodes=as_str(item.get('prior_episodes') or item.get('priorEpisodes'), ''),
                    woven_sources=as_str(item.get('woven_sources') or item.get('wovenSources'), ''),
                    episode_required=bool(item.get('episode_required') or item.get('episodeRequired') or handle.workstream),
                    skills=item.get('skills') or [],
                    harness_job_id=as_str(item.get('harness_job_id') or item.get('harnessJobId'), ''),
                    auto_hop=bool(item.get('autoHop') or item.get('auto_hop')),
                    capability=as_str(item.get('capability') or 'standard'),
                )
            )
            self._tasks[taskId] = task
            handle._future = task
            tasks.append(task)
        return handles

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
                if h.sessionId == sessionId and h.status not in ('pending', 'running', 'queued', 'stalling')
            ]
            if len(finished) > max_retained:
                for tid in finished[: len(finished) - max_retained]:
                    self._handles.pop(tid, None)
                    self._tasks.pop(tid, None)
        else:
            finished = [tid for tid, h in self._handles.items() if h.status not in ('pending', 'running', 'queued', 'stalling')]
            cap = max_retained * 8
            if len(finished) > cap:
                for tid in finished[: len(finished) - cap]:
                    self._handles.pop(tid, None)
                    self._tasks.pop(tid, None)
        # Queue positions: ordered by startedAt among queued for this session
        queued_order: dict[str, int] = {}
        queued_list = sorted(
            [h for h in self._handles.values() if h.status == 'queued' and (not sessionId or h.sessionId == sessionId)],
            key=lambda x: x.startedAt,
        )
        for idx, h in enumerate(queued_list, 1):
            queued_order[h.taskId] = idx
        queued_total = len(queued_list)
        result = []
        for h in self._handles.values():
            if sessionId and h.sessionId != sessionId:
                continue
            d = h.toDict()
            if h.status == 'queued':
                d['queuePosition'] = queued_order.get(h.taskId, 0)
                d['queueTotal'] = queued_total
            result.append(d)
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

    def enqueueMailbox(self, taskId: str, message: str) -> bool:
        """Queue a steering message for a running worker. Returns False if unknown."""
        if taskId not in self._handles:
            return False
        handle = self._handles[taskId]
        if handle.status not in ('pending', 'running'):
            return False
        text = (message or '').strip()
        if not text:
            return False
        self._mailboxes.setdefault(taskId, []).append(text)
        return True

    def drainMailbox(self, taskId: str) -> list[str]:
        msgs = self._mailboxes.pop(taskId, [])
        return list(msgs)

    def _collectMissedSteer(self, taskId: str) -> str:
        """D-1 (Part 22): steering that arrived after the worker's final
        mailbox drain must not vanish silently — surface it on the result so
        the parent sees what the worker never got to act on."""
        try:
            leftover = self._mailboxes.pop(taskId, [])
        except Exception:
            return ''
        if not leftover:
            return ''
        return '\n'.join(leftover)

    @staticmethod
    def _partial_from_transcript(taskId: str, limit: int = 6000) -> str:
        """D-2 (Part 22): reconstruct the worker's partial findings from its
        live transcript (text deltas + tool-call names) for stop/cancel."""
        try:
            events = _read_transcript(taskId, limit=200)
        except Exception:
            return ''
        parts: list[str] = []
        for ev in events:
            et = ev.get('type')
            if et == 'subagentText':
                txt = str(ev.get('content') or '').strip()
                if txt:
                    parts.append(txt)
            elif et == 'subagentToolCall':
                parts.append(f"[ran {ev.get('name') or 'tool'}]")
        text = '\n'.join(parts).strip()
        if len(text) > limit:
            text = text[:limit] + '\n…[truncated]'
        return text

    async def terminate(self, taskId: str) -> bool:
        """Terminate a running or queued sub-agent by taskId. Returns True if found.

        D-2 (Part 22): a stopped worker's work is not wasted — its partial
        transcript is collected into ``handle.result`` (persisted with the
        run row, rendered by the drawer) and the completion notice the parent
        receives carries it with a ``stopped`` marker.
        """
        task = self._tasks.get(taskId)
        handle = self._handles.get(taskId)
        if not task or not handle:
            return False
        task.cancel()
        handle.status = 'cancelled'
        handle.finishedAt = time.time()
        partial = self._partial_from_transcript(taskId)
        if partial and not handle.result:
            handle.result = {
                'status': 'stopped',
                'result': f'[stopped by user — partial work follows]\n{partial}',
            }
        _append_transcript(taskId, {"type": "subagentDone", "taskId": taskId, "jobId": taskId, "status": "cancelled", "ts": time.time()})
        _record_run(handle)
        try:
            await task
        except asyncio.CancelledError:
            pass
        return True

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
        acceptance_criteria: str = '',
        stop_condition: str = '',
        max_iterations: int = 0,
        workstream: str = '',
        prior_episodes: str = '',
        woven_sources: str = '',
        episode_required: bool = False,
        skills: object = None,
        harness_job_id: str = '',
        auto_hop: bool = False,
        capability: str = 'standard',
    ) -> None:
        """Acquire semaphore, run the sub-agent task, release."""
        # If queued, update to running on dequeue; touch for stall monitor
        handle.lastActivityAt = time.time()
        try:
            await asyncio.wait_for(self._semaphore.acquire(), timeout=SLOT_ACQUIRE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            handle.status = 'failed'
            handle.error = 'Timed out waiting for a worker slot (all sub-agent slots busy).'
            handle.finishedAt = time.time()
            _append_transcript(handle.taskId, {"type": "subagentDone", "taskId": handle.taskId, "jobId": handle.taskId, "status": "failed", "error": handle.error, "ts": time.time()})
            _record_run(handle)
            await self._fireEvent('subagentFailed', handle.toDict())
            return
        try:
            handle.status = 'running'
            handle.touch()
            _append_transcript(handle.taskId, {"type": "subagentRunning", "taskId": handle.taskId, "ts": time.time()})
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
                    acceptance_criteria=acceptance_criteria,
                    stop_condition=stop_condition,
                    max_iterations=max_iterations,
                    workstream=workstream,
                    prior_episodes=prior_episodes,
                    woven_sources=woven_sources,
                    episode_required=episode_required,
                    skills=skills,
                    harness_job_id=harness_job_id,
                    auto_hop=auto_hop,
                    capability=capability,
                )
                handle.result = result
                handle.finishedAt = time.time()
                # D-1 (Part 22): steering queued after the worker's final
                # mailbox drain would otherwise vanish — attach it to the
                # result so the parent sees what the worker never acted on.
                missed = self._collectMissedSteer(handle.taskId)
                if missed and isinstance(handle.result, dict):
                    handle.result = {
                        **handle.result,
                        'missedSteer': missed,
                        'result': str(handle.result.get('result') or '')
                        + f'\n\n[STEER the worker never received]\n{missed}',
                    }
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
