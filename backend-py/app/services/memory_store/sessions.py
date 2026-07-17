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
    # UPSERT (not INSERT OR REPLACE): REPLACE is DELETE+INSERT and trips the
    # messages.session_id foreign key when child rows already exist.
    conn.execute(
        '''INSERT INTO sessions
           (id, title, started_at, message_count, provider, model, folder_id,
            is_archived, workspace_path, workbench_blob, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title,
             started_at=excluded.started_at,
             message_count=excluded.message_count,
             provider=excluded.provider,
             model=excluded.model,
             folder_id=excluded.folder_id,
             is_archived=excluded.is_archived,
             workspace_path=excluded.workspace_path,
             workbench_blob=excluded.workbench_blob,
             updated_at=excluded.updated_at''',
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
        # UPSERT (not INSERT OR REPLACE): REPLACE is DELETE+INSERT and trips the
        # messages.session_id foreign key when child rows already exist.
        conn.execute(
            '''INSERT INTO sessions
               (id, title, started_at, message_count, provider, model, folder_id,
                is_archived, workspace_path, workbench_blob, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,
                 started_at=excluded.started_at,
                 message_count=excluded.message_count,
                 provider=excluded.provider,
                 model=excluded.model,
                 folder_id=excluded.folder_id,
                 is_archived=excluded.is_archived,
                 workspace_path=excluded.workspace_path,
                 workbench_blob=excluded.workbench_blob,
                 updated_at=excluded.updated_at''',
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
                payload_dict: dict[str, object] = {'content': content}
                for k in ('tool_calls', 'tool_use_id', 'name'):
                    if k in msg:
                        payload_dict[k] = msg[k]
                payload: object = payload_dict
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


# Child tables that store per-session rows. ``messages`` has a real FK to
# ``sessions(id)`` (NO ACTION), so parent delete fails unless children go first.
# Other tables lack formal FKs but still hold orphan-prone session data.
_SESSION_CHILD_TABLES: tuple[str, ...] = (
    'messages',
    'episodic_timeline',
    'session_topics',
    'proposals',
    'lifecycle',
    'usage_events',
    'execution_state',
    'scratchpad',
    'tool_guardrail_log',
    'verifier_gate_log',
    'blackboard',
)


def _delete_messages_for_session(conn: object, sid: str) -> int:
    """Delete messages for a session, surviving partial FTS/index corruption.

    Bulk ``DELETE FROM messages WHERE session_id=?`` can raise
    ``database disk image is malformed`` when the messages FTS shadow
    tables are inconsistent. Rebuild FTS, then fall back to per-row
    deletes so cascade never gets stuck on one bad session.
    """
    import sqlite3

    c = cast(sqlite3.Connection, conn)  # typed loosely; always the brain sqlite connection
    try:
        cur = c.execute('DELETE FROM messages WHERE session_id = ?', (sid,))
        return int(cur.rowcount or 0)
    except sqlite3.DatabaseError:
        # FTS out of sync with base table — rebuild then retry bulk, then by id.
        try:
            c.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        except sqlite3.Error:
            pass
        try:
            cur = c.execute('DELETE FROM messages WHERE session_id = ?', (sid,))
            return int(cur.rowcount or 0)
        except sqlite3.DatabaseError:
            pass
        deleted = 0
        try:
            ids = [
                int(r[0])
                for r in c.execute(
                    'SELECT id FROM messages WHERE session_id = ?', (sid,)
                ).fetchall()
            ]
        except sqlite3.DatabaseError:
            ids = []
        for mid in ids:
            try:
                cur = c.execute('DELETE FROM messages WHERE id = ?', (mid,))
                deleted += int(cur.rowcount or 0)
            except sqlite3.DatabaseError:
                continue
        return deleted


def delete_session_cascade(
    sessionId: str, *, notify: bool = True
) -> dict[str, object]:
    """Delete a session and all dependent rows in one transaction.

    Always sweeps child tables even when the parent ``sessions`` row is
    already gone (orphans from prior partial deletes). Returns:
      ``{ok, sessionId, messages, children: {table: n}}``
    ``ok`` is True when a parent row or any child row was removed.

    When ``notify`` is True (default), fans out a real-time session-deleted
    event so the desktop sidebar can drop the row immediately.
    """
    import sqlite3

    conn = _conn()
    sid = as_str(sessionId, '')
    if not sid:
        return {'ok': False, 'sessionId': sid, 'messages': 0, 'children': {}}

    children: dict[str, int] = {}
    try:
        conn.execute('BEGIN')
        # Messages first (real FK + optional FTS corruption path).
        try:
            msg_n = _delete_messages_for_session(conn, sid)
            if msg_n:
                children['messages'] = msg_n
        except sqlite3.OperationalError:
            pass
        for table in _SESSION_CHILD_TABLES:
            if table == 'messages':
                continue
            try:
                cur = conn.execute(f'DELETE FROM {table} WHERE session_id = ?', (sid,))
                if cur.rowcount:
                    children[table] = int(cur.rowcount)
            except sqlite3.OperationalError:
                # Table may not exist on older / partial brains.
                pass
            except sqlite3.DatabaseError:
                # Non-fatal: continue so parent + other children still clean up.
                pass
        # Conversation auto-memories keyed by full session id.
        try:
            cur = conn.execute(
                "DELETE FROM auto_memories WHERE key = ? OR key LIKE ?",
                (f'conv_summary_{sid}', f'conv_summary_{sid}%'),
            )
            if cur.rowcount:
                children['auto_memories'] = int(cur.rowcount)
        except sqlite3.OperationalError:
            pass
        # Pending skill drafts attributed to this session.
        try:
            cur = conn.execute(
                'DELETE FROM pending_skills WHERE source_session_id = ?', (sid,)
            )
            if cur.rowcount:
                children['pending_skills'] = int(cur.rowcount)
        except sqlite3.OperationalError:
            pass
        cur = conn.execute('DELETE FROM sessions WHERE id = ?', (sid,))
        parent_deleted = cur.rowcount > 0
        conn.commit()
        any_child = bool(children)
        ok = parent_deleted or any_child
        if ok and notify:
            try:
                from app.services.workbench.sessions import notify_session_deleted

                notify_session_deleted(sid)
            except Exception:
                pass
        return {
            'ok': ok,
            'sessionId': sid,
            'messages': children.get('messages', 0),
            'children': children,
        }
    except Exception:
        conn.rollback()
        raise


def delete_session_record(sessionId: str) -> bool:
    """Delete a session and all dependent rows (messages, timeline, …).

    Cascades child deletes first so the ``messages.session_id`` FK cannot block
    the parent delete. Prefer this over calling ``delete_session_messages``
    then this function separately — order bugs caused FK failures historically.
    """
    result = delete_session_cascade(sessionId)
    return bool(result.get('ok'))


