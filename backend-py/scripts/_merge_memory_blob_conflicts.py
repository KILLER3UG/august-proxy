"""Union-merge memory_store blob conflicts with camel (content-aware, not timestamp).

- agent_jobs: union by job id (snake wins on same id)
- self_evolution_log: union by timestamp entry
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "august_brain.sqlite"


def main() -> None:
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row

    def get(table: str, key: str):
        row = conn.execute(
            f'SELECT value, updated_at FROM "{table}" WHERE key=?', (key,)
        ).fetchone()
        if not row:
            return None, None
        return json.loads(row["value"]), row["updated_at"]

    def put(key: str, value: object) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?,?,?)",
            (key, json.dumps(value, ensure_ascii=False), now),
        )

    c_jobs, _ = get("memoryStore", "agent_jobs")
    s_jobs, _ = get("memory_store", "agent_jobs")
    by_id: dict = {}
    for j in c_jobs or []:
        if isinstance(j, dict) and j.get("id"):
            by_id[j["id"]] = j
    for j in s_jobs or []:
        if isinstance(j, dict) and j.get("id"):
            by_id[j["id"]] = j
    merged_jobs = sorted(by_id.values(), key=lambda x: x.get("createdAt") or "")
    put("agent_jobs", merged_jobs)
    print(
        "agent_jobs",
        "merged=",
        len(merged_jobs),
        "camel=",
        len(c_jobs or []),
        "snake_before=",
        len(s_jobs or []),
    )

    c_log, _ = get("memoryStore", "self_evolution_log")
    s_log, _ = get("memory_store", "self_evolution_log")
    by_ts: dict = {}
    for e in c_log or []:
        if isinstance(e, dict) and "timestamp" in e:
            by_ts[str(e["timestamp"])] = e
    for e in s_log or []:
        if isinstance(e, dict) and "timestamp" in e:
            by_ts[str(e["timestamp"])] = e
    merged_log = sorted(by_ts.values(), key=lambda x: float(x.get("timestamp") or 0))
    put("self_evolution_log", merged_log)
    print(
        "self_evolution_log",
        "merged=",
        len(merged_log),
        "camel=",
        len(c_log or []),
        "snake_before=",
        len(s_log or []),
    )

    conn.commit()
    try:
        conn.execute("INSERT INTO memory_store_fts(memory_store_fts) VALUES('rebuild')")
        conn.commit()
        print("memory_store_fts rebuild ok")
    except sqlite3.Error as exc:
        print("fts rebuild:", exc)
    conn.close()


if __name__ == "__main__":
    main()
