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


def test_wal_conversion_waits_out_a_concurrent_first_open(tmp_path):
    """`journal_mode=WAL` gets no busy handler, so it has to retry itself.

    SQLite deliberately does not invoke the busy handler to take the write lock
    a journal-mode change needs — two connections waiting on each other there
    would deadlock. So `sqlite3.connect(timeout=…)` does NOT cover this one
    statement, while every pragma after it is fine. Two threads opening the same
    brand-new brain database therefore fail here with `database is locked`.

    That is the flake behind the `isolatedData` setup errors under `-n auto`: a
    leaked thread lazily opens the *next* test's fresh file, because
    `AUGUST_BRAIN_SQLITE_FILE` is process-global env. Measured before the retry:
    5 failures / 72 concurrent inits of a fresh file, 0 / 72 once WAL was
    already set — which is what localised it to this pragma and nothing else.
    """
    import sqlite3
    import threading

    from app.services.memory_conn import apply_conn_pragmas

    db = tmp_path / 'race.sqlite'
    # check_same_thread=False because the release happens on the helper thread;
    # without it sqlite refuses the rollback, the lock is never dropped, and the
    # test fails for the wrong reason.
    holder = sqlite3.connect(str(db), timeout=0, check_same_thread=False)
    holder.execute('CREATE TABLE t (x)')
    holder.execute('BEGIN IMMEDIATE')

    release = threading.Event()

    def _release_later() -> None:
        # Long enough that one un-retried attempt cannot possibly succeed, short
        # enough to sit well inside the retry budget.
        release.wait(0.4)
        if holder.in_transaction:
            holder.rollback()
        holder.close()

    waiter = threading.Thread(target=_release_later, daemon=True)
    waiter.start()
    try:
        victim = sqlite3.connect(str(db), timeout=0)
        apply_conn_pragmas(victim)
        assert victim.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
        victim.close()
    finally:
        release.set()
        waiter.join(timeout=5)
