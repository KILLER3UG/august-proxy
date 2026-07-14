"""P0.3 — EXPLAIN QUERY PLAN pack for hot brain SQLite queries.

Measurement only. Prints plans for typical workbench/session paths.
Uses live ``data/august_brain.sqlite`` if present, else a temp schema.

Usage:
  python backend-py/scripts/p0_explain_plans.py [--db path]
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "august_brain.sqlite"

QUERIES: list[tuple[str, str]] = [
    (
        "list_sessions_active",
        "SELECT id, title, started_at, message_count, is_archived FROM sessions "
        "WHERE is_archived = 0 ORDER BY started_at DESC LIMIT 50",
    ),
    (
        "messages_by_session",
        "SELECT id, role, content, created_at FROM messages "
        "WHERE session_id = ? ORDER BY id ASC",
    ),
    (
        "usage_by_session",
        "SELECT * FROM usage_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 20",
    ),
    (
        "blackboard_by_session",
        "SELECT * FROM blackboard WHERE session_id = ? ORDER BY priority DESC, created_at DESC",
    ),
    (
        "auto_memories_fts",
        "SELECT key, content FROM auto_memories_fts "
        "WHERE auto_memories_fts MATCH ? ORDER BY rank LIMIT 10",
    ),
    (
        "memory_store_fts",
        "SELECT key, value FROM memory_store_fts WHERE memory_store_fts MATCH ? "
        "ORDER BY rank LIMIT 10",
    ),
    (
        "memory_store_by_key",
        "SELECT key, value, updated_at FROM memory_store WHERE key = ?",
    ),
    # Phase-4 gap list completeness (all six indexes)
    (
        "usage_events_by_created",
        "SELECT id, session_id, created_at FROM usage_events ORDER BY created_at DESC LIMIT 20",
    ),
    (
        "exam_attempts_by_exam",
        "SELECT id, exam_id, question_id, is_correct FROM exam_attempts "
        "WHERE exam_id = ? ORDER BY answered_at DESC",
    ),
]


def _ensure_min_schema(conn: sqlite3.Connection) -> None:
    sys.path.insert(0, str(ROOT / "backend-py"))
    from app.services.memory_schema import ensure_schema

    ensure_schema(conn)


def explain(conn: sqlite3.Connection, label: str, sql: str, params: tuple = ()) -> None:
    print(f"\n=== {label} ===")
    print(f"SQL: {sql}")
    try:
        rows = conn.execute(f"EXPLAIN QUERY PLAN {sql}", params).fetchall()
        for r in rows:
            print(" ", tuple(r))
        uses_index = any("USING INDEX" in str(r).upper() or "USING COVERING INDEX" in str(r).upper() for r in rows)
        scan = any("SCAN" in str(r).upper() and "INDEX" not in str(r).upper() for r in rows)
        print(f"  note: uses_index_hint={uses_index} has_scan_hint={scan}")
    except sqlite3.Error as exc:
        print(f"  ERROR: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=None)
    args = ap.parse_args()
    tmp: Path | None = None
    if args.db:
        db = args.db
    elif DEFAULT_DB.exists():
        db = DEFAULT_DB
    else:
        tmp = Path(tempfile.mkdtemp()) / "brain.sqlite"
        db = tmp

    print(f"DB: {db}")
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA busy_timeout=10000")
    if tmp is not None or not DEFAULT_DB.exists():
        _ensure_min_schema(conn)
    else:
        # Live DB may already be migrated; still ensure
        try:
            _ensure_min_schema(conn)
        except Exception as exc:
            print(f"ensure_schema note: {exc}")

    # seed dummy session id param
    sid = "p0-explain-session"
    try:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, started_at, message_count) VALUES (?,?,datetime('now'),0)",
            (sid, "explain"),
        )
        conn.commit()
    except sqlite3.Error:
        pass

    for label, sql in QUERIES:
        if "?" in sql and "MATCH" in sql:
            explain(conn, label, sql, ("test",))
        elif "?" in sql:
            explain(conn, label, sql, (sid,))
        else:
            explain(conn, label, sql)

    conn.close()
    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
