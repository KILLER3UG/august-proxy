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
import threading
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
# Serialize full-file snapshots so concurrent chat tasks cannot interleave dumps.
_sessions_lock = threading.Lock()

# camelCase aliases (same objects — tests / workbench re-exports)
_SESSIONFile = _SESSION_FILE
_statusSubscribers = _status_subscribers


def _sessions_path() -> Path:
    from app.lib.paths import dataPath

    return dataPath(_SESSION_FILE)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _new_session_id(prefix: str = 'wb') -> str:
    """Build a human-readable session id with UTC date/time + short suffix.

    Example: ``wb_20260715_143052_a1b2c3`` — easy for models and humans to
    tell sessions apart when comparing memory, logs, or conv summaries.
    """
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    suffix = uuid.uuid4().hex[:6]
    return f'{prefix}_{stamp}_{suffix}'


def _default_session_title() -> str:
    """Default title stamped with UTC date/time until the first user message."""
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')
    return f'Chat {stamp} UTC'


def is_placeholder_title(title: str | None) -> bool:
    """True when the title is still a default/empty placeholder."""
    t = (title or '').strip()
    if not t:
        return True
    if t.lower() in ('new chat', 'new session', 'untitled', 'conversation started.'):
        return True
    # Date-stamped defaults: "Chat 2026-07-15 14:30" / "Chat 2026-07-15 14:30 UTC"
    if t.lower().startswith('chat ') and len(t) >= 15:
        rest = t[5:].strip()
        if rest[:4].isdigit() and '-' in rest[:12]:
            return True
    return False


def derive_title_from_message(text: str, *, max_len: int = 48) -> str:
    """Build a short sidebar title from the first user message."""
    cleaned = (text or '').replace('\r\n', '\n').strip()
    if not cleaned:
        return ''
    # Strip accidental role-prefixed dumps
    import re

    cleaned = re.sub(r'^(user|assistant|system)\s*:\s*', '', cleaned, flags=re.I)
    first = cleaned.split('\n', 1)[0].strip()
    first = re.split(r'\s+(?:user|assistant|system)\s*:\s*', first, maxsplit=1, flags=re.I)[0].strip()
    first = re.sub(r'\s+', ' ', first).strip()
    # Skip slash commands
    if re.match(r'^/[a-zA-Z]', first):
        return ''
    if len(first) < 2:
        return ''
    if len(first) > max_len:
        first = first[:max_len].rstrip() + '…'
    return first


def rename_workbench_session(session_id: str, title: str) -> WorkbenchSession | None:
    """Set a session title, persist, and push realtime update to the UI."""
    sid = (session_id or '').strip()
    new_title = (title or '').strip()
    if not sid or not new_title:
        return None
    if not _sessions:
        _load_sessions()
    session = _sessions.get(sid)
    if not session:
        return None
    session.title = new_title[:120]
    session.updatedAt = _now()
    try:
        save_sessions()
    except Exception:
        logger.exception('save_sessions failed after rename %s', sid)
    try:
        from app.services.realtime_bus import emit_realtime, emit_invalidate

        emit_realtime(
            'session.updated',
            sessionId=sid,
            title=session.title,
            messageCount=session.messageCount,
            provider=session.provider,
            model=session.model,
            guardMode=session.guardMode,
        )
        emit_invalidate('workbench-session', session_id=sid)
    except Exception:
        pass
    _emit_session_status(sid)
    return session


def migrate_json_sessions_to_sqlite(*, force: bool = False) -> dict[str, object]:
    """One-shot JSON → SQLite import. Idempotent; renames source after success.

    Long-term: SQLite is SoT. The JSON file is import-once then ``.migrated``.
    Returns a status dict for smoke / admin.
    """
    path = _sessions_path()
    result: dict[str, object] = {
        'ok': True,
        'imported': 0,
        'skipped': False,
        'source': str(path),
        'message': '',
    }
    if not path.exists():
        result['message'] = 'no workbench-sessions.json'
        result['skipped'] = True
        return result
    try:
        from app.services import memory_store
        from app.services.memory_store import list_workbench_blobs, save_workbench_session_sot

        memory_store.init()
        existing = list_workbench_blobs(limit=5)
        if existing and not force:
            result['skipped'] = True
            result['message'] = 'sqlite already has sessions; leave JSON as optional export'
            return result
        data = json.loads(path.read_text('utf-8'))
        if not isinstance(data, list):
            result['ok'] = False
            result['message'] = 'JSON root is not a list'
            return result
        imported = 0
        for item in data:
            if not isinstance(item, dict):
                continue
            session = WorkbenchSession.fromDict(item)
            if not session.id:
                continue
            _sessions[session.id] = session
            save_workbench_session_sot(session.toDict())
            imported += 1
        result['imported'] = imported
        # Retire the import file so it is never re-read as a second SoT.
        migrated = path.with_suffix(path.suffix + '.migrated')
        try:
            if migrated.exists():
                migrated.unlink()
            path.rename(migrated)
            result['retiredTo'] = str(migrated)
        except OSError as exc:
            result['retireError'] = str(exc)
        result['message'] = f'imported {imported} session(s) into SQLite'
        logger.info('Migrated %d sessions from JSON into SQLite (retired source file)', imported)
        return result
    except (json.JSONDecodeError, OSError, Exception) as exc:
        logger.exception('JSON→SQLite session migration failed')
        result['ok'] = False
        result['message'] = str(exc)
        return result


def _load_sessions() -> None:
    """Load sessions from SQLite first; one-shot JSON migrate if SQLite empty."""
    try:
        from app.services import memory_store
        from app.services.memory_store import list_workbench_blobs

        memory_store.init()
        blobs = list_workbench_blobs(limit=200)
        for item in blobs:
            session = WorkbenchSession.fromDict(item)
            if session.id:
                _sessions[session.id] = session
        if _sessions:
            return
    except Exception:
        logger.exception('SQLite session load failed; trying JSON fallback')

    # Older installs: import workbench-sessions.json into SQLite once, then retire file.
    migrate_json_sessions_to_sqlite(force=False)


def is_session_json_export_enabled() -> bool:
    """Whether continuous JSON backup export is on (env overrides config).

    SoT remains SQLite either way. Enable via:
      * env ``AUGUST_SESSION_JSON_EXPORT=1`` (highest priority when set)
      * config ``auxiliary.session_json_export.enabled``
    """
    import os

    env = os.environ.get('AUGUST_SESSION_JSON_EXPORT')
    if env is not None and str(env).strip() != '':
        return str(env).strip().lower() in ('1', 'true', 'yes', 'on')
    try:
        from app.services import config_service

        cfg = config_service.getConfig()
        aux = cfg.get('auxiliary') if isinstance(cfg.get('auxiliary'), dict) else {}
        assert isinstance(aux, dict)
        block = aux.get('session_json_export') if isinstance(aux.get('session_json_export'), dict) else {}
        assert isinstance(block, dict)
        return bool(block.get('enabled', False))
    except Exception:
        return False


def set_session_json_export_enabled(enabled: bool) -> dict[str, object]:
    """Persist admin toggle under ``auxiliary.session_json_export.enabled``."""
    from app.services import config_service

    cfg = config_service.getConfig()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    block = aux.get('session_json_export')
    if not isinstance(block, dict):
        block = {}
        aux['session_json_export'] = block
    block['enabled'] = bool(enabled)
    config_service.saveConfig(cfg)
    return get_session_json_export_status()


def get_session_json_export_status() -> dict[str, object]:
    """Public status for admin UI / API."""
    import os

    env_raw = os.environ.get('AUGUST_SESSION_JSON_EXPORT')
    env_overrides = env_raw is not None and str(env_raw).strip() != ''
    enabled = is_session_json_export_enabled()
    path = _sessions_path()
    return {
        'enabled': enabled,
        'envOverrides': env_overrides,
        'source': 'env' if env_overrides else 'config',
        'path': str(path),
        'fileExists': path.exists(),
        'note': 'SQLite remains the session source of truth; JSON is backup export only.',
    }


def save_sessions() -> None:
    """Persist sessions to SQLite (full blob + messages). Keeps last 50.

    JSON export is **off by default**. Enable via admin config
    ``auxiliary.session_json_export.enabled`` or env ``AUGUST_SESSION_JSON_EXPORT=1``.
    JSON is never the SoT.
    """
    with _sessions_lock:
        sorted_sessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:50]
        keep_ids = {s.id for s in sorted_sessions}
        for sid in list(_sessions.keys()):
            if sid not in keep_ids:
                del _sessions[sid]

        try:
            from app.services import memory_store
            from app.services.memory_store import save_workbench_session_sot

            memory_store.init()
            for s in sorted_sessions:
                save_workbench_session_sot(s.toDict())
        except Exception:
            logger.exception('SQLite session write failed')

        if is_session_json_export_enabled():
            try:
                path = _sessions_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                write_json_atomic(path, [s.toDict() for s in sorted_sessions], indent=2)
            except Exception:
                logger.exception('JSON session export failed (non-fatal; SQLite is primary)')


def export_sessions_json() -> Path:
    """Admin one-shot: write workbench-sessions.json from current SQLite/in-memory SoT."""
    with _sessions_lock:
        if not _sessions:
            _load_sessions()
        sorted_sessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:50]
        path = _sessions_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(path, [s.toDict() for s in sorted_sessions], indent=2)
        return path


def reload_sessions_from_sot() -> int:
    """Clear in-memory cache and reload from SQLite only (no JSON). For smoke/tests."""
    _sessions.clear()
    try:
        from app.services import memory_store
        from app.services.memory_store import list_workbench_blobs

        memory_store.init()
        blobs = list_workbench_blobs(limit=200)
        for item in blobs:
            session = WorkbenchSession.fromDict(item)
            if session.id:
                _sessions[session.id] = session
    except Exception:
        logger.exception('reload_sessions_from_sot failed')
    return len(_sessions)


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
    # Instant UI push (approval banner, sidebar pulse, plan gate, etc.)
    try:
        from app.services.realtime_bus import emit_realtime, emit_invalidate

        emit_realtime(
            'session.status',
            sessionId=session_id,
            status=session.status,
            guardMode=session.guardMode,
            pendingMutations=len(session.pendingMutations) > 0,
            plan=session.plan is not None,
            planApproved=session.planApproved,
            messageCount=session.messageCount,
            title=session.title,
            provider=session.provider,
            model=session.model,
        )
        emit_invalidate('session-status', 'workbench-session', session_id=session_id)
    except Exception:
        pass


def notify_session_deleted(session_id: str) -> None:
    """Fan out a real-time session-deleted event so the UI can drop the row
    immediately (tool deletes, API deletes, cascade) without waiting on poll.
    """
    if not session_id:
        return
    event: dict[str, object] = {
        'type': 'session_deleted',
        'sessionId': session_id,
    }
    for cb in list(_status_subscribers):
        try:
            cb(event)
        except Exception:
            pass
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='session',
            layer='workbench',
            summary=f'Session deleted: {session_id}',
            meta={'action': 'deleted', 'sessionId': session_id},
        )
    except Exception:
        pass
    try:
        from app.services.realtime_bus import emit_realtime

        emit_realtime('session.deleted', sessionId=session_id)
    except Exception:
        pass


def notify_session_created(session: WorkbenchSession) -> None:
    """Push a new session to connected frontends immediately."""
    if not session or not session.id:
        return
    try:
        from app.services.realtime_bus import emit_realtime

        emit_realtime(
            'session.created',
            sessionId=session.id,
            title=session.title,
            provider=session.provider,
            model=session.model,
            agentId=session.agentId,
            guardMode=session.guardMode,
            messageCount=session.messageCount,
            createdAt=session.createdAt,
            updatedAt=session.updatedAt,
            startedAt=session.startedAt,
            workspacePath=session.workspacePath,
        )
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
    session_id = _new_session_id('wb')
    now = _now()
    session = WorkbenchSession(
        id=session_id,
        title=_default_session_title(),
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
    # save_sessions() already writes SQLite (blob + messages).
    if session.workspacePath:
        try:
            from app.services.cognitive_boot import attach_session_watcher

            attach_session_watcher(session_id, session.workspacePath)
        except Exception:
            pass
    _emit_session_status(session_id)
    notify_session_created(session)
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
    """Delete a session from memory, SQLite, and the JSON export file.

    Always attempts brain SQLite cascade (messages, timeline, …) even when the
    session is not currently loaded in memory — otherwise orphan child rows
    (and FK failures on partial deletes) linger after tool/UI cleanup.

    Emits ``session_deleted`` *as soon as* the in-memory entry is gone so the
    frontend can animate the row out before the slower SQLite cascade finishes.
    """
    if not session_id:
        return False
    if not _sessions:
        _load_sessions()
    session = _sessions.get(session_id)
    found_in_memory = session is not None
    workspace = session.workspacePath if session else ''

    # Drop from RAM + notify UI first (real-time), cascade SQLite after.
    if session_id in _sessions:
        del _sessions[session_id]
        found_in_memory = True
    if found_in_memory:
        notify_session_deleted(session_id)
        try:
            path = _sessions_path()
            remaining = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:50]
            write_json_atomic(path, [s.toDict() for s in remaining], indent=2)
        except Exception:
            pass

    try:
        from app.services import aug_artifact_service

        aug_artifact_service.deleteForSession(workspace or None, session_id)
    except Exception:
        pass
    cascade_ok = False
    try:
        from app.services.memory_store import delete_session_cascade

        # Cascade deletes messages / timeline / usage / … before the session row
        # (messages.session_id FK is NO ACTION — children must go first).
        # notify=False: we already emitted above when the session was in memory;
        # cascade will notify if this was a brain-only orphan row.
        result = delete_session_cascade(session_id, notify=not found_in_memory)
        cascade_ok = bool(result.get('ok'))
    except Exception:
        logger.exception('SQLite session delete failed for %s', session_id)
    return found_in_memory or cascade_ok


def reset_workbench_session(
    session_id: str, provider: str = '', agentId: str = ''
) -> WorkbenchSession | None:
    """Delete and recreate a session."""
    delete_workbench_session(session_id)
    return create_workbench_session(provider=provider, agentId=agentId)


def undo_last_turn(session_id: str) -> dict[str, object] | None:
    """Remove the last user turn and everything after it (assistant/tools).

    Mirrors the chat UI \"revert\" action so workbench history stays in sync.
    """
    session = get_workbench_session(session_id)
    if not session:
        return None
    msgs = list(session.messages)
    last_user = -1
    for i in range(len(msgs) - 1, -1, -1):
        if as_str(msgs[i].get('role')) == 'user':
            last_user = i
            break
    if last_user < 0:
        return {
            'session': session.toDict(),
            'removed': 0,
            'message': 'Nothing to undo — no user messages yet.',
        }
    removed = len(msgs) - last_user
    session.messages = msgs[:last_user]
    session.messageCount = len(session.messages)
    session.updatedAt = _now()
    # Clear in-flight plan/clarify that belonged to the undone turn.
    session.plan = None
    session.planApproved = False
    session.clarify = None
    session.queuedUserMessages = []
    save_sessions()
    _emit_session_status(session_id)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=session_id, action='undo_last_turn')
        emit_invalidate('workbench-session', 'session-status', session_id=session_id)
    except Exception:
        pass
    return {
        'session': session.toDict(),
        'removed': removed,
        'message': f'Removed {removed} message(s) from the end of the conversation.',
    }


def branch_workbench_session(
    session_id: str,
    *,
    up_to_index: int | None = None,
) -> WorkbenchSession | None:
    """Clone a session (optionally only messages through ``up_to_index`` inclusive)."""
    src = get_workbench_session(session_id)
    if not src:
        return None
    msgs = list(src.messages)
    if up_to_index is not None:
        if up_to_index < 0:
            msgs = []
        else:
            msgs = msgs[: up_to_index + 1]
    new = create_workbench_session(
        provider=src.provider,
        agentId=src.agentId,
        guardMode=src.guardMode,
        goal=src.goal,
    )
    new.messages = [dict(m) for m in msgs if isinstance(m, dict)]
    new.messageCount = len(new.messages)
    new.model = src.model
    new.workspacePath = src.workspacePath
    base_title = (src.title or 'Chat').strip() or 'Chat'
    if base_title.endswith(' (branch)'):
        new.title = base_title
    else:
        new.title = f'{base_title} (branch)'[:120]
    # Do not copy pending plan/mutations — branch is a clean fork of history.
    new.plan = None
    new.planApproved = False
    new.todos = list(src.todos) if src.todos else None
    new.updatedAt = _now()
    _sessions[new.id] = new
    save_sessions()
    notify_session_created(new)
    _emit_session_status(new.id)
    return new


def compact_workbench_session_now(session_id: str) -> dict[str, object] | None:
    """Force context compression on a session (user-triggered \"Free up memory\")."""
    session = get_workbench_session(session_id)
    if not session:
        return None
    from app.providers.clients.base import estimateTokens
    from app.services.memory.context_compressor import compressMessages

    original = list(session.messages)
    original_tokens = estimateTokens(original)
    if len(original) < 6:
        return {
            'session': session.toDict(),
            'underThreshold': True,
            'originalTokens': original_tokens,
            'compressedTokens': original_tokens,
            'compressedCount': 0,
            'headCount': 4,
            'tailCount': 6,
            'message': 'Not enough messages to compress yet.',
        }
    # threshold=0 forces compression whenever head+tail leave a middle section
    compressed = compressMessages(original, threshold=0, head_count=4, tail_count=6)
    compressed_tokens = estimateTokens(compressed)
    compressed_count = max(0, len(original) - len(compressed))
    if compressed_count <= 0 or compressed_tokens >= original_tokens:
        return {
            'session': session.toDict(),
            'underThreshold': True,
            'originalTokens': original_tokens,
            'compressedTokens': compressed_tokens,
            'compressedCount': 0,
            'headCount': 4,
            'tailCount': 6,
            'message': 'Context is already compact enough.',
        }
    session.messages = compressed
    session.messageCount = len(session.messages)
    session.updatedAt = _now()
    session._last_compaction_turn = getattr(session, 'turn_count', 0) or 0
    save_sessions()
    _emit_session_status(session_id)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=session_id, action='compact')
        emit_invalidate('workbench-session', 'session-status', session_id=session_id)
    except Exception:
        pass
    return {
        'session': session.toDict(),
        'underThreshold': False,
        'originalTokens': original_tokens,
        'compressedTokens': compressed_tokens,
        'compressedCount': compressed_count,
        'headCount': 4,
        'tailCount': 6,
        'message': (
            f'Freed chat memory — summarized {compressed_count} middle messages '
            f'(~{original_tokens} → ~{compressed_tokens} tokens).'
        ),
    }


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
        # Lazy-load from disk so status works after restart
        if not _sessions:
            _load_sessions()
        session = _sessions.get(session_id)
    if not session:
        return None
    has_pending = len(session.pendingMutations) > 0
    pm = session.pendingMutations[-1] if has_pending else None
    pm_dict = as_dict(pm) if pm is not None else {}
    return {
        'sessionId': session_id,
        'status': session.status,
        'guardMode': session.guardMode,
        # Flat fields used by ApprovalBanner / useSessionStatus
        'pendingToken': as_str(pm_dict.get('token')) or None,
        'pendingTool': as_str(pm_dict.get('toolName')) or None,
        'pendingArgs': as_dict(pm_dict.get('args')) if pm_dict.get('args') is not None else None,
        'pendingPreview': as_str(pm_dict.get('preview')) or None,
        'pendingCreatedAt': pm_dict.get('createdAt'),
        'approved': bool(session.planApproved),
        'updatedAt': session.updatedAt,
        # Nested blob kept for older clients
        'pendingMutation': pm if has_pending else None,
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
undoLastTurn = undo_last_turn
branchWorkbenchSession = branch_workbench_session
compactWorkbenchSessionNow = compact_workbench_session_now
summarizeSession = summarize_session
getWorkbenchSessionStatus = get_workbench_session_status
subscribeSessionStatus = subscribe_session_status
