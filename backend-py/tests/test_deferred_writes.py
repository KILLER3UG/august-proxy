"""P4.2 — debounced persistence for high-frequency per-turn writes.

Covers the ``defer_commit`` contract and its wiring into the three
per-turn writers (turn_outcomes, lifecycle, internal_state):

* Sync/worker contexts commit immediately (behavior unchanged).
* On a loop thread the commit is deferred: same-connection reads still see
  the row (visibility unchanged), a foreign connection does not until the
  flush fires (≤2s window or explicit ``flush_thread_pending``).
* Repeated defers collapse into ONE commit (the batching property).
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
from app.services import deferred_writes
from app.services.deferred_writes import defer_commit, flush_thread_pending


class _CommitSpy:
    """Minimal conn stand-in that records commit calls."""

    def __init__(self) -> None:
        self.commits = 0
        self.in_transaction = True

    def commit(self) -> None:
        self.commits += 1
        self.in_transaction = False


@pytest.fixture(autouse=True)
def _clean_registry():
    flush_thread_pending()
    yield
    flush_thread_pending()
    with deferred_writes._lock:
        deferred_writes._pending.clear()
        deferred_writes._timers.clear()


def test_sync_context_commits_immediately() -> None:
    """No running loop → the commit happens inline (tests/boot unchanged)."""
    spy = _CommitSpy()
    defer_commit(spy)  # type: ignore[arg-type]
    assert spy.commits == 1


def test_loop_thread_defers_and_same_conn_reads_see_row(tmp_path: Path) -> None:
    """On a loop thread the commit is deferred; visibility rules hold."""
    brain = tmp_path / 'defer.sqlite'
    conn = sqlite3.connect(str(brain))
    conn.execute('CREATE TABLE t (x INTEGER)')

    async def scenario() -> None:
        conn.execute('INSERT INTO t VALUES (1)')
        defer_commit(conn)
        # Not committed yet: a foreign connection must not see the row.
        foreign = sqlite3.connect(str(brain))
        try:
            count = foreign.execute('SELECT COUNT(*) FROM t').fetchone()[0]
        finally:
            foreign.close()
        assert count == 0, 'deferred row leaked across connections before flush'
        flush_thread_pending()

    try:
        asyncio.run(scenario())
    finally:
        conn.close()
    foreign = sqlite3.connect(str(brain))
    try:
        assert foreign.execute('SELECT COUNT(*) FROM t').fetchone()[0] == 1
    finally:
        foreign.close()


def test_repeated_defers_collapse_into_one_commit() -> None:
    spy = _CommitSpy()

    async def scenario() -> None:
        defer_commit(spy)  # type: ignore[arg-type]
        defer_commit(spy)  # type: ignore[arg-type]
        defer_commit(spy)  # type: ignore[arg-type]
        assert spy.commits == 0, 'commit fired before the debounce window'
        flush_thread_pending()

    asyncio.run(scenario())
    assert spy.commits == 1, 'repeated defers must collapse into a single commit'


def test_loop_timer_flushes_without_explicit_flush() -> None:
    """The armed call_later flush commits inside the window on its own."""
    spy = _CommitSpy()

    async def scenario() -> None:
        defer_commit(spy, window_s=0.2)  # type: ignore[arg-type]
        await asyncio.sleep(0.5)

    asyncio.run(scenario())
    assert spy.commits == 1


def test_record_turn_outcome_lands_after_flush(tmp_path: Path) -> None:
    """Wiring: the P4.2 writer keeps recording rows under deferral."""
    from app.services import memory_store, turn_outcomes

    memory_store.init()

    async def scenario() -> None:
        turn_outcomes.record_turn_outcome(
            model='m', provider='p', task_type='agent', ok=True, duration_ms=5
        )
        flush_thread_pending()

    asyncio.run(scenario())
    from app.services.memory_conn import db_path

    foreign = sqlite3.connect(str(db_path()))
    try:
        row = foreign.execute(
            'SELECT model, provider, ok FROM turn_outcomes'
        ).fetchone()
    finally:
        foreign.close()
    assert row == ('m', 'p', 1)


# ── raw-BEGIN interaction: a deferred write must not break session saves ────
#
# A per-turn deferred writer runs on the loop thread and leaves the thread-local
# connection inside an open implicit transaction (only the COMMIT is debounced).
# save_workbench_session_sot / delete_workbench_session then issue a raw
# ``conn.execute('BEGIN')``, which used to raise "cannot start a transaction
# within a transaction" and lose the whole save/delete.


def test_deferred_write_then_session_save_does_not_hit_nested_begin() -> None:
    from app.services import memory_store
    from app.services.memory_conn import conn as _conn
    from app.services.memory_store import sessions as sess
    from app.services.memory_store.rest import record_lifecycle

    memory_store.init()

    async def scenario() -> None:
        # Deferred per-turn write: leaves the connection mid-transaction.
        record_lifecycle('sess-1', 'turn_start', {'a': 1})
        assert _conn().in_transaction is True, 'deferred write must hold the txn open'

        # A raw-BEGIN session save must now succeed instead of raising.
        sess.save_workbench_session_sot(
            {'id': 'sess-1', 'title': 'T', 'startedAt': 'x', 'updatedAt': 'x'},
            [{'role': 'user', 'content': 'hi'}],
        )
        flush_thread_pending()

    asyncio.run(scenario())
    # The session row persisted (and did not raise OperationalError).
    row = _conn().execute('SELECT title FROM sessions WHERE id = ?', ('sess-1',)).fetchone()
    assert row is not None and row['title'] == 'T'


def test_deferred_write_then_session_delete_does_not_hit_nested_begin() -> None:
    from app.services import memory_store
    from app.services.memory_conn import conn as _conn
    from app.services.memory_store import sessions as sess
    from app.services.memory_store.rest import record_lifecycle

    memory_store.init()
    sess.save_workbench_session_sot(
        {'id': 'sess-del', 'title': 'D', 'startedAt': 'x', 'updatedAt': 'x'},
        [{'role': 'user', 'content': 'bye'}],
    )

    async def scenario() -> None:
        record_lifecycle('sess-del', 'turn_start', {'a': 1})
        assert _conn().in_transaction is True
        result = sess.delete_session_cascade('sess-del', notify=False)
        assert result.get('ok') is True
        flush_thread_pending()

    asyncio.run(scenario())
    assert _conn().execute('SELECT 1 FROM sessions WHERE id = ?', ('sess-del',)).fetchone() is None
