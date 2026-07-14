"""Connection PRAGMA defaults must stay durable unless explicitly opted in."""

from __future__ import annotations

from app.services import memory_store


def test_default_pragmas_wal_busy_full_sync(isolatedData, monkeypatch):
    monkeypatch.delenv('AUGUST_SQLITE_SYNC', raising=False)
    monkeypatch.delenv('AUGUST_SQLITE_CACHE_KB', raising=False)
    monkeypatch.delenv('AUGUST_SQLITE_MMAP_MB', raising=False)
    memory_store.close()
    memory_store.init()
    conn = memory_store._conn()
    assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    assert int(conn.execute('PRAGMA busy_timeout').fetchone()[0]) == 10000
    # FULL == 2 — do not default to NORMAL without measure + accept-loss
    assert int(conn.execute('PRAGMA synchronous').fetchone()[0]) == 2
