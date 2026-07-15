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
    """Remove a session from workbench memory + brain SQLite (cascade children)."""
    from app.services import memory_store

    wb_ok = False
    try:
        from app.services.workbench.sessions import delete_workbench_session

        wb_ok = bool(delete_workbench_session(sessionId))
    except Exception:
        # Fall through to brain cascade even if workbench module is unavailable.
        pass
    # Workbench delete already cascades when the session exists in SQLite; run
    # cascade again for orphan brain rows (id present only in messages/timeline).
    result = memory_store.delete_session_cascade(sessionId)
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
        'delete_session',
        'Delete a chat session by its session ID (e.g. wb_20260715_143052_a1b2c3). Cascades: messages, timeline entries, usage, topics, and other dependent rows are deleted first so foreign keys cannot block the delete. Use brain_query(store=sessions) to list sessions first. IMPORTANT: Before calling this tool, list the sessions, present to the user exactly which session(s) you intend to delete, and wait for explicit user confirmation ("yes", "go ahead", "delete it") before proceeding. Never delete without confirmation.',
        _deleteSession,
        {
            'type': 'object',
            'properties': {'sessionId': {'type': 'string', 'description': 'The session ID to delete.'}},
            'required': ['sessionId'],
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
