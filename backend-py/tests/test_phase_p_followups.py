"""Cross-cutting Phase P follow-up smokes (not FTS/gateway/pragma — see dedicated files).

FTS: test_fts_app_path.py + scripts/_check_fts_query_hygiene.py
Gateway: test_gateway_final_output.py
PRAGMA: test_sqlite_pragma_defaults.py
"""

from __future__ import annotations

import time

import pytest

from app.lib.batched_emit import BatchedEmit
from app.services import db_writer, memory_store


def test_batched_emit_time_budget_flushes():
    out: list[dict] = []
    b = BatchedEmit(out.append, max_chars=10_000, max_interval_ms=5.0)
    b({'type': 'finalOutput', 'content': 'A'})
    assert out[-1]['content'] == 'A'
    b({'type': 'finalOutput', 'content': 'B'})
    time.sleep(0.02)
    b({'type': 'finalOutput', 'content': 'C'})
    assert any(e.get('content') == 'BC' for e in out)


@pytest.mark.asyncio
async def test_db_writer_stats_counters(isolatedData):
    db_writer.reset_stats()
    await db_writer.enqueue_write(lambda: None, priority='high')
    await db_writer.enqueue_write(lambda: None, priority='low')
    for _ in range(50):
        st = db_writer.get_stats()
        if int(st.get('executed') or 0) >= 1:
            break
        await __import__('asyncio').sleep(0.02)
    st = db_writer.get_stats()
    assert int(st['enqueued']) >= 2
    assert 'queue_depth' in st


def test_schema_user_version_warm_path(isolatedData):
    memory_store.init()
    conn = memory_store._conn()
    ver = int(conn.execute('PRAGMA user_version').fetchone()[0])
    assert ver >= 5
    from app.services.memory_schema import ensure_schema

    ensure_schema(conn)
    assert int(conn.execute('PRAGMA user_version').fetchone()[0]) == ver
