"""Sessions table domain."""
from __future__ import annotations
from typing import cast
from app.json_narrowing import as_str
from app.services.memory_conn import conn as _conn
from app.services.memory_store.wire import _row_as_wire, _session_field
from app.type_aliases import SessionRecord

def save_session(session: SessionRecord) -> None:
    """Persist a session record. Accepts camelCase wire keys (or snake_case)."""
    conn = _conn()
    # Dual-read: wire camelCase or snake_case
    sid = as_str(session.get('id'), '')
    title = _session_field(session, 'title', '')
    started_at = _session_field(session, 'startedAt')
    message_count = _session_field(session, 'messageCount', 0)
    provider = _session_field(session, 'provider', '')
    model = _session_field(session, 'model', '')
    folder_id = _session_field(session, 'folderId')
    is_archived = _session_field(session, 'isArchived')
    workspace_path = _session_field(session, 'workspacePath')
    conn.execute(
        'INSERT OR REPLACE INTO sessions (id, title, started_at, message_count, provider, model, folder_id, is_archived, workspace_path)\n           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (
            sid,
            title or '',
            started_at,
            message_count if message_count is not None else 0,
            provider or '',
            model or '',
            folder_id,
            1 if is_archived else 0,
            workspace_path,
        ),
    )
    conn.commit()


def list_sessions() -> list[SessionRecord]:
    """List all sessions, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessions ORDER BY started_at DESC').fetchall()
    return [cast(SessionRecord, _row_as_wire(r)) for r in rows]


def get_session(sessionId: str) -> SessionRecord | None:
    """Get a single session by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM sessions WHERE id = ?', (sessionId,)).fetchone()
    return cast(SessionRecord, _row_as_wire(row)) if row else None


def delete_session_record(sessionId: str) -> bool:
    """Delete a session record."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM sessions WHERE id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount > 0


