"""Memory, facts, brain_query, and session-deletion tool handlers + registration."""

from __future__ import annotations

import asyncio
import json

from app.json_narrowing import as_int, as_str
from app.services import tool_registry


async def _memorySearch(query: str) -> str:
    """Search past conversation memory across KV store, auto_memories, and
    past session transcripts (cross-session recall)."""
    from app.services.memory.auto_memory import getRelevantMemories
    from app.services.memory_store import search_memory

    try:
        lines = [f'Memory search results for: {query}\n']
        found = False
        try:
            kv_results = search_memory(query) or []
        except Exception:
            kv_results = []
        for r in kv_results:
            found = True
            key = as_str(r.get('key'), '')
            value = r.get('value', '')
            if isinstance(value, dict) or isinstance(value, list):
                value = json.dumps(value, indent=2)
            lines.append(f'  [kv:{key}]: {str(value)[:500]}')
        try:
            auto_results = getRelevantMemories(query, limit=8) or []
        except Exception:
            auto_results = []
        for m in auto_results:
            found = True
            origin = as_str(m.get('origin') or m.get('source'), 'auto')
            title = as_str(m.get('title') or m.get('label'), as_str(m.get('key'), ''))
            desc = as_str(m.get('summary') or m.get('description') or m.get('content'), '')
            lines.append(f'  [{origin}:{title}]: {desc[:500]}')
        # Cross-session recall: past session transcripts are FTS-indexed —
        # surface the top hits so the model can reference what was said in
        # an earlier chat without knowing brain_query exists.
        try:
            from app.services.memory_store import brain_query as _bq

            past = _bq('messages', query, None, 3)
            pastDict: dict[str, object] = {}
            if isinstance(past, str):
                try:
                    parsed = json.loads(past)
                    if isinstance(parsed, dict):
                        pastDict = parsed
                except (json.JSONDecodeError, TypeError):
                    pastDict = {}
            elif isinstance(past, dict):
                pastDict = past
            rows = pastDict.get('rows') or pastDict.get('data') or []
            if isinstance(rows, list):
                for row in rows[:3]:
                    if not isinstance(row, dict):
                        continue
                    found = True
                    sid = as_str(row.get('session_id') or row.get('sessionId'), '?')
                    text = as_str(
                        row.get('content')
                        or row.get('text')
                        or row.get('summary')
                        or row.get('snippet'),
                        '',
                    )
                    lines.append(f'  [past-session:{sid}]: {text[:500]}')
        except Exception:
            pass
        if not found:
            return f'No memory results for: {query}'
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error searching memory: {exc}'


async def _factSearch(query: str) -> str:
    """Search semantic facts (KV + facts table) and include tagged auto_memories."""
    from app.services.memory.auto_memory import getRelevantMemories
    from app.services.memory_store import search_facts, search_memory

    try:
        lines = [f'Fact search results for: {query}\n']
        found = False
        try:
            for r in search_memory(query) or []:
                found = True
                key = as_str(r.get('key'), '')
                value = r.get('value', '')
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, indent=2)
                lines.append(f'  [kv:{key}]: {str(value)[:500]}')
        except Exception:
            pass
        try:
            for f in search_facts(query) or []:
                found = True
                if isinstance(f, dict):
                    fk = as_str(f.get('factKey') or f.get('fact_key') or f.get('key'), '')
                    fv = f.get('factValue') or f.get('fact_value') or f.get('value') or f
                    lines.append(f'  [fact:{fk}]: {str(fv)[:500]}')
                else:
                    lines.append(f'  [fact]: {str(f)[:500]}')
        except Exception:
            pass
        try:
            for m in getRelevantMemories(query, limit=5) or []:
                found = True
                origin = as_str(m.get('origin') or m.get('source'), 'auto')
                title = as_str(m.get('title') or m.get('label'), as_str(m.get('key'), ''))
                desc = as_str(m.get('summary') or m.get('description') or m.get('content'), '')
                lines.append(f'  [autoMemories/{origin}:{title}]: {desc[:500]}')
        except Exception:
            pass
        if not found:
            return f'No fact results for: {query}'
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error searching facts: {exc}'


async def _contextRead() -> str:
    """Read current context/profile from memory."""
    from app.services.memory_store import get_memory

    try:
        profile = get_memory('userProfile')
        context = get_memory('current_context')
        preferences = get_memory('user_preferences')
        parts = []
        if profile:
            parts.append(f'User Profile:\n{json.dumps(profile, indent=2)}')
        if context:
            parts.append(f'Current Context:\n{json.dumps(context, indent=2)}')
        if preferences:
            parts.append(f'Preferences:\n{json.dumps(preferences, indent=2)}')
        return '\n\n'.join(parts) if parts else 'No context stored yet.'
    except Exception as exc:
        return f'Error reading context: {exc}'


async def _rememberMemory(
    content: str,
    category: str = 'preference',
    importance: float = 0.7,
    pinned: bool = False,
) -> str:
    """Persist an intentional fact/preference for future sessions."""
    from app.services.memory.auto_memory import rememberMemory
    from app.services.memory.memory_scrubber import refuse_reason

    reason = refuse_reason(content)
    if reason:
        return reason
    try:
        clamped = max(0.0, min(1.0, float(importance or 0.7)))
        sid = ''
        try:
            from app.services.workbench.workbench import get_session

            sess = get_session()
            if sess is not None:
                sid = str(getattr(sess, 'id', '') or '')
        except Exception:
            pass
        item = rememberMemory(
            content, category=category, importance=clamped, pinned=pinned, session_id=sid
        )
        if not item:
            return 'Nothing saved: content was empty.'
        title = as_str(item.get('title') or item.get('label') or item.get('key'), '')
        mid = as_str(item.get('id') or item.get('key'), '')
        return f'Remembered: {title} [id: {mid}]'
    except Exception as exc:
        return f'Error saving memory: {exc}'


async def _forgetMemory(memoryId: int) -> str:
    """Remove a stored memory row by id (wrong or stale facts)."""
    from app.services.memory.auto_memory import delete_auto_memory, get_auto_memory

    try:
        mem = get_auto_memory(memoryId)
        if mem is None:
            return f'No memory found with id {memoryId}.'
        if delete_auto_memory(memoryId):
            title = as_str(mem.get('title') or mem.get('label') or mem.get('key'), str(memoryId))
            return f'Deleted memory: {title}'
        return f'Failed to delete memory {memoryId}.'
    except Exception as exc:
        return f'Error deleting memory: {exc}'


async def _updateMemory(
    memoryId: int,
    content: str = '',
    category: str = '',
    importance: float | None = None,
) -> str:
    """Update an existing memory in place (amendments must not create twins)."""
    from app.services.memory.auto_memory import get_auto_memory, update_auto_memory
    from app.services.memory.memory_scrubber import refuse_reason

    try:
        mem = get_auto_memory(memoryId)
        if mem is None:
            return f'No memory found with id {memoryId}.'
        if content and content.strip():
            reason = refuse_reason(content)
            if reason:
                return reason
        ok = update_auto_memory(
            memory_id=memoryId,
            content=content.strip() if content and content.strip() else None,
            category=category.strip() if category and category.strip() else None,
            importance=max(0.0, min(1.0, float(importance))) if importance is not None else None,
        )
        if not ok:
            return f'Failed to update memory {memoryId}.'
        title = as_str(mem.get('title') or mem.get('label') or mem.get('key'), str(memoryId))
        return f'Updated memory: {title} [id: {memoryId}]'
    except Exception as exc:
        return f'Error updating memory: {exc}'


async def _search(query: str, scope: str = 'memory,files', limit: int = 10) -> str:
    """Unified search across memory, files, and web with dedup."""
    from app.json_narrowing import as_int as _as_int

    scopes = [s.strip().lower() for s in (scope or 'memory,files').split(',') if s.strip()]
    lim = max(1, min(_as_int(limit, 10), 30))
    blocks: list[str] = []
    seen: set[str] = set()

    def _dedupe_key(text: str) -> str:
        return ' '.join(text.lower().split())[:200]

    if 'memory' in scopes or 'auto' in scopes:
        try:
            mem = await _memorySearch(query)
            if 'No memory results' not in mem:
                for line in mem.splitlines()[1:]:
                    k = _dedupe_key(line)
                    if k and k not in seen:
                        seen.add(k)
                        blocks.append(line)
                        if len(blocks) >= lim:
                            break
        except Exception:
            pass
        if 'fact' in scopes or 'memory' in scopes:
            try:
                fact = await _factSearch(query)
                if 'No fact results' not in fact:
                    for line in fact.splitlines()[1:]:
                        k = _dedupe_key(line)
                        if k and k not in seen:
                            seen.add(k)
                            blocks.append(line)
            except Exception:
                pass
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
    """Read-only unified brain query across any cognitive store.

    Returns compact JSON. Stores not yet shipped return "not available".
    """
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

def _purge_session_everywhere(sessionId: str) -> dict[str, object]:
    """Remove a session from workbench memory + brain SQLite (cascade children).

    Workbench delete emits ``session_deleted`` immediately (UI real-time) then
    cascades SQLite. A second cascade pass with notify=False sweeps orphans.
    """
    from app.services import memory_store

    wb_ok = False
    try:
        from app.services.workbench.sessions import delete_workbench_session

        wb_ok = bool(delete_workbench_session(sessionId))
    except Exception:
        # Fall through to brain cascade even if workbench module is unavailable.
        pass
    # Free the headless browser for this session — every session that used a
    # browser tool otherwise leaves a chromium process resident until app
    # shutdown (audit finding).
    try:
        from app.services.browser.session_manager import closeSession

        asyncio.run(closeSession(sessionId))
    except Exception:
        pass
    # Workbench delete already cascaded + notified when present. Second pass
    # cleans orphans only; suppress duplicate UI events.
    result = memory_store.delete_session_cascade(sessionId, notify=not wb_ok)
    return {
        'ok': wb_ok or bool(result.get('ok')),
        'messages': as_int(result.get('messages'), 0),
        'children': result.get('children') or {},
        'workbench': wb_ok,
    }


async def _deleteSession(sessionId: str) -> str:
    """Delete a chat session and all dependent rows from workbench + brain DB."""
    try:
        # SQLite cascades and the legacy JSON cleanup are synchronous.  Keep
        # them off the event loop so another chat can continue streaming while
        # a large session is being deleted.
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
            plane = 'workbench+brain' if result.get('workbench') else 'brain'
            return f'Deleted session {sessionId} via {plane} (+ {msgCount} message(s){extra_note}).'
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
    """Delete all sessions in a folder and their dependent rows from workbench + brain."""
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
    """Register memory and session tools."""
    tool_registry.register(
        'memory_search',
        'Search the key-value memory store for past conversation context and session notes. Use this to recall earlier information from the current or past sessions. For structured facts use fact_search; for cross-store search use brain_query.',
        _memorySearch,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Search query.'}},
            'required': ['query'],
        },
    )
    tool_registry.register(
        'fact_search',
        'Search structured semantic facts (key-value pairs with categories, confidence scores, and source tracking). Use this when looking for specific learned facts, preferences, or knowledge. For general conversation history use memory_search; for broad cross-store search use brain_query.',
        _factSearch,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Search query.'}},
            'required': ['query'],
        },
    )
    tool_registry.register(
        'context_read',
        "Read the user's current context and profile from memory: stored preferences, session goals, user profile data, and active context flags.",
        _contextRead,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'remember',
        'Store a durable memory for future sessions. Use for explicit remember requests, stable user preferences/corrections, or project facts not derivable from code/git. Update existing rows instead of duplicating; save before the turn ends. Categories: correction | preference | project | reference.',
        _rememberMemory,
        {
            'type': 'object',
            'properties': {
                'content': {
                    'type': 'string',
                    'description': 'The fact or preference to remember (one idea per call).',
                },
                'category': {
                    'type': 'string',
                    'enum': ['correction', 'preference', 'project', 'reference'],
                    'description': 'Memory type. Default preference.',
                },
                'importance': {
                    'type': 'number',
                    'description': '0.0-1.0 importance for recall ranking. Default 0.7.',
                },
                'pinned': {
                    'type': 'boolean',
                    'description': 'When true, inject this memory into every prompt (like user-added memory). Default false.',
                },
            },
            'required': ['content'],
        },
    )
    tool_registry.register(
        'forget',
        'Delete a stored memory by id when it is wrong, stale, transient, or no longer useful '
        'for future sessions. If an automatically recalled memory is clearly unnecessary to '
        'keep, clean it up proactively with this tool; do not delete a durable fact merely '
        'because it is irrelevant to the current turn. List memories first with '
        'brain_query(store=autoMemories) or memory_search.',
        _forgetMemory,
        {
            'type': 'object',
            'properties': {
                'memoryId': {
                    'type': 'integer',
                    'description': 'The memory id (from memory_search / brain_query / remember result).',
                }
            },
            'required': ['memoryId'],
        },
    )
    tool_registry.register(
        'update_memory',
        'Update an existing memory in place by its id (from memory_search / '
        'brain_query / remember). Use this when a stored memory is outdated or '
        'incomplete — amending via remember would create a duplicate row. '
        'Pass only the fields that change; omitted fields stay as-is.',
        _updateMemory,
        {
            'type': 'object',
            'properties': {
                'memoryId': {
                    'type': 'integer',
                    'description': 'The memory id to update (from memory_search / brain_query / remember).',
                },
                'content': {
                    'type': 'string',
                    'description': 'New content for the memory. Optional.',
                },
                'category': {
                    'type': 'string',
                    'enum': ['correction', 'preference', 'project', 'reference'],
                    'description': 'New category. Optional.',
                },
                'importance': {
                    'type': 'number',
                    'description': 'New importance 0.0-1.0. Optional.',
                },
            },
            'required': ['memoryId'],
        },
    )
    tool_registry.register(
        'brain_query',
        "Read-only query across any brain store (memory, autoMemories, heuristics, facts, sessions, messages, timeline, blackboard, graph, daemons, exams, examAttempts). Stores not yet shipped return 'not available'. Returns compact JSON rows. For autoMemories and graph, rows include human-readable label/description (and typeLabel/relationLabel) plus the stable technical id/key — prefer labels when explaining memories to the user; use id/key when calling other tools.",
        _brainQuery,
        {
            'type': 'object',
            'properties': {
                'store': {
                    'type': 'string',
                    'description': 'Which brain store to read: memory | autoMemories | heuristics | facts | sessions | messages | timeline | blackboard | graph | daemons | exams | examAttempts',
                    'enum': [
                        'memory',
                        'autoMemories',
                        'heuristics',
                        'facts',
                        'sessions',
                        'messages',
                        'timeline',
                        'blackboard',
                        'graph',
                        'daemons',
                        'exams',
                        'examAttempts',
                    ],
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
        'rename_session',
        'Rename a chat session in the sidebar when the user asks. '
        'Session titles are generated automatically after the first reply — '
        'do NOT call this just to invent a title for a new chat. '
        'Use a short 3–8 word title. Pass sessionId when known; for the current chat '
        '(see <session> in the system prompt) you may omit it.',
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
        'Delete a single chat session by its session ID (e.g. wb_20260715_143052_a1b2c3). '
        'The current chat id is in the <session> system-prompt block. '
        'For multiple sessions use delete_sessions (bulk) instead of calling this repeatedly. '
        'Cascades messages and dependent rows. Use brain_query(store=sessions) to list first. '
        'IMPORTANT: Confirm with the user before deleting.',
        _deleteSession,
        {
            'type': 'object',
            'properties': {'sessionId': {'type': 'string', 'description': 'The session ID to delete.'}},
            'required': ['sessionId'],
        },
    )
    tool_registry.register(
        'delete_sessions',
        'Bulk-delete multiple chat sessions in one call. Pass sessionIds as an array of IDs '
        '(e.g. from brain_query(store=sessions)). Prefer this over many delete_session calls. '
        'Cascades messages and dependent rows for each ID. '
        'IMPORTANT: List the exact sessions to the user and wait for explicit confirmation '
        'before calling. Never bulk-delete without confirmation.',
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
        'Unified search across memory, files, and web with dedup. Replaces needing memory_search vs fact_search vs brain_query vs search_files — one call, scope decides. Prefer this.',
        _search,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Search query.'},
                'scope': {
                    'type': 'string',
                    'description': 'Comma-separated scopes: memory,files,web (e.g. "memory,files"). Default memory,files.',
                },
                'limit': {'type': 'integer', 'description': 'Max results (1-30). Default 10.'},
            },
            'required': ['query'],
        },
    )
    tool_registry.register(
        'delete_folder',
        'Delete all sessions in a folder by folder ID. All messages in those sessions are also deleted. Use brain_query(store=sessions) to list sessions and their folderId values first. IMPORTANT: Before calling this tool, list the folder contents, present to the user exactly which folder and sessions you intend to delete, and wait for explicit user confirmation ("yes", "go ahead", "delete it") before proceeding. Never delete without confirmation.',
        _deleteFolder,
        {
            'type': 'object',
            'properties': {'folderId': {'type': 'string', 'description': 'The folder ID whose sessions to delete.'}},
            'required': ['folderId'],
        },
    )
