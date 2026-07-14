"""Fingerprint live august_brain.sqlite for before/after suite isolation proof.

Prints a stable multi-line report: table row counts + content hashes for key
tables + FTS row counts. Exit 0 always when DB exists (comparison is external).

Usage:
  python backend-py/scripts/_live_db_fingerprint.py [--db path] [--out file]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "august_brain.sqlite"

TABLES = [
    "memory_store",
    "memoryStore",
    "auto_memories",
    "autoMemories",
    "usage_events",
    "usageEvents",
    "config_audit",
    "configAudit",
    "exam_questions",
    "examQuestions",
    "exam_attempts",
    "examAttempts",
    "sessions",
    "messages",
    "facts",
    "blackboard",
    "pending_skills",
    "pendingSkills",
]

FTS_TABLES = [
    "memory_store_fts",
    "auto_memories_fts",
]


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?",
            (name,),
        ).fetchone()
        is not None
    )


def fingerprint(db: Path) -> dict:
    conn = sqlite3.connect(str(db))
    report: dict = {"db": str(db.resolve()), "size": db.stat().st_size, "tables": {}, "fts": {}, "blobs": {}}
    for t in TABLES:
        if not _table_exists(conn, t):
            report["tables"][t] = None
            continue
        n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        # Content hash of ordered dump (stable)
        rows = conn.execute(f'SELECT * FROM "{t}" ORDER BY rowid').fetchall()
        h = hashlib.sha256(repr(rows).encode("utf-8", errors="replace")).hexdigest()[:16]
        report["tables"][t] = {"count": n, "sha16": h}

    for t in FTS_TABLES:
        if not _table_exists(conn, t):
            report["fts"][t] = None
            continue
        try:
            n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except sqlite3.Error as exc:
            report["fts"][t] = {"error": str(exc)}
            continue
        report["fts"][t] = {"count": n}

    # Specific blob keys for conflict review
    if _table_exists(conn, "memory_store"):
        for key in ("agent_jobs", "self_evolution_log"):
            row = conn.execute(
                'SELECT value, updated_at FROM memory_store WHERE key=?', (key,)
            ).fetchone()
            if row:
                report["blobs"][f"memory_store:{key}"] = {
                    "updated_at": row[1],
                    "value_sha16": hashlib.sha256(str(row[0]).encode()).hexdigest()[:16],
                    "value_len": len(str(row[0])),
                }
    if _table_exists(conn, "memoryStore"):
        for key in ("agent_jobs", "self_evolution_log"):
            row = conn.execute(
                'SELECT value, updated_at FROM memoryStore WHERE key=?', (key,)
            ).fetchone()
            if row:
                report["blobs"][f"memoryStore:{key}"] = {
                    "updated_at": row[1],
                    "value_sha16": hashlib.sha256(str(row[0]).encode()).hexdigest()[:16],
                    "value_len": len(str(row[0])),
                }

    conn.close()
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    if not args.db.exists():
        print(f"MISSING {args.db}", file=sys.stderr)
        return 1
    rep = fingerprint(args.db)
    text = json.dumps(rep, indent=2, sort_keys=True)
    print(text)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
