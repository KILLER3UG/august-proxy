"""
One-time migration: august_core_memory.json → SQLite memory_store.

Reads the legacy JSON file and upserts user_profile, current_context, and
active_projects into the memory_store table. Supports --dry-run and
--source json|sqlite|merge flags per the Phase 0 spec.

Usage:
    python scripts/migrate_core_memory.py [--dry-run] [--source json|sqlite|merge]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


# ── helpers ──────────────────────────────────────────────────────────────


def _db_path() -> Path:
    """Resolve brain DB path (mirrors memory_store._db_path)."""
    env_path = __import__("os").environ.get("AUGUST_BRAIN_SQLITE_FILE")
    if env_path:
        return Path(env_path)

    from app.lib.paths import data_path
    return data_path("august_brain.sqlite")


def _connect() -> sqlite3.Connection:
    db = _db_path()
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def _read_sqlite_key(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM memory_store WHERE key = ?", (key,)
    ).fetchone()
    if row:
        try:
            return json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            return row["value"]
    return None


def _upsert(conn: sqlite3.Connection, key: str, value: dict) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value, updated_at) "
        "VALUES (?, ?, datetime('now'))",
        (key, json.dumps(value)),
    )


def _merge_values(json_val, sqlite_val) -> dict:
    """Field-level merge: prefer non-empty, prefer JSON on conflict."""
    if json_val is None and sqlite_val is None:
        return {}
    if json_val is None:
        return sqlite_val or {}
    if sqlite_val is None:
        return json_val or {}
    if not isinstance(json_val, dict) or not isinstance(sqlite_val, dict):
        return json_val or sqlite_val
    merged = {}
    all_keys = set(json_val.keys()) | set(sqlite_val.keys())
    for k in all_keys:
        jv = json_val.get(k)
        sv = sqlite_val.get(k)
        if jv and sv and jv != sv:
            # Prefer JSON value (older, more curated per spec)
            merged[k] = jv
        elif jv:
            merged[k] = jv
        else:
            merged[k] = sv
    return merged


# ── migration ────────────────────────────────────────────────────────────


def run_migration(source: str = "merge", dry_run: bool = False) -> dict:
    """Run the core memory migration. Returns stats dict."""
    json_path = Path("data/august_core_memory.json")
    stats = {"json_found": False, "sqlite_source_count": 0, "upserted": 0, "errors": []}

    conn = _connect()

    # Read from JSON
    json_data = _read_json(json_path)
    if json_data is not None:
        stats["json_found"] = True

    # Read existing from SQLite
    sqlite_profile = _read_sqlite_key(conn, "user_profile")
    sqlite_context = _read_sqlite_key(conn, "current_context")
    sqlite_projects = _read_sqlite_key(conn, "active_projects")
    stats["sqlite_source_count"] = sum(
        1 for v in [sqlite_profile, sqlite_context, sqlite_projects] if v
    )

    # Extract JSON values
    json_profile = (json_data or {}).get("user_profile")
    json_context = (json_data or {}).get("global_context")
    json_projects = (json_data or {}).get("active_projects")

    # Merge (default: merge)
    if source == "json":
        profile_val = json_profile
        context_val = json_context
        projects_val = json_projects
    elif source == "sqlite":
        profile_val = sqlite_profile
        context_val = sqlite_context
        projects_val = sqlite_projects
    else:
        # merge — field-level per spec
        profile_val = _merge_values(json_profile, sqlite_profile)
        context_val = _merge_values(json_context, sqlite_context)
        projects_val = _merge_values(json_projects, sqlite_projects)

    # Upsert
    if profile_val is not None:
        if dry_run:
            print(f"[dry-run] Would upsert user_profile: {str(profile_val)[:100]}...")
        else:
            _upsert(conn, "user_profile", profile_val)
        stats["upserted"] += 1

    if context_val is not None:
        if dry_run:
            print(f"[dry-run] Would upsert current_context: {str(context_val)[:100]}...")
        else:
            _upsert(conn, "current_context", context_val)
        stats["upserted"] += 1

    if projects_val is not None:
        if dry_run:
            print(f"[dry-run] Would upsert active_projects: {str(projects_val)[:100]}...")
        else:
            _upsert(conn, "active_projects", projects_val)
        stats["upserted"] += 1

    if not dry_run:
        conn.commit()

    # Verify
    for key in ("user_profile", "current_context", "active_projects"):
        stored = _read_sqlite_key(conn, key)
        if stored is not None:
            stats[f"verified_{key}"] = True

    conn.close()
    return stats


# ── main ─────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Migrate august_core_memory.json to SQLite memory_store"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing",
    )
    parser.add_argument(
        "--source",
        choices=["json", "sqlite", "merge"],
        default="merge",
        help="Source priority for merge conflicts (default: merge)",
    )
    args = parser.parse_args()

    print(f"Core memory migration (--source={args.source}, dry_run={args.dry_run})")
    print("=" * 50)

    stats = run_migration(source=args.source, dry_run=args.dry_run)

    print("\nResults:")
    for k, v in stats.items():
        print(f"  {k}: {v}")

    if not args.dry_run:
        print("\nMigration complete.")
    else:
        print("\nDry-run complete — no data written.")


if __name__ == "__main__":
    main()
