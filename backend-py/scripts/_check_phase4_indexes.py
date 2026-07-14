"""Confirm the six Phase-4 indexes exist on a brain DB."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "august_brain.sqlite"

WANTED = [
    "idx_messages_session",
    "idx_usage_events_session",
    "idx_usage_events_created",
    "idx_sessions_archived",
    "idx_blackboard_session",
    "idx_exam_attempts_exam",
]


def main() -> int:
    db = Path(sys.argv[1]) if len(sys.argv) > 1 else DB
    if not db.exists():
        print(f"MISSING_DB {db}")
        return 2
    conn = sqlite3.connect(str(db))
    names = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        )
    }
    missing = [w for w in WANTED if w not in names]
    for w in WANTED:
        print(f"{w}: {'YES' if w in names else 'MISSING'}")
    # EXPLAIN the two that P0 pack previously skipped
    for label, sql, params in (
        (
            "usage_by_created",
            "SELECT * FROM usage_events ORDER BY created_at DESC LIMIT 20",
            (),
        ),
        (
            "exam_attempts_by_exam",
            "SELECT * FROM exam_attempts WHERE exam_id = ? ORDER BY answered_at DESC",
            ("exam-x",),
        ),
    ):
        print(f"\n=== EXPLAIN {label} ===")
        try:
            for row in conn.execute(f"EXPLAIN QUERY PLAN {sql}", params):
                print(" ", tuple(row))
        except sqlite3.Error as exc:
            print("  ERROR", exc)
    conn.close()
    if missing:
        print(f"\nINCOMPLETE missing={missing}")
        return 1
    print("\nALL_SIX_PRESENT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
