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
from typing import Callable
logger = logging.getLogger(__name__)
MAX_DAEMONS_PER_SESSION = 3
RESULT_EXPIRY_TURNS = 5
BACKOFF_SCHEDULE = [5, 15, 45, 135]
BACKOFF_CAP = 300
MAX_RETRIES = 2
POLL_INTERVAL = 30
SHUTDOWN_TIMEOUT = 5

@dataclass
class DaemonSpec:
    """Specification for a daemon to spawn."""
    name: str
    prompt: str
    watchCondition: str | None = None
    tools: list[str] | None = None

@dataclass
class DaemonResult:
    """Result from a daemon run."""
    output: str = ''
    status: str = 'running'
    error: str = ''
    lastCheck: float = 0.0
    previousHash: str = ''
    turnsAlive: int = 0
    triggered: bool = False

class DaemonManager:
    """Manages daemon lifecycle for all sessions."""

    def __init__(self):
        self._daemons: dict[str, dict[str, object]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def spawn(self, spec: DaemonSpec, sessionId: str, context: dict[str, object] | None=None) -> str:
        """Spawn a daemon. Returns daemon_id string or error message."""
        async with self._lock:
            sessionDaemons = [d for d in self._daemons.values() if d.get('session_id') == sessionId and getattr(d.get('result'), 'status', '') != 'errored']
            if len(sessionDaemons) >= MAX_DAEMONS_PER_SESSION:
                return f'Error: max {MAX_DAEMONS_PER_SESSION} daemons per session'
            daemonId = f'{sessionId}_{spec.name}_{int(time.time())}'
            info = {'id': daemonId, 'name': spec.name, 'session_id': sessionId, 'prompt': spec.prompt, 'watch_condition': spec.watch_condition, 'tools': spec.tools, 'result': DaemonResult(), 'context': context or {}, 'retries': 0, 'backoff_index': 0, 'backoff_until': 0.0}
            self._daemons[daemonId] = info
            task = asyncio.create_task(self._runLoop(daemonId))
            self._tasks[daemonId] = task
            logger.info('Daemon spawned: %s', daemonId)
            return daemonId

    async def kill(self, daemonId: str) -> bool:
        """Kill a daemon by id. Returns True if it existed."""
        async with self._lock:
            if daemonId not in self._tasks:
                return False
            self._tasks[daemonId].cancel()
            del self._tasks[daemonId]
            if daemonId in self._daemons:
                self._daemons[daemonId]['result'].status = 'completed'
                del self._daemons[daemonId]
            logger.info('Daemon killed: %s', daemonId)
            return True

    def listDaemons(self, sessionId: str | None=None) -> list[dict[str, object]]:
        """List daemons, optionally filtered by session.

        Returns compact info (no full results). Expired results are removed.
        """
        now = time.time()
        results: list[dict[str, object]] = []
        for did, info in list(self._daemons.items()):
            if sessionId and info.get('session_id') != sessionId:
                continue
            r = info.get('result', DaemonResult())
            if r.triggered and r.turns_alive >= RESULT_EXPIRY_TURNS:
                r.triggered = False
                r.output = ''
                r.status = 'completed'
            results.append({'id': did, 'name': info['name'], 'status': r.status, 'triggered': r.triggered, 'error': r.error or None, 'last_check': r.last_check, 'turns_alive': r.turns_alive, 'output': r.output})
        return results

    def getResult(self, daemonId: str) -> DaemonResult | None:
        """Get the current result for a daemon."""
        info = self._daemons.get(daemonId)
        if info:
            return info.get('result')
        return None

    def incrementTurns(self, sessionId: str) -> None:
        """Increment turn counter for all daemons in a session (called after each LLM turn)."""
        for info in self._daemons.values():
            if info.get('session_id') == sessionId:
                r = info.get('result', DaemonResult())
                if r.triggered:
                    r.turns_alive += 1

    async def shutdown(self) -> None:
        """Cancel all daemon tasks gracefully."""
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True, timeout=SHUTDOWN_TIMEOUT)
        self._tasks.clear()
        self._daemons.clear()
        logger.info('All daemons shut down')

    async def _runLoop(self, daemonId: str) -> None:
        """Main daemon loop: poll on interval, evaluate watch condition."""
        info = self._daemons.get(daemonId)
        if not info:
            return
        while True:
            try:
                if info['backoff_until'] > time.time():
                    await asyncio.sleep(1)
                    continue
                result = await self._runOnce(daemonId)
                if result is None:
                    break
                info['result'] = result
                info['result'].last_check = time.time()
                triggered = self._evaluateWatch(info)
                if triggered:
                    info['result'].triggered = True
                    info['result'].turns_alive = 0
                    logger.info('Daemon triggered: %s (condition: %s)', daemonId, info['watch_condition'])
                info['backoff_index'] = 0
                await asyncio.sleep(POLL_INTERVAL)
            except asyncio.CancelledError:
                logger.info('Daemon cancelled: %s', daemonId)
                break
            except Exception as exc:
                logger.error('Daemon error: %s: %s', daemonId, exc)
                info['result'].status = 'errored'
                info['result'].error = str(exc)
                if info['retries'] < MAX_RETRIES:
                    info['retries'] += 1
                    delay = self._backoff(info)
                    logger.info('Daemon retry %d/%d in %.0fs', info['retries'], MAX_RETRIES, delay)
                    await asyncio.sleep(delay)
                else:
                    logger.error('Daemon max retries reached: %s', daemonId)
                    break

    async def _runOnce(self, daemonId: str) -> DaemonResult | None:
        """Execute one daemon poll cycle."""
        info = self._daemons.get(daemonId)
        if not info:
            return None
        result = DaemonResult()
        try:
            modelRole = 'cerebellum'
            try:
                from app.services.workbench.modelFleet import getModelForRole
                cerebellumModel = getModelForRole(modelRole)
            except Exception:
                cerebellumModel = None
            if cerebellumModel:
                from app.providers.clients import getClient
                output = await self._callCerebellum(cerebellumModel, info['prompt'])
                result.output = output
                result.status = 'completed'
            else:
                result.output = f"Daemon '{info['name']}' running (no cerebellum model configured)"
                result.status = 'completed'
        except Exception as exc:
            result.status = 'errored'
            result.error = str(exc)
        return result

    async def _callCerebellum(self, model: str, prompt: str) -> str:
        """Call the cerebellum model with a prompt.

        In production, this would use the provider client. For now,
        returns a placeholder that simulates the daemon running.
        """
        try:
            from app.providers.clients import getClient
            client = getClient({'model': model})
            if client and hasattr(client, 'generate'):
                response = await client.generate(prompt)
                return response
        except Exception:
            pass
        return f'[daemon analysis: {prompt[:100]}...]'

    def _evaluateWatch(self, info: dict) -> bool:
        """Evaluate the watch condition against the daemon's current output."""
        condition = info.get('watch_condition')
        if not condition:
            return False
        output = info['result'].output
        if not output:
            return False
        if condition == 'on_completion':
            return bool(output.strip())
        if condition.startswith('on_match:'):
            keyword = condition[len('on_match:'):]
            return keyword.lower() in output.lower()
        if condition == 'on_change':
            currentHash = hashlib.md5(output.encode()).hexdigest()
            previous = info['result'].previous_hash
            info['result'].previous_hash = currentHash
            if previous and currentHash != previous:
                return True
            return False
        return False

    def _backoff(self, info: dict) -> float:
        """Return the next backoff delay in seconds."""
        idx = info['backoff_index']
        delay = BACKOFF_SCHEDULE[min(idx, len(BACKOFF_SCHEDULE) - 1)]
        delay = min(delay, BACKOFF_CAP)
        info['backoff_index'] = idx + 1
        info['backoff_until'] = time.time() + delay
        return delay
_manager: DaemonManager | None = None

def getManager() -> DaemonManager:
    """Get the global daemon manager singleton."""
    global _manager
    if _manager is None:
        _manager = DaemonManager()
    return _manager

async def shutdownAll() -> None:
    """Shutdown all daemon managers."""
    global _manager
    if _manager:
        await _manager.shutdown()
        _manager = None