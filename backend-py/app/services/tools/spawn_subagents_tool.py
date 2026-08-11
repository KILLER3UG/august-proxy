"""
``spawn_subagents`` tool — registered alongside ``spawn_subagent``.

Enables an agent to spawn multiple sub-agents in parallel via the
``SubagentOrchestrator``.

Schema
------
    {
      "workItems": [
        {
          "goal": "string (required)",
          "agentId": "string (optional, default 'general')",
          "restrictedTools": ["string"] (optional),
          "context": "string (optional)"
        }
      ],
      "mode": "auto" | "proposed" | "negotiated" (default 'auto'),
      "background": bool (default true) — return immediately; each
        completion is delivered to the parent model as it settles
    }

Modes
-----
- ``auto``: spawn immediately.
- ``proposed``: emit a ``subagentProposed`` event for user approval before
  spawning. The frontend shows an approval card; the user must approve via
  ``POST /api/subagents/propose-breakdown`` before spawning begins.
- ``negotiated``: like proposed, but the orchestrator may rebalance work
  items before spawning.

Background (default)
--------------------
When ``background`` is true (the default for multi-spawn), the tool returns
as soon as every worker is dispatched. Each subagent's completion is emitted
as an SSE event *and* enqueued for the parent model so the parent sees
per-subagent results incrementally rather than after a blocking join.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from app.json_narrowing import as_list, as_str
from app.services.subagent_orchestrator import SubagentOrchestrator, SubagentSpawnRequest

logger = logging.getLogger(__name__)
TOOL_NAME = 'spawn_subagents'
TOOL_DEFINITION = {
    'name': TOOL_NAME,
    'description': (
        'Spawn multiple sub-agents in parallel for independent work items. '
        'Prefer this (or several spawn_subagent calls in one turn) when investigating '
        'different areas at once. By default returns immediately after dispatch; each '
        'subagent completion is delivered to you individually as it finishes. '
        'Set background=false only when you must block until every item completes.'
    ),
    'input_schema': {
        'type': 'object',
        'properties': {
            'workItems': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'goal': {'type': 'string', 'description': 'The goal/instruction for this sub-agent.'},
                        'agentId': {
                            'type': 'string',
                            'description': "Agent ID to use (e.g. 'explore', 'general'). Default 'general'.",
                            'default': 'general',
                        },
                        'restrictedTools': {
                            'type': 'array',
                            'items': {'type': 'string'},
                            'description': 'Tool names this sub-agent is restricted from using.',
                        },
                        'yieldSchema': {
                            'type': 'object',
                            'description': (
                                'Optional JSON Schema. When set, the sub-agent returns a SINGLE '
                                'JSON object matching it; you read the result programmatically '
                                'instead of parsing prose.'
                            ),
                        },
                        'effort': {
                            'type': 'string',
                            'enum': ['low', 'medium', 'high', 'max'],
                            'description': 'Reasoning/thinking budget for this sub-agent (default medium).',
                        },
                        'model': {
                            'type': 'string',
                            'description': (
                                'Optional model override for this sub-agent (e.g. a specific '
                                'model id). Default: the agent\'s alias or the cheap smol fleet model.'
                            ),
                        },
                        'context': {'type': 'string', 'description': 'Additional context for the sub-agent.'},
                    },
                    'required': ['goal'],
                },
                'minItems': 1,
                'maxItems': 10,
            },
            'mode': {
                'type': 'string',
                'enum': ['auto', 'proposed', 'negotiated'],
                'default': 'auto',
                'description': "Spawn mode: 'auto' spawns immediately, 'proposed' requires user approval.",
            },
            'background': {
                'type': 'boolean',
                'default': True,
                'description': (
                    'If true (default), return as soon as workers are dispatched and deliver '
                    'each completion to you as it settles. If false, block until all finish.'
                ),
            },
        },
        'required': ['workItems'],
    },
}
_pendingProposals: dict[str, dict[str, Any]] = {}
# Background completion-watcher tasks per parent session (spawned in _doSpawn
# when background=True). Session deletion cancels them via
# cancel_session_watches so they cannot outlive their session.
_session_watch_tasks: dict[str, set[Any]] = {}
# Pending proposals expire after this long — a proposal the user never
# approves must not hold a live session ref (and a DB row) forever.
PROPOSAL_TTL_S = 600.0


def cancel_session_watches(session_id: str) -> int:
    """Cancel every background subagent completion watcher for a session.

    Used by the session-delete path (sessions.cancel_session_work). Returns
    the number of tasks cancelled.
    """
    if not session_id:
        return 0
    tasks = _session_watch_tasks.pop(session_id, set())
    cancelled = 0
    for t in tasks:
        if not t.done():
            t.cancel()
            cancelled += 1
    return cancelled


def _expire_stale_proposals(now: float | None = None) -> int:
    """Drop pending proposals older than PROPOSAL_TTL_S (memory + DB).

    Entries are only removed by approveProposal today; without a TTL every
    proposed spawn leaked one in-memory entry (holding a live session ref)
    and one DB row forever. Returns the number expired.
    """
    now = time.time() if now is None else now
    expired = 0
    for pid in list(_pendingProposals.keys()):
        entry = _pendingProposals.get(pid)
        created = entry.get('createdAt') if entry else None
        if isinstance(created, (int, float)) and now - float(created) > PROPOSAL_TTL_S:
            _pendingProposals.pop(pid, None)
            expired += 1
    try:
        import json as _json
        from datetime import datetime, timezone

        from app.services.memory_store import _conn

        conn = _conn()
        rows = conn.execute(
            "SELECT id, content FROM proposals WHERE status = 'pending'"
        ).fetchall()
        for r in rows:
            try:
                data = _json.loads(r['content'] or '{}')
                created = data.get('createdAt')
            except Exception:
                continue
            if isinstance(created, (int, float)) and now - float(created) > PROPOSAL_TTL_S:
                conn.execute(
                    'UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?',
                    ('expired', datetime.now(timezone.utc).isoformat(), r['id']),
                )
                expired += 1
        conn.commit()
    except Exception:
        logger.debug('proposal expiry sweep failed (non-fatal)', exc_info=True)
    return expired


def expire_proposals_for_session(session_id: str) -> int:
    """Expire pending proposals bound to a deleted session (memory + DB)."""
    if not session_id:
        return 0
    expired = 0
    for pid in list(_pendingProposals.keys()):
        entry = _pendingProposals.get(pid)
        if entry and _session_id(entry.get('session') or {}) == session_id:
            _pendingProposals.pop(pid, None)
            expired += 1
    try:
        from datetime import datetime, timezone

        from app.services.memory_store import _conn

        conn = _conn()
        cur = conn.execute(
            "UPDATE proposals SET status = 'expired', decided_at = ? "
            'WHERE session_id = ? AND status = ?',
            (datetime.now(timezone.utc).isoformat(), session_id, 'pending'),
        )
        conn.commit()
        expired += int(cur.rowcount or 0)
    except Exception:
        logger.debug('proposal session expiry failed (non-fatal)', exc_info=True)
    return expired


# ── Proposal persistence (B5): survive backend restarts ────────────────
# The in-memory dict above is the fast path; the `proposals` table is the
# durable store. On restart, approvals hydrate the session from the
# workbench store and re-spawn the work items.

def _persist_proposal(
    proposal_id: str,
    session: object,
    work_items: list[dict[str, Any]],
    mode: str,
    background: bool,
    created_at: float,
) -> None:
    """Insert one pending proposal row (fire-and-forget, never raises)."""
    try:
        import json as _json
        from datetime import datetime, timezone

        from app.services.memory_store import _conn

        sid = _session_id(session)
        _conn().execute(
            'INSERT INTO proposals (session_id, proposal_type, content, status, created_at) '
            'VALUES (?, ?, ?, ?, ?)',
            (
                sid,
                'subagent_breakdown',
                _json.dumps(
                    {
                        'proposalId': proposal_id,
                        'workItems': work_items,
                        'mode': mode,
                        'background': background,
                        'createdAt': created_at,
                        'sessionId': sid,
                    }
                ),
                'pending',
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        _conn().commit()
    except Exception:
        logger.debug('proposal persist failed (non-fatal)', exc_info=True)


def _load_proposal_from_db(proposal_id: str) -> dict[str, Any] | None:
    """Rehydrate a pending proposal after a restart (memory miss)."""
    try:
        import json as _json
        import types

        from app.services.memory_store import _conn

        rows = _conn().execute(
            "SELECT id, session_id, content FROM proposals WHERE status = 'pending'"
        ).fetchall()
        for r in rows:
            try:
                data = _json.loads(r['content'] or '{}')
            except Exception:
                continue
            if data.get('proposalId') != proposal_id:
                continue
            sid = str(r['session_id'] or data.get('sessionId') or '')
            session: object | None = None
            if sid:
                try:
                    from app.services.workbench.workbench import get_workbench_session

                    session = get_workbench_session(sid)
                except Exception:
                    session = None
            if session is None:
                # Best-effort shell — spawning still works via session id.
                # Hydrate provider/model from config (agents-router pattern)
                # so the respawn does not fail with "No provider available"
                # when the original session is gone.
                try:
                    from app.services.config_service import getConfig

                    _cfg = getConfig()
                    _provider = as_str(_cfg.get('activeProvider')) or ''
                    _model = as_str(_cfg.get('activeModel')) or ''
                except Exception:
                    _provider, _model = '', ''
                session = types.SimpleNamespace(
                    id=sid or 'default', model=_model, agentId='', provider=_provider, subagent_depth=0
                )
            return {
                'session': session,
                'workItems': as_list(data.get('workItems'), []),
                'mode': str(data.get('mode') or 'auto'),
                'background': bool(data.get('background', True)),
            }
    except Exception:
        logger.debug('proposal db load failed (non-fatal)', exc_info=True)
    return None


def list_persisted_proposals() -> list[dict[str, Any]]:
    """Pending proposals from the durable store (for the Runs tab)."""
    _expire_stale_proposals()
    try:
        import json as _json

        from app.services.memory_store import _conn

        rows = _conn().execute(
            'SELECT id, content FROM proposals WHERE status = ? ORDER BY id DESC LIMIT 20',
            ('pending',),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                data = _json.loads(r['content'] or '{}')
            except Exception:
                continue
            items = data.get('workItems') or []
            out.append(
                {
                    'proposalId': data.get('proposalId') or f'db_{r["id"]}',
                    'createdAt': data.get('createdAt') or 0,
                    'workItemCount': len(items) if isinstance(items, list) else 0,
                    'goals': [
                        str((w.get('goal') or '') if isinstance(w, dict) else '')[:200]
                        for w in items
                        if isinstance(w, dict)
                    ],
                }
            )
        return out
    except Exception:
        logger.debug('proposal list failed (non-fatal)', exc_info=True)
        return []


def _mark_proposal_decided(proposal_id: str, status: str) -> None:
    """Mark a proposal row decided (approved/rejected)."""
    try:
        import json as _json
        from datetime import datetime, timezone

        from app.services.memory_store import _conn

        conn = _conn()
        rows = conn.execute(
            "SELECT id, content FROM proposals WHERE status = 'pending'"
        ).fetchall()
        for r in rows:
            try:
                data = _json.loads(r['content'] or '{}')
            except Exception:
                continue
            if data.get('proposalId') == proposal_id:
                conn.execute(
                    'UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?',
                    (status, datetime.now(timezone.utc).isoformat(), r['id']),
                )
                conn.commit()
                return
    except Exception:
        logger.debug('proposal decide failed (non-fatal)', exc_info=True)


def _session_id(session: object) -> str:
    if hasattr(session, 'id'):
        return str(session.id)
    if isinstance(session, dict):
        return str(session.get('id', '') or '')
    return ''


def _format_completion_notice(result: dict[str, Any]) -> str:
    task_id = result.get('taskId', '')
    agent_id = result.get('agentId', 'general')
    status = result.get('status', 'completed')
    goal = str(result.get('goal') or '')[:200]
    payload = result.get('result')
    if isinstance(payload, dict):
        text = str(payload.get('result') or payload.get('output') or payload.get('error') or '')
    else:
        text = str(payload or result.get('error') or '')
    text = text.strip()
    if len(text) > 8000:
        text = text[:8000] + '\n…[truncated]'
    lines = [
        f'[SUBAGENT_COMPLETE taskId="{task_id}" agentId="{agent_id}" status="{status}"]',
        f'goal: {goal}' if goal else '',
        text or '(empty result)',
        '[/SUBAGENT_COMPLETE]',
    ]
    return '\n'.join(line for line in lines if line)


def _enqueue_completion(session: object, result: dict[str, Any]) -> None:
    """Deliver one settled subagent result to the parent model ASAP."""
    sid = _session_id(session)
    if not sid:
        return
    try:
        from app.services.workbench.workbench import enqueueUserMessage

        enqueueUserMessage(sid, _format_completion_notice(result), kind='subagent')
    except Exception:
        logger.debug('failed to enqueue subagent completion', exc_info=True)
        return
    # The parent turn may already have ended — a completion enqueued on an
    # idle session would otherwise sit in the queue until the user's next
    # message (the spawn tool promises per-completion delivery). The router
    # starts a coalesced, capped auto-turn for late completions.
    try:
        from app.routers.workbench import scheduleSubagentAutoTurn

        scheduleSubagentAutoTurn(sid)
    except Exception:
        logger.debug('failed to schedule subagent auto-turn', exc_info=True)


async def executeSpawnSubagents(
    orchestrator: SubagentOrchestrator,
    session: object,
    workItems: list[dict[str, Any]],
    mode: str = 'auto',
    emit: Callable | None = None,
    background: bool = True,
) -> dict[str, Any]:
    """Execute the spawn_subagents tool.

    Args:
        orchestrator: The subagent orchestrator instance.
        session: The parent session object.
        workItems: List of work item dicts (goal, agentId, etc.).
        mode: Spawn mode ('auto', 'proposed', 'negotiated').
        emit: Optional SSE event emitter.
        background: If True, return after dispatch; completions arrive per-subagent.

    Returns:
        Result dict with ``status`` and either ``handles`` (background) or ``results``.
    """
    _expire_stale_proposals()
    if mode == 'proposed':
        proposalId = f'proposal_{__import__("uuid").uuid4().hex[:8]}'
        createdAt = __import__('time').time()
        _pendingProposals[proposalId] = {
            'workItems': workItems,
            'session': session,
            'mode': mode,
            'background': background,
            'createdAt': createdAt,
        }
        _persist_proposal(proposalId, session, workItems, mode, background, createdAt)
        if emit:
            emit(
                {
                    'type': 'subagentProposed',
                    'proposalId': proposalId,
                    'workBreakdown': [
                        {'goal': item.get('goal', ''), 'agentId': item.get('agentId', 'general')} for item in workItems
                    ],
                }
            )
        return {
            'status': 'awaiting_approval',
            'proposalId': proposalId,
            'message': f'Proposal {proposalId} created. Waiting for user approval.',
        }
    return await _doSpawn(orchestrator, session, workItems, emit=emit, background=background)


async def approveProposal(orchestrator: SubagentOrchestrator, proposalId: str) -> dict[str, Any]:
    """Approve a pending proposal and trigger spawning.

    Memory-first; after a restart the proposal is rehydrated from the
    durable ``proposals`` table (B5) and the session re-fetched from the
    workbench store.
    """
    _expire_stale_proposals()
    proposal = _pendingProposals.pop(proposalId, None)
    if not proposal:
        proposal = _load_proposal_from_db(proposalId)
        if not proposal:
            return {'status': 'error', 'error': f'Proposal {proposalId} not found or already expired.'}
    _mark_proposal_decided(proposalId, 'approved')
    return await _doSpawn(
        orchestrator,
        proposal['session'],
        proposal['workItems'],
        emit=None,
        background=bool(proposal.get('background', True)),
    )


def _doneResultText(result: dict[str, Any]) -> str:
    """Flatten a worker handle dict to the text payload for ``subagentDone``.

    ``waitForEach`` yields ``handle.toDict()`` whose ``result`` is the whole
    worker dict (``{'taskId', 'agentId', 'status', 'result': text}``), not a
    string. The frontend calls ``.trim()`` on ``subagentDone.result`` — a dict
    there throws and silently kills the event, leaving the chat container
    stuck at "running". Mirrors ``SubagentOrchestrator._result_payload_text``.
    """
    payload = result.get('result')
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        return str(payload.get('result') or payload.get('output') or '')
    return '' if payload is None else str(payload)


async def _doSpawn(
    orchestrator: SubagentOrchestrator,
    session: object,
    workItems: list[dict[str, Any]],
    emit: Any | None = None,
    background: bool = True,
) -> dict[str, Any]:
    """Spawn sub-agents; optionally wait or return after dispatch."""
    request = SubagentSpawnRequest(
        session=session,
        workItems=[
            {
                'goal': item.get('goal', ''),
                'agentId': item.get('agentId', 'general'),
                'restrictedTools': item.get('restrictedTools'),
                'yieldSchema': item.get('yieldSchema'),
                'effort': item.get('effort', 'medium'),
                'model': item.get('model', ''),
                'context': item.get('context', ''),
            }
            for item in workItems
        ],
        mode='auto',
        emit=emit,
    )
    handles = await orchestrator.spawn(request)
    dispatch = [
        {
            'taskId': h.taskId,
            'agentId': h.agentId,
            'goal': h.goal,
            'status': h.status,
        }
        for h in handles
    ]
    if emit:
        try:
            from app.services.workbench.context import currentToolUseId

            parentToolUseId = currentToolUseId.get()
        except Exception:
            parentToolUseId = ''
        for h in handles:
            emit(
                {
                    'type': 'subagentStart',
                    'jobId': h.taskId,
                    'agentId': h.agentId,
                    'task': h.goal,
                    'parentToolUseId': parentToolUseId or None,
                }
            )

    if background:
        # Watch completions without blocking the parent tool result.
        async def _watch() -> None:
            try:
                async for result in orchestrator.waitForEach(handles):
                    if emit:
                        emit(
                            {
                                'type': 'subagentDone',
                                'jobId': result.get('taskId'),
                                'status': result.get('status'),
                                'result': _doneResultText(result),
                                'message': result.get('error') or '',
                            }
                        )
                    _enqueue_completion(session, result)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception('background subagent watch failed')

        import asyncio

        watch_task = asyncio.create_task(_watch())
        # Track per parent session so the delete path can cancel the watcher
        # (it would otherwise keep enqueuing completions into a dead session).
        sid = _session_id(session)
        if sid:
            _session_watch_tasks.setdefault(sid, set()).add(watch_task)
            watch_task.add_done_callback(
                lambda t: _session_watch_tasks.get(sid, set()).discard(t)
            )
        return {
            'status': 'started',
            'total': len(handles),
            'background': True,
            'handles': dispatch,
            'message': (
                f'Dispatched {len(handles)} subagent(s). Each completion will be delivered '
                'to you individually as it finishes — do not poll; continue other work or wait.'
            ),
        }

    # Blocking: still emit incrementally as each settles, then return join.
    # No _enqueue_completion here — the joined results are already the tool
    # result; enqueuing them too would inject a duplicate [SUBAGENT_COMPLETE]
    # block into the next round.
    results: list[dict[str, Any]] = []
    async for result in orchestrator.waitForEach(handles):
        results.append(result)
        if emit:
            emit(
                {
                    'type': 'subagentDone',
                    'jobId': result.get('taskId'),
                    'status': result.get('status'),
                    'result': _doneResultText(result),
                    'message': result.get('error') or '',
                }
            )

    succeeded = sum((1 for r in results if r['status'] == 'completed'))
    failed = sum((1 for r in results if r['status'] in ('failed', 'error')))
    return {
        'status': 'completed' if failed == 0 else 'partial' if succeeded > 0 else 'failed',
        'total': len(results),
        'succeeded': succeeded,
        'failed': failed,
        'background': False,
        'results': results,
    }
