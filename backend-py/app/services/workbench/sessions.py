"""
Workbench session persistence and CRUD.

Owns the in-memory session store, disk persistence, and status pub/sub.
Extracted from workbench.py for Phase 3 modularization.

Globals (``_sessions``, ``_status_subscribers``) live only here; workbench
imports and re-exports them so chat streaming and external callers share one store.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TYPE_CHECKING, cast

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_str, as_dict, as_list, as_int, as_float, as_bool

if TYPE_CHECKING:
    import asyncio

    from app.services.workbench.tool_guardrails import ToolCallTracker

logger = logging.getLogger('workbench.sessions')

_SESSION_FILE = 'workbench-sessions.json'


@dataclass
class WorkbenchSession:
    """In-memory representation of a workbench session.

    Persisted to disk as JSON via save_sessions().
    """

    id: str = ''
    title: str = 'New Session'
    provider: str = ''
    model: str = ''
    agentId: str = ''
    guardMode: str = 'full'
    createdAt: str = ''
    updatedAt: str = ''
    startedAt: str = ''
    messageCount: int = 0
    mutationCount: int = 0
    workspacePath: str = ''
    goal: str = ''
    plan: dict[str, object] | None = None
    planApproved: bool = False
    clarify: dict[str, object] | None = None
    todos: list[dict[str, object]] | None = None
    messages: list[dict[str, object]] = field(default_factory=list)
    pendingMutations: list[dict[str, object]] = field(default_factory=list)
    mutationLog: list[dict[str, object]] = field(default_factory=list)
    status: str = 'idle'
    metadata: dict[str, object] = field(default_factory=dict)
    totalInputTokens: int = 0
    totalOutputTokens: int = 0
    totalCost: float = 0.0
    queuedUserMessages: list[dict[str, object]] = field(default_factory=list)
    # Dynamically-set instance attrs (declared so mypy can track them)
    _tool_assembly: object | None = None
    _failure_feedback: object | None = None
    _failure_feedback_age: int | None = None
    _last_compaction_turn: int | None = None
    _tool_tracker: ToolCallTracker | None = None
    _execution_state: object | None = None
    _working_memory: object | None = None
    _state_lock: asyncio.Lock | None = None

    def toDict(self) -> dict[str, object]:
        return {
            'id': self.id,
            'title': self.title,
            'provider': self.provider,
            'model': self.model,
            'agentId': self.agentId,
            'guardMode': self.guardMode,
            'createdAt': self.createdAt,
            'updatedAt': self.updatedAt,
            'startedAt': self.startedAt,
            'messageCount': self.messageCount,
            'mutationCount': self.mutationCount,
            'workspacePath': self.workspacePath,
            'goal': self.goal,
            'plan': self.plan,
            'planApproved': self.planApproved,
            'clarify': self.clarify,
            'todos': self.todos,
            'messages': self.messages,
            'pendingMutations': self.pendingMutations,
            'mutationLog': self.mutationLog,
            'status': self.status,
            'metadata': self.metadata,
            'totalInputTokens': self.totalInputTokens,
            'totalOutputTokens': self.totalOutputTokens,
            'totalCost': self.totalCost,
            'queuedUserMessages': self.queuedUserMessages,
        }

    @staticmethod
    def fromDict(d: dict[str, object]) -> WorkbenchSession:
        return WorkbenchSession(
            id=as_str(d.get('id', '')),
            title=as_str(d.get('title', 'New Session')),
            provider=as_str(d.get('provider', '')),
            model=as_str(d.get('model', '')),
            agentId=as_str(d.get('agentId', '')),
            guardMode=as_str(d.get('guardMode', 'full')),
            createdAt=as_str(d.get('createdAt', '')),
            updatedAt=as_str(d.get('updatedAt', '')),
            startedAt=as_str(d.get('startedAt', '')),
            messageCount=as_int(d.get('messageCount', 0)),
            mutationCount=as_int(d.get('mutationCount', 0)),
            workspacePath=as_str(d.get('workspacePath', '')),
            goal=as_str(d.get('goal', '')),
            plan=as_dict(d.get('plan')),
            planApproved=as_bool(d.get('planApproved', False)),
            clarify=as_dict(d.get('clarify')),
            todos=cast('list[dict[str, object]]', as_list(d.get('todos'))),
            messages=cast('list[dict[str, object]]', as_list(d.get('messages', []))),
            pendingMutations=cast('list[dict[str, object]]', as_list(d.get('pendingMutations', []))),
            mutationLog=cast('list[dict[str, object]]', as_list(d.get('mutationLog', []))),
            status=as_str(d.get('status', 'idle')),
            metadata=as_dict(d.get('metadata', {})),
            totalInputTokens=as_int(d.get('totalInputTokens', 0)),
            totalOutputTokens=as_int(d.get('totalOutputTokens', 0)),
            totalCost=as_float(d.get('totalCost', 0.0)),
            queuedUserMessages=cast('list[dict[str, object]]', as_list(d.get('queuedUserMessages', []))),
        )


# Single source of truth for in-memory store + status listeners
_sessions: dict[str, WorkbenchSession] = {}
_status_subscribers: list[Callable[[dict[str, object]], None]] = []

# camelCase aliases (same objects — tests / workbench re-exports)
_SESSIONFile = _SESSION_FILE
_statusSubscribers = _status_subscribers


def _sessions_path() -> Path:
    from app.lib.paths import dataPath

    return dataPath(_SESSION_FILE)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _load_sessions() -> None:
    """Load sessions from disk."""
    path = _sessions_path()
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text('utf-8'))
        for item in data:
            session = WorkbenchSession.fromDict(item)
            _sessions[session.id] = session
    except (json.JSONDecodeError, OSError):
        pass


def save_sessions() -> None:
    """Persist all sessions to disk (keeps last 50)."""
    sorted_sessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:50]
    path = _sessions_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, [s.toDict() for s in sorted_sessions], indent=2)


def _emit_session_status(session_id: str) -> None:
    """Notify status subscribers of a session status change."""
    session = _sessions.get(session_id)
    if not session:
        return
    event: dict[str, object] = {
        'type': 'session_status',
        'sessionId': session_id,
        'status': session.status,
        'guardMode': session.guardMode,
        'pendingMutations': len(session.pendingMutations) > 0,
    }
    for cb in _status_subscribers:
        try:
            cb(event)
        except Exception:
            pass


def create_workbench_session(
    provider: str = '',
    agentId: str = '',
    guardMode: str = '',
    task: str = '',
    goal: str = '',
) -> WorkbenchSession:
    """Create a new workbench session.

    Parameter names keep camelCase for call-site compatibility
    (``createWorkbenchSession(provider=..., agentId=..., guardMode=...)``).
    """
    # Lazy import avoids circular dependency (workbench imports sessions).
    from app.services.workbench.workbench import normalizeGuardMode

    _ = task  # accepted for signature parity with prior API
    session_id = f'wb_{uuid.uuid4().hex[:12]}'
    now = _now()
    session = WorkbenchSession(
        id=session_id,
        provider=provider,
        agentId=agentId,
        guardMode=normalizeGuardMode(guardMode or 'full'),
        goal=goal,
        createdAt=now,
        updatedAt=now,
        startedAt=now,
    )
    if goal:
        session.goal = goal
    _sessions[session_id] = session
    save_sessions()
    _emit_session_status(session_id)
    return session


def get_workbench_session(session_id: str | None) -> WorkbenchSession | None:
    """Get a session by ID. Returns None if not found."""
    if not session_id:
        return None
    if not _sessions:
        _load_sessions()
    return _sessions.get(session_id)


def set_workbench_session_agent(session_id: str, agent_id: str) -> WorkbenchSession | None:
    """Bind (or clear) an agent on a session so its context shapes the prompt."""
    session = get_workbench_session(session_id)
    if not session:
        return None
    session.agentId = agent_id or ''
    session.updatedAt = _now()
    save_sessions()
    _emit_session_status(session_id)
    return session


def list_workbench_sessions() -> list[dict[str, object]]:
    """Return all sessions summarized."""
    if not _sessions:
        _load_sessions()
    sorted_sessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)
    return [summarize_session(s) for s in sorted_sessions]


def delete_workbench_session(session_id: str) -> bool:
    """Delete a session."""
    if session_id not in _sessions:
        return False
    session = _sessions[session_id]
    try:
        from app.services import aug_artifact_service

        aug_artifact_service.deleteForSession(session.workspacePath or None, session_id)
    except Exception:
        pass
    del _sessions[session_id]
    save_sessions()
    return True


def reset_workbench_session(
    session_id: str, provider: str = '', agentId: str = ''
) -> WorkbenchSession | None:
    """Delete and recreate a session."""
    delete_workbench_session(session_id)
    return create_workbench_session(provider=provider, agentId=agentId)


def summarize_session(session: WorkbenchSession) -> dict[str, object]:
    """Return a lightweight summary of a session."""
    return {
        'id': session.id,
        'title': session.title,
        'provider': session.provider,
        'model': session.model,
        'agentId': session.agentId,
        'guardMode': session.guardMode,
        'goal': session.goal,
        'plan': session.plan is not None,
        'planApproved': session.planApproved,
        'messageCount': session.messageCount,
        'mutationCount': session.mutationCount,
        'status': session.status,
        'createdAt': session.createdAt,
        'updatedAt': session.updatedAt,
        'startedAt': session.startedAt,
        'workspacePath': session.workspacePath,
    }


def get_workbench_session_status(session_id: str) -> dict[str, object] | None:
    """Return flat status for the UI's approval banner."""
    session = _sessions.get(session_id)
    if not session:
        return None
    has_pending = len(session.pendingMutations) > 0
    return {
        'sessionId': session_id,
        'status': session.status,
        'guardMode': session.guardMode,
        'pendingMutation': session.pendingMutations[-1] if has_pending else None,
        'plan': session.plan,
        'planApproved': session.planApproved,
        'todos': session.todos,
    }


def subscribe_session_status(callback: Callable[[dict[str, object]], None]) -> Callable[[], None]:
    """Register a session status subscriber. Returns unsubscribe function."""
    _status_subscribers.append(callback)

    def unsubscribe() -> None:
        if callback in _status_subscribers:
            _status_subscribers.remove(callback)

    return unsubscribe


# ---------------------------------------------------------------------------
# camelCase aliases — public API stability for workbench re-exports / callers
# ---------------------------------------------------------------------------
_sessionsPath = _sessions_path
_loadSessions = _load_sessions
saveSessions = save_sessions
_emitSessionStatus = _emit_session_status
createWorkbenchSession = create_workbench_session
getWorkbenchSession = get_workbench_session
setWorkbenchSessionAgent = set_workbench_session_agent
listWorkbenchSessions = list_workbench_sessions
deleteWorkbenchSession = delete_workbench_session
resetWorkbenchSession = reset_workbench_session
summarizeSession = summarize_session
getWorkbenchSessionStatus = get_workbench_session_status
subscribeSessionStatus = subscribe_session_status
