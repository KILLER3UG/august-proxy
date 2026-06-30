"""
One-time migration: split old auto_memories JSON blob into individual FTS-indexed rows.

The original auto_memory.py stored all entries as a single JSON array under the
key "auto_memories" in the memory_store table. This script:
1. Reads that blob
2. Inserts each entry as an individual row in the auto_memories table
   (FTS triggers automatically index them)
3. Deletes the orphaned blob from memory_store

Usage:
    python scripts/migrate_auto_memories.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any


def _db_path() -> Path:
    env_path = __import__("os").environ.get("AUGUST_BRAIN_SQLITE_FILE")
    if env_path:
        return Path(env_path)
    from app.lib.paths import dataPath
    return data_path("august_brain.sqlite")


def _connect() -> sqlite3.Connection:
    db = _db_path()
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _normalize_iso(ts: str | None) -> str:
    if not ts:
        return datetime.utcnow().isoformat()
    return ts.replace("Z", "").split("+")[0].split(".")[0] or datetime.utcnow().isoformat()


def _read_blob(conn: sqlite3.Connection) -> list[dict] | None:
    """Read the old auto_memories JSON blob from memory_store."""
    row = conn.execute(
        "SELECT value FROM memory_store WHERE key = ?", ("auto_memories",)
    ).fetchone()
    if not row:
        return None
    try:
        val = json.loads(row["value"])
        if isinstance(val, list):
            return val
        return None
    except (json.JSONDecodeError, TypeError):
        return None


def run_migration(dry_run: bool = False) -> dict[str, Any]:
    """Run the auto_memories migration. Returns stats dict."""
    stats = {
        "blob_found": False,
        "blob_entry_count": 0,
        "existing_auto_count": 0,
        "inserted": 0,
        "skipped_duplicates": 0,
        "blob_deleted": False,
        "errors": [],
    }

    conn = _connect()

    # Check existing auto_memories rows
    existing = conn.execute("SELECT COUNT(*) FROM auto_memories").fetchone()
    stats["existing_auto_count"] = existing[0] if existing else 0

    # Read the blob
    blob = _read_blob(conn)
    if blob is None:
        stats["errors"].append("No auto_memories blob found in memory_store — nothing to migrate.")
        conn.close()
        return stats

    stats["blob_found"] = True
    stats["blob_entry_count"] = len(blob)

    for entry in blob:
        if not isinstance(entry, dict):
            stats["skipped_duplicates"] += 1
            continue

        key = entry.get("key", "")
        if not key:
            stats["skipped_duplicates"] += 1
            continue

        # Check for duplicate by key
        dup = conn.execute(
            "SELECT id FROM auto_memories WHERE key = ?", (key,)
        ).fetchone()
        if dup:
            stats["skipped_duplicates"] += 1
            continue

        content = entry.get("content", "")
        if isinstance(content, (dict, list)):
            content = json.dumps(content)
        else:
            content = str(content)

        category = entry.get("category", "auto")
        importance = entry.get("importance", 0.5)
        created_raw = entry.get("created_at") or entry.get("created", "")
        created = _normalize_iso(created_raw)
        source = entry.get("source", "migration")

        if dry_run:
            print(f"[dry-run] Would insert: key={key}, importance={importance}")
            stats["inserted"] += 1
            continue

        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (key, content, category, importance, source, created),
        )
        stats["inserted"] += 1

    # Delete the orphaned blob
    if not dry_run and stats["inserted"] > 0:
        conn.execute("DELETE FROM memory_store WHERE key = 'auto_memories'")
        stats["blob_deleted"] = True

    if not dry_run:
        conn.commit()

    # Verify FTS index
    try:
        fts_count = conn.execute("SELECT COUNT(*) FROM auto_memories_fts").fetchone()
        stats["fts_count"] = fts_count[0] if fts_count else 0
    except Exception as e:
        stats["fts_error"] = str(e)

    # Verify orphan deleted
    if stats["blob_deleted"]:
        blob_check = conn.execute(
            "SELECT value FROM memory_store WHERE key = 'auto_memories'"
        ).fetchone()
        stats["blob_remains"] = blob_check is not None

    conn.close()
    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Migrate auto_memories JSON blob to individual FTS-indexed rows"
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would change without writing")
    args = parser.parse_args()

    print(f"Auto-memories migration (dry_run={args.dry_run})")
    print("=" * 50)

    stats = run_migration(dry_run=args.dry_run)

    print("\nResults:")
    for k, v in stats.items():
        print(f"  {k}: {v}")

    if not args.dry_run:
        print("\nMigration complete.")
    else:
        print("\nDry-run complete — no data written.")


if __name__ == "__main__":
    main()
