"""Memory, facts, brain_query, and session-deletion tool handlers + registration."""

from __future__ import annotations
import json
from app.json_narrowing import as_str
from app.services import tool_registry


async def _memorySearch(query: str) -> str:
    """Search past conversation memory."""
    from app.services.memory_store import search_memory

    try:
        results = search_memory(query)
        if not results:
            return f'No memory results for: {query}'
        lines = [f'Memory search results for: {query}\n']
        for r in results:
            key = as_str(r.get('key'), '')
            value = r.get('value', '')
            if isinstance(value, dict) or isinstance(value, list):
                value = json.dumps(value, indent=2)
            lines.append(f'  [{key}]: {str(value)[:500]}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error searching memory: {exc}'


async def _factSearch(query: str) -> str:
    """Search semantic facts in memory."""
    return await _memorySearch(query)


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
    # Workbench delete already cascaded + notified when present. Second pass
    # cleans orphans only; suppress duplicate UI events.
    result = memory_store.delete_session_cascade(sessionId, notify=not wb_ok)
    return {
        'ok': wb_ok or bool(result.get('ok')),
        'messages': int(result.get('messages') or 0),
        'children': result.get('children') or {},
        'workbench': wb_ok,
    }


async def _deleteSession(sessionId: str) -> str:
    """Delete a chat session and all dependent rows from workbench + brain DB."""
    try:
        result = _purge_session_everywhere(sessionId)
        if result.get('ok'):
            children = result.get('children') or {}
            msgCount = int(result.get('messages') or 0)
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
            result = _purge_session_everywhere(sid)
            if result.get('ok'):
                deleted.append(sid)
                msg_total += int(result.get('messages') or 0)
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
    from app.services.workbench.sessions import rename_workbench_session, get_workbench_session
    from app.services.workbench.context import currentSessionId

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
            result = _purge_session_everywhere(sid)
            if result.get('ok'):
                count += 1
                msgCount += int(result.get('messages') or 0)
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
        'brain_query',
        "Read-only query across any brain store (memory, autoMemories, heuristics, facts, sessions, messages, timeline, blackboard, graph, daemons, exams, examAttempts). Stores not yet shipped return 'not available'. Returns compact JSON rows.",
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
        'delete_folder',
        'Delete all sessions in a folder by folder ID. All messages in those sessions are also deleted. Use brain_query(store=sessions) to list sessions and their folderId values first. IMPORTANT: Before calling this tool, list the folder contents, present to the user exactly which folder and sessions you intend to delete, and wait for explicit user confirmation ("yes", "go ahead", "delete it") before proceeding. Never delete without confirmation.',
        _deleteFolder,
        {
            'type': 'object',
            'properties': {'folderId': {'type': 'string', 'description': 'The folder ID whose sessions to delete.'}},
            'required': ['folderId'],
        },
    )
