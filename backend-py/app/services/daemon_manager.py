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
import logging
import time
from dataclasses import dataclass
from typing import cast

import httpx  # noqa: F401

from app.json_narrowing import as_float, as_int, as_str
from app.type_aliases import DaemonStatusDict

logger = logging.getLogger(__name__)
MAX_DAEMONS_PER_SESSION = 10
MAX_DAEMONS_PER_WORKSPACE = 20
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
    persistWorkspace: bool = False


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

    async def spawn(self, spec: DaemonSpec, sessionId: str, context: dict[str, object] | None = None) -> str:
        """Spawn a daemon. Returns daemon_id string or error message."""
        async with self._lock:
            sessionDaemons = [
                d
                for d in self._daemons.values()
                if as_str(d.get('session_id')) == sessionId
                and getattr(cast('DaemonResult | None', d.get('result')), 'status', '') != 'errored'
            ]
            if len(sessionDaemons) >= MAX_DAEMONS_PER_SESSION:
                return f'Error: max {MAX_DAEMONS_PER_SESSION} daemons per session'
            workspacePath = ''
            try:
                from app.services.workbench.sessions import get_workbench_session

                sess = get_workbench_session(sessionId)
                if sess is not None:
                    workspacePath = str(getattr(sess, 'workspacePath', '') or '')
            except Exception:
                pass
            if workspacePath:
                ws_daemons = [
                    d
                    for d in self._daemons.values()
                    if as_str(d.get('workspace_path')) == workspacePath
                    and getattr(cast('DaemonResult | None', d.get('result')), 'status', '') != 'errored'
                ]
                if len(ws_daemons) >= MAX_DAEMONS_PER_WORKSPACE:
                    return f'Error: max {MAX_DAEMONS_PER_WORKSPACE} daemons per workspace'
            daemonId = f'{sessionId}_{spec.name}_{int(time.time())}'
            info: dict[str, object] = {
                'id': daemonId,
                'name': spec.name,
                'session_id': sessionId,
                'workspace_path': workspacePath,
                'prompt': spec.prompt,
                'watch_condition': spec.watchCondition,
                'tools': spec.tools,
                'persist_workspace': bool(getattr(spec, 'persistWorkspace', False)),
                'result': DaemonResult(),
                'context': context or {},
                'retries': 0,
                'backoff_index': 0,
                'backoff_until': 0.0,
            }
            self._daemons[daemonId] = info
            task = asyncio.create_task(self._runLoop(daemonId))
            self._tasks[daemonId] = task
            logger.info('Daemon spawned: %s', daemonId)
            try:
                import json as _json

                from app.services.memory_store import _conn as _mem_conn

                c = _mem_conn()
                c.execute(
                    'INSERT OR REPLACE INTO daemons (id, session_id, workspace_path, name, spec_json, result_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))',
                    (
                        daemonId,
                        sessionId,
                        workspacePath,
                        spec.name,
                        _json.dumps(
                            {
                                'prompt': spec.prompt,
                                'watchCondition': spec.watchCondition,
                                'tools': spec.tools,
                                'persistWorkspace': bool(getattr(spec, 'persistWorkspace', False)),
                            }
                        ),
                        _json.dumps({'status': 'running'}),
                        'running',
                    ),
                )
                c.commit()
            except Exception:
                pass
            return daemonId

    async def kill(self, daemonId: str) -> bool:
        """Kill a daemon by id. Returns True if it existed."""
        async with self._lock:
            if daemonId not in self._tasks:
                return False
            self._tasks[daemonId].cancel()
            del self._tasks[daemonId]
            if daemonId in self._daemons:
                r = self._daemons[daemonId].get('result')
                if isinstance(r, DaemonResult):
                    r.status = 'completed'
                del self._daemons[daemonId]
            logger.info('Daemon killed: %s', daemonId)
            try:
                from app.services.memory_store import _conn as _mem_conn2

                c2 = _mem_conn2()
                c2.execute('DELETE FROM daemons WHERE id = ?', (daemonId,))
                c2.commit()
            except Exception:
                pass
            return True

    async def kill_for_session(self, sessionId: str) -> int:
        """Kill every daemon bound to a session (session-deletion cleanup).

        Daemons don't auto-clean otherwise — deleting a session must take
        its background processes with it (model-experience report,
        2026-08-28). Returns the number killed.
        """
        if not sessionId:
            return 0
        ids = [as_str(d.get('id')) for d in self.list_daemons(sessionId)]
        killed = 0
        for daemonId in ids:
            if not daemonId:
                continue
            try:
                if await self.kill(daemonId):
                    killed += 1
            except Exception:
                logger.debug('daemon kill failed for %s', daemonId, exc_info=True)
        if killed:
            logger.info('Daemons killed for deleted session %s: %d', sessionId, killed)
        return killed

    def rehydrate_from_db(self) -> int:
        """Rehydrate in-memory daemon entries from DB after restart."""
        try:
            import json as _json

            from app.services.memory_store import _conn as _mem_conn3

            c = _mem_conn3()
            rows = c.execute('SELECT id, session_id, workspace_path, name, spec_json, result_json, status FROM daemons WHERE status = "running"').fetchall()
            n = 0
            for r in rows:
                did = str(r['id'])
                if did in self._daemons:
                    continue
                try:
                    spec_d = _json.loads(r['spec_json'] or '{}')
                    res_d = _json.loads(r['result_json'] or '{}')
                except Exception:
                    continue
                info: dict[str, object] = {
                    'id': did,
                    'name': str(r['name'] or spec_d.get('name') or 'daemon'),
                    'session_id': str(r['session_id'] or ''),
                    'workspace_path': str(r['workspace_path'] or ''),
                    'prompt': str(spec_d.get('prompt') or ''),
                    'watch_condition': spec_d.get('watchCondition'),
                    'tools': spec_d.get('tools'),
                    'persist_workspace': bool(spec_d.get('persistWorkspace')),
                    'result': DaemonResult(status=str(res_d.get('status') or 'running')),
                    'context': {},
                    'retries': 0,
                    'backoff_index': 0,
                    'backoff_until': 0.0,
                }
                self._daemons[did] = info
                try:
                    import asyncio as _asyncio

                    self._tasks[did] = _asyncio.create_task(self._runLoop(did))
                except Exception:
                    pass
                n += 1
            return n
        except Exception:
            return 0

    def list_daemons(self, sessionId: str | None = None) -> list[DaemonStatusDict]:
        """List daemons, optionally filtered by session.

        Returns compact info (no full results). Expired results are removed.
        """
        results: list[DaemonStatusDict] = []
        for did, info in list(self._daemons.items()):
            if sessionId and as_str(info.get('session_id')) != sessionId:
                continue
            r = (
                cast(DaemonResult, info.get('result'))
                if isinstance(info.get('result'), DaemonResult)
                else DaemonResult()
            )
            if r.triggered and r.turnsAlive >= RESULT_EXPIRY_TURNS:
                r.triggered = False
                r.output = ''
                r.status = 'completed'
            entry: dict[str, object] = {
                'id': did,
                'name': info['name'],
                'status': r.status,
                'triggered': r.triggered,
                'error': r.error or None,
                'last_check': r.lastCheck,
                'turns_alive': r.turnsAlive,
                'output': r.output,
            }
            results.append(cast(DaemonStatusDict, entry))
        return results

    def getResult(self, daemonId: str) -> DaemonResult | None:
        """Get the current result for a daemon."""
        info = self._daemons.get(daemonId)
        if info:
            r = info.get('result')
            return cast(DaemonResult, r) if isinstance(r, DaemonResult) else None
        return None

    def increment_turns(self, sessionId: str) -> None:
        """Increment turn counter for all daemons in a session (called after each LLM turn)."""
        for info in self._daemons.values():
            if as_str(info.get('session_id')) == sessionId:
                r = (
                    cast(DaemonResult, info.get('result'))
                    if isinstance(info.get('result'), DaemonResult)
                    else DaemonResult()
                )
                if r.triggered:
                    r.turnsAlive += 1

    async def shutdown(self) -> None:
        """Cancel all daemon tasks gracefully."""
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=SHUTDOWN_TIMEOUT)
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
                if as_float(info.get('backoff_until'), 0.0) > time.time():
                    await asyncio.sleep(1)
                    continue
                result = await self._runOnce(daemonId)
                if result is None:
                    break
                info['result'] = result
                result.lastCheck = time.time()
                triggered = self._evaluateWatch(info)
                if triggered:
                    result.triggered = True
                    result.turnsAlive = 0
                    logger.info('Daemon triggered: %s (condition: %s)', daemonId, info['watch_condition'])
                info['backoff_index'] = 0
                await asyncio.sleep(POLL_INTERVAL)
            except asyncio.CancelledError:
                logger.info('Daemon cancelled: %s', daemonId)
                break
            except Exception as exc:
                logger.error('Daemon error: %s: %s', daemonId, exc)
                r = info.get('result')
                if isinstance(r, DaemonResult):
                    r.status = 'errored'
                    r.error = str(exc)
                if as_int(info.get('retries'), 0) < MAX_RETRIES:
                    info['retries'] = as_int(info.get('retries'), 0) + 1
                    delay = self._backoff(info)
                    logger.info('Daemon retry %d/%d in %.0fs', as_int(info.get('retries'), 0), MAX_RETRIES, delay)
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
                from app.services.workbench.model_fleet import getModelForRole

                cerebellumModel = getModelForRole(modelRole)
            except Exception:
                cerebellumModel = None
            if cerebellumModel:

                output = await self._callCerebellum(cerebellumModel, as_str(info.get('prompt'), ''))
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
        """Call the cerebellum fleet model with a real provider generate path.

        Uses ``model_fleet`` / provider resolver + client ``generate``.
        Returns an honest error string when model/provider/key is missing —
        never a fake success placeholder that pretends analysis ran.
        """
        if not model:
            return '[daemon: no cerebellum model configured in fleet]'
        try:
            from app.providers import resolver as providerResolver
            from app.providers.clients import getClient

            provider = providerResolver.resolve(model)
            if not provider:
                return f'[daemon: no provider resolved for model {model!r}]'
            client = getClient(provider)
            if client is None:
                return f'[daemon: no client for provider of {model!r}]'
            system = (
                'You are a short-lived background daemon for August Proxy. '
                'Answer concisely. Do not invent tool results.'
            )
            response = await client.generate(prompt, system=system)
            text = str(response or '').strip()
            if not text:
                return '[daemon: empty model response]'
            return text
        except Exception as exc:
            logger.warning('Daemon cerebellum call failed for %s: %s', model, exc)
            return f'[daemon error: {exc}]'

    def _evaluateWatch(self, info: dict) -> bool:
        """Evaluate the watch condition against the daemon's current output."""
        condition = as_str(info.get('watch_condition'))
        if not condition:
            return False
        output = info['result'].output
        if not output:
            return False
        if condition == 'on_completion':
            return bool(output.strip())
        if condition.startswith('on_match:'):
            keyword = condition[len('on_match:') :]
            return keyword.lower() in output.lower()
        if condition == 'on_change':
            currentHash = hashlib.md5(output.encode()).hexdigest()
            # Persist the hash on `info`, NOT on the ephemeral DaemonResult —
            # every poll creates a fresh result, so reading previous_hash
            # from it was always '' and on_change could never fire (audit
            # finding).
            previous = info.get('last_hash')
            info['last_hash'] = currentHash
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
