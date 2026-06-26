"""
SQLite memory store — persists conversations, facts, and index data.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from app.lib.paths import data_path


def get_db() -> sqlite3.Connection:
    db_path = data_path("august-sessions.db")
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    """Create tables on first use."""
    conn = get_db()
    conn.executescript("""
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
        CREATE TABLE IF NOT EXISTS memory_store (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            content, content_memory_store='memory_store', content_rowid='rowid'
        );
    """)
    conn.commit()
    conn.close()


def save_session(session: dict[str, Any]) -> None:
    conn = get_db()
    conn.execute(
        """INSERT OR REPLACE INTO sessions (id, title, started_at, message_count, provider, model, folder_id, is_archived, workspace_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session["id"], session.get("title", ""), session.get("startedAt"),
            session.get("messageCount", 0), session.get("provider", ""),
            session.get("model", ""), session.get("folderId"),
            1 if session.get("isArchived") else 0,
            session.get("workspacePath"),
        ),
    )
    conn.commit()
    conn.close()


def list_sessions() -> list[dict[str, Any]]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_memory(key: str, value: Any) -> None:
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        (key, json.dumps(value)),
    )
    conn.commit()
    conn.close()


def get_memory(key: str) -> Any | None:
    conn = get_db()
    row = conn.execute("SELECT value FROM memory_store WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row:
        return json.loads(row["value"])
    return None


def search_memory(query: str) -> list[dict[str, Any]]:
    conn = get_db()
    rows = conn.execute(
        "SELECT key, value FROM memory_fts WHERE content MATCH ?", (query,)
    ).fetchall()
    conn.close()
    return [{"key": r["key"], "value": json.loads(r["value"])} for r in rows]
