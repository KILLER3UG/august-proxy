"""Sessions table domain — workbench sessions and messages in SQLite."""
from __future__ import annotations

import json
from typing import cast

from app.json_narrowing import as_int, as_str
from app.services.memory_conn import conn as _conn
from app.services.memory_store.transcript_blocks import encode_blocks
from app.services.memory_store.wire import _row_as_wire, _session_field
from app.type_aliases import SessionRecord


def _begin_txn(conn) -> None:
    """Start an explicit transaction, tolerating an already-open one.

    Per-turn writers (``turn_outcomes`` / ``lifecycle`` / ``internal_state``)
    run on the loop thread and use ``deferred_writes.defer_commit``, which
    deliberately leaves the thread-local connection inside an open implicit
    transaction (only the COMMIT is debounced). A raw ``BEGIN`` on top of that
    raises "cannot start a transaction within a transaction" and the whole
    session save/delete is lost. Settling the open transaction first is safe —
    those rows only ever wanted a *later* commit, and committing now just makes
    them durable sooner — and it lets the explicit ``BEGIN`` below own a clean,
    atomic transaction. When a transaction is already open it already provides
    the atomicity the raw ``BEGIN`` was asking for, so we simply keep it.
    """
    if conn.in_transaction:
        conn.commit()
    conn.execute('BEGIN')


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
    if blob is None or is_archived is None:
        # ... and the same for the archive flag: an unrelated metadata write used
        # to reset it to 0, silently un-archiving a session the user parked.
        row = conn.execute(
            'SELECT workbench_blob, is_archived FROM sessions WHERE id = ?', (sid,)
        ).fetchone()
        if row is not None:
            try:
                stored_blob = row['workbench_blob']
                stored_archived = row['is_archived']
            except (KeyError, IndexError, TypeError):
                stored_blob = row[0] if row else None
                stored_archived = row[1] if row and len(row) > 1 else 0
            if blob is None:
                blob = stored_blob
            if is_archived is None:
                is_archived = bool(as_int(stored_archived, 0))
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


# Client-identity match window for the snapshot rewrite (migration 048). The
# workbench transcript and the desktop transcript are the same conversation
# seen from two sides, so the same message can differ in its TAIL: the desktop
# sends the typed text while the backend row carries the appended @git snapshot
# / bot-mention note, and a mid-turn save catches a partially streamed
# assistant reply. Both differences append, so the LEADING window identifies
# the message while a full-text comparison does not. 160 chars is long enough
# that an unrelated message must open identically to be adopted.
_CLIENT_MATCH_PREFIX = 160


def _normalize_text(content: object) -> str:
    text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, default=str)
    # The two writers spell a text message differently: the POST path stores
    # ``_json(content)`` (a JSON string, quotes included) while the snapshot
    # writer stores the bare string. Unwrap one so the pair can be compared.
    stripped = text.strip()
    if len(stripped) > 1 and stripped[0] == '"' and stripped[-1] == '"':
        try:
            decoded = json.loads(stripped)
        except (json.JSONDecodeError, TypeError, ValueError):
            decoded = None
        if isinstance(decoded, str):
            text = decoded
    return ' '.join(text.split())


def _same_message(a: object, b: object) -> bool:
    """True when two views of one message agree over the leading window.

    Either side may be the longer one: the desktop's text is a prefix of the
    backend's row (injected @git / bot notes), and a streamed assistant reply
    is a prefix of the finalized one.
    """
    left = _normalize_text(a)
    right = _normalize_text(b)
    if not left or not right:
        return False
    if left[:_CLIENT_MATCH_PREFIX] == right[:_CLIENT_MATCH_PREFIX]:
        return True
    if len(left) <= _CLIENT_MATCH_PREFIX and right.startswith(left):
        return True
    return len(right) <= _CLIENT_MATCH_PREFIX and left.startswith(right)


def _claim_client_rows(
    conn,
    sid: str,
) -> dict[str, list[dict[str, object]]]:
    """Existing client-authored rows of this session, grouped by role, in order.

    Only rows the desktop has claimed (``client_message_id IS NOT NULL``) take
    part: a server-derived row must never be adopted, or an enrichment PATCH
    could land on a message the client never authored.
    """
    rows = conn.execute(
        'SELECT id, role, content, client_message_id, blocks_json FROM messages'
        ' WHERE session_id = ? AND client_message_id IS NOT NULL ORDER BY id',
        (sid,),
    ).fetchall()
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        try:
            entry = {
                'id': row['id'],
                'role': row['role'],
                'content': row['content'],
                'clientMessageId': row['client_message_id'],
                'blocksJson': row['blocks_json'],
            }
        except (KeyError, IndexError, TypeError):
            entry = {
                'id': row[0],
                'role': row[1],
                'content': row[2],
                'clientMessageId': row[3],
                'blocksJson': row[4],
            }
        grouped.setdefault(as_str(entry['role'], 'user'), []).append(entry)
    return grouped


def _claim_client_row(
    bucket: dict[str, list[dict[str, object]]],
    role: str,
    content: object,
) -> dict[str, object] | None:
    """Take the earliest unclaimed client row that is the same message."""
    candidates = bucket.get(role)
    if not candidates:
        return None
    for index, entry in enumerate(candidates):
        if _same_message(entry['content'], content):
            return candidates.pop(index)
    return None


def save_workbench_session_sot(
    session_dict: dict[str, object],
    messages: list[dict[str, object]] | None = None,
) -> None:
    """Write session metadata, full blob, and messages in one SQLite transaction.

    This is the primary workbench save path. Optional JSON file export happens
    outside this function.

    Migration 048: the rewrite is DELETE-all + re-INSERT, which used to silently
    drop everything the desktop had synced. Client-authored identity and
    ``blocks_json`` are now carried across the rewrite, so the rich transcript
    a user sees survives the next durability barrier (model dispatch, tool
    step boundary, autosave). A row the snapshot no longer contains IS deleted —
    the backend transcript stays authoritative for removals (Undo, clear,
    regeneration) — and the client re-posts it on its next sync.
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
    # The workbench session object carries no archive flag — the UI owns it —
    # so writing the dict back used to reset `is_archived` to 0 on the next
    # autosave. Keep the stored value unless this caller states it explicitly.
    explicit_archived = 'isArchived' in session_dict or 'is_archived' in session_dict
    try:
        _begin_txn(conn)
        if explicit_archived:
            archived = 1 if (
                session_dict.get('isArchived') or session_dict.get('is_archived')
            ) else 0
        else:
            stored = conn.execute(
                'SELECT is_archived FROM sessions WHERE id = ?', (sid,)
            ).fetchone()
            try:
                stored_value = stored['is_archived'] if stored is not None else 0
            except (KeyError, IndexError, TypeError):
                stored_value = stored[0] if stored else 0
            archived = as_int(stored_value, 0)
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
                archived,
                as_str(session_dict.get('workspacePath'), ''),
                blob,
                updated,
            ),
        )
        # A durability barrier must not fail because of an optional nicety.
        # On a DB that somehow lacks the 048 column the save proceeds exactly
        # as it did before 048 (no identity carried across the rewrite).
        try:
            client_rows = _claim_client_rows(conn, sid)
            has_client_column = True
        except Exception:
            client_rows = {}
            has_client_column = False
        conn.execute('DELETE FROM messages WHERE session_id = ?', (sid,))
        rows: list[tuple[str, str, str, str | None, str | None]] = []
        # The unique index would reject a duplicate id inside this batch and
        # roll the whole save back; the first claim wins instead.
        seen_client_ids: set[str] = set()
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
            # 047: the structured timeline (blocks / thinking / tools /
            # attachments / todos …) rides beside `content`, which stays the
            # FTS-indexed text. NULL for a message with nothing structured.
            blocks_json = encode_blocks(msg)
            # 048: re-attach the desktop's identity for this message, and keep
            # the timeline it synced when the snapshot itself carries none
            # (the backend's own transcript cannot derive tool cards the
            # desktop rendered).
            client_id = msg.get('clientMessageId') or msg.get('client_message_id')
            claimed: dict[str, object] | None = None
            if isinstance(client_id, str) and client_id.strip():
                client_id = client_id.strip()
            else:
                client_id = None
                claimed = _claim_client_row(client_rows, role, content_str)
                if claimed is not None:
                    client_id = as_str(claimed.get('clientMessageId'), '') or None
            if blocks_json is None and claimed is not None:
                preserved = claimed.get('blocksJson')
                blocks_json = preserved if isinstance(preserved, str) else None
            if client_id is not None and client_id in seen_client_ids:
                client_id = None
            if client_id is not None:
                seen_client_ids.add(client_id)
            rows.append((sid, role, content_str, blocks_json, client_id))
        # One executemany instead of a per-row execute: the active session's
        # full transcript is re-written on every debounced save, so O(N)
        # round-trips were the dominant write cost on long sessions.
        if rows:
            if has_client_column:
                conn.executemany(
                    'INSERT INTO messages'
                    ' (session_id, role, content, blocks_json, client_message_id)'
                    ' VALUES (?, ?, ?, ?, ?)',
                    rows,
                )
            else:  # pre-048 database: the pre-048 shape, no identity column
                conn.executemany(
                    'INSERT INTO messages (session_id, role, content, blocks_json)'
                    ' VALUES (?, ?, ?, ?)',
                    [r[:4] for r in rows],
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    # Topic index (deterministic, no LLM): derive a session topic from the
    # title so workflow detection + topic-based cross-session recall have
    # data to work with (previously session_topics was never written).
    try:
        from app.services.memory_store.rest import index_session_topic

        topic = (title or '').strip()[:48]
        if topic:
            index_session_topic(sid, topic)
    except Exception:
        pass


def get_workbench_blob(session_id: str) -> dict[str, object] | None:
    """Load ONE workbench session blob from SQLite by id, or None.

    Used when a session was pruned from the in-memory map (the snapshot
    keeps only the top-50 by recency) — replying to a pruned session must
    resume the ORIGINAL conversation, not silently create a new one.
    """
    if not session_id:
        return None
    try:
        conn = _conn()
        row = conn.execute(
            'SELECT workbench_blob FROM sessions WHERE id = ? '
            'AND workbench_blob IS NOT NULL AND workbench_blob != \'\'',
            (session_id,),
        ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    try:
        raw = row['workbench_blob'] if hasattr(row, 'keys') else row[0]
    except (KeyError, IndexError, TypeError):
        raw = row[0] if row else None
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None
    return data if isinstance(data, dict) and data.get('id') else None


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


def session_archive_flags() -> dict[str, bool]:
    """Ids of archived sessions — the cheap read the sidebar needs.

    Deliberately NOT part of ``list_workbench_blobs``: that query drags the
    whole transcript blob for up to 500 sessions, and the only thing the caller
    wants here is a boolean. Only archived rows are returned, so the payload
    stays tiny and an absent id means "not archived" rather than "unknown".
    """
    conn = _conn()
    rows = conn.execute('SELECT id FROM sessions WHERE is_archived = 1').fetchall()
    flags: dict[str, bool] = {}
    for row in rows:
        try:
            sid = row['id'] if hasattr(row, 'keys') else row[0]
        except (KeyError, IndexError, TypeError):
            sid = row[0] if row else None
        if sid:
            flags[str(sid)] = True
    return flags


def list_sessions() -> list[SessionRecord]:
    """List all sessions, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessions ORDER BY started_at DESC').fetchall()
    return [cast(SessionRecord, _row_as_wire(r)) for r in rows]


def set_session_archived(sessionId: str, archived: bool) -> SessionRecord | None:
    """The single authority for parking a session; None when it does not exist.

    Both the REST surface (``PATCH /api/sessions/{id}``) and the legacy
    ``/api/august/sessions/manage`` action route call this, so the flag cannot
    be written two different ways.
    """
    session = get_session(sessionId)
    if not session:
        return None
    updated = dict(session)
    updated['isArchived'] = bool(archived)
    save_session(cast(SessionRecord, updated))
    return get_session(sessionId)


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
    'blackboard',
    # Learning rows carry raw user-message excerpts keyed by
    # session_id — deleting a session used to orphan them (still queryable in
    # the Curator UI after "delete this chat").
    'episodes',
    'turn_outcomes',
    # Local refine entries belong to the session that learned them; global
    # entries carry an empty session_id and are untouched by this purge
    # (same key-space rule as episodes). The refine journal survives with
    # the other audit journals — it is cleared by "clear activity logs".
    'refine_entries',
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
        _begin_txn(conn)
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
        # auto_memories cascade removed:
        # the store no longer exists, so a session delete has nothing to
        # clean up there.
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


