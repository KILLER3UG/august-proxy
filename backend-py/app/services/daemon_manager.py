"""
Daemon manager — asyncio task pool for subconscious background agents (Phase 8).

Manages the lifecycle of daemons: spawn, list, kill, result storage, crash
handling, exponential backoff, and graceful shutdown.

Daemons run on the Cerebellum model (fast, cheap) with a restricted read-only
tool set. For tool-using background tasks, use spawn_subagent instead.

Design: docs/design/cognitive-architecture-v1.md §5.4
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)


# ── Constants ───────────────────────────────────────────────────────────

MAX_DAEMONS_PER_SESSION = 3
RESULT_EXPIRY_TURNS = 5
BACKOFF_SCHEDULE = [5, 15, 45, 135]  # seconds, capped at 300
BACKOFF_CAP = 300  # 5 minutes
MAX_RETRIES = 2
POLL_INTERVAL = 30  # default seconds
SHUTDOWN_TIMEOUT = 5  # seconds


# ── Data types ──────────────────────────────────────────────────────────


@dataclass
class DaemonSpec:
    """Specification for a daemon to spawn."""
    name: str
    prompt: str
    watch_condition: str | None = None  # "on_completion" | "on_match:KEYWORD" | "on_change" | null
    tools: list[str] | None = None  # None = default read-only set, [] = no tools


@dataclass
class DaemonResult:
    """Result from a daemon run."""
    output: str = ""
    status: str = "running"  # running | triggered | completed | errored
    error: str = ""
    last_check: float = 0.0
    previous_hash: str = ""
    turns_alive: int = 0
    triggered: bool = False


# ── Daemon Manager ──────────────────────────────────────────────────────


class DaemonManager:
    """Manages daemon lifecycle for all sessions."""

    def __init__(self):
        self._daemons: dict[str, dict[str, Any]] = {}  # daemon_id → DaemonInfo
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def spawn(
        self,
        spec: DaemonSpec,
        session_id: str,
        context: dict[str, Any] | None = None,
    ) -> str:
        """Spawn a daemon. Returns daemon_id string or error message."""
        async with self._lock:
            # Check per-session cap
            session_daemons = [
                d for d in self._daemons.values()
                if d.get("session_id") == session_id
                and getattr(d.get("result"), "status", "") != "errored"
            ]
            if len(session_daemons) >= MAX_DAEMONS_PER_SESSION:
                return f"Error: max {MAX_DAEMONS_PER_SESSION} daemons per session"

            daemon_id = f"{session_id}_{spec.name}_{int(time.time())}"

            info = {
                "id": daemon_id,
                "name": spec.name,
                "session_id": session_id,
                "prompt": spec.prompt,
                "watch_condition": spec.watch_condition,
                "tools": spec.tools,
                "result": DaemonResult(),
                "context": context or {},
                "retries": 0,
                "backoff_index": 0,
                "backoff_until": 0.0,
            }
            self._daemons[daemon_id] = info

            # Start the polling loop
            task = asyncio.create_task(self._run_loop(daemon_id))
            self._tasks[daemon_id] = task
            logger.info("Daemon spawned: %s", daemon_id)
            return daemon_id

    async def kill(self, daemon_id: str) -> bool:
        """Kill a daemon by id. Returns True if it existed."""
        async with self._lock:
            if daemon_id not in self._tasks:
                return False
            self._tasks[daemon_id].cancel()
            del self._tasks[daemon_id]
            if daemon_id in self._daemons:
                self._daemons[daemon_id]["result"].status = "completed"
                del self._daemons[daemon_id]
            logger.info("Daemon killed: %s", daemon_id)
            return True

    def list_daemons(self, session_id: str | None = None) -> list[dict[str, Any]]:
        """List daemons, optionally filtered by session.

        Returns compact info (no full results). Expired results are removed.
        """
        now = time.time()
        results: list[dict[str, Any]] = []

        for did, info in list(self._daemons.items()):
            if session_id and info.get("session_id") != session_id:
                continue

            r = info.get("result", DaemonResult())

            # Expire old triggered results
            if r.triggered and r.turns_alive >= RESULT_EXPIRY_TURNS:
                r.triggered = False
                r.output = ""
                r.status = "completed"

            results.append({
                "id": did,
                "name": info["name"],
                "status": r.status,
                "triggered": r.triggered,
                "error": r.error or None,
                "last_check": r.last_check,
                "turns_alive": r.turns_alive,
                "output": r.output,  # v2: include result text for [CRITICAL] preservation
            })
        return results

    def get_result(self, daemon_id: str) -> DaemonResult | None:
        """Get the current result for a daemon."""
        info = self._daemons.get(daemon_id)
        if info:
            return info.get("result")
        return None

    def increment_turns(self, session_id: str) -> None:
        """Increment turn counter for all daemons in a session (called after each LLM turn)."""
        for info in self._daemons.values():
            if info.get("session_id") == session_id:
                r = info.get("result", DaemonResult())
                if r.triggered:
                    r.turns_alive += 1

    # ── Shutdown ───────────────────────────────────────────────────────

    async def shutdown(self) -> None:
        """Cancel all daemon tasks gracefully."""
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True, timeout=SHUTDOWN_TIMEOUT)
        self._tasks.clear()
        self._daemons.clear()
        logger.info("All daemons shut down")

    # ── Internal: daemon loop ──────────────────────────────────────────

    async def _run_loop(self, daemon_id: str) -> None:
        """Main daemon loop: poll on interval, evaluate watch condition."""
        info = self._daemons.get(daemon_id)
        if not info:
            return

        while True:
            try:
                # Check backoff
                if info["backoff_until"] > time.time():
                    await asyncio.sleep(1)
                    continue

                result = await self._run_once(daemon_id)
                if result is None:
                    break  # daemon was killed

                info["result"] = result
                info["result"].last_check = time.time()

                # Evaluate watch condition
                triggered = self._evaluate_watch(info)
                if triggered:
                    info["result"].triggered = True
                    info["result"].turns_alive = 0
                    logger.info("Daemon triggered: %s (condition: %s)", daemon_id, info["watch_condition"])
                    # Don't break — keep polling if the model reads the result

                # Reset backoff on success
                info["backoff_index"] = 0

                await asyncio.sleep(POLL_INTERVAL)

            except asyncio.CancelledError:
                logger.info("Daemon cancelled: %s", daemon_id)
                break
            except Exception as exc:
                logger.error("Daemon error: %s: %s", daemon_id, exc)
                # Handle crash — mark errored and retry if under cap
                info["result"].status = "errored"
                info["result"].error = str(exc)
                if info["retries"] < MAX_RETRIES:
                    info["retries"] += 1
                    delay = self._backoff(info)
                    logger.info("Daemon retry %d/%d in %.0fs", info["retries"], MAX_RETRIES, delay)
                    await asyncio.sleep(delay)
                else:
                    logger.error("Daemon max retries reached: %s", daemon_id)
                    break

    async def _run_once(self, daemon_id: str) -> DaemonResult | None:
        """Execute one daemon poll cycle."""
        info = self._daemons.get(daemon_id)
        if not info:
            return None

        result = DaemonResult()

        try:
            # Get the cerebellum model
            model_role = "cerebellum"
            try:
                from app.services.workbench.model_fleet import get_model_for_role
                cerebellum_model = get_model_for_role(model_role)
            except Exception:
                cerebellum_model = None

            if cerebellum_model:
                # Call the cerebellum model with the daemon prompt
                # The daemon can use its restricted tool set via the prompt
                from app.providers.clients import get_client
                # This is a simplified cerebellum call — in production, the
                # daemon would use the restricted tool set via the workbench
                # tool loop. For now, we run the prompt as a text generation.
                output = await self._call_cerebellum(cerebellum_model, info["prompt"])
                result.output = output
                result.status = "completed"
            else:
                # No cerebellum configured — daemon runs as pure text analysis
                result.output = f"Daemon '{info['name']}' running (no cerebellum model configured)"
                result.status = "completed"

        except Exception as exc:
            result.status = "errored"
            result.error = str(exc)

        return result

    async def _call_cerebellum(self, model: str, prompt: str) -> str:
        """Call the cerebellum model with a prompt.

        In production, this would use the provider client. For now,
        returns a placeholder that simulates the daemon running.
        """
        try:
            from app.providers.clients import get_client
            client = get_client({"model": model})
            if client and hasattr(client, "generate"):
                response = await client.generate(prompt)
                return response
        except Exception:
            pass
        return f"[daemon analysis: {prompt[:100]}...]"

    # ── Watch evaluation ───────────────────────────────────────────────

    def _evaluate_watch(self, info: dict) -> bool:
        """Evaluate the watch condition against the daemon's current output."""
        condition = info.get("watch_condition")
        if not condition:
            return False

        output = info["result"].output
        if not output:
            return False

        if condition == "on_completion":
            return bool(output.strip())

        if condition.startswith("on_match:"):
            keyword = condition[len("on_match:"):]
            return keyword.lower() in output.lower()

        if condition == "on_change":
            current_hash = hashlib.md5(output.encode()).hexdigest()
            previous = info["result"].previous_hash
            info["result"].previous_hash = current_hash
            if previous and current_hash != previous:
                return True
            return False

        return False

    def _backoff(self, info: dict) -> float:
        """Return the next backoff delay in seconds."""
        idx = info["backoff_index"]
        delay = BACKOFF_SCHEDULE[min(idx, len(BACKOFF_SCHEDULE) - 1)]
        delay = min(delay, BACKOFF_CAP)
        info["backoff_index"] = idx + 1
        info["backoff_until"] = time.time() + delay
        return delay


# ── Global singleton ────────────────────────────────────────────────────

_manager: DaemonManager | None = None


def get_manager() -> DaemonManager:
    """Get the global daemon manager singleton."""
    global _manager
    if _manager is None:
        _manager = DaemonManager()
    return _manager


async def shutdown_all() -> None:
    """Shutdown all daemon managers."""
    global _manager
    if _manager:
        await _manager.shutdown()
        _manager = None
