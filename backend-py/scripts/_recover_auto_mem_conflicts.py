"""Recover auto_memories camel rows skipped due to id-only conflicts."""

from __future__ import annotations

import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "august_brain.sqlite"


def main() -> None:
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")

    missing = conn.execute(
        """
        SELECT c.* FROM autoMemories c
        WHERE c.key IS NOT NULL AND c.key != ''
          AND NOT EXISTS (
            SELECT 1 FROM auto_memories s WHERE s.key = c.key
          )
        """
    ).fetchall()
    print(f"camel keys missing on snake: {len(missing)}")
    for row in missing:
        conn.execute(
            """
            INSERT INTO auto_memories
              (key, content, category, importance, source, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                row["key"],
                row["content"],
                row["category"],
                row["importance"],
                row["source"],
                row["created_at"],
                row["updated_at"],
            ),
        )
        new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        print(f"  inserted key={row['key']!r} as id={new_id} (was camel id={row['id']})")

    conn.commit()
    n_s = conn.execute("SELECT COUNT(*) FROM auto_memories").fetchone()[0]
    n_c = conn.execute("SELECT COUNT(*) FROM autoMemories").fetchone()[0]
    print(f"counts: auto_memories={n_s} autoMemories={n_c}")

    ck = {
        r[0]
        for r in conn.execute(
            "SELECT key FROM autoMemories WHERE key IS NOT NULL AND key != ''"
        )
    }
    sk = {
        r[0]
        for r in conn.execute(
            "SELECT key FROM auto_memories WHERE key IS NOT NULL AND key != ''"
        )
    }
    print(f"keys only on camel: {sorted(ck - sk)}")
    print(f"keys only on snake: {len(sk - ck)} (ok if newer snake-only)")

    try:
        conn.execute("INSERT INTO auto_memories_fts(auto_memories_fts) VALUES('rebuild')")
        conn.commit()
        print("FTS rebuild ok")
    except sqlite3.Error as exc:
        print("FTS rebuild:", exc)
    conn.close()


if __name__ == "__main__":
    main()
