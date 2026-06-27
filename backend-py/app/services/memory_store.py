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
        conn.execute("PRAGMA busy_timeout=5000")
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
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_store (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

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

        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_session ON lifecycle(session_id);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON lifecycle(event_type);
        CREATE INDEX IF NOT EXISTS idx_config_audit_category ON config_audit(category);
        CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit(created_at);
    """)
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


def record_usage(session_id: str, model: str, input_tokens: int = 0, output_tokens: int = 0) -> int:
    """Record a usage event."""
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO usage_events (session_id, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?)",
        (session_id, model, input_tokens, output_tokens),
    )
    conn.commit()
    return cursor.lastrowid


def get_usage(session_id: str) -> dict[str, Any]:
    """Get aggregated usage for a session."""
    conn = _conn()
    row = conn.execute(
        "SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as request_count "
        "FROM usage_events WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    return dict(row) if row else {"total_input": 0, "total_output": 0, "request_count": 0}


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
