"""Session-management and unified search tool handlers + registration."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from app.json_narrowing import as_int, as_str
from app.services import tool_registry
from app.services.sensitive_topics import isSensitiveMemory as _isSensitiveMemory


async def _search(query: str, scope: str = 'files', limit: int = 10) -> str:
    """Unified search across files and web with dedup."""
    from app.json_narrowing import as_int as _as_int

    scopes = [s.strip().lower() for s in (scope or 'files').split(',') if s.strip()]
    lim = max(1, min(_as_int(limit, 10), 30))
    blocks: list[str] = []
    seen: set[str] = set()

    def _dedupe_key(text: str) -> str:
        return ' '.join(text.lower().split())[:200]

    if 'files' in scopes:
        try:
            from app.services.tool_registrations.file_tools import _searchFiles

            fres = await _searchFiles(query)
            if 'No matches' not in fres and 'Error' not in fres[:30]:
                for line in fres.splitlines():
                    k = _dedupe_key(line)
                    if k and k not in seen:
                        seen.add(k)
                        blocks.append(f'[file] {line}')
        except Exception:
            pass
    if 'web' in scopes:
        try:
            from app.services.tool_registrations.web_tools import _webSearch

            wres = await _webSearch(query)
            text = str(wres)[:6000]
            for line in text.splitlines():
                k = _dedupe_key(line)
                if k and k not in seen and len(line.strip()) > 20:
                    seen.add(k)
                    blocks.append(f'[web] {line[:300]}')
        except Exception:
            pass
    if not blocks:
        return f'No results for: {query} (scopes: {",".join(scopes)})'
    header = f'Unified search for: {query} (scopes: {",".join(scopes)})\n'
    return header + '\n'.join(blocks[:lim])


async def _brainQuery(store: str, query: str = '', filters: str = '', limit: int = 10) -> str:
    """Read-only query over runtime stores (sessions, messages, daemons, blackboard)."""
    from app.services.memory_store import brain_query as _bq

    try:
        filtersDict = {}
        if filters and filters.strip():
            import json as _json

            try:
                filtersDict = _json.loads(filters)
            except _json.JSONDecodeError:
                pass
        result = _bq(store, query, filtersDict or None, limit)
        return result
    except Exception as exc:
        return f'{{"error": "brain_query: {exc}"}}'


# Sensitive-topic denylist for the `remember` write door — the scanner now
# lives in services.sensitive_topics (shared with the Part 16 distiller's
# drafted summaries/bodies); this alias keeps the remember door unchanged.


def _deriveFactKey(text: str) -> str:
    """Stable fallback key from the fact text (identical text → same key, so a
    repeated save updates rather than duplicates). Models should pass `key`
    explicitly when updating a known fact."""
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:48]
    return f'model:{slug or "note"}'


# Write-time quality gates for the remember door (plan 2026-08-28 Bug 8b):
# length bounds plus a per-turn budget so a runaway loop cannot flood the
# facts store. All refusals are soft ({ok: False, policy}) — the model gets
# the reason and can adjust.
_REMEMBER_MIN_FACT_CHARS = 8
_REMEMBER_MAX_FACT_CHARS = 500
_REMEMBER_MAX_DETAILS_CHARS = 2000
_REMEMBER_PER_TURN_LIMIT = 3
# Per-turn counters keyed by workbench session id (ContextVar set by
# _execute_tool); reset at turn start via reset_remember_turn_budget().
_rememberTurnCounts: dict[str, int] = {}


def reset_remember_turn_budget(sessionId: str = '') -> None:
    """Reset the per-turn remember counter for a session (turn start)."""
    if not sessionId:
        _rememberTurnCounts.clear()
        return
    _rememberTurnCounts.pop(sessionId, None)


def remember_used_this_turn(sessionId: str = '') -> bool:
    """True when `remember` already ran this turn for the session (counter > 0).

    Read by the end-of-turn memory-habit nudge (workbench.py) so a turn that
    already consolidated knowledge does not get nudged again.
    """
    try:
        key = sessionId or _currentRememberSessionKey()
    except Exception:
        return False
    return _rememberTurnCounts.get(key, 0) > 0


def _currentRememberSessionKey() -> str:
    try:
        from app.services.workbench.context import currentSessionId

        return str(currentSessionId.get() or 'default')
    except Exception:
        return 'default'


def _currentWorkspacePath() -> str:
    """The current workbench session's workspacePath ('' when none/home).

    Part 17 Phase A: resolves the session bound to the current tool
    dispatch via the ContextVar so the project-memory write door can route
    remember/forget to the right workspace without changing the tool
    signature everywhere.
    """
    try:
        from app.services.workbench import workbench as _wb
        from app.services.workbench.context import currentSessionId

        sid = str(currentSessionId.get() or '')
        if not sid:
            return ''
        session = _wb.getWorkbenchSession(sid)
        if session is None:
            return ''
        ws = as_str(getattr(session, 'workspacePath', '') or '')
        if ws and Path(ws).resolve() == Path.home().resolve():
            # §9 F-5: the home dir is NOT a project root (matches the
            # docstring and every other Part 17 door) — auto-project must
            # not create <home>/.aug/memory/ for home-anchored sessions.
            return ''
        return ws
    except Exception:
        return ''


async def _remember(
    fact: str,
    key: str = '',
    category: str = 'general',
    details: str = '',
    expires_at: str = '',
    title: str = '',
    kind: str = '',
    scope: str = '',
    **_extra: object,
) -> str:
    """Single model write door into durable memory (facts store).

    Gated by the ``modelMemoryWrites`` toggle and a sensitive-topic denylist
    (unless ``memorySensitiveTopics`` is on). Writes via ``save_fact`` with
    ``source='model'`` (upsert over the key = update-over-duplicate) and
    records a rollback entry so the write is undoable. Every entry gets a
    short human ``title`` (derived from the text when not supplied) and a
    ``kind`` (fact | lesson | preference | skill-note).

    Part 17 Phase A: ``scope='project'`` writes to the workspace's md-file
    project memory (``<ws>/.aug/memory/memory.md``) instead of the global
    facts store — same gates, same rollback snapshot, same per-turn budget.
    Inside a session with a non-home workspace the default scope IS project
    (the workspace's constraints and lessons belong to that project); the
    global store is reached explicitly with ``scope='global'``.
    """
    import json as _json

    from app.services import brain_config_service, memory_store
    from app.type_aliases import JsonValue

    text = str(fact or '').strip()
    if not text:
        return _json.dumps({'ok': False, 'error': 'fact is required'})
    detailsText = str(details or '').strip()
    if len(text) < _REMEMBER_MIN_FACT_CHARS:
        return _json.dumps(
            {
                'ok': False,
                'policy': f'refused: fact is too short (min {_REMEMBER_MIN_FACT_CHARS} characters). '
                'Save complete, self-contained facts only.',
            }
        )
    if len(text) > _REMEMBER_MAX_FACT_CHARS:
        return _json.dumps(
            {
                'ok': False,
                'policy': f'refused: fact exceeds {_REMEMBER_MAX_FACT_CHARS} characters. Keep the fact '
                'to one concise sentence and move the rest into details.',
            }
        )
    if len(detailsText) > _REMEMBER_MAX_DETAILS_CHARS:
        return _json.dumps(
            {
                'ok': False,
                'policy': f'refused: details exceed {_REMEMBER_MAX_DETAILS_CHARS} characters. '
                'Trim to the essentials.',
            }
        )
    try:
        cfg = brain_config_service.getRuntimeConfig()
    except Exception:
        cfg = {}
    if not bool(cfg.get('modelMemoryWrites', True)):
        return _json.dumps(
            {
                'ok': False,
                'policy': 'model memory writes are disabled by the user. Do not retry; '
                "tell the user you can't save memories while this setting is off.",
            }
        )
    if not bool(cfg.get('memorySensitiveTopics', False)) and _isSensitiveMemory(text, details):
        return _json.dumps(
            {
                'ok': False,
                'policy': 'refused: this looks like a sensitive topic (health, ID numbers, minors, '
                'beliefs) and sensitive memory is disabled. Do not retry.',
            }
        )
    sessKey = _currentRememberSessionKey()
    used = _rememberTurnCounts.get(sessKey, 0)
    if used >= _REMEMBER_PER_TURN_LIMIT:
        return _json.dumps(
            {
                'ok': False,
                'policy': f'refused: per-turn memory budget exhausted ({_REMEMBER_PER_TURN_LIMIT} '
                'facts max per turn). Continue the task; you can save more next turn.',
            }
        )
    # ── Part 17 Phase A: project scope (md-file workspace memory) ──────────
    ws = _currentWorkspacePath()
    scopeNorm = (scope or '').strip().lower()
    if scopeNorm == 'project' or (not scopeNorm and ws):
        if not ws:
            return _json.dumps(
                {
                    'ok': False,
                    'error': 'scope=project requires a workspace; no workspacePath is bound to '
                    'this session (use scope=global or open a workspace first)',
                }
            )
        try:
            cfgPj = brain_config_service.getRuntimeConfig()
        except Exception:
            cfgPj = {}
        if not bool(cfgPj.get('projectMemory', True)):
            return _json.dumps(
                {
                    'ok': False,
                    'policy': 'project memory is disabled by the user (projectMemory setting). '
                    'Do not retry; save with scope=global only if the fact is user-level.',
                }
            )
        entryTitle = (title or '').strip() or memory_store.derive_fact_title(text)
        before: dict[str, object] | None = None
        try:
            from app.services import project_memory as _pm

            existing = _pm.read_entries(ws, title=entryTitle)
            if existing:
                before = {
                    'workspace': ws,
                    'file': existing[0].file,
                    'title': existing[0].title,
                    'body': existing[0].body,
                    'updated': existing[0].updated,
                }
            body = f'{text}\n\n{detailsText}' if detailsText else text
            _pm.upsert_entry(ws, entryTitle, body)
        except Exception as exc:
            return _json.dumps({'ok': False, 'error': f'remember(project) failed: {exc}'})
        _rememberTurnCounts[sessKey] = used + 1
        try:
            from app.services.rollback_store import record_rollback

            record_rollback(
                type='restore_memory_item',
                target=f'project:{entryTitle}',
                before=before,
                after={'workspace': ws, 'title': entryTitle, 'body': body},
            )
        except Exception:
            pass
        return _json.dumps(
            {
                'ok': True,
                'scope': 'project',
                'key': entryTitle,
                'file': 'memory.md',
                'updated': before is not None,
            }
        )
    cat = (category or 'general').strip().lower()
    if cat not in ('user', 'feedback', 'project', 'reference', 'general'):
        cat = 'general'
    factKey = (key or '').strip() or _deriveFactKey(text)
    factTitle = (title or '').strip() or memory_store.derive_fact_title(text)
    factKind = (kind or '').strip().lower()
    value: JsonValue = text if not detailsText else {'fact': text, 'details': detailsText}
    exp = (expires_at or '').strip() or None
    before = memory_store.get_fact(factKey)  # type: ignore[assignment]
    try:
        memory_store.save_fact(
            factKey, value, category=cat, source='model', confidence=0.7,
            expires_at=exp, title=factTitle, kind=factKind,
        )
    except Exception as exc:
        return _json.dumps({'ok': False, 'error': f'remember failed: {exc}'})
    _rememberTurnCounts[sessKey] = used + 1
    try:
        # M3 usage feedback: a fact the model writes/updates counts as used.
        memory_store.touch_fact_usage([factKey])
    except Exception:
        pass
    try:
        from app.services.rollback_store import record_rollback

        record_rollback(
            type='restore_memory_item',
            target=factKey,
            before=before,
            after={'key': factKey, 'value': value, 'category': cat, 'source': 'model'},
        )
    except Exception:
        pass
    return _json.dumps({'ok': True, 'key': factKey, 'category': cat, 'updated': before is not None})


# Sources the model may delete via `forget`: its own writes, user-added
# entries, and imports. Anything else (extracted / lesson / consolidation
# daemons) is system-owned and survives model cleanup.
_FORGET_ALLOWED_SOURCES = ('model', 'user', '')


async def _forget(key: str) -> str:
    """Delete one durable memory entry by exact key.

    The delete half of the model's memory CRUD (with ``remember`` = write and
    ``list_facts`` = read). Gated by ``modelMemoryWrites``; only model / user
    / imported facts can be deleted. A rollback snapshot is recorded so the
    delete is undoable, matching the Memory UI's delete path.

    Part 17 Phase A: ``project:<title>`` deletes a project-memory entry
    (the remember scope='project' write door's counterpart — deletes from
    ``<ws>/.aug/memory/``, moves nothing into the global store).
    """
    import json as _json

    from app.services import brain_config_service, memory_store

    factKey = (key or '').strip()
    if not factKey:
        return _json.dumps({'ok': False, 'error': 'key is required — call list_facts to see keys'})
    # Project-scope delete: `project:<title>` targets the workspace's md
    # entries; a bare key inside a non-home workspace tries the project
    # entries first (matching remember's auto-project default) and falls
    # through to the global facts store when no entry matches.
    ws = _currentWorkspacePath()
    if ws:
        isProjectKey = factKey.startswith('project:')
        title = factKey[len('project:') :].strip() if isProjectKey else factKey
        try:
            from app.services import project_memory as _pm

            existing = [e for e in _pm.read_entries(ws) if e.title.lower() == title.lower()]
        except Exception:
            existing = []
        if existing:
            try:
                cfgF = brain_config_service.getRuntimeConfig()
            except Exception:
                cfgF = {}
            if not bool(cfgF.get('modelMemoryWrites', True)):
                return _json.dumps(
                    {
                        'ok': False,
                        'policy': 'model memory writes are disabled by the user. Do not retry; '
                        "tell the user you can't delete memories while this setting is off.",
                    }
                )
            entry = existing[0]
            try:
                from app.services import project_memory as _pm

                _pm.delete_entry(ws, entry.title)
            except Exception as exc:
                return _json.dumps({'ok': False, 'error': f'forget(project) failed: {exc}'})
            try:
                from app.services.rollback_store import record_rollback

                record_rollback(
                    type='restore_memory_item',
                    target=f'project:{entry.title}',
                    before={
                        'workspace': ws,
                        'file': entry.file,
                        'title': entry.title,
                        'body': entry.body,
                        'updated': entry.updated,
                    },
                    after=None,
                )
            except Exception:
                pass
            return _json.dumps(
                {'ok': True, 'deleted': True, 'scope': 'project', 'key': entry.title}
            )
        if isProjectKey:
            return _json.dumps(
                {
                    'ok': False,
                    'deleted': False,
                    'error': f'no project-memory entry titled "{title}" in this workspace',
                }
            )
    try:
        cfg = brain_config_service.getRuntimeConfig()
    except Exception:
        cfg = {}
    if not bool(cfg.get('modelMemoryWrites', True)):
        return _json.dumps(
            {
                'ok': False,
                'policy': 'model memory writes are disabled by the user. Do not retry; '
                "tell the user you can't delete memories while this setting is off.",
            }
        )
    before = memory_store.get_fact(factKey)
    if not before:
        return _json.dumps(
            {
                'ok': False,
                'deleted': False,
                'error': f'no fact with key "{factKey}" — call list_facts to see current keys',
            }
        )
    source = str(before.get('source') or '')
    if source not in _FORGET_ALLOWED_SOURCES and not source.startswith('imported'):
        return _json.dumps(
            {
                'ok': False,
                'policy': f'refused: "{factKey}" is system-owned (source="{source}"); '
                'only model/user/imported facts can be forgotten.',
            }
        )
    try:
        deleted = memory_store.delete_fact(factKey)
    except Exception as exc:
        return _json.dumps({'ok': False, 'error': f'forget failed: {exc}'})
    if deleted:
        try:
            from app.services.rollback_store import record_rollback

            record_rollback(
                type='restore_memory_item',
                target=factKey,
                before=before,
                after=None,
            )
        except Exception:
            pass
    return _json.dumps({'ok': bool(deleted), 'deleted': bool(deleted), 'key': factKey})


async def _list_facts(category: str = '', query: str = '', limit: int = 50) -> str:
    """List durable memory entries (key, title, category, source).

    The read half of the model's memory CRUD — this is what makes
    ``remember``'s "pass a stable key to update" and ``forget``'s key
    argument actually usable. Gated by ``modelMemoryRead``. Bounded at 50
    rows, newest first.
    """
    import json as _json

    from app.services import brain_config_service, memory_store

    try:
        cfg = brain_config_service.getRuntimeConfig()
    except Exception:
        cfg = {}
    if not bool(cfg.get('modelMemoryRead', True)):
        return _json.dumps(
            {
                'ok': False,
                'policy': 'model memory reads are disabled by the user. Do not retry; '
                'answer from the conversation context instead.',
            }
        )
    lim = max(1, min(as_int(limit, 50), 50))
    cat = (category or '').strip().lower()
    q = (query or '').strip()
    try:
        rows = memory_store.search_facts(q, cat) if q else memory_store.list_facts(cat)
    except Exception as exc:
        return _json.dumps({'ok': False, 'error': f'list_facts failed: {exc}'})
    facts: list[dict[str, object]] = []
    # Part 17 Phase A: inside a workspace, project-memory entries list first
    # (they are the remember-default scope there) with key `project:<title>`.
    ws = _currentWorkspacePath()
    if ws:
        try:
            from app.services import project_memory as _pm

            for e in _pm.read_entries(ws):
                if q and q.lower() not in e.title.lower() and q.lower() not in e.body.lower():
                    continue
                facts.append(
                    {
                        'key': f'project:{e.title}',
                        'title': e.title[:120],
                        'category': 'project',
                        'source': 'project-file',
                        'kind': 'entry',
                        'updated': e.updated or '',
                        'file': e.file,
                    }
                )
        except Exception:
            pass
    for r in rows[:lim]:
        title = str(r.get('title') or '').strip()
        value = str(r.get('factValue') or '')
        if not title:
            # factValue is stored JSON-encoded: unwrap {"fact","details"}
            # dicts and plain strings alike; fall back to the first line.
            try:
                obj = _json.loads(value)
                if isinstance(obj, dict) and isinstance(obj.get('fact'), str):
                    title = str(obj.get('fact'))
                elif isinstance(obj, str):
                    title = obj
            except Exception:
                pass
            if not title:
                title = value.split('\n', 1)[0][:80]
        facts.append(
            {
                'key': r.get('factKey'),
                'title': title[:120],
                'category': r.get('category') or '',
                'source': r.get('source') or '',
                'kind': r.get('kind') or '',
                'updated': r.get('updatedAt') or '',
            }
        )
    return _json.dumps({'ok': True, 'count': len(facts), 'facts': facts})


def _purge_session_everywhere(sessionId: str) -> dict[str, object]:
    """Remove a session from workbench storage + brain SQLite (cascade children)."""
    from app.services import memory_store

    wb_ok = False
    try:
        from app.services.workbench.sessions import delete_workbench_session

        wb_ok = bool(delete_workbench_session(sessionId))
    except Exception:
        pass
    # Free the headless browser for this session — every session that used a
    # browser tool otherwise leaves a chromium process resident until app
    # shutdown.
    try:
        from app.services.browser.session_manager import closeSession

        asyncio.run(closeSession(sessionId))
    except Exception:
        pass
    result = memory_store.delete_session_cascade(sessionId, notify=not wb_ok)
    return {
        'ok': wb_ok or bool(result.get('ok')),
        'messages': as_int(result.get('messages'), 0),
        'children': result.get('children') or {},
        'workbench': wb_ok,
    }


async def _deleteSession(sessionId: str) -> str:
    """Delete a chat session and all dependent rows."""
    try:
        # SQLite cascades are synchronous — keep them off the event loop so
        # another chat can continue streaming while a large session deletes.
        result = await asyncio.to_thread(_purge_session_everywhere, sessionId)
        if result.get('ok'):
            children = result.get('children') or {}
            msgCount = as_int(result.get('messages'), 0)
            extra = (
                sum(int(v) for k, v in children.items() if k != 'messages')
                if isinstance(children, dict)
                else 0
            )
            extra_note = f', {extra} other related row(s)' if extra else ''
            return f'Deleted session {sessionId} (+ {msgCount} message(s){extra_note}).'
        return f'Session {sessionId} not found — it may have already been deleted.'
    except Exception as exc:
        return f'Error deleting session {sessionId}: {exc}'


async def _deleteSessions(sessionIds: object = None, sessionId: str = '') -> str:
    """Bulk-delete chat sessions. Prefer over many delete_session calls."""
    from app.services.tool_registrations.bulk_helpers import coerce_str_list, format_bulk_report

    ids = coerce_str_list(sessionIds, single=sessionId)
    if not ids:
        return 'Error: sessionIds is required (array of session IDs to delete).'
    deleted: list[str] = []
    missing: list[str] = []
    errors: list[str] = []
    msg_total = 0
    for sid in ids:
        try:
            result = await asyncio.to_thread(_purge_session_everywhere, sid)
            if result.get('ok'):
                deleted.append(sid)
                msg_total += as_int(result.get('messages'), 0)
            else:
                missing.append(sid)
        except Exception as exc:
            errors.append(f'{sid}: {exc}')
    return format_bulk_report(
        label='delete_sessions',
        total=len(ids),
        ok_ids=deleted,
        missing=missing,
        errors=errors,
        extra=f'(+ {msg_total} message(s))',
    )


async def _renameSession(sessionId: str = '', title: str = '') -> str:
    """Rename a chat session so the sidebar shows a clear human title."""
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.sessions import get_workbench_session, rename_workbench_session

    sid = (sessionId or '').strip()
    new_title = (title or '').strip()
    if not new_title:
        return 'Error: title is required.'
    if not sid:
        # Prefer the session that is currently executing tools.
        ctx = currentSessionId.get()
        if ctx and ctx != 'default':
            sid = ctx
    if not sid:
        try:
            from app.services.workbench import workbench as wb

            sessions = wb.listWorkbenchSessions()
            if sessions:
                sid = str(sessions[0].get('id') or '')
        except Exception:
            pass
    if not sid:
        return 'Error: sessionId is required (no active session found).'
    session = rename_workbench_session(sid, new_title)
    if not session:
        if not get_workbench_session(sid):
            return f'Session {sid} not found.'
        return f'Could not rename session {sid}.'
    return f'Renamed session {sid} → "{session.title}".'


async def _deleteFolder(folderId: str) -> str:
    """Delete all sessions in a folder and their dependent rows."""
    from app.services import memory_store

    try:
        sessions = memory_store.list_sessions()
        folderSessions = [s for s in sessions if s.get('folderId') == folderId]
        if not folderSessions:
            return f"No sessions found in folder '{folderId}'."
        count = 0
        msgCount = 0
        for s in folderSessions:
            sid = s['id']
            result = await asyncio.to_thread(_purge_session_everywhere, sid)
            if result.get('ok'):
                count += 1
                msgCount += as_int(result.get('messages'), 0)
        return f"Deleted {count} session(s) from folder '{folderId}' (+ {msgCount} message(s))."
    except Exception as exc:
        return f"Error deleting folder '{folderId}': {exc}"


def register() -> None:
    """Register session-management and search tools."""
    tool_registry.register(
        'rename_session',
        'Rename a chat session in the sidebar when the user asks. Titles auto-generate after the first '
        'reply — do NOT call this just to title a new chat. Use a short 3–8 word title. Pass sessionId '
        'when known; for the current chat (see <session> in the system prompt) you may omit it.',
        _renameSession,
        {
            'type': 'object',
            'properties': {
                'sessionId': {
                    'type': 'string',
                    'description': 'Workbench session id (e.g. wb_20260715_143052_a1b2c3). Optional for the active chat.',
                },
                'title': {
                    'type': 'string',
                    'description': 'Short sidebar title (max ~48 chars).',
                },
            },
            'required': ['title'],
        },
    )
    tool_registry.register(
        'delete_session',
        'Delete a single chat session by ID (e.g. wb_20260715_143052_a1b2c3; the current chat id is in '
        'the <session> block). For multiple, use delete_sessions instead of repeating this. Use '
        'brain_query(store=sessions) to list first. IMPORTANT: confirm with the user before deleting.',
        _deleteSession,
        {
            'type': 'object',
            'properties': {'sessionId': {'type': 'string', 'description': 'The session ID to delete.'}},
            'required': ['sessionId'],
        },
    )
    tool_registry.register(
        'delete_sessions',
        'Bulk-delete multiple chat sessions in one call. Pass sessionIds as an array (e.g. from '
        'brain_query(store=sessions)); prefer over many delete_session calls. IMPORTANT: list the exact '
        'sessions to the user and wait for explicit confirmation — never bulk-delete without it.',
        _deleteSessions,
        {
            'type': 'object',
            'properties': {
                'sessionIds': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Session IDs to delete (e.g. ["wb_…", "wb_…"]).',
                },
                'sessionId': {
                    'type': 'string',
                    'description': 'Optional single ID fallback if sessionIds is omitted.',
                },
            },
            'required': ['sessionIds'],
        },
    )
    tool_registry.register(
        'search',
        'Unified search across files and web with dedup — one call, scope decides. '
        'Prefer this over juggling search_files vs web_search.',
        _search,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Search query.'},
                'scope': {
                    'type': 'string',
                    'description': 'Comma-separated scopes: files,web (e.g. "files,web"). Default files.',
                },
                'limit': {'type': 'integer', 'description': 'Max results (1-30). Default 10.'},
            },
            'required': ['query'],
        },
    )
    tool_registry.register(
        'brain_query',
        "Read-only query over runtime stores (sessions, messages, blackboard, daemons, "
        'facts, project-memory). Returns compact JSON rows. Use store=sessions to list chats '
        'before deleting; store=project-memory reads this workspace\'s md-file entries '
        '(BM25-ranked by query).',
        _brainQuery,
        {
            'type': 'object',
            'properties': {
                'store': {
                    'type': 'string',
                    'description': 'Which store to read: sessions | messages | blackboard | daemons | facts | project-memory',
                    'enum': ['sessions', 'messages', 'blackboard', 'daemons', 'facts', 'project-memory'],
                },
                'query': {'type': 'string', 'description': 'Search text (FTS or LIKE). Optional.'},
                'filters': {
                    'type': 'string',
                    'description': 'JSON object of column filters (e.g. \'{"category": "auth"}\'). Optional.',
                },
                'limit': {'type': 'integer', 'description': 'Max rows to return (1-100). Default 10.'},
            },
            'required': ['store'],
        },
    )
    tool_registry.register(
        'remember',
        'Save one durable memory entry (the only model write door). Use for user-stated '
        'preferences, project constraints, and feedback that must outlive this session. Pass a stable '
        'key to update an existing entry rather than duplicate (call list_facts to see current keys). '
        'Sensitive topics are refused unless enabled. Scope: inside a workspace session the default is '
        "project (this workspace's md-file memory); use scope='global' for user-level facts that "
        "apply everywhere, or scope='project' to force the project store.",
        _remember,
        {
            'type': 'object',
            'properties': {
                'fact': {'type': 'string', 'description': 'The fact to remember (one concise statement).'},
                'title': {
                    'type': 'string',
                    'description': 'Optional short human label (≤60 chars) shown in the Memory UI. '
                    'Derived from the fact text when omitted.',
                },
                'kind': {
                    'type': 'string',
                    'enum': ['fact', 'lesson', 'preference', 'skill-note'],
                    'description': 'Entry type. Default fact.',
                },
                'key': {
                    'type': 'string',
                    'description': 'Optional stable key; pass it to update an existing fact instead of creating a new one.',
                },
                'category': {
                    'type': 'string',
                    'enum': ['user', 'feedback', 'project', 'reference', 'general'],
                    'description': 'Memory category. Default general.',
                },
                'scope': {
                    'type': 'string',
                    'enum': ['global', 'project'],
                    'description': 'Where to save: project (workspace md memory, the default inside a '
                    'workspace session) or global (user-level facts store, the default without a workspace).',
                },
                'details': {'type': 'string', 'description': 'Optional extra context stored alongside the fact.'},
                'expires_at': {
                    'type': 'string',
                    'description': 'Optional ISO-8601 expiry (e.g. 2026-12-31T00:00:00Z); purged after this.',
                },
            },
            'required': ['fact'],
        },
    )
    tool_registry.register(
        'list_facts',
        'List durable long-term memory entries (key, title, category, source, updated). Call this '
        'before `remember` with a stable key (update, don\'t duplicate) and before `forget` (to get '
        'the exact key). Optional filters: category (user | feedback | project | reference | general) '
        'and free-text query over keys/values.',
        _list_facts,
        {
            'type': 'object',
            'properties': {
                'category': {
                    'type': 'string',
                    'enum': ['user', 'feedback', 'project', 'reference', 'general'],
                    'description': 'Optional category filter.',
                },
                'query': {'type': 'string', 'description': 'Optional text search over keys/values.'},
                'limit': {'type': 'integer', 'description': 'Max rows (1-50). Default 50.'},
            },
        },
    )
    tool_registry.register(
        'forget',
        'Delete one durable memory fact by its exact key (call list_facts to see keys). Use when a '
        'stored fact is wrong or outdated, or when the user asks to forget something. Only '
        'model/user/imported entries can be deleted; system-owned entries are refused. Inside a '
        'workspace, project-memory entries match by title (the key IS the entry title); prefix '
        '"project:" to force the project store. IMPORTANT: never delete a memory the user did not '
        'ask to remove or that is not clearly superseded.',
        _forget,
        {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'The exact fact key to delete (from list_facts).'},
            },
            'required': ['key'],
        },
    )
    tool_registry.register(
        'delete_folder',
        'Delete all sessions in a folder by folder ID (their messages are deleted too). Use '
        'brain_query(store=sessions) to list sessions and folderId values first. IMPORTANT: present the '
        'exact folder and sessions to the user and wait for explicit confirmation before calling.',
        _deleteFolder,
        {
            'type': 'object',
            'properties': {'folderId': {'type': 'string', 'description': 'The folder ID whose sessions to delete.'}},
            'required': ['folderId'],
        },
    )
