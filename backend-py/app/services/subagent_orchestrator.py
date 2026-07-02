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
    await orchestrator.terminate(task_id)
    active = orchestrator.list_active(session_id)
    sub = orchestrator.on("failure", handler)
"""
from __future__ import annotations
import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Optional

from app.services.agent_message_bus import AgentMessageBus, Subscription, Handler
from app.services.subagent_worker import run_subagent

logger = logging.getLogger(__name__)

MAX_CONCURRENT_WORKERS = 5
PEER_HELP_CLAIM_WINDOW_S = 5.0


class SubagentSpawnRequest:
    """Parameters for spawning one or more sub-agents."""

    def __init__(
        self,
        session: object,
        work_items: list[dict[str, Any]],
        mode: str = "auto",
    ) -> None:
        self.session = session
        self.work_items = work_items  # list of {goal, agent_id?, restricted_tools?, context?}
        self.mode = mode  # "auto" | "proposed" | "negotiated"


class SubagentHandle:
    """Handle returned by ``spawn()`` for tracking a sub-agent task."""

    def __init__(self, task_id: str, agent_id: str, goal: str, session_id: str = "") -> None:
        self.task_id = task_id
        self.agent_id = agent_id
        self.goal = goal
        self.session_id = session_id
        self.status: str = "pending"
        self.result: str = ""
        self.error: str = ""
        self.started_at: float = time.time()
        self.finished_at: float | None = None
        self._future: asyncio.Future | None = None

    @property
    def elapsed(self) -> float:
        if self.finished_at:
            return round(self.finished_at - self.started_at, 2)
        return round(time.time() - self.started_at, 2)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "agent_id": self.agent_id,
            "goal": self.goal,
            "session_id": self.session_id,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed": self.elapsed,
        }


class SubagentOrchestrator:
    """Manages concurrent sub-agent execution with failure recovery."""

    def __init__(self, bus: AgentMessageBus, max_workers: int = MAX_CONCURRENT_WORKERS) -> None:
        self._bus = bus
        self._semaphore = asyncio.Semaphore(max_workers)
        self._handles: dict[str, SubagentHandle] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._event_handlers: dict[str, list[Handler]] = {}
        self._closed = False

    # ── public API ────────────────────────────────────────────────────

    async def spawn(self, request: SubagentSpawnRequest) -> list[SubagentHandle]:
        """Spawn one or more sub-agents concurrently.

        Returns a list of handles (one per work item).
        """
        if self._closed:
            raise RuntimeError("Orchestrator is closed")

        handles: list[SubagentHandle] = []
        tasks: list[asyncio.Task] = []

        for item in request.work_items:
            goal = item.get("goal", "")
            agent_id = item.get("agent_id", "general")
            context = item.get("context", "")
            restricted_tools = item.get("restricted_tools")

            task_id = f"task_{uuid.uuid4().hex[:12]}"
            # Extract session_id from the session object if available
            sid = ""
            if hasattr(request.session, 'id'):
                sid = str(request.session.id)
            elif isinstance(request.session, dict):
                sid = str(request.session.get('id', ''))
            handle = SubagentHandle(task_id, agent_id, goal, session_id=sid)
            self._handles[task_id] = handle
            handles.append(handle)

            # Acquire semaphore slot and launch
            task = asyncio.create_task(
                self._run_with_slot(
                    handle=handle,
                    request=request,
                    agent_id=agent_id,
                    goal=goal,
                    context=context,
                    restricted_tools=restricted_tools,
                )
            )
            self._tasks[task_id] = task
            tasks.append(task)

        return handles

    async def terminate(self, task_id: str) -> bool:
        """Cancel a running sub-agent task.

        Returns ``True`` if the task was found and cancelled.
        """
        task = self._tasks.get(task_id)
        handle = self._handles.get(task_id)
        if task and not task.done():
            task.cancel()
            if handle:
                handle.status = "cancelled"
                handle.finished_at = time.time()
            return True
        return False

    def list_active(self, session_id: str | None = None) -> list[dict[str, Any]]:
        """Return all active (running or pending) sub-agent tasks.

        If *session_id* is provided, only tasks for that session are returned.
        """
        active = []
        for tid, handle in self._handles.items():
            if handle.status in ("pending", "running"):
                if session_id is None or handle.session_id == session_id:
                    active.append(handle.to_dict())
        return active

    def get_handle(self, task_id: str) -> SubagentHandle | None:
        return self._handles.get(task_id)

    async def wait_for_all(self, handles: list[SubagentHandle]) -> list[dict[str, Any]]:
        """Wait for all given handles to complete and return their results.

        Uses ``asyncio.gather`` so results are collected as tasks finish.
        """
        tasks = []
        for h in handles:
            task = self._tasks.get(h.task_id)
            if task and not task.done():
                tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return [h.to_dict() for h in handles]

    def on(self, event: str, handler: Handler) -> Subscription:
        """Register a handler for orchestrator-level events.

        Supported events:
            - ``"subagent_started"`` — when a sub-agent begins
            - ``"subagent_completed"`` — when a sub-agent finishes successfully
            - ``"subagent_failed"`` — when a sub-agent fails
            - ``"subagent_cancelled"`` — when a sub-agent is terminated

        Returns a ``Subscription`` that can be used to unsubscribe.
        """
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)
        return Subscription(self._bus, f"orchestrator:{event}", handler)

    async def close(self) -> None:
        """Cancel all running tasks and shut down."""
        self._closed = True
        for tid, task in self._tasks.items():
            if not task.done():
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()
        self._handles.clear()

    # ── internal ──────────────────────────────────────────────────────

    async def _run_with_slot(
        self,
        handle: SubagentHandle,
        request: SubagentSpawnRequest,
        agent_id: str,
        goal: str,
        context: str,
        restricted_tools: list[str] | None,
    ) -> None:
        """Acquire a semaphore slot and run the sub-agent."""
        async with self._semaphore:
            if self._closed:
                return
            handle.status = "running"

            # Publish orchestrator event
            await self._fire_event("subagent_started", {
                "task_id": handle.task_id,
                "agent_id": agent_id,
                "goal": goal,
            })

            try:
                result = await run_subagent(
                    bus=self._bus,
                    session=request.session,
                    agent_id=agent_id,
                    goal=goal,
                    context=context,
                    task_id=handle.task_id,
                    restricted_tools=restricted_tools,
                )
                handle.status = result.get("status", "error")
                handle.result = result.get("result", "")
                handle.error = result.get("error", "")
                handle.finished_at = time.time()

                if handle.status == "failed":
                    await self._handle_failure(handle)
                    await self._fire_event("subagent_failed", handle.to_dict())
                else:
                    await self._fire_event("subagent_completed", handle.to_dict())

            except asyncio.CancelledError:
                handle.status = "cancelled"
                handle.finished_at = time.time()
                await self._fire_event("subagent_cancelled", handle.to_dict())

            except Exception as exc:
                logger.exception("[Orchestrator] unexpected error for task %s", handle.task_id)
                handle.status = "failed"
                handle.error = str(exc)
                handle.finished_at = time.time()
                await self._handle_failure(handle)
                await self._fire_event("subagent_failed", handle.to_dict())

    async def _handle_failure(self, handle: SubagentHandle) -> None:
        """Broadcast failure and open a peer-help claim window."""
        task_id = handle.task_id

        # Broadcast failure
        await self._bus.publish(f"task:{task_id}:failure", {
            "type": "subagent_failed",
            "task_id": task_id,
            "agent_id": handle.agent_id,
            "goal": handle.goal,
            "error": handle.error,
        })

        # Open peer-help claim window (5 seconds)
        # Peers can claim by publishing to task:{task_id}:peer-help
        logger.info(
            "[Orchestrator] task %s failed, opening %ss peer-help window",
            task_id,
            PEER_HELP_CLAIM_WINDOW_S,
        )

        try:
            claim = await self._bus.wait_for_message(
                f"task:{task_id}:peer-help",
                timeout=PEER_HELP_CLAIM_WINDOW_S,
            )
            if claim and claim.get("claim"):
                claimant = claim.get("claimant_id", "unknown")
                logger.info(
                    "[Orchestrator] task %s claimed by peer %s",
                    task_id,
                    claimant,
                )
                handle.status = "recovered"
                handle.result = f"Recovered by {claimant}"
        except asyncio.TimeoutError:
            logger.info(
                "[Orchestrator] no peer claimed task %s within window, escalating",
                task_id,
            )

    async def _fire_event(self, event: str, data: dict[str, Any]) -> None:
        """Fire an orchestrator-level event to registered handlers."""
        handlers = list(self._event_handlers.get(event, []))
        for handler in handlers:
            try:
                result = handler(data)
                if result is not None:
                    await result
            except Exception:
                logger.exception("[Orchestrator] event handler error for %s", event)
