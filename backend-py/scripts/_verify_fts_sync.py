"""Verify FTS5 virtual tables cover base-table rows after dual-schema merge.

Checks:
  * every memory_store.key appears in memory_store_fts (via MATCH or join)
  * every auto_memories row with content is findable via FTS or rowid sync count
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "august_brain.sqlite"


def main() -> int:
    if not DB.exists():
        print("DB missing", file=sys.stderr)
        return 1
    conn = sqlite3.connect(str(DB))
    errors = 0

    print("=== FTS sync check ===")

    # memory_store
    base_n = conn.execute("SELECT COUNT(*) FROM memory_store").fetchone()[0]
    try:
        fts_n = conn.execute("SELECT COUNT(*) FROM memory_store_fts").fetchone()[0]
    except sqlite3.Error as exc:
        print(f"memory_store_fts ERROR: {exc}")
        fts_n = -1
        errors += 1
    print(f"memory_store rows={base_n} fts_rows={fts_n}")
    if fts_n >= 0 and fts_n < base_n:
        print("  FAIL: FTS has fewer rows than base")
        errors += 1
    # sample: each key MATCH
    keys = [r[0] for r in conn.execute("SELECT key FROM memory_store").fetchall()]
    for key in keys:
        # Escape FTS special chars roughly by quoting phrase
        safe = key.replace('"', '""')
        try:
            hit = conn.execute(
                "SELECT COUNT(*) FROM memory_store_fts WHERE memory_store_fts MATCH ?",
                (f'"{safe}"',),
            ).fetchone()[0]
        except sqlite3.Error:
            # fallback: count by rowid join if fts content table
            hit = conn.execute(
                """
                SELECT COUNT(*) FROM memory_store_fts f
                JOIN memory_store m ON m.rowid = f.rowid
                WHERE m.key = ?
                """,
                (key,),
            ).fetchone()[0]
        if hit < 1:
            print(f"  FAIL: key {key!r} not in FTS")
            errors += 1
        else:
            print(f"  OK FTS has key {key!r}")

    # auto_memories
    base_n = conn.execute("SELECT COUNT(*) FROM auto_memories").fetchone()[0]
    try:
        fts_n = conn.execute("SELECT COUNT(*) FROM auto_memories_fts").fetchone()[0]
    except sqlite3.Error as exc:
        print(f"auto_memories_fts ERROR: {exc}")
        fts_n = -1
        errors += 1
    print(f"auto_memories rows={base_n} fts_rows={fts_n}")
    if fts_n >= 0 and fts_n < base_n:
        print("  FAIL: auto_memories FTS has fewer rows than base")
        errors += 1

    # Spot-check: keys recovered from camel should be searchable
    sample = conn.execute(
        """
        SELECT key, content FROM auto_memories
        WHERE key IN ('tool_failure_1783087532', 'correction_1783087804')
           OR key LIKE 'tool_failure_%'
           OR key LIKE 'correction_%'
        LIMIT 20
        """
    ).fetchall()
    print(f"sample recovered-style keys: {len(sample)}")
    for key, content in sample:
        if not key:
            continue
        token = None
        # pick a simple alphanumeric token from key
        for part in key.replace("-", "_").split("_"):
            if part.isalpha() and len(part) >= 4:
                token = part
                break
        if not token and content:
            for part in str(content).replace("{", " ").replace("}", " ").split():
                if part.isalpha() and len(part) >= 4:
                    token = part
                    break
        if not token:
            print(f"  SKIP no token for key={key!r}")
            continue
        try:
            hit = conn.execute(
                "SELECT COUNT(*) FROM auto_memories_fts WHERE auto_memories_fts MATCH ?",
                (token,),
            ).fetchone()[0]
        except sqlite3.Error as exc:
            print(f"  FAIL MATCH {token!r} for {key!r}: {exc}")
            errors += 1
            continue
        # Also verify row is in fts by rowid
        rid = conn.execute(
            "SELECT id FROM auto_memories WHERE key=?", (key,)
        ).fetchone()
        if rid:
            fts_has = conn.execute(
                "SELECT COUNT(*) FROM auto_memories_fts WHERE rowid=?", (rid[0],)
            ).fetchone()[0]
        else:
            fts_has = 0
        status = "OK" if fts_has >= 1 else "FAIL"
        if fts_has < 1:
            errors += 1
        print(f"  {status} key={key!r} fts_rowid={fts_has} match_token={token!r} hits={hit}")

    # Overall: missing FTS rowids
    missing = conn.execute(
        """
        SELECT COUNT(*) FROM auto_memories m
        WHERE NOT EXISTS (
          SELECT 1 FROM auto_memories_fts f WHERE f.rowid = m.id
        )
        """
    ).fetchone()[0]
    print(f"auto_memories rows missing from FTS by rowid: {missing}")
    if missing:
        errors += 1

    conn.close()
    print(f"\nRESULT: {'PASS' if errors == 0 else 'FAIL'} errors={errors}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
