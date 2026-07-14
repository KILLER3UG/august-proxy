"""Content-diff dual memoryStore / memory_store keys (not timestamp-only).

For agent_jobs and self_evolution_log: parse JSON when possible and report
whether camel has unique entries that snake lacks.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "august_brain.sqlite"
KEYS = ("agent_jobs", "self_evolution_log")


def _load(conn: sqlite3.Connection, table: str, key: str):
    if (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is None
    ):
        return None
    row = conn.execute(
        f'SELECT value, updated_at FROM "{table}" WHERE key=?', (key,)
    ).fetchone()
    return row


def _parse(val: str):
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return val


def _job_ids(payload) -> set[str]:
    if not isinstance(payload, list):
        return set()
    out = set()
    for item in payload:
        if isinstance(item, dict) and item.get("id"):
            out.add(str(item["id"]))
    return out


def _log_timestamps(payload) -> set[str]:
    if not isinstance(payload, list):
        return set()
    out = set()
    for item in payload:
        if isinstance(item, dict) and "timestamp" in item:
            out.add(str(item["timestamp"]))
    return out


def main() -> int:
    if not DB.exists():
        print("DB missing", file=sys.stderr)
        return 1
    conn = sqlite3.connect(str(DB))
    print("=== memoryStore / memory_store content conflict report ===\n")
    for key in KEYS:
        c_row = _load(conn, "memoryStore", key)
        s_row = _load(conn, "memory_store", key)
        print(f"--- key={key!r} ---")
        if c_row is None and s_row is None:
            print("  absent on both")
            continue
        if c_row is None:
            print("  camel: MISSING")
        else:
            print(f"  camel updated_at={c_row[1]} value_len={len(str(c_row[0]))}")
        if s_row is None:
            print("  snake: MISSING")
        else:
            print(f"  snake updated_at={s_row[1]} value_len={len(str(s_row[0]))}")

        if c_row is None or s_row is None:
            print("  verdict: one side missing — not a pure timestamp conflict")
            print()
            continue

        c_val = _parse(c_row[0])
        s_val = _parse(s_row[0])
        identical = c_val == s_val
        print(f"  identical_content={identical}")

        if key == "agent_jobs":
            c_ids = _job_ids(c_val)
            s_ids = _job_ids(s_val)
            only_c = sorted(c_ids - s_ids)
            only_s = sorted(s_ids - c_ids)
            print(f"  job_ids only_camel={only_c}")
            print(f"  job_ids only_snake={only_s}")
            print(f"  job_ids both={len(c_ids & s_ids)} camel_n={len(c_ids)} snake_n={len(s_ids)}")
            if only_c:
                print("  VERDICT: camel has job ids not in snake — 'newer wins' DROPS unique camel jobs")
            elif only_s and not only_c:
                print("  VERDICT: snake is superset by job id (or different run) — keeping snake OK for ids")
            elif identical:
                print("  VERDICT: identical")
            else:
                print("  VERDICT: same job-id set or partial overlap but different payloads — review manually")

        if key == "self_evolution_log":
            c_ts = _log_timestamps(c_val)
            s_ts = _log_timestamps(s_val)
            only_c = sorted(c_ts - s_ts)
            only_s = sorted(s_ts - c_ts)
            print(f"  log timestamps only_camel={only_c}")
            print(f"  log timestamps only_snake={only_s}")
            print(f"  entries camel_n={len(c_val) if isinstance(c_val, list) else 'n/a'} "
                  f"snake_n={len(s_val) if isinstance(s_val, list) else 'n/a'}")
            if only_c:
                print(
                    "  VERDICT: camel has log entries not in snake — "
                    "append/merge needed; 'newer wins' DROPS history"
                )
            elif only_s and not only_c:
                print("  VERDICT: snake is superset by timestamp — keep snake")
            elif identical:
                print("  VERDICT: identical")
            else:
                print("  VERDICT: different content without simple timestamp set diff — review")

        print()
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
