"""Sessions table domain — workbench sessions and messages in SQLite."""
from __future__ import annotations

import json
from typing import cast

from app.json_narrowing import as_int, as_str
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
    blob = session.get('workbenchBlob') or session.get('workbench_blob')
    updated_at = _session_field(session, 'updatedAt') or started_at
    # Preserve existing blob if caller only updates metadata
    if blob is None:
        row = conn.execute(
            'SELECT workbench_blob FROM sessions WHERE id = ?', (sid,)
        ).fetchone()
        if row is not None:
            try:
                blob = row['workbench_blob']
            except (KeyError, IndexError, TypeError):
                blob = row[0] if row else None
    conn.execute(
        '''INSERT OR REPLACE INTO sessions
           (id, title, started_at, message_count, provider, model, folder_id,
            is_archived, workspace_path, workbench_blob, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
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
            blob if isinstance(blob, str) else (json.dumps(blob) if blob is not None else None),
            updated_at,
        ),
    )
    conn.commit()


def save_workbench_session_sot(
    session_dict: dict[str, object],
    messages: list[dict[str, object]] | None = None,
) -> None:
    """Write session metadata, full blob, and messages in one SQLite transaction.

    This is the primary workbench save path. Optional JSON file export happens
    outside this function.
    """

    conn = _conn()
    sid = as_str(session_dict.get('id'), '')
    if not sid:
        raise ValueError('session id required')
    title = as_str(session_dict.get('title'), 'Workbench session')
    started = as_str(session_dict.get('startedAt') or session_dict.get('createdAt'), '')
    updated = as_str(session_dict.get('updatedAt'), started)
    msgs = messages if messages is not None else cast(
        list[dict[str, object]], session_dict.get('messages') or []
    )
    if not isinstance(msgs, list):
        msgs = []
    blob = json.dumps(session_dict, ensure_ascii=False, default=str)
    try:
        conn.execute('BEGIN')
        conn.execute(
            '''INSERT OR REPLACE INTO sessions
               (id, title, started_at, message_count, provider, model, folder_id,
                is_archived, workspace_path, workbench_blob, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                sid,
                title,
                started,
                len(msgs) or as_int(session_dict.get('messageCount'), 0),
                as_str(session_dict.get('provider'), ''),
                as_str(session_dict.get('model'), ''),
                session_dict.get('folderId'),
                1 if session_dict.get('isArchived') else 0,
                as_str(session_dict.get('workspacePath'), ''),
                blob,
                updated,
            ),
        )
        conn.execute('DELETE FROM messages WHERE session_id = ?', (sid,))
        for msg in msgs:
            if not isinstance(msg, dict):
                continue
            role = as_str(msg.get('role'), 'user')
            content = msg.get('content', '')
            if msg.get('tool_calls') is not None or msg.get('tool_use_id') is not None:
                payload: object = {
                    'content': content,
                    **{k: msg[k] for k in ('tool_calls', 'tool_use_id', 'name') if k in msg},
                }
            else:
                payload = content
            content_str = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
            conn.execute(
                'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                (sid, role, content_str),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def list_workbench_blobs(limit: int = 200) -> list[dict[str, object]]:
    """Load workbench session blobs from SQLite (newest first)."""
    conn = _conn()
    rows = conn.execute(
        '''SELECT workbench_blob FROM sessions
           WHERE workbench_blob IS NOT NULL AND workbench_blob != ''
           ORDER BY COALESCE(updated_at, started_at) DESC
           LIMIT ?''',
        (max(1, min(limit, 500)),),
    ).fetchall()
    out: list[dict[str, object]] = []
    for row in rows:
        try:
            raw = row['workbench_blob'] if hasattr(row, 'keys') else row[0]
        except (KeyError, IndexError, TypeError):
            raw = row[0] if row else None
        if not raw:
            continue
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(data, dict) and data.get('id'):
            out.append(cast(dict[str, object], data))
    return out


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


