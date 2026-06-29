"""
SQLite memory store — persists conversations, facts, proposals, lifecycle,
and index data. The core persistence layer for the August "brain".

Port of backend/services/memory/sqlite-memory-store.js (1,431 lines).
Uses aiosqlite for async access and a sync sqlite3 fallback.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from app.lib.paths import data_path

# ── Configuration ────────────────────────────────────────────────────

_BRAIN_FILE_ENV = "AUGUST_BRAIN_SQLITE_FILE"
_DEFAULT_BRAIN_FILE = "august_brain.sqlite"
_TIMEOUT_MS = 10000
_BUSY_RETRIES = 2

_local = threading.local()


# ── Database helpers ─────────────────────────────────────────────────


def _db_path() -> Path:
    """Resolve the brain SQLite database path."""
    env_path = os.environ.get(_BRAIN_FILE_ENV)
    if env_path:
        return Path(env_path)
    return data_path(_DEFAULT_BRAIN_FILE)


def _conn() -> sqlite3.Connection:
    """Get a thread-local connection to the brain database."""
    if not hasattr(_local, "conn") or _local.conn is None:
        db_path = _db_path()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path), timeout=_TIMEOUT_MS / 1000)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")  # Phase 0: raised from 5000 for write-queue safety
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return _local.conn


def close() -> None:
    """Close the thread-local connection."""
    if hasattr(_local, "conn") and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None


# ── Value helpers ────────────────────────────────────────────────────


def _q(value: Any) -> str:
    """Quote a value for SQL (sync helper)."""
    if value is None:
        return "NULL"
    return f"'{str(value).replace(chr(39), chr(39) + chr(39))}'"


def _json(value: Any) -> str:
    """Serialize a value to JSON for storage."""
    return json.dumps(value)


# ── Schema ───────────────────────────────────────────────────────────


def init() -> None:
    """Create all tables on first use."""
    conn = _conn()

    # ── Phase 0 schema additions ──────────────────────────────────────
    # These go through executescript so the full DDL + triggers are atomic.
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_store (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- FTS5 on memory_store (content-sync table — triggers added below in Phase 0)
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_store_fts USING fts5(
            key, value, content='memory_store', content_rowid='rowid'
        );

        CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact_key TEXT UNIQUE NOT NULL,
            fact_value TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source TEXT DEFAULT '',
            confidence REAL DEFAULT 1.0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            proposal_type TEXT NOT NULL,
            content TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now')),
            decided_at TEXT,
            decided_by TEXT
        );

        CREATE TABLE IF NOT EXISTS lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            event_type TEXT NOT NULL,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS session_topics (
            session_id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            parent_topic TEXT,
            confidence REAL DEFAULT 0.75,
            classified_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            started_at TEXT,
            message_count INTEGER DEFAULT 0,
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            folder_id TEXT,
            is_archived INTEGER DEFAULT 0,
            workspace_path TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            context_tokens INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS config_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            action TEXT NOT NULL,
            actor TEXT DEFAULT '',
            before_json TEXT,
            after_json TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- ═══════════════════════════════════════════════════════════════
        -- Phase 0: Learned Heuristics table
        -- ═══════════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS learned_heuristics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule TEXT NOT NULL,
            source TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- ═══════════════════════════════════════════════════════════════
        -- Phase 0: Flattened auto_memories (individual FTS-indexed rows)
        -- ═══════════════════════════════════════════════════════════════
        CREATE TABLE IF NOT EXISTS auto_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT,
            content TEXT,
            category TEXT DEFAULT 'auto',
            importance REAL DEFAULT 0.5,
            source TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS auto_memories_fts USING fts5(
            key, content, content='auto_memories', content_rowid='rowid'
        );

        -- ═══════════════════════════════════════════════════════════════
        -- Phase 0: FTS5 triggers — CRITICAL — without these FTS indexes
        -- stay empty. Both memory_store_fts and auto_memories_fts need
        -- INSERT/UPDATE/DELETE triggers.
        -- ═══════════════════════════════════════════════════════════════

        -- memory_store_fts triggers (fixes existing broken FTS)
        CREATE TRIGGER IF NOT EXISTS memory_store_fts_ai AFTER INSERT ON memory_store BEGIN
            INSERT INTO memory_store_fts(rowid, key, value)
            VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_store_fts_ad AFTER DELETE ON memory_store BEGIN
            INSERT INTO memory_store_fts(memory_store_fts, rowid, key, value)
            VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_store_fts_au AFTER UPDATE ON memory_store BEGIN
            INSERT INTO memory_store_fts(memory_store_fts, rowid, key, value)
            VALUES('delete', old.rowid, old.key, old.value);
            INSERT INTO memory_store_fts(rowid, key, value)
            VALUES (new.rowid, new.key, new.value);
        END;

        -- auto_memories_fts triggers
        CREATE TRIGGER IF NOT EXISTS auto_memories_ai AFTER INSERT ON auto_memories BEGIN
            INSERT INTO auto_memories_fts(rowid, key, content)
            VALUES (new.id, new.key, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS auto_memories_ad AFTER DELETE ON auto_memories BEGIN
            INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)
            VALUES('delete', old.id, old.key, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS auto_memories_au AFTER UPDATE ON auto_memories BEGIN
            INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)
            VALUES('delete', old.id, old.key, old.content);
            INSERT INTO auto_memories_fts(rowid, key, content)
            VALUES (new.id, new.key, new.content);
        END;

        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_session ON lifecycle(session_id);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON lifecycle(event_type);
        CREATE INDEX IF NOT EXISTS idx_config_audit_category ON config_audit(category);
        CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit(created_at);
    """)
    conn.commit()

    # Idempotent backfill: populate memory_store_fts for rows inserted before
    # triggers existed. Only runs if the FTS table is empty.
    row_count = conn.execute("SELECT count(*) FROM memory_store_fts").fetchone()[0]
    if row_count == 0:
        conn.execute("""
        INSERT INTO memory_store_fts(rowid, key, value)
        SELECT rowid, key, value FROM memory_store
    """)
    conn.commit()

    # v1.1 migration: add updated_at to auto_memories if missing
    # (the column is declared in the CREATE TABLE above for new DBs; this
    # block handles DBs created before v1.1.)
    # Note: SQLite ALTER TABLE ADD COLUMN cannot use a non-constant DEFAULT
    # like datetime('now'). Existing rows get NULL; auto_memory.save_auto_memory
    # always sets updated_at explicitly on UPDATE, so new rows are fine.
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(auto_memories)").fetchall()]
        if "updated_at" not in cols:
            conn.execute("ALTER TABLE auto_memories ADD COLUMN updated_at TEXT")
    except Exception as exc:
        import logging
        logging.warning("auto_memories updated_at migration failed: %s", exc)

    # Phase 9: episodic_timeline table (idempotent)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS episodic_timeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            session_id TEXT,
            event_summary TEXT,
            category TEXT DEFAULT 'general'
        )
    """)

    # Phase 10: blackboard table (inter-agent coordination)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS blackboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            agent TEXT NOT NULL DEFAULT 'main',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            priority INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT
        )
    """)

    # v3: Exam tables (added idempotently; only created if not exist)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            topic TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            source TEXT DEFAULT 'model',
            source_files TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS exam_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            stem TEXT NOT NULL,
            options TEXT NOT NULL,
            correct_index INTEGER NOT NULL,
            rationale TEXT DEFAULT '',
            source_snippet TEXT DEFAULT '',
            origin TEXT DEFAULT 'generated',
            FOREIGN KEY (exam_id) REFERENCES exams(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS exam_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            question_id INTEGER NOT NULL,
            selected_index INTEGER,
            is_correct INTEGER DEFAULT 0,
            asked_for_help INTEGER DEFAULT 0,
            answered_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()

    # Idempotent additive migration: add context_tokens to pre-existing
    # usage_events tables that were created before this column shipped.
    _ensure_column(conn, "usage_events", "context_tokens", "INTEGER DEFAULT 0")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column to a table if it does not already exist (idempotent)."""
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        conn.commit()


# ── Memory key-value store ───────────────────────────────────────────


def save_memory(key: str, value: Any) -> None:
    """Save a key-value pair to memory."""
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        (key, _json(value)),
    )
    conn.commit()


def get_memory(key: str) -> Any | None:
    """Get a value from memory by key."""
    conn = _conn()
    row = conn.execute("SELECT value FROM memory_store WHERE key = ?", (key,)).fetchone()
    if row:
        try:
            return json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            return row["value"]
    return None


def delete_memory(key: str) -> bool:
    """Delete a memory key. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute("DELETE FROM memory_store WHERE key = ?", (key,))
    conn.commit()
    return cursor.rowcount > 0


def list_memory(pattern: str = "%") -> list[dict[str, Any]]:
    """List memory entries with optional key pattern matching."""
    conn = _conn()
    rows = conn.execute(
        "SELECT key, value, updated_at FROM memory_store WHERE key LIKE ? ORDER BY updated_at DESC",
        (pattern,),
    ).fetchall()
    results = []
    for r in rows:
        try:
            val = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            val = r["value"]
        results.append({"key": r["key"], "value": val, "updated_at": r["updated_at"]})
    return results


# ── FTS search ───────────────────────────────────────────────────────


def search_memory(query: str) -> list[dict[str, Any]]:
    """Full-text search across memory keys and values."""
    if not query or not query.strip():
        return []

    conn = _conn()
    try:
        # Prepare the query for FTS5 (escape special characters, add prefix matching)
        fts_query = " OR ".join(f'"{w}"*' for w in query.strip().split() if w)
        if not fts_query:
            return []

        rows = conn.execute(
            """SELECT key, value FROM memory_store_fts WHERE content MATCH ?
               ORDER BY rank LIMIT 20""",
            (fts_query,),
        ).fetchall()

        results = []
        for r in rows:
            try:
                val = json.loads(r["value"])
            except (json.JSONDecodeError, TypeError):
                val = r["value"]
            results.append({"key": r["key"], "value": val})
        return results
    except sqlite3.OperationalError:
        # FTS may not be available or query syntax error; fall back to LIKE
        like_query = f"%{query.strip()}%"
        rows = conn.execute(
            "SELECT key, value FROM memory_store WHERE key LIKE ? OR value LIKE ? LIMIT 20",
            (like_query, like_query),
        ).fetchall()
        results = []
        for r in rows:
            try:
                val = json.loads(r["value"])
            except (json.JSONDecodeError, TypeError):
                val = r["value"]
            results.append({"key": r["key"], "value": val})
        return results


# ── Facts ─────────────────────────────────────────────────────────────


def save_fact(fact_key: str, fact_value: Any, category: str = "general", source: str = "", confidence: float = 1.0) -> None:
    """Save a structured fact."""
    conn = _conn()
    conn.execute(
        """INSERT OR REPLACE INTO facts (fact_key, fact_value, category, source, confidence, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))""",
        (fact_key, _json(fact_value), category, source, confidence),
    )
    conn.commit()


def get_fact(fact_key: str) -> dict[str, Any] | None:
    """Get a fact by key."""
    conn = _conn()
    row = conn.execute("SELECT * FROM facts WHERE fact_key = ?", (fact_key,)).fetchone()
    if not row:
        return None
    return dict(row)


def search_facts(query: str, category: str = "") -> list[dict[str, Any]]:
    """Search facts by key or value."""
    conn = _conn()
    like = f"%{query}%"
    if category:
        rows = conn.execute(
            "SELECT * FROM facts WHERE (fact_key LIKE ? OR fact_value LIKE ?) AND category = ? ORDER BY updated_at DESC LIMIT 20",
            (like, like, category),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM facts WHERE fact_key LIKE ? OR fact_value LIKE ? ORDER BY updated_at DESC LIMIT 20",
            (like, like),
        ).fetchall()
    return [dict(r) for r in rows]


def list_facts(category: str = "") -> list[dict[str, Any]]:
    """List facts, optionally filtered by category."""
    conn = _conn()
    if category:
        rows = conn.execute("SELECT * FROM facts WHERE category = ? ORDER BY updated_at DESC", (category,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM facts ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


def delete_fact(fact_key: str) -> bool:
    """Delete a fact by key."""
    conn = _conn()
    cursor = conn.execute("DELETE FROM facts WHERE fact_key = ?", (fact_key,))
    conn.commit()
    return cursor.rowcount > 0


# ── Proposals (plan/approval lifecycle) ──────────────────────────────


def save_proposal(session_id: str, proposal_type: str, content: Any) -> int:
    """Save a proposal (plan, mutation, etc.)."""
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO proposals (session_id, proposal_type, content) VALUES (?, ?, ?)",
        (session_id, proposal_type, _json(content)),
    )
    conn.commit()
    return cursor.lastrowid


def get_proposal(proposal_id: int) -> dict[str, Any] | None:
    """Get a proposal by ID."""
    conn = _conn()
    row = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    return dict(row) if row else None


def list_proposals(session_id: str, status: str = "") -> list[dict[str, Any]]:
    """List proposals for a session, optionally filtered by status."""
    conn = _conn()
    if status:
        rows = conn.execute(
            "SELECT * FROM proposals WHERE session_id = ? AND status = ? ORDER BY created_at DESC",
            (session_id, status),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM proposals WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def decide_proposal(proposal_id: int, status: str, decided_by: str = "") -> bool:
    """Decide (approve/reject) a proposal."""
    conn = _conn()
    cursor = conn.execute(
        "UPDATE proposals SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?",
        (status, decided_by, proposal_id),
    )
    conn.commit()
    return cursor.rowcount > 0


# ── Lifecycle events ─────────────────────────────────────────────────


def record_lifecycle(session_id: str, event_type: str, detail: Any = None) -> int:
    """Record a lifecycle event."""
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO lifecycle (session_id, event_type, detail) VALUES (?, ?, ?)",
        (session_id, event_type, _json(detail) if detail else None),
    )
    conn.commit()
    return cursor.lastrowid


def list_lifecycle(session_id: str, event_type: str = "", limit: int = 100) -> list[dict[str, Any]]:
    """List lifecycle events for a session."""
    conn = _conn()
    if event_type:
        rows = conn.execute(
            "SELECT * FROM lifecycle WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?",
            (session_id, event_type, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM lifecycle WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Config audit ─────────────────────────────────────────────────────


def record_config_audit(
    category: str,
    action: str,
    actor: str = "",
    before: Any = None,
    after: Any = None,
) -> int:
    """Record a structured config-change audit entry.

    Used by alias, fallback, and agent mutation paths so that every
    self-configuration change is traceable.
    """
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO config_audit (category, action, actor, before_json, after_json) VALUES (?, ?, ?, ?, ?)",
        (category, action, actor, _json(before) if before is not None else None, _json(after) if after is not None else None),
    )
    conn.commit()
    return cursor.lastrowid


def list_config_audit(category: str = "", limit: int = 200) -> list[dict[str, Any]]:
    """List config-change audit entries, newest first."""
    conn = _conn()
    if category:
        rows = conn.execute(
            "SELECT * FROM config_audit WHERE category = ? ORDER BY created_at DESC LIMIT ?",
            (category, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM config_audit ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    results = []
    for r in rows:
        entry = {
            "id": r["id"],
            "category": r["category"],
            "action": r["action"],
            "actor": r["actor"] or "",
            "createdAt": r["created_at"],
        }
        for raw_key, out_key in (("before_json", "before"), ("after_json", "after")):
            # r is a sqlite3.Row; index by column name.
            raw = r[raw_key]
            if isinstance(raw, str):
                try:
                    entry[out_key] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    entry[out_key] = raw
            else:
                entry[out_key] = raw
        results.append(entry)
    return results


# ── Session topic indexing ───────────────────────────────────────────


def index_session_topic(session_id: str, topic: str, parent_topic: str | None = None, confidence: float = 0.75) -> bool:
    """Record or update the topic for a session."""
    conn = _conn()
    try:
        conn.execute(
            """INSERT INTO session_topics (session_id, topic, parent_topic, confidence, classified_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(session_id) DO UPDATE SET
                   topic=excluded.topic,
                   parent_topic=excluded.parent_topic,
                   confidence=excluded.confidence,
                   classified_at=excluded.classified_at""",
            (session_id, topic, parent_topic, confidence),
        )
        conn.commit()
        return True
    except Exception:
        return False


def get_session_topic(session_id: str) -> dict[str, Any] | None:
    """Get the classified topic for a session."""
    conn = _conn()
    row = conn.execute("SELECT * FROM session_topics WHERE session_id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def list_topics(limit: int = 50) -> list[dict[str, Any]]:
    """List all classified session topics, most recent first."""
    conn = _conn()
    rows = conn.execute(
        "SELECT * FROM session_topics ORDER BY classified_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def search_sessions_by_topic(topic: str) -> list[dict[str, Any]]:
    """Find sessions with a given topic classification."""
    conn = _conn()
    rows = conn.execute(
        "SELECT * FROM session_topics WHERE topic = ? ORDER BY classified_at DESC", (topic,)
    ).fetchall()
    return [dict(r) for r in rows]


# ── Session persistence ──────────────────────────────────────────────


def save_session(session: dict[str, Any]) -> None:
    """Persist a session record."""
    conn = _conn()
    conn.execute(
        """INSERT OR REPLACE INTO sessions (id, title, started_at, message_count, provider, model, folder_id, is_archived, workspace_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session["id"],
            session.get("title", ""),
            session.get("startedAt"),
            session.get("messageCount", 0),
            session.get("provider", ""),
            session.get("model", ""),
            session.get("folderId"),
            1 if session.get("isArchived") else 0,
            session.get("workspacePath"),
        ),
    )
    conn.commit()


def list_sessions() -> list[dict[str, Any]]:
    """List all sessions, most recent first."""
    conn = _conn()
    rows = conn.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_session(session_id: str) -> dict[str, Any] | None:
    """Get a single session by ID."""
    conn = _conn()
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def delete_session_record(session_id: str) -> bool:
    """Delete a session record."""
    conn = _conn()
    cursor = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    return cursor.rowcount > 0


# ── Messages ─────────────────────────────────────────────────────────


def save_message(session_id: str, role: str, content: Any) -> int:
    """Save a message to a session."""
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
        (session_id, role, _json(content)),
    )
    conn.commit()
    return cursor.lastrowid


def get_messages(session_id: str) -> list[dict[str, Any]]:
    """Get all messages for a session."""
    conn = _conn()
    rows = conn.execute(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at", (session_id,)
    ).fetchall()
    results = []
    for r in rows:
        msg = dict(r)
        try:
            msg["content"] = json.loads(msg["content"]) if isinstance(msg["content"], str) else msg["content"]
        except (json.JSONDecodeError, TypeError):
            pass
        results.append(msg)
    return results


def delete_session_messages(session_id: str) -> int:
    """Delete all messages for a session."""
    conn = _conn()
    cursor = conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    conn.commit()
    return cursor.rowcount


# ── Usage events ─────────────────────────────────────────────────────


def record_usage(
    session_id: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    context_tokens: int = 0,
) -> int:
    """Record a usage event.

    ``context_tokens`` captures the provider-reported ``input_tokens`` of the
    FINAL sub-call in the agentic turn — i.e. the true current context fill
    (system prompt + tools + messages, counted once). The cumulative
    ``input_tokens``/``output_tokens`` are still recorded for Usage-page totals.
    """
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO usage_events (session_id, model, input_tokens, output_tokens, context_tokens) "
        "VALUES (?, ?, ?, ?, ?)",
        (session_id, model, input_tokens, output_tokens, context_tokens),
    )
    conn.commit()
    return cursor.lastrowid


def get_usage(session_id: str) -> dict[str, Any]:
    """Get aggregated usage for a session.

    Returns cumulative totals (for the Usage page) plus ``latest_context_tokens``
    — the ``context_tokens`` of the most recent usage event, which equals the
    provider-reported input_tokens of the final sub-call of the latest turn
    (the true current context fill). Also returns the per-event list ordered
    newest-first so the caller can derive the same value independently.
    """
    conn = _conn()
    row = conn.execute(
        "SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as request_count "
        "FROM usage_events WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    totals = dict(row) if row else {"total_input": 0, "total_output": 0, "request_count": 0}

    latest = conn.execute(
        "SELECT context_tokens, input_tokens FROM usage_events "
        "WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    if latest:
        # Prefer the dedicated context_tokens column; fall back to input_tokens
        # for rows recorded before the column existed (context_tokens == 0).
        latest_ctx = latest["context_tokens"] or latest["input_tokens"]
    else:
        latest_ctx = 0

    events = [
        {
            "id": e["id"],
            "model": e["model"],
            "inputTokens": e["input_tokens"],
            "outputTokens": e["output_tokens"],
            "contextTokens": e["context_tokens"] or e["input_tokens"],
            "totalTokens": (e["input_tokens"] or 0) + (e["output_tokens"] or 0),
            "createdAt": e["created_at"],
        }
        for e in conn.execute(
            "SELECT id, model, input_tokens, output_tokens, context_tokens, created_at "
            "FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC",
            (session_id,),
        ).fetchall()
    ]

    return {
        "sessionId": session_id,
        "totalEvents": totals.get("request_count", 0) or 0,
        "totalInputTokens": totals.get("total_input", 0) or 0,
        "totalOutputTokens": totals.get("total_output", 0) or 0,
        "totalTokens": (totals.get("total_input", 0) or 0) + (totals.get("total_output", 0) or 0),
        "totalCost": 0.0,
        "model": events[0]["model"] if events else None,
        "provider": None,
        "contextTokens": latest_ctx,
        "latestContextTokens": latest_ctx,
        "events": events,
    }


# ── Maintenance ──────────────────────────────────────────────────────


def vacuum() -> None:
    """Vacuum the database to reclaim space."""
    conn = _conn()
    conn.execute("VACUUM")
    conn.commit()


def get_stats() -> dict[str, Any]:
    """Get database statistics."""
    conn = _conn()
    stats = {}

    for table in ["memory_store", "facts", "proposals", "sessions", "messages", "usage_events", "session_topics"]:
        try:
            row = conn.execute(f"SELECT COUNT(*) as count FROM {table}").fetchone()
            stats[table] = row["count"] if row else 0
        except Exception:
            stats[table] = 0

    stats["db_size_bytes"] = _db_path().stat().st_size if _db_path().exists() else 0
    return stats


# ── brain_query (Phase 0, §11 of the cognitive architecture spec) ────────

# Supported stores and their backing tables/sources.
# Stores from later phases (timeline, blackboard, daemons, exams) return
# "not available" until their table ships.
_BRAIN_STORES: dict[str, dict[str, Any]] = {
    "memory": {
        "table": "memory_store",
        "fts": "memory_store_fts",
        "columns": "key, value, updated_at",
        "search_cols": ["key", "value"],
        "label": "key-value memory store",
    },
    "auto_memories": {
        "table": "auto_memories",
        "fts": "auto_memories_fts",
        "columns": "id, key, content, category, importance, created_at",
        "search_cols": ["key", "content"],
        "label": "auto-captured memories",
    },
    "heuristics": {
        "table": "learned_heuristics",
        "fts": None,
        "columns": "id, rule, source, category, created_at, updated_at",
        "search_cols": ["rule", "source"],
        "label": "learned behavioral rules",
    },
    "facts": {
        "table": "facts",
        "fts": None,
        "columns": "id, fact_key, fact_value, category, source, confidence, created_at, updated_at",
        "search_cols": ["fact_key", "fact_value"],
        "label": "structured semantic facts",
    },
    "sessions": {
        "table": "sessions",
        "fts": None,
        "columns": "id, title, started_at, message_count, provider, model, workspace_path",
        "search_cols": ["title", "id"],
        "label": "conversation sessions",
    },
    "messages": {
        "table": "messages",
        "fts": None,
        "columns": "id, session_id, role, content, created_at",
        "search_cols": ["content"],
        "label": "chat messages",
    },
    "timeline": {
        "table": "episodic_timeline",
        "fts": None,
        "columns": "id, timestamp, session_id, event_summary, category",
        "search_cols": ["event_summary", "category", "session_id"],
        "label": "episodic timeline entries",
    },
    "blackboard": {
        "table": "blackboard",
        "fts": None,
        "columns": "id, session_id, agent, key, value, priority, created_at, expires_at",
        "search_cols": ["agent", "key", "value"],
        "label": "inter-agent blackboard notes",
    },
    "exams": {
        "table": "exams",
        "fts": None,
        "columns": "id, title, topic, created_at, source, source_files",
        "search_cols": ["title", "topic"],
        "label": "exam sessions",
    },
    "exam_attempts": {
        "table": "exam_attempts",
        "fts": None,
        "columns": "id, exam_id, question_id, selected_index, is_correct, asked_for_help, answered_at",
        "search_cols": ["exam_id"],
        "label": "exam attempt history",
    },
    # ── Custom handlers (not metadata-driven; routed explicitly in brain_query) ──
    # "graph":     JSON file (august_graph_memory.json)        v1.1
    # "daemons":   live daemon registry (Phase 8)              v1.1
}


def _brain_query_graph(query: str, filters: dict | None, limit: int) -> str:
    """v1.1: Read graph entities/relations from august_graph_memory.json.

    Returns list of {entity, type, attributes} or {source, relation, target} rows.
    If the JSON file is missing or empty, returns an empty list (NOT an error).
    """
    try:
        import json as _json
        import os as _os
        # Try a few common locations for the graph JSON
        candidates = [
            _os.path.join("data", "august_graph_memory.json"),
            "august_graph_memory.json",
            _os.path.expanduser("~/.august/august_graph_memory.json"),
        ]
        graph_path = next((p for p in candidates if _os.path.exists(p)), None)
        if graph_path is None:
            return _json.dumps([])
        with open(graph_path, "r", encoding="utf-8") as f:
            data = _json.load(f)
    except (ImportError, _json.JSONDecodeError, OSError):
        return _json.dumps([])

    rows: list[dict] = []
    entities = data.get("entities", []) if isinstance(data, dict) else []
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name", "")
        if query and query.lower() not in name.lower():
            continue
        rows.append({"entity": name, "type": ent.get("type", ""), "attributes": ent.get("attributes", {})})
        if len(rows) >= limit:
            return _json.dumps(rows[:limit], ensure_ascii=False)

    if len(rows) < limit:
        relations = data.get("relations", []) if isinstance(data, dict) else []
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            source = rel.get("source", "")
            target = rel.get("target", "")
            if query and query.lower() not in (source + target).lower():
                continue
            rows.append({"source": source, "relation": rel.get("relation", ""), "target": target})
            if len(rows) >= limit:
                break
    return _json.dumps(rows[:limit], ensure_ascii=False)


def _brain_query_daemons(query: str, filters: dict | None, limit: int) -> str:
    """v1.1: Read live daemon registry (Phase 8).

    Returns list of {session_id, name, status, watch_condition, last_check, error} rows.
    If no daemons are running, returns an empty list.
    Gracefully degrades if daemon_manager is unavailable (returns []).
    """
    import json as _json
    try:
        from app.services import daemon_manager
    except ImportError:
        return _json.dumps([])
    try:
        # Read internal daemon registry. The exact data shape may vary across
        # daemon_manager revisions; be defensive and skip on any error.
        internal = getattr(daemon_manager, "_daemons", None)
        if not isinstance(internal, dict):
            return _json.dumps([])
        rows: list[dict] = []
        for session_id, daemons in internal.items():
            for d in daemons or []:
                # DaemonSpec is a dataclass; convert via __dict__ or .keys
                if hasattr(d, "__dict__"):
                    info = dict(d.__dict__)
                elif isinstance(d, dict):
                    info = d
                else:
                    continue
                row = {
                    "session_id": session_id,
                    "name": info.get("name", ""),
                    "status": info.get("status", "unknown"),
                    "watch_condition": info.get("watch_condition"),
                    "last_check": info.get("last_check"),
                    "error": info.get("error"),
                }
                if filters and filters.get("session_id") and filters["session_id"] != session_id:
                    continue
                if query and query.lower() not in row["name"].lower():
                    continue
                rows.append(row)
                if len(rows) >= limit:
                    break
            if len(rows) >= limit:
                break
        return _json.dumps(rows[:limit], ensure_ascii=False)
    except Exception:
        return _json.dumps([])


def brain_query(store: str, query: str = "", filters: dict | None = None, limit: int = 10) -> str:
    """Read-only query across any brain store (§11 of the cognitive spec).

    Returns compact JSON rows. Capped at ``limit`` and at a hard token
    ceiling (truncated with "N more rows; narrow your query" if exceeded).

    Unknown or not-yet-shipped stores return a structured error string
    rather than raising — keeps the tool stable across phases.
    """
    _TOKEN_CEILING = 2000  # hard cap on output tokens
    conn = _conn()

    # v1.1: Route non-table stores to custom handlers
    if store == "graph":
        return _brain_query_graph(query, filters, limit)
    if store == "daemons":
        return _brain_query_daemons(query, filters, limit)

    if store not in _BRAIN_STORES:
        return json.dumps({
            "error": f"store '{store}' not available in this build",
            "available": sorted(_BRAIN_STORES.keys()),
        })

    info = _BRAIN_STORES[store]
    try:
        # Verify the backing table exists
        table_check = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (info["table"],),
        ).fetchone()
        if not table_check:
            return json.dumps({"error": f"store '{store}' table not yet created"})

        # Build query
        cols = info["columns"]
        sql = f"SELECT {cols} FROM {info['table']}"
        params: list[Any] = []

        # Apply text search
        where_clauses: list[str] = []
        if query:
            fts = info.get("fts")
            if fts:
                # FTS-backed store: JOIN back to base table to get all columns.
                # FTS virtual tables only contain indexed columns (key, value
                # for memory_store_fts; key, content for auto_memories_fts);
                # SELECT-ing other columns from the FTS table fails with
                # "no such column". The JOIN gives us ranking + full row data.
                fts_q = " OR ".join(f'"{w}"*' for w in query.strip().split() if w)
                if fts_q:
                    # Qualify columns with t. to disambiguate from FTS-side columns
                    qualified_cols = ", ".join(f"t.{c.strip()}" for c in cols.split(","))
                    sql = (
                        f"SELECT {qualified_cols} FROM {fts} fts "
                        f"JOIN {info['table']} t ON fts.rowid = t.rowid "
                        f"WHERE fts.content MATCH ? ORDER BY rank"
                    )
                    params = [fts_q]
                else:
                    where_clauses.append("1=0")
            else:
                # LIKE-based search
                search_parts = []
                for col in info["search_cols"]:
                    search_parts.append(f"{col} LIKE ?")
                    params.append(f"%{query}%")
                where_clauses.append(f"({' OR '.join(search_parts)})")

        # Apply filters
        if filters:
            for key, val in filters.items():
                # Validate column exists (safety check)
                col_info = conn.execute(f"PRAGMA table_info({info['table']})").fetchall()
                col_names = {c["name"] for c in col_info}
                if key in col_names:
                    where_clauses.append(f"{key} = ?")
                    params.append(val)

        if where_clauses:
            if "WHERE" not in sql and "MATCH" not in sql:
                sql += " WHERE " + " AND ".join(where_clauses)
            elif "MATCH" in sql and "WHERE" in sql:
                pass  # FTS already has WHERE
            elif "MATCH" not in sql:
                sql += " WHERE " + " AND ".join(where_clauses)

        sql += f" LIMIT {min(limit, 100)}"
        rows = conn.execute(sql, params).fetchall()

        results = [dict(r) for r in rows]
        # Estimate token count (conservative: 4 chars ≈ 1 token)
        result_json = json.dumps(results, default=str, ensure_ascii=False)
        if len(result_json) > _TOKEN_CEILING * 4:
            # Truncate rows to fit
            truncated = []
            char_budget = _TOKEN_CEILING * 4
            for r in results:
                row_s = json.dumps(r, default=str, ensure_ascii=False)
                if len(json.dumps(truncated, default=str, ensure_ascii=False)) + len(row_s) < char_budget:
                    truncated.append(r)
                else:
                    break
            n_more = len(results) - len(truncated)
            result_json = json.dumps(
                {"rows": truncated, "note": f"{n_more} more rows; narrow your query"},
                default=str, ensure_ascii=False,
            )

        return result_json

    except Exception as exc:
        return json.dumps({"error": f"brain_query({store}): {exc}"})
