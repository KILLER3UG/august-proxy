"""Session-management and unified search tool handlers + registration."""

from __future__ import annotations

import asyncio
import re

from app.json_narrowing import as_int
from app.services import tool_registry


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


# Sensitive-topic denylist for the `remember` write door. Keyword/regex scan —
# deliberately conservative; a hit refuses the write unless the user turned on
# memorySensitiveTopics. Covers health specifics, ID numbers, minors, beliefs.
_SENSITIVE_MEMORY_RE = re.compile(
    r'\b('
    r'diagnos\w*|cancer|tumor|hiv\b|diabet\w*|medication|prescription|dosage|'
    r'antidepressant|psychotherap\w*|mental illness|'
    r'social security|ssn\b|passport|credit card|bank account|routing number|tax id|'
    r'religio\w*|political party|political affiliation|'
    r'(?:son|daughter|child|kid)(?:\'s)? (?:name|age|school|medical)'
    r')\b'
    r'|\b\d{3}-\d{2}-\d{4}\b',  # SSN-like pattern
    re.IGNORECASE,
)


def _isSensitiveMemory(*texts: str) -> bool:
    blob = ' '.join(str(t) for t in texts if t)
    return bool(_SENSITIVE_MEMORY_RE.search(blob))


def _deriveFactKey(text: str) -> str:
    """Stable fallback key from the fact text (identical text → same key, so a
    repeated save updates rather than duplicates). Models should pass `key`
    explicitly when updating a known fact."""
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:48]
    return f'model:{slug or "note"}'


async def _remember(
    fact: str,
    key: str = '',
    category: str = 'general',
    details: str = '',
    expires_at: str = '',
    **_extra: object,
) -> str:
    """Single model write door into durable memory (facts store).

    Gated by the ``modelMemoryWrites`` toggle and a sensitive-topic denylist
    (unless ``memorySensitiveTopics`` is on). Writes via ``save_fact`` with
    ``source='model'`` (INSERT OR REPLACE = update-over-duplicate) and records
    a rollback entry so the write is undoable.
    """
    import json as _json

    from app.services import brain_config_service, memory_store
    from app.type_aliases import JsonValue

    text = str(fact or '').strip()
    if not text:
        return _json.dumps({'ok': False, 'error': 'fact is required'})
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
    cat = (category or 'general').strip().lower()
    if cat not in ('user', 'feedback', 'project', 'reference', 'general'):
        cat = 'general'
    factKey = (key or '').strip() or _deriveFactKey(text)
    detailsText = str(details or '').strip()
    value: JsonValue = text if not detailsText else {'fact': text, 'details': detailsText}
    exp = (expires_at or '').strip() or None
    before = memory_store.get_fact(factKey)
    try:
        memory_store.save_fact(factKey, value, category=cat, source='model', confidence=0.7, expires_at=exp)
    except Exception as exc:
        return _json.dumps({'ok': False, 'error': f'remember failed: {exc}'})
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
        "Read-only query over runtime stores (sessions, messages, blackboard, daemons). "
        'Returns compact JSON rows. Use store=sessions to list chats before deleting.',
        _brainQuery,
        {
            'type': 'object',
            'properties': {
                'store': {
                    'type': 'string',
                    'description': 'Which store to read: sessions | messages | blackboard | daemons',
                    'enum': ['sessions', 'messages', 'blackboard', 'daemons'],
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
        'Save one durable fact to long-term memory (the only model write door). Use for user-stated '
        'preferences, project constraints, and feedback that must outlive this session. Pass a stable '
        'key to update an existing fact rather than duplicate. Sensitive topics are refused unless enabled.',
        _remember,
        {
            'type': 'object',
            'properties': {
                'fact': {'type': 'string', 'description': 'The fact to remember (one concise statement).'},
                'key': {
                    'type': 'string',
                    'description': 'Optional stable key; pass it to update an existing fact instead of creating a new one.',
                },
                'category': {
                    'type': 'string',
                    'enum': ['user', 'feedback', 'project', 'reference', 'general'],
                    'description': 'Memory category. Default general.',
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
