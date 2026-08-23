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
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Callable, cast

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_bool, as_dict, as_float, as_int, as_list, as_str

if TYPE_CHECKING:
    import asyncio

    from app.services.workbench.tool_guardrails import ToolCallTracker

logger = logging.getLogger('workbench.sessions')

_SESSION_FILE = 'workbench-sessions.json'


def _optional_dict(value: object) -> dict[str, object] | None:
    """Narrow optional dict fields; None/empty → None (never {})."""
    if not isinstance(value, dict) or not value:
        return None
    return value


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
    # Codex-like sandbox axis (orthogonal to Plan/Ask/Full).
    sandboxMode: str = 'workspace-write'
    sandboxNetwork: bool = False
    # Opt-in final-answer gate: while true, finalOutput text is withheld until
    # update_state(phase='complete') passes the verifier gate (see the
    # _verifier_gated_emit wrapper in the workbench chat loop).
    verifierEnforced: bool = False
    # Optional per-session spend ceiling (USD). 0 = off. When the estimated
    # cumulative session cost reaches the ceiling, new turns are blocked with
    # a clear error until the user raises it or starts a new chat.
    costCeiling: float = 0.0
    # Agent mode: '' | 'chat' (text only, tools blocked) | 'agent' (native tool
    # calling) | 'code' (fenced python blocks via the code runner).
    agent_mode: str = ''
    # Unattended runs (automation-triggered workbench jobs) skip the memory-
    # extraction side effects (background review, auto-memory sync, diff
    # learning) for leaner headless execution.
    headless: bool = False
    createdAt: str = ''
    updatedAt: str = ''
    startedAt: str = ''
    messageCount: int = 0
    mutationCount: int = 0
    turnCount: int = 0
    workspacePath: str = ''
    goal: str = ''
    plan: dict[str, object] | None = None
    planApproved: bool = False
    planRisk: str = ''
    clarify: dict[str, object] | None = None
    todos: list[dict[str, object]] | None = None
    messages: list[dict[str, object]] = field(default_factory=list)
    pendingMutations: list[dict[str, object]] = field(default_factory=list)
    mutationLog: list[dict[str, object]] = field(default_factory=list)
    status: str = 'idle'
    metadata: dict[str, object] = field(default_factory=dict)
    totalInputTokens: int = 0
    totalOutputTokens: int = 0
    # Universal prompt-cache split accumulated across turns (context ring).
    cacheHitTokens: int = 0
    cacheMissTokens: int = 0
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
    # True when this turn's model was chosen by the evidence-driven auto-
    # router (surpass #1) — the turn's routing_evidence row is then tagged
    # source='auto-route' so the decision is measurable. Reset per turn.
    _auto_routed: bool = False
    # Auto-memories that getRelevantMemories() prefetched into the last
    # buildSystemPrompt() call — surfaced to the frontend as a `recalledMemories`
    # SSE event (see workbench.chatTurn). Cleared/replaced every turn.
    _last_recalled_memories: list[dict[str, object]] | None = None
    # Verifier gate receipts: tails of command tool outputs executed this turn.
    # update_state requires a passing receipt before allowing review/complete
    # (see system_tools._updateState). Cleared every turn in chatTurn.
    _verification_receipts: list[dict[str, object]] | None = None
    # What the last buildSystemPrompt() call injected (profile, heuristics,
    # recalled memories, ...) — carried into the per-turn `done` event and the
    # chat context panel. Set/cleared every turn in buildSystemPrompt.
    _last_context_snapshot: dict[str, object] | None = None

    def toDict(self) -> dict[str, object]:
        return {
            'id': self.id,
            'title': self.title,
            'provider': self.provider,
            'model': self.model,
            'agentId': self.agentId,
            'guardMode': self.guardMode,
            'sandboxMode': self.sandboxMode,
            'sandboxNetwork': self.sandboxNetwork,
            'verifierEnforced': self.verifierEnforced,
            'costCeiling': self.costCeiling,
            'createdAt': self.createdAt,
            'updatedAt': self.updatedAt,
            'startedAt': self.startedAt,
            'messageCount': self.messageCount,
            'mutationCount': self.mutationCount,
            'workspacePath': self.workspacePath,
            'goal': self.goal,
            # Never serialize empty {} as a plan — UI treats truthy plan as pending.
            'plan': self.plan if self.plan else None,
            'planApproved': self.planApproved,
            'clarify': self.clarify if self.clarify else None,
            'todos': self.todos,
            'messages': self.messages,
            'pendingMutations': self.pendingMutations,
            'mutationLog': self.mutationLog,
            'status': self.status,
            'metadata': self.metadata,
            # Agent mode + turn counter survive restarts (set_agent_mode is a
            # session-level behavior switch; a restart must not silently
            # re-enable tools in a chat-mode session).
            'agentMode': self.agent_mode,
            'headless': self.headless,
            'turnCount': self.turnCount,
            'totalInputTokens': self.totalInputTokens,
            'totalOutputTokens': self.totalOutputTokens,
            'totalCost': self.totalCost,
            'queuedUserMessages': self.queuedUserMessages,
            'lastCommand': (
                self.metadata.get('lastCommand')
                if isinstance(self.metadata.get('lastCommand'), dict)
                else None
            ),
            'lastReceipt': (
                self.metadata.get('lastReceipt')
                if isinstance(self.metadata.get('lastReceipt'), dict)
                else None
            ),
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
            sandboxMode=as_str(d.get('sandboxMode', 'workspace-write') or 'workspace-write'),
            sandboxNetwork=as_bool(d.get('sandboxNetwork', False)),
            verifierEnforced=as_bool(d.get('verifierEnforced', False)),
            costCeiling=as_float(d.get('costCeiling', 0.0)),
            createdAt=as_str(d.get('createdAt', '')),
            updatedAt=as_str(d.get('updatedAt', '')),
            startedAt=as_str(d.get('startedAt', '')),
            messageCount=as_int(d.get('messageCount', 0)),
            mutationCount=as_int(d.get('mutationCount', 0)),
            workspacePath=as_str(d.get('workspacePath', '')),
            goal=as_str(d.get('goal', '')),
            # Preserve None for optional payloads. as_dict(None) → {} which is
            # truthy in the UI and falsely triggers the plan banner.
            plan=_optional_dict(d.get('plan')),
            planApproved=as_bool(d.get('planApproved', False)),
            clarify=_optional_dict(d.get('clarify')),
            todos=cast('list[dict[str, object]]', as_list(d.get('todos'))),
            messages=cast('list[dict[str, object]]', as_list(d.get('messages', []))),
            pendingMutations=cast('list[dict[str, object]]', as_list(d.get('pendingMutations', []))),
            mutationLog=cast('list[dict[str, object]]', as_list(d.get('mutationLog', []))),
            status=as_str(d.get('status', 'idle')),
            metadata=as_dict(d.get('metadata', {})),
            agent_mode=as_str(d.get('agentMode', '')),
            headless=as_bool(d.get('headless', False)),
            turnCount=as_int(d.get('turnCount', 0)),
            totalInputTokens=as_int(d.get('totalInputTokens', 0)),
            totalOutputTokens=as_int(d.get('totalOutputTokens', 0)),
            totalCost=as_float(d.get('totalCost', 0.0)),
            queuedUserMessages=cast('list[dict[str, object]]', as_list(d.get('queuedUserMessages', []))),
        )


# Single source of truth for in-memory store + status listeners
_sessions: dict[str, WorkbenchSession] = {}
# RAM pass 0.16.8: recency window for the in-memory session cache. Each
# WorkbenchSession holds its full message array — 200 cached sessions of
# long agent chats cost hundreds of MB. 60 hot sessions is ample (the UI
# shows far fewer at once) and SQLite reloads evicted ones transparently.
_SESSION_WINDOW = 60
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


_PLACEHOLDER_CHAT_TITLE = re.compile(
    r'^Chat \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: UTC)?$',
    re.IGNORECASE,
)


def is_placeholder_title(title: str | None) -> bool:
    """True when the title is still a default/empty placeholder."""
    t = (title or '').strip()
    if not t:
        return True
    if t.lower() in ('new chat', 'new session', 'untitled', 'conversation started.'):
        return True
    # Date-stamped defaults from `_default_session_title`:
    # "Chat 2026-07-15 14:30" / "Chat 2026-07-15 14:30 UTC"
    if _PLACEHOLDER_CHAT_TITLE.match(t):
        return True
    return False


def derive_title_from_message(text: str, *, max_len: int = 48) -> str:
    """Build a short sidebar title from the first user message."""
    cleaned = (text or '').replace('\r\n', '\n').strip()
    if not cleaned:
        return ''
    # Strip accidental role-prefixed dumps
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
        save_sessions(immediate=True)
    except Exception:
        logger.exception('save_sessions failed after rename %s', sid)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

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
        blobs = list_workbench_blobs(limit=_SESSION_WINDOW)
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


# Debounce concurrent chat turns so SQLite snapshots do not stall the asyncio
# event loop (and both SSE streams) under `_sessions_lock`.
_SAVE_DEBOUNCE_S = 0.15
_save_pending = False
_save_timer: threading.Timer | None = None
_save_thread_lock = threading.Lock()
_persist_io_lock = threading.Lock()
# Optional external probe "is this session mid-turn?" — routers/workbench.py
# registers it so the snapshot prune never evicts a session whose chat turn
# is still writing to the in-memory object.
_active_turn_check: Callable[[str], bool] | None = None
# Sessions touched within this window of the snapshot time are never pruned
# (conservative fallback when no active-turn probe is registered).
_PRUNE_RECENT_SKIP_S = 60.0


def set_active_turn_check(check: Callable[[str], bool] | None) -> None:
    """Register (or clear) the in-flight-turn probe used by the snapshot prune.

    routers/workbench.py owns the live-turn task map; it registers a probe so
    the prune in ``_persist_sessions_snapshot`` never evicts a session whose
    chat turn is still writing messages (audit finding — pruned sessions'
    newest messages never persisted).
    """
    global _active_turn_check
    _active_turn_check = check


def _session_has_active_turn(session_id: str) -> bool:
    check = _active_turn_check
    if check is None:
        return False
    try:
        return bool(check(session_id))
    except Exception:
        return False


def _persist_sessions_snapshot() -> None:
    """Take a snapshot and write SQLite/JSON under one persist lock.

    The snapshot AND the write share ``_persist_io_lock`` so two overlapping
    saves (a debounce fire racing an immediate save) can never interleave: the
    last save to acquire the lock writes the newest snapshot, and a stale
    snapshot can no longer overwrite newer data (audit finding). The
    ``_sessions_lock`` is still only held for the in-memory copy so concurrent
    chat turns are not stalled across I/O.

    The in-memory map is a recency window (60, RAM pass 0.16.8 — was 200;
    each cached WorkbenchSession carries its full message array, so 200
    long-running sessions cost hundreds of MB on big installs). SQLite stays
    the source of truth and ``list_workbench_sessions`` merges sessions beyond
    the window so they never silently disappear from the UI; a pruned session
    is transparently reloaded from SQLite on next access.
    """
    with _persist_io_lock:
        with _sessions_lock:
            sorted_sessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:_SESSION_WINDOW]
            keep_ids = {s.id for s in sorted_sessions}
            snapshot_time = datetime.now(timezone.utc)
            for sid in list(_sessions.keys()):
                if sid in keep_ids:
                    continue
                s = _sessions.get(sid)
                if s is None:
                    continue
                # Never prune a session whose turn is still in flight — the
                # turn loop holds a reference to an object that would be
                # removed from the store, so its newest messages would never
                # persist.
                if _session_has_active_turn(sid):
                    continue
                # Conservative fallback: skip sessions touched near the
                # snapshot time even without an active-turn probe.
                try:
                    updated = datetime.fromisoformat(as_str(s.updatedAt).replace('Z', '+00:00'))
                    if (snapshot_time - updated).total_seconds() < _PRUNE_RECENT_SKIP_S:
                        continue
                except Exception:
                    pass
                del _sessions[sid]
            snapshots = [s.toDict() for s in sorted_sessions]
            export_json = is_session_json_export_enabled()

        try:
            from app.services import memory_store
            from app.services.memory_store import save_workbench_session_sot

            memory_store.init()
            for blob in snapshots:
                save_workbench_session_sot(blob)
        except Exception:
            logger.exception('SQLite session write failed')

        if export_json:
            try:
                path = _sessions_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                write_json_atomic(path, snapshots, indent=2)
            except Exception:
                logger.exception('JSON session export failed (non-fatal; SQLite is primary)')

def save_sessions_now() -> None:
    """Persist immediately (create/delete/rename/shutdown/tests).

    Safe to call from any thread/context: it cancels any pending debounce
    timer and writes the current snapshot under ``_persist_io_lock``, so a
    racing debounce fire can never overwrite the newer data afterwards.
    """
    global _save_pending, _save_timer
    with _save_thread_lock:
        _save_pending = False
        timer = _save_timer
        _save_timer = None
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass
    _persist_sessions_snapshot()


def flush_pending_saves() -> None:
    """Flush any in-flight debounced save (lifespan teardown path).

    Idempotent and thread-safe: cancels the pending debounce timer and
    persists the latest snapshot when a debounced save was still queued.
    Safe to call from anywhere (no-op when nothing is pending).
    """
    global _save_pending, _save_timer
    with _save_thread_lock:
        pending = _save_pending
        timer = _save_timer
        _save_timer = None
        _save_pending = False
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass
    if pending:
        try:
            _persist_sessions_snapshot()
        except Exception:
            logger.exception('flush_pending_saves failed')


def save_sessions(*, immediate: bool = False) -> None:
    """Persist sessions to SQLite (full blob + messages). Keeps last 50.

    Default path is **debounced** and runs the snapshot write on a daemon
    thread so concurrent chat turns do not block the asyncio event loop.
    Pass ``immediate=True`` (or call ``save_sessions_now``) when the caller
    must observe the write before returning.

    JSON export is **off by default**. Enable via admin config
    ``auxiliary.session_json_export.enabled`` or env ``AUGUST_SESSION_JSON_EXPORT=1``.
    JSON is never the SoT.
    """
    if immediate:
        save_sessions_now()
        return

    global _save_pending, _save_timer

    def _fire() -> None:
        global _save_timer, _save_pending
        with _save_thread_lock:
            _save_timer = None
            if not _save_pending:
                return
            _save_pending = False
        try:
            _persist_sessions_snapshot()
        except Exception:
            logger.exception('debounced save_sessions failed')

    with _save_thread_lock:
        _save_pending = True
        if _save_timer is not None:
            return
        timer = threading.Timer(_SAVE_DEBOUNCE_S, _fire)
        timer.daemon = True
        _save_timer = timer
        timer.start()

def export_sessions_json() -> Path:
    """Admin one-shot: write workbench-sessions.json from current SQLite/in-memory SoT."""
    with _sessions_lock:
        if not _sessions:
            _load_sessions()
        sorted_sessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:_SESSION_WINDOW]
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
        blobs = list_workbench_blobs(limit=_SESSION_WINDOW)
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
        'sandboxMode': getattr(session, 'sandboxMode', 'workspace-write'),
        'sandboxNetwork': bool(getattr(session, 'sandboxNetwork', False)),
        'verifierEnforced': bool(getattr(session, 'verifierEnforced', False)),
        'pendingMutations': len(session.pendingMutations) > 0,
    }
    for cb in _status_subscribers:
        try:
            cb(event)
        except Exception:
            pass
    # Instant UI push (approval banner, sidebar pulse, plan gate, etc.)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime(
            'session.status',
            sessionId=session_id,
            status=session.status,
            guardMode=session.guardMode,
            sandboxMode=getattr(session, 'sandboxMode', 'workspace-write'),
            sandboxNetwork=bool(getattr(session, 'sandboxNetwork', False)),
            verifierEnforced=bool(getattr(session, 'verifierEnforced', False)),
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
    workspacePath: str = '',
    sandboxMode: str = '',
    sandboxNetwork: bool | None = None,
    verifierEnforced: bool | None = None,
    headless: bool = False,
) -> WorkbenchSession:
    """Create a new workbench session.

    Parameter names keep camelCase for call-site compatibility
    (``createWorkbenchSession(provider=..., agentId=..., guardMode=...)``).

    ``headless`` marks unattended runs (automation-triggered workbench jobs):
    the turn skips memory-extraction side effects (background review,
    auto-memory sync, diff learning).
    """
    # Lazy import avoids circular dependency (workbench imports sessions).
    from app.services.workbench.workbench import normalizeGuardMode

    _ = task  # accepted for signature parity with prior API
    session_id = _new_session_id('wb')
    now = _now()
    from app.services.sandbox import DEFAULT_SANDBOX_MODE, normalize_sandbox_mode

    session = WorkbenchSession(
        id=session_id,
        title=_default_session_title(),
        provider=provider,
        agentId=agentId,
        guardMode=normalizeGuardMode(guardMode or 'full'),
        sandboxMode=normalize_sandbox_mode(sandboxMode or DEFAULT_SANDBOX_MODE),
        sandboxNetwork=bool(sandboxNetwork) if sandboxNetwork is not None else False,
        verifierEnforced=bool(verifierEnforced) if verifierEnforced is not None else False,
        workspacePath=str(workspacePath or ''),
        goal=goal,
        createdAt=now,
        updatedAt=now,
        startedAt=now,
        headless=bool(headless),
    )
    if goal:
        session.goal = goal
    _sessions[session_id] = session
    save_sessions(immediate=True)
    # save_sessions() already writes SQLite (blob + messages).
    if session.workspacePath:
        try:
            from app.services.cognitive_boot import attach_session_watcher

            attach_session_watcher(session_id, session.workspacePath)
        except Exception:
            pass
        try:
            from app.services.memory.cross_session_context import upsert_active_project

            upsert_active_project(path=session.workspacePath, kind='workspace')
        except Exception:
            pass
    if task and str(task).startswith('Automation:'):
        session.title = str(task)[:120]
    _emit_session_status(session_id)
    notify_session_created(session)
    try:
        from app.services.hooks.lifecycle import fire_session_start

        fire_session_start(session_id)
    except Exception:
        pass
    return session


def get_workbench_session(session_id: str | None) -> WorkbenchSession | None:
    """Get a session by ID. Returns None if not found.

    When the id is missing from the in-memory map (the debounced snapshot
    prunes it to the recency window — 60 as of the 0.16.8 RAM pass), reload
    it from SQLite so replying resumes the ORIGINAL conversation instead of
    silently creating a new session (audit finding).
    """
    if not session_id:
        return None
    if not _sessions:
        _load_sessions()
    session = _sessions.get(session_id)
    if session is not None:
        return session
    try:
        from app.services.memory_store import get_workbench_blob

        blob = get_workbench_blob(session_id)
        if not blob:
            return None
        restored = WorkbenchSession.fromDict(blob)
        if restored.id:
            _sessions[restored.id] = restored
            return restored
    except Exception:
        logger.debug('workbench session reload from SQLite failed', exc_info=True)
    return None


def set_workbench_session_agent(session_id: str, agent_id: str) -> WorkbenchSession | None:
    """Bind (or clear) an agent on a session so its context shapes the prompt."""
    session = get_workbench_session(session_id)
    if not session:
        return None
    session.agentId = agent_id or ''
    session.updatedAt = _now()
    save_sessions(immediate=True)
    _emit_session_status(session_id)
    return session


def list_workbench_sessions() -> list[dict[str, object]]:
    """Return all sessions summarized (memory ∪ SQLite, newest first).

    SQLite is the source of truth and the in-memory map is only a recency
    window — sessions beyond it must still surface in the list (a hard
    in-memory cap used to silently hide older chats from the UI).
    """
    if not _sessions:
        _load_sessions()
    merged: dict[str, WorkbenchSession] = dict(_sessions)
    try:
        from app.services import memory_store

        blobs = memory_store.list_workbench_blobs(limit=500)
        for blob in blobs:
            session = WorkbenchSession.fromDict(blob)
            if session.id and session.id not in merged:
                merged[session.id] = session
    except Exception:
        logger.debug('SQLite session list failed; memory only', exc_info=True)
    sorted_sessions = sorted(merged.values(), key=lambda s: s.updatedAt, reverse=True)
    return [summarize_session(s) for s in sorted_sessions]


def cancel_session_work(session_id: str) -> None:
    """Cancel in-flight work bound to a session that is being deleted.

    Covers the service-layer surfaces owned outside this module:
      * ``SubagentOrchestrator`` worker tasks for the session
      * background ``spawn_subagents`` completion ``_watch()`` tasks
      * fire-and-forget recurring-task sub-agents (they bypass the orchestrator)
      * pending spawn proposals bound to the session (memory + DB)

    Live chat-turn tasks (``routers/workbench._activeStreams`` / ``_cancelled``)
    are owned by the router and cancelled in its ``deleteSession`` handler.
    Safe no-op when nothing is in flight; never raises.
    """
    if not session_id:
        return
    try:
        from app.services.runtime_services import get_orchestrator

        orch = get_orchestrator()
        if orch is not None and hasattr(orch, 'terminateForSession'):
            orch.terminateForSession(session_id)
    except Exception:
        logger.debug('orchestrator session cancel failed', exc_info=True)
    try:
        from app.services.tools.spawn_subagents_tool import cancel_session_watches

        cancel_session_watches(session_id)
    except Exception:
        logger.debug('spawn-subagent watch cancel failed', exc_info=True)
    try:
        from app.services.workbench.subagent import cancel_subagent_tasks_for_session

        cancel_subagent_tasks_for_session(session_id)
    except Exception:
        logger.debug('subagent task cancel failed', exc_info=True)
    try:
        from app.services.tools.spawn_subagents_tool import expire_proposals_for_session

        expire_proposals_for_session(session_id)
    except Exception:
        logger.debug('proposal expiry failed', exc_info=True)


def delete_workbench_session(session_id: str) -> bool:
    """Delete a session from memory, SQLite, and the JSON export file.

    Always attempts brain SQLite cascade (messages, timeline, …) even when the
    session is not currently loaded in memory — otherwise orphan child rows
    (and FK failures on partial deletes) linger after tool/UI cleanup.

    In-flight work bound to the session is cancelled first (live turn tasks
    are handled by the router; orchestrator workers, spawn watchers,
    recurring-task sub-agents, and the environment watcher here) so nothing
    keeps running — or writing — after the session is gone.

    Emits ``session_deleted`` *as soon as* the in-memory entry is gone so the
    frontend can animate the row out before the slower SQLite cascade finishes.
    """
    if not session_id:
        return False
    if not _sessions:
        _load_sessions()
    session = _sessions.get(session_id)
    found_in_memory = session is not None

    # Cancel in-flight work + detach the session-scoped environment watcher
    # (thread + FsEvent log leak otherwise — the watcher keeps recording
    # events for a deleted session forever).
    cancel_session_work(session_id)
    try:
        from app.services.cognitive_boot import detach_session_watcher

        # Idempotent: no-op when the session never had a watcher attached.
        detach_session_watcher(session_id)
    except Exception:
        logger.debug('session watcher detach failed', exc_info=True)

    # Drop from RAM + notify UI first (real-time), cascade SQLite after.
    if session_id in _sessions:
        del _sessions[session_id]
        found_in_memory = True
    if found_in_memory:
        notify_session_deleted(session_id)
        try:
            path = _sessions_path()
            remaining = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:_SESSION_WINDOW]
            write_json_atomic(path, [s.toDict() for s in remaining], indent=2)
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
    return truncate_session(session_id, up_to_index=None)


def truncate_session(
    session_id: str, up_to_index: int | None = None
) -> dict[str, object] | None:
    """Truncate the session in place up to (and including) ``up_to_index``.

    Messages after the index are removed along with any in-flight plan,
    clarify question, and queued follow-ups. With ``up_to_index=None`` the
    session is cut back to just before the last user turn (undo semantics).
    Used by the chat UI's revert / edit / regenerate actions so the backend
    history matches what the user sees after truncating locally.
    """
    session = get_workbench_session(session_id)
    if not session:
        return None
    msgs = list(session.messages)
    if up_to_index is None:
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
        cut = last_user
    else:
        cut = int(up_to_index)
        if cut < 0:
            cut = 0
        if cut >= len(msgs):
            return {
                'session': session.toDict(),
                'removed': 0,
                'message': 'Nothing to remove — index is past the end of the conversation.',
            }
    removed = len(msgs) - cut
    session.messages = msgs[:cut]
    session.messageCount = len(session.messages)
    session.updatedAt = _now()
    # Clear in-flight plan/clarify/queue that belonged to the truncated turns.
    session.plan = None
    session.planApproved = False
    session.clarify = None
    session.queuedUserMessages = []
    save_sessions(immediate=True)
    _emit_session_status(session_id)
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('session.updated', sessionId=session_id, action='truncate')
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
    save_sessions(immediate=True)
    notify_session_created(new)
    _emit_session_status(new.id)
    return new


async def compact_workbench_session_now(session_id: str) -> dict[str, object] | None:
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
    try:
        from app.services.transcript_archive import archive_messages

        archive_messages(session_id, original, reason='compact')
    except Exception:
        pass
    compressed = await compressMessages(original, threshold=0, head_count=4, tail_count=6)
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
    session._last_compaction_turn = getattr(session, 'turnCount', 0) or 0
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


def _handoff_tail_window(
    messages: list[dict[str, object]], *, max_tokens: int = 2000, max_turns: int = 24
) -> list[dict[str, object]]:
    """Fallback window when there's no tracked handoff cursor yet.

    Walks backwards from the end of the conversation, collecting the last
    ``max_turns`` messages while staying under ``max_tokens`` (best-effort).
    """
    from app.providers.clients.base import estimateTokens

    tail: list[dict[str, object]] = []
    tokens = 0
    for msg in reversed(messages):
        try:
            t = estimateTokens([msg])
        except Exception:
            t = 0
        if tail and tokens + t > max_tokens:
            break
        tail.insert(0, msg)
        tokens += t
        if len(tail) >= max_turns:
            break
    return tail


def _handoff_plain_truncate(messages: list[dict[str, object]], max_chars: int = 1200) -> str:
    """Cheap non-LLM fallback used when ``localSummarize`` itself fails."""
    parts: list[str] = []
    for msg in messages[-6:]:
        role = as_str(msg.get('role')) if isinstance(msg, dict) else ''
        content = msg.get('content') if isinstance(msg, dict) else ''
        text = content if isinstance(content, str) else ''
        text = ' '.join(text.split())
        if text:
            parts.append(f'[{role}] {text[:200]}')
    joined = '\n'.join(parts)
    return joined[:max_chars]


def create_workbench_handoff(
    session_id: str,
    *,
    from_model: str = '',
    to_model: str = '',
) -> dict[str, object] | None:
    """Summarize messages since the last handoff (or a recent tail window) and
    persist the record on the session for the next chat turn to pick up.

    Returns ``None`` only when the session does not exist. Any summarization
    failure degrades to a plain-truncation fallback rather than raising, so
    callers can always surface *some* summary to the frontend.
    """
    session = get_workbench_session(session_id)
    if not session:
        return None

    msgs = [m for m in session.messages if isinstance(m, dict)]
    meta = dict(session.metadata) if isinstance(session.metadata, dict) else {}
    cursor = as_int(meta.get('handoffCursor'), 0)

    source = msgs[cursor:] if 0 <= cursor < len(msgs) else []
    if not source:
        source = _handoff_tail_window(msgs)

    start_index = max(len(msgs) - len(source), 0)
    end_index = max(len(msgs) - 1, 0) if msgs else -1

    summary = ''
    try:
        from app.services.memory.context_compressor import localSummarize

        summary = localSummarize(source) if source else ''
    except Exception:
        logger.exception('localSummarize failed during handoff; using plain truncation')
    if not summary:
        summary = _handoff_plain_truncate(source)
    if not summary:
        summary = 'No prior conversation content available for handoff.'

    record: dict[str, object] = {
        'fromModel': from_model or session.model,
        'toModel': to_model,
        'summary': summary,
        'createdAt': _now(),
        'sourceMessageRange': [start_index, end_index],
    }
    meta['lastHandoff'] = record
    meta['handoffCursor'] = len(msgs)
    session.metadata = meta
    session.updatedAt = _now()
    try:
        save_sessions()
    except Exception:
        logger.exception('Failed to persist session after handoff summary')
    return record


def mark_memory_reviewed(session_id: str | None) -> bool:
    """Record that a memory review completed for this session.

    Writes ``lastMemoryReviewAtTurn`` into session.metadata so both the
    per-turn ``<review_required>`` injection and the background review tick
    stay quiet until the next turn interval. Returns True when a live
    session was found and stamped.
    """
    if not session_id:
        return False
    sess = get_workbench_session(session_id)
    if sess is None:
        return False
    meta = dict(sess.metadata) if isinstance(sess.metadata, dict) else {}
    meta['lastMemoryReviewAtTurn'] = int(getattr(sess, 'turnCount', 0) or 0)
    sess.metadata = meta
    sess.updatedAt = _now()
    try:
        save_sessions()
    except Exception:
        logger.exception('Failed to persist memory-review marker')
    return True


def take_session_handoff(session_id: str) -> dict[str, object] | None:
    """Pop the persisted handoff record so the next chat turn consumes it once."""
    session = get_workbench_session(session_id)
    if not session:
        return None
    meta = session.metadata if isinstance(session.metadata, dict) else {}
    record = meta.get('lastHandoff')
    if not isinstance(record, dict):
        return None
    meta = dict(meta)
    meta.pop('lastHandoff', None)
    session.metadata = meta
    try:
        save_sessions()
    except Exception:
        logger.exception('Failed to persist session after consuming handoff')
    return record


def format_session_handoff(record: dict[str, object]) -> str:
    """Render a persisted handoff record into the ``<model_handoff>`` body text."""
    summary = as_str(record.get('summary')).strip()
    if not summary:
        return ''
    from_model = as_str(record.get('fromModel')).strip()
    header = (
        f'Previous model ({from_model}) context handoff:' if from_model else 'Context handoff from previous model:'
    )
    return f'{header}\n{summary}'


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
        # Boolean presence flag for lists — never an empty {} standing in for null.
        'plan': bool(session.plan),
        'planApproved': session.planApproved,
        'messageCount': session.messageCount,
        'mutationCount': session.mutationCount,
        'turnCount': session.turnCount,
        'status': session.status,
        'createdAt': session.createdAt,
        'updatedAt': session.updatedAt,
        'startedAt': session.startedAt,
        'workspacePath': session.workspacePath,
        # Usage roll-ups — feed the Runs view's stat strip (tokens/cost per run).
        'totalInputTokens': session.totalInputTokens,
        'totalOutputTokens': session.totalOutputTokens,
        'totalCost': session.totalCost,
    }


def get_workbench_session_status(session_id: str) -> dict[str, object] | None:
    """Return flat status for the UI's approval banner."""
    # Mirrors get_workbench_session: memory first, then a SQLite blob reload —
    # a memory-window-only lookup returned None after restart/prune, which
    # made approval banners vanish for older chats.
    session = get_workbench_session(session_id)
    if not session:
        return None
    has_pending = len(session.pendingMutations) > 0
    pm = session.pendingMutations[-1] if has_pending else None
    pm_dict = as_dict(pm) if pm is not None else {}

    def _path_from_args(args: object) -> str | None:
        ad = as_dict(args) if args is not None else {}
        for key in ('path', 'file_path', 'filePath', 'file', 'target', 'target_file'):
            v = ad.get(key)
            if isinstance(v, str) and v.strip():
                return v
        return None

    # Full batch for multi-file pre-apply cards (newest last = same order as list)
    pending_list: list[dict[str, object]] = []
    for raw in session.pendingMutations:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        args = item.get('args')
        if 'path' not in item:
            p = _path_from_args(args)
            if p:
                item['path'] = p
        pending_list.append(item)

    return {
        'sessionId': session_id,
        'status': session.status,
        'guardMode': session.guardMode,
        'sandboxMode': getattr(session, 'sandboxMode', 'workspace-write') or 'workspace-write',
        'sandboxNetwork': bool(getattr(session, 'sandboxNetwork', False)),
        # Flat fields used by ApprovalBanner / useSessionStatus (last pending)
        'pendingToken': as_str(pm_dict.get('token')) or None,
        'pendingTool': as_str(pm_dict.get('toolName')) or None,
        'pendingArgs': as_dict(pm_dict.get('args')) if pm_dict.get('args') is not None else None,
        'pendingPreview': as_str(pm_dict.get('preview')) or None,
        'pendingCreatedAt': pm_dict.get('createdAt'),
        'pendingPath': _path_from_args(pm_dict.get('args')),
        'approved': bool(session.planApproved),
        'updatedAt': session.updatedAt,
        # Nested blob kept for older clients
        'pendingMutation': pm if has_pending else None,
        # Full list for multi-file Accept/Reject cards
        'pendingMutations': pending_list,
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
saveSessionsNow = save_sessions_now
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
cancelSessionWork = cancel_session_work
flushPendingSaves = flush_pending_saves
setActiveTurnCheck = set_active_turn_check
