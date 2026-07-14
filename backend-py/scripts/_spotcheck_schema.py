"""Ground Rule 1 spot-check: live august_brain.sqlite schema state."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "august_brain.sqlite"
sys.path.insert(0, str(ROOT / "backend-py"))

PAIRS = [
    ("memoryStore", "memory_store"),
    ("sessionTopics", "session_topics"),
    ("usageEvents", "usage_events"),
    ("configAudit", "config_audit"),
    ("learnedHeuristics", "learned_heuristics"),
    ("autoMemories", "auto_memories"),
    ("episodicTimeline", "episodic_timeline"),
    ("examQuestions", "exam_questions"),
    ("examAttempts", "exam_attempts"),
    ("pendingSkills", "pending_skills"),
]
SPOT_SNAKE = [
    "sessions",
    "messages",
    "memory_store",
    "facts",
    "proposals",
    "usage_events",
    "blackboard",
    "pending_skills",
]


def main() -> int:
    print("DB:", DB, "size=", DB.stat().st_size if DB.exists() else 0)
    if not DB.exists():
        return 1

    conn = sqlite3.connect(str(DB))
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }

    print("\n=== Dual camel/snake pairs ===")
    dual = 0
    for camel, snake in PAIRS:
        nc = ns = None
        cc = sc = []
        if camel in tables:
            nc = conn.execute(f'SELECT COUNT(*) FROM "{camel}"').fetchone()[0]
            cc = [r[1] for r in conn.execute(f'PRAGMA table_info("{camel}")').fetchall()]
        if snake in tables:
            ns = conn.execute(f'SELECT COUNT(*) FROM "{snake}"').fetchone()[0]
            sc = [r[1] for r in conn.execute(f'PRAGMA table_info("{snake}")').fetchall()]
        both = camel in tables and snake in tables
        if both:
            dual += 1
        print(
            f"  {camel} rows={nc} cols={cc}\n"
            f"  {snake} rows={ns} cols={sc}\n"
            f"  BOTH={both}"
        )

    print(f"\nDual-table pairs: {dual}/{len(PAIRS)}")

    print("\n=== Snake spot-check columns ===")
    for t in SPOT_SNAKE:
        if t not in tables:
            print(f"  {t}: MISSING")
            continue
        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{t}")').fetchall()]
        camel_cols = [c for c in cols if any(ch.isupper() for ch in c)]
        print(f"  {t}: {cols}")
        print(f"    camel leftovers: {camel_cols or 'NONE'}")

    print("\n=== Any camelCase column anywhere? ===")
    any_camel_col = False
    for t in sorted(tables):
        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{t}")').fetchall()]
        camel_cols = [c for c in cols if any(ch.isupper() for ch in c)]
        if camel_cols:
            any_camel_col = True
            print(f"  {t}: {camel_cols}")
    if not any_camel_col:
        print("  NONE")

    from app.services.schema_rename_migration import (
        _needs_migration,
        migrate_camel_to_snake,
    )

    print("\n=== migrate_camel_to_snake on live DB ===")
    print("needs_migration before:", _needs_migration(conn))
    n = migrate_camel_to_snake(conn)
    print("change count:", n)
    print("needs_migration after:", _needs_migration(conn))
    tables_after = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    left = [c for c, _ in PAIRS if c in tables_after]
    print("camel tables still present after migrate:", left or "NONE")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
