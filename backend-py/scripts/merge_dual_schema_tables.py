"""Merge dual camel/snake brain tables (camel → snake) without dropping camel.

Protocol (user-mandated):
  1. Caller must backup the live DB first.
  2. Per-table merge (not blanket).
  3. Conflict-check pairs where both sides have rows.
  4. Does **not** DROP camel tables (second confirmation pass later).
  5. Re-run ``_spotcheck_schema.py`` after.

Usage:
  python backend-py/scripts/merge_dual_schema_tables.py [--db path] [--dry-run]
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "august_brain.sqlite"

# camel_name, snake_name, natural key column(s) for identity
# Prefer logical keys over autoincrement ids when both sides may have
# independently allocated the same integer id for different rows.
PAIRS: list[tuple[str, str, tuple[str, ...]]] = [
    ("memoryStore", "memory_store", ("key",)),
    ("sessionTopics", "session_topics", ("session_id",)),
    ("usageEvents", "usage_events", ("id",)),
    ("configAudit", "config_audit", ("id",)),
    ("learnedHeuristics", "learned_heuristics", ("id",)),
    # auto_memories: primary id; post-pass recovers alt key collisions
    ("autoMemories", "auto_memories", ("id",)),
    ("episodicTimeline", "episodic_timeline", ("id",)),
    ("examQuestions", "exam_questions", ("id",)),
    ("examAttempts", "exam_attempts", ("id",)),
    ("pendingSkills", "pending_skills", ("id",)),
]


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _cols(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()]


def _row_dict(cols: list[str], row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    return {c: row[i] for i, c in enumerate(cols)}


def _key_tuple(d: dict[str, Any], key_cols: tuple[str, ...]) -> tuple[Any, ...]:
    return tuple(d.get(c) for c in key_cols)


def _payload(d: dict[str, Any], key_cols: tuple[str, ...]) -> dict[str, Any]:
    """Non-key fields for conflict comparison."""
    return {k: v for k, v in d.items() if k not in key_cols}


def analyze_and_merge(
    conn: sqlite3.Connection,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Analyze conflicts and merge missing camel rows into snake tables.

    Returns a report dict. Never drops camel tables.
    """
    report: dict[str, Any] = {"tables": {}, "inserted": 0, "conflicts": 0, "identical": 0, "errors": []}

    for camel, snake, key_cols in PAIRS:
        entry: dict[str, Any] = {
            "camel": camel,
            "snake": snake,
            "key": key_cols,
            "camel_rows": 0,
            "snake_rows_before": 0,
            "snake_rows_after": None,
            "identical_keys": 0,
            "conflict_keys": [],
            "inserted": 0,
            "skipped_missing_cols": 0,
            "status": "ok",
        }
        if not _table_exists(conn, camel) and not _table_exists(conn, snake):
            entry["status"] = "absent"
            report["tables"][snake] = entry
            continue
        if not _table_exists(conn, camel):
            entry["status"] = "camel_absent"
            report["tables"][snake] = entry
            continue
        if not _table_exists(conn, snake):
            entry["status"] = "snake_absent_needs_rename"
            report["errors"].append(f"{camel}: snake table missing — use rename path, not merge")
            report["tables"][snake] = entry
            continue

        camel_cols = _cols(conn, camel)
        snake_cols = _cols(conn, snake)
        # Only insert columns present on both sides
        shared = [c for c in snake_cols if c in camel_cols]
        if not all(k in shared for k in key_cols):
            entry["status"] = "key_missing"
            report["errors"].append(f"{camel}/{snake}: key {key_cols} not fully in shared cols {shared}")
            report["tables"][snake] = entry
            continue

        camel_rows = conn.execute(f'SELECT * FROM "{camel}"').fetchall()
        snake_rows = conn.execute(f'SELECT * FROM "{snake}"').fetchall()
        entry["camel_rows"] = len(camel_rows)
        entry["snake_rows_before"] = len(snake_rows)

        snake_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
        for r in snake_rows:
            d = _row_dict(snake_cols, r)
            snake_by_key[_key_tuple(d, key_cols)] = d

        for r in camel_rows:
            d = _row_dict(camel_cols, r)
            k = _key_tuple(d, key_cols)
            if k in snake_by_key:
                sp = _payload(snake_by_key[k], key_cols)
                cp = _payload({c: d.get(c) for c in shared}, key_cols)
                # Compare only shared non-key columns
                sp_f = {c: sp.get(c) for c in shared if c not in key_cols}
                cp_f = {c: cp.get(c) for c in shared if c not in key_cols}
                if sp_f == cp_f:
                    entry["identical_keys"] += 1
                    report["identical"] += 1
                else:
                    entry["conflict_keys"].append(
                        {
                            "key": k,
                            "snake": sp_f,
                            "camel": cp_f,
                        }
                    )
                    report["conflicts"] += 1
                continue

            # Missing on snake — insert
            cols = [c for c in shared if c in d]
            placeholders = ", ".join("?" for _ in cols)
            col_list = ", ".join(f'"{c}"' for c in cols)
            values = [d[c] for c in cols]
            if dry_run:
                entry["inserted"] += 1
                report["inserted"] += 1
                continue
            try:
                conn.execute(
                    f'INSERT INTO "{snake}" ({col_list}) VALUES ({placeholders})',
                    values,
                )
                entry["inserted"] += 1
                report["inserted"] += 1
            except sqlite3.IntegrityError as exc:
                # Unique constraint on non-key (e.g. facts) — try content-level skip
                entry.setdefault("integrity_errors", []).append(str(exc))
                report["errors"].append(f"{snake} insert failed for key={k}: {exc}")

        # auto_memories: id-collision with different logical keys — insert without id
        if camel == "autoMemories" and not dry_run:
            recovered = _recover_auto_memories_by_key(conn)
            entry["inserted"] += recovered
            report["inserted"] += recovered
            entry["key_recovered"] = recovered

        if not dry_run:
            entry["snake_rows_after"] = conn.execute(
                f'SELECT COUNT(*) FROM "{snake}"'
            ).fetchone()[0]
        else:
            entry["snake_rows_after"] = entry["snake_rows_before"] + entry["inserted"]

        if entry["conflict_keys"]:
            entry["status"] = "merged_with_conflicts_snake_kept"
        report["tables"][snake] = entry


def _recover_auto_memories_by_key(conn: sqlite3.Connection) -> int:
    """Insert camel autoMemories rows whose key is missing on snake (new ids)."""
    missing = conn.execute(
        """
        SELECT c.* FROM autoMemories c
        WHERE c.key IS NOT NULL AND c.key != ''
          AND NOT EXISTS (
            SELECT 1 FROM auto_memories s WHERE s.key = c.key
          )
        """
    ).fetchall()
    cols = _cols(conn, "autoMemories")
    n = 0
    for r in missing:
        d = _row_dict(cols, r)
        conn.execute(
            """
            INSERT INTO auto_memories
              (key, content, category, importance, source, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                d.get("key"),
                d.get("content"),
                d.get("category"),
                d.get("importance"),
                d.get("source"),
                d.get("created_at"),
                d.get("updated_at"),
            ),
        )
        n += 1
    return n

    if not dry_run:
        conn.commit()
        # Rebuild FTS content indexes for tables that have them
        _rebuild_fts(conn)

    return report


def _rebuild_fts(conn: sqlite3.Connection) -> None:
    """Rebuild FTS5 indexes so merged rows are searchable."""
    for fts, content in (
        ("memory_store_fts", "memory_store"),
        ("auto_memories_fts", "auto_memories"),
    ):
        if not _table_exists(conn, fts) or not _table_exists(conn, content):
            continue
        try:
            conn.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
            conn.commit()
        except sqlite3.Error as exc:
            # Non-fatal: triggers may already cover new inserts
            print(f"  FTS rebuild {fts}: {exc}", file=sys.stderr)


def print_report(report: dict[str, Any]) -> None:
    print("=== Dual-schema merge report ===")
    print(f"inserted={report['inserted']} identical={report['identical']} conflicts={report['conflicts']}")
    if report["errors"]:
        print("errors:")
        for e in report["errors"]:
            print(f"  - {e}")
    for name, e in report["tables"].items():
        conf_n = len(e.get("conflict_keys") or [])
        print(
            f"  {e.get('camel')} → {name}: "
            f"camel={e.get('camel_rows')} snake_before={e.get('snake_rows_before')} "
            f"inserted={e.get('inserted')} identical={e.get('identical_keys')} "
            f"conflicts={conf_n} after={e.get('snake_rows_after')} status={e.get('status')}"
        )
        for c in (e.get("conflict_keys") or [])[:5]:
            print(f"    CONFLICT key={c['key']}")
            print(f"      snake={c['snake']}")
            print(f"      camel={c['camel']}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.db.exists():
        print(f"DB missing: {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        # Phase A: dry analysis is always printed first when not dry-run
        if not args.dry_run:
            print("--- dry-run analysis first ---")
            dry = analyze_and_merge(conn, dry_run=True)
            print_report(dry)
            if dry["conflicts"]:
                print(
                    f"\nNOTE: {dry['conflicts']} conflict(s) — snake row kept, camel not overwriting.\n"
                )
            print("--- applying merge (camel tables retained) ---")
            # dry-run path doesn't mutate; re-run for real on fresh connection state
            # (dry_run only counted inserts without writing — safe to call again)
        report = analyze_and_merge(conn, dry_run=args.dry_run)
        print_report(report)
    finally:
        conn.close()

    if report["errors"] and report["inserted"] == 0 and any(
        e.get("status") == "key_missing" for e in report["tables"].values()
    ):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
