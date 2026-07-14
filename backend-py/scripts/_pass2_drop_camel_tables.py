"""Pass 2: drop legacy camel content tables after merge verification.

Requires confirm via --confirm. Back up the DB first.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend-py"))

from app.services.schema_rename_migration import (  # noqa: E402
    TABLE_MAP,
    _needs_migration,
    drop_legacy_camel_tables,
)

DEFAULT_DB = ROOT / "data" / "august_brain.sqlite"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--confirm", action="store_true")
    args = ap.parse_args()
    if not args.confirm:
        print("Refusing: pass --confirm", file=sys.stderr)
        return 2
    if not args.db.exists():
        print(f"missing {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA busy_timeout=10000")
    print("needs_migration before:", _needs_migration(conn))
    n = drop_legacy_camel_tables(conn, confirm=True)
    print("dropped:", n)
    print("needs_migration after:", _needs_migration(conn))
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    left = [c for c in TABLE_MAP if c in tables]
    print("camel tables left:", left if left else "NONE")
    for t in (
        "auto_memories",
        "memory_store",
        "exam_questions",
        "usage_events",
        "config_audit",
    ):
        if t in tables:
            print(t, conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])
    conn.close()
    return 0 if not left else 1


if __name__ == "__main__":
    raise SystemExit(main())
