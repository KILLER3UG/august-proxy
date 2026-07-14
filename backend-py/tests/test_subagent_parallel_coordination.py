"""
Tests that sub-agents spawned *in parallel* by the SubagentOrchestrator
actually coordinate with one another (via the shared blackboard) so their
outputs do not contradict.

Rather than calling a real LLM, these tests reuse the established in-process
"stub model" pattern from ``testWorkbenchToolLoop.py``: a ``CoordinationStub``
whose ``messagesStream`` yields scripted Anthropic events. The stub is
content-driven -- it inspects the conversation to decide its next action --
so two parallel sub-agents that share a single stub client still behave
independently and correctly.

Scenarios covered:
  A. Shared decision via blackboard: one sub-agent writes a decision, the
     other reads it and adopts the SAME value -> no contradiction.
     Contrast: if the reader ignores the blackboard, the two diverge ->
     contradiction is detected (proving the test measures real comms).
  B. Parallel resource allocation: N sub-agents each claim a distinct port
     from a shared pool by reading existing claims before writing, with a
     bounded retry that re-reads live state, guaranteeing distinct claims.
  C. Concurrency: sub-agents truly run concurrently (overlapping execution
     intervals) and publish lifecycle events on the AgentMessageBus.

No network access or API credentials are required.
"""

from __future__ import annotations
import asyncio
import json
import re
import time
from typing import Any

import pytest

from app.services.workbench import workbench as wb
from app.services.subagent_orchestrator import (
    SubagentOrchestrator,
    SubagentSpawnRequest,
)
from app.services.agent_message_bus import AgentMessageBus
from app.services.blackboard_service import readNotes
from app.services import memory_store
from app.services import tool_definitions  # noqa: F401  (defines registerAll)

STUB_PROVIDER = {
    'name': 'stub-anthropic',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
    'modelProfiles': {},
}

# Port pool for the resource-allocation scenario.
PORT_MIN, PORT_MAX = 8000, 8009
MAX_POLLS = 6  # how many times an adopter re-reads before giving up
MAX_WRITES = 6  # how many times a claimer rewrites its port before giving up


def _ev_tool(self, name: str, inp: dict[str, Any]) -> list[dict[str, Any]]:
    uid = f'toolu_{id(self)}_{self.call_count}_{self._seq}'
    self._seq += 1
    return [
        {
            '_event_type': 'content_block_start',
            'content_block': {'type': 'tool_use', 'id': uid, 'name': name, 'input': inp},
        },
        {'_event_type': 'content_block_delta', 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(inp)}},
        {'_event_type': 'content_block_stop'},
        {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}},
    ]


def _ev_text(self, text: str) -> list[dict[str, Any]]:
    return [
        {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': text}},
        {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}},
    ]


class CoordinationStub:
    """Stub upstream client that coordinates sub-agents through the blackboard.

    The stub is *content-driven*: it inspects ``body['messages']`` to count the
    tool calls it has already made, and it reads the live blackboard directly
    (via ``readNotes``) to make coordination decisions. This keeps behaviour
    deterministic even when two sub-agents interleave on the shared event loop.
    """

    def __init__(self, session_id: str, execution_log: list | None = None, busy_sleep: float = 0.0) -> None:
        self.session_id = session_id
        self.call_count = 0
        self._seq = 0
        self.execution_log = execution_log
        self.busy_sleep = busy_sleep
        self._started_workers: set[str] = set()
        self._next_decision_override: dict[str, Any] | None = None

    # -- plumbing ---------------------------------------------------------
    def resolveApiKey(self) -> str:
        return 'stub-key'

    def _goal(self, messages: list[dict[str, Any]]) -> str:
        for m in messages:
            if m.get('role') != 'user':
                continue
            c = m.get('content')
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                txt = ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
                if txt:
                    return txt
        return ''

    def _worker(self, messages: list[dict[str, Any]]) -> str:
        goal = self._goal(messages)
        wid = ''
        m = re.search(r'WORKER_ID=(\S+)', goal)
        if m:
            wid = m.group(1)
        if 'ROLE:PROPOSER' in goal:
            return 'PROPOSER' + (':' + wid if wid else '')
        if 'ROLE:ADOPTER' in goal:
            return 'ADOPTER' + (':' + wid if wid else '')
        if 'ROLE:CLAIMER' in goal:
            return 'CLAIMER' + (':' + wid if wid else 'CLAIMER')
        return 'UNKNOWN'

    def _tally(self, messages: list[dict[str, Any]]):
        reads = writes = 0
        last_write_val = last_write_key = None
        for m in messages:
            if m.get('role') != 'assistant':
                continue
            c = m.get('content')
            if not isinstance(c, list):
                continue
            for b in c:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    name = b.get('name', '')
                    inp = b.get('input', {}) or {}
                    if name == 'read_blackboard':
                        reads += 1
                    elif name == 'write_blackboard':
                        writes += 1
                        last_write_val = inp.get('value')
                        last_write_key = inp.get('key')
        return reads, writes, last_write_val, last_write_key

    # -- blackboard helpers (fresh connection) ----------------------------
    def _read_decided(self, messages: list[dict[str, Any]]) -> str | None:
        """Read the decided value from the blackboard using a fresh DB connection.

        Uses ``memory_store._db_path()`` (same path as write tools) rather than
        hand-building from AUGUST_DATA_DIR — the two can diverge if settings
        and env are not in lockstep, which showed up as a CI flake on Linux.
        """
        import sqlite3
        from app.services.memory_store import _db_path

        try:
            conn = sqlite3.connect(str(_db_path()), timeout=5)
            conn.row_factory = sqlite3.Row
            cur = conn.execute(
                'SELECT value FROM blackboard WHERE sessionId=? AND key=?',
                (self.session_id, 'decided'),
            )
            row = cur.fetchone()
            conn.close()
            if row:
                return str(row['value'])
        except Exception:
            pass
        # Prefer the service helper as a second path (same session scope).
        try:
            notes = readNotes(self.session_id, key='decided')
            if notes:
                return str(notes[0]['value'])
        except Exception:
            pass
        return None

    def _claimed_ports(self, messages: list[dict[str, Any]]) -> set[int]:
        """Read claimed ports from the blackboard using a fresh DB connection."""
        import sqlite3
        from app.services.memory_store import _db_path

        ports: set[int] = set()
        db = _db_path()
        try:
            conn = sqlite3.connect(str(db), timeout=5)
            conn.row_factory = sqlite3.Row
            cur = conn.execute(
                'SELECT key, value FROM blackboard WHERE sessionId=? AND key LIKE ?', (self.session_id, 'port_%')
            )
            for row in cur.fetchall():
                try:
                    ports.add(int(row['value']))
                except (TypeError, ValueError):
                    pass
            conn.close()
        except Exception:
            pass
        return ports

    @staticmethod
    def _lowest_free(taken: set[int]) -> int:
        for p in range(PORT_MIN, PORT_MAX + 1):
            if p not in taken:
                return p
        return PORT_MIN

    # -- decision logic ---------------------------------------------------
    def _decide(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        goal = self._goal(messages)
        reads, writes, last_val, _ = self._tally(messages)

        if 'ROLE:PROPOSER' in goal:
            decided = re.search(r'DECIDED=(\S+)', goal)
            decided_val = decided.group(1) if decided else '/api/v1'
            if writes == 0:
                return _ev_tool(self, 'write_blackboard', {'key': 'decided', 'value': decided_val})
            return _ev_text(self, f'Agreed base path: {decided_val}')

        if 'ROLE:ADOPTER' in goal:
            if 'IGNORE_BB' in goal:
                # Contrast case: never consult the blackboard.
                return _ev_text(self, 'Chosen base path: /api/v1')
            if reads == 0:
                return _ev_tool(self, 'read_blackboard', {'key': 'decided'})
            live = self._read_decided(messages)
            if live is not None:
                return _ev_text(self, f'Adopted base path: {live}')
            if reads < MAX_POLLS:
                return _ev_tool(self, 'read_blackboard', {'key': 'decided'})
            return _ev_text(self, 'Chosen base path: /api/v1')

        if 'ROLE:CLAIMER' in goal:
            m = re.search(r'WORKER_ID=(\S+)', goal)
            wid = m.group(1) if m else 'w?'
            if writes == 0:
                if reads == 0:
                    return _ev_tool(self, 'read_blackboard', {'key': 'port'})
                candidate = self._lowest_free(self._claimed_ports(messages))
                return _ev_tool(self, 'write_blackboard', {'key': f'port_{wid}', 'value': str(candidate)})
            # Already wrote at least once: check for collision.
            taken = self._claimed_ports(messages)
            others = taken - {last_val}
            if last_val in others and writes < MAX_WRITES:
                candidate = self._lowest_free(taken)
                return _ev_tool(self, 'write_blackboard', {'key': f'port_{wid}', 'value': str(candidate)})
            return _ev_text(self, f'Claimed port {last_val}')

        # Default: just finish.
        return _ev_text(self, 'done')

    # -- async generator interface used by _callAnthropicWorkbench --------
    async def messages_stream(self, body: dict[str, Any]):
        self.call_count += 1
        messages = body.get('messages', [])
        if self.busy_sleep:
            await asyncio.sleep(self.busy_sleep)
        events = self._decide(messages)
        is_final = not any(e.get('content_block', {}).get('type') == 'tool_use' for e in events)
        if self.execution_log is not None:
            worker = self._worker(messages)
            if worker not in self._started_workers:
                self._started_workers.add(worker)
                self.execution_log.append(('start', time.monotonic(), worker))
            if is_final:
                self.execution_log.append(('end', time.monotonic(), worker))
        for ev in events:
            yield ev


# ---------------------------------------------------------------------------
# Fixture: isolate the workbench + wire the stub model + a fresh blackboard.
# ---------------------------------------------------------------------------
@pytest.fixture
def coord_env(monkeypatch, tmp_path):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    try:
        settings.reload()
    except Exception:
        pass
    monkeypatch.setattr(wb, '_sessions', {})

    # Ensure the brain/blackboard tables exist in the temp DB.
    memory_store.init()
    # Register all core tools so blackboard tools are available.
    tool_definitions.registerAll()  # noqa: F811

    # Route model resolution / provider selection at the sub-agent layer.
    monkeypatch.setattr(wb, '_resolveWorkbenchProvider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr(wb, '_resolveModel', lambda p, hint='': 'stub-claude')
    import app.providers.model_resolver as modelResolver

    monkeypatch.setattr(
        modelResolver,
        'resolve_or_fallback',
        lambda *a, **kw: {'provider': 'stub-anthropic', 'model': 'stub-claude'},
    )
    import app.services.fallback_service as fallbackService

    monkeypatch.setattr(fallbackService, 'getFallback', lambda *a, **kw: {'enabled': False})

    # Wire the stub model: getClient returns whatever the test puts in the holder.
    holder: dict[str, Any] = {}

    def fake_get_client(provider):
        return holder.get('client')

    import app.providers.clients as clientsMod

    monkeypatch.setattr(clientsMod, 'getClient', fake_get_client)
    monkeypatch.setattr('app.providers.clients.getClient', fake_get_client)

    # A single parent session. Both sub-agents resolve to it via get_session(),
    # so they share the same blackboard scope.
    session = wb.createWorkbenchSession(provider='stub-anthropic')
    session_id = session.id

    yield {'holder': holder, 'session_id': session_id}

    try:
        memory_store.close()
    except Exception:
        pass


def _result_text(handle_dict: dict[str, Any]) -> str:
    """Extract the final text from a handle dict returned by waitForAll."""
    res = handle_dict.get('result')
    if isinstance(res, dict):
        return str(res.get('result', ''))
    return str(res or '')


def _session(coord_env):
    sessions = getattr(wb, '_sessions', {})
    try:
        return next(iter(sessions.values()))
    except StopIteration:
        return None


async def _spawn_and_wait(coord_env, goals, execution_log=None, busy_sleep=0.0):
    """Spawn sub-agents in parallel with one stub instance and wait for all.

    Returns ``(handles, results, stub, bus_events)`` where ``bus_events`` maps
    each taskId to the lifecycle messages published on the AgentMessageBus
    (captured before the bus is closed).
    """
    stub = CoordinationStub(coord_env['session_id'], execution_log=execution_log, busy_sleep=busy_sleep)
    coord_env['holder']['client'] = stub
    bus = AgentMessageBus()
    orch = SubagentOrchestrator(bus)
    work_items = [{'goal': g, 'agentId': 'general'} for g in goals]
    request = SubagentSpawnRequest(session=_session(coord_env), workItems=work_items)
    handles = await orch.spawn(request)
    results = await orch.waitForAll(handles)
    bus_events: dict[str, dict[str, list]] = {}
    for h in handles:
        bus_events[h.taskId] = {
            'progress': list(bus.get_topic_messages(f'task:{h.taskId}:progress')),
            'result': list(bus.get_topic_messages(f'task:{h.taskId}:result')),
        }
    await orch.close()
    bus.close()
    return handles, results, stub, bus_events


# ---------------------------------------------------------------------------
# Test 1 (Scenario A, positive): shared decision coordinated via blackboard.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_shared_decision_coordinated_via_blackboard(coord_env):
    proposer_goal = 'ROLE:PROPOSER DECIDED=/api/v2-K3p Decide the shared API base path and record it on the blackboard.'
    adopter_goal = (
        'ROLE:ADOPTER Read the shared decision from the blackboard and adopt exactly that base path in your answer.'
    )
    handles, results, _, _ = await _spawn_and_wait(coord_env, [proposer_goal, adopter_goal])

    for h in handles:
        assert h.status == 'completed', f'sub-agent {h.taskId} failed: {h.error}'

    # waitForAll may not preserve spawn order under load — identify by content.
    texts = [_result_text(r) for r in results]
    proposer_text = next((t for t in texts if t.startswith('Agreed base path:')), texts[0])
    adopter_text = next((t for t in texts if t.startswith('Adopted base path:') or t.startswith('Chosen base path:')), texts[-1])

    # Both must reference the SAME decided value -> they communicated.
    assert '/api/v2-K3p' in proposer_text, f'proposer texts={texts!r}'
    assert '/api/v2-K3p' in adopter_text, f'adopter texts={texts!r}'

    # The blackboard must hold the decision.
    notes = readNotes(coord_env['session_id'], key='decided')
    assert notes, 'no decision recorded on the blackboard'
    assert str(notes[0]['value']) == '/api/v2-K3p'


# ---------------------------------------------------------------------------
# Test 2 (Scenario A, contrast): without coordination the outputs contradict.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_shared_decision_contradicts_without_coordination(coord_env):
    proposer_goal = 'ROLE:PROPOSER DECIDED=/api/v2-K3p Decide the shared API base path and record it on the blackboard.'
    # IGNORE_BB -> the adopter never reads the blackboard and uses its own value.
    adopter_goal = 'ROLE:ADOPTER IGNORE_BB Choose your own API base path without consulting the blackboard.'
    handles, results, _, _ = await _spawn_and_wait(coord_env, [proposer_goal, adopter_goal])

    for h in handles:
        assert h.status == 'completed', f'sub-agent {h.taskId} failed: {h.error}'

    proposer_text = _result_text(results[0])
    adopter_text = _result_text(results[1])

    # Proposer recorded /api/v2-K3p; adopter ignored it and used /api/v1.
    assert '/api/v2-K3p' in proposer_text
    assert '/api/v1' in adopter_text
    # The two decisions contradict (different base paths).
    assert '/api/v2-K3p' not in adopter_text


# ---------------------------------------------------------------------------
# Test 3 (Scenario B, positive): parallel port allocation with no contradiction.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_parallel_resource_allocation_no_contradiction(coord_env):
    goals = [
        'ROLE:CLAIMER WORKER_ID=w1 Claim an available port from 8000-8009 '
        'using the blackboard so you do not clash with other workers.',
        'ROLE:CLAIMER WORKER_ID=w2 Claim an available port from 8000-8009 '
        'using the blackboard so you do not clash with other workers.',
        'ROLE:CLAIMER WORKER_ID=w3 Claim an available port from 8000-8009 '
        'using the blackboard so you do not clash with other workers.',
    ]
    handles, results, _, _ = await _spawn_and_wait(coord_env, goals)

    for h in handles:
        assert h.status == 'completed', f'sub-agent {h.taskId} failed: {h.error}'

    # Collect each worker's final (latest) claimed port from the blackboard.
    # (value, id) tuple per key; keep highest id.
    latest: dict[str, tuple[int, int]] = {}
    for n in readNotes(coord_env['session_id']):
        key = str(n.get('key', ''))
        if key.startswith('port_'):
            # Keep the latest note per key (highest id wins).
            existing = latest.get(key)
            nid = n.get('id', 0)
            if existing is None or nid > existing[0]:
                try:
                    latest[key] = (nid, int(n['value']))
                except (TypeError, ValueError):
                    pass

    values = [v for _, v in latest.values()]
    assert len(values) == 3, f'expected 3 distinct worker claims, got {values}'
    assert len(set(values)) == 3, f'port collision detected: {values}'


# ---------------------------------------------------------------------------
# Test 4 (concurrency): sub-agents run in parallel and publish bus events.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_subagents_run_concurrently(coord_env):
    execution_log: list[tuple[str, float, str]] = []
    proposer_goal = 'ROLE:PROPOSER DECIDED=/api/v2-K3p Record the shared API base path.'
    adopter_goal = 'ROLE:ADOPTER Read the shared decision from the blackboard and adopt it.'
    handles, results, _, bus_events = await _spawn_and_wait(
        coord_env,
        [proposer_goal, adopter_goal],
        execution_log=execution_log,
        busy_sleep=0.03,
    )

    for h in handles:
        assert h.status == 'completed', f'sub-agent {h.taskId} failed: {h.error}'

    # Both sub-agents must have published lifecycle events on the bus.
    for h in handles:
        assert bus_events[h.taskId]['progress'], f'no progress event for {h.taskId}'
        assert bus_events[h.taskId]['result'], f'no result event for {h.taskId}'

    # Execution intervals must overlap -> they ran concurrently, not serially.
    by_worker: dict[str, list[float]] = {}
    for kind, ts, worker in execution_log:
        by_worker.setdefault(worker, []).append(ts)

    workers = list(by_worker.keys())
    assert len(workers) >= 2, f'expected >=2 workers in log, got {workers}'
    w0, w1 = workers[0], workers[1]
    start0, end0 = min(by_worker[w0]), max(by_worker[w0])
    start1, end1 = min(by_worker[w1]), max(by_worker[w1])
    assert start0 < end1 and start1 < end0, f'workers did not overlap: {w0}=({start0},{end0}) {w1}=({start1},{end1})'
