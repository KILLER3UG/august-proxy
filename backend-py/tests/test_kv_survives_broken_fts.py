"""A broken FTS index must never be able to lose a durable write.

`save_internal` writes to `memory_store`, which carries an AFTER INSERT
trigger that maintains `memory_store_fts` — an external-content index that is
a SEARCH index, derived and fully rebuildable from the base table at any time.

In SQLite a trigger that raises aborts the statement that fired it, so a
failure to construct the FTS vtable takes the KV row down with it. That is
the wrong way round: the index is a cache, and a cache must not be able to
reject the write.

These tests build the broken state directly (drop the FTS shadow tables and
leave the vtable entry behind, which is what a partial/interrupted schema
application leaves) rather than trying to win a race to produce it.
"""

from __future__ import annotations

import sqlite3

import pytest
from app.services import memory_schema
from app.services.memory_store import kv


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _break_fts_index() -> None:
    """Leave `memory_store_fts` registered but with its shadow tables gone.

    That is the state SQLite reports as a vtable that cannot be opened: the
    vtable entry is in sqlite_master, so `CREATE VIRTUAL TABLE IF NOT EXISTS`
    skips it, but the `_content`/`_idx`/`_docsize`/`_config` tables the
    constructor needs are not there.
    """
    from app.services.memory_conn import conn

    c = conn()
    for shadow in ('memory_store_fts_docsize', 'memory_store_fts_idx'):
        c.execute(f'DROP TABLE IF EXISTS {shadow}')
    c.commit()


class TestSchemaCreationIsSerialized:
    def test_concurrent_core_schema_leaves_a_usable_index(self, brain):
        """The ORIGIN, not the symptom.

        Two connections building the schema against one file can interleave so
        that one creates the sync triggers against a half-built vtable. The
        result is a file whose `memory_store_fts` entry survives while its
        shadow tables do not — and because `CREATE VIRTUAL TABLE IF NOT EXISTS`
        skips the surviving entry, that is permanent.

        With the lock this cannot interleave, so the index is still openable
        afterwards and the KV write that fires its trigger succeeds.
        """
        import threading

        from app.services.memory_conn import conn
        from app.services.memory_schema import create_core_schema

        errors: list[BaseException] = []

        def build() -> None:
            try:
                create_core_schema(conn())
            except BaseException as exc:  # noqa: BLE001 — reported below
                errors.append(exc)

        threads = [threading.Thread(target=build) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f'concurrent schema creation raised: {errors}'
        # The assertion that matters: the index still opens, which is exactly
        # what it does not do when the triggers were built against a
        # half-constructed vtable.
        rows = conn().execute(
            "SELECT key FROM memory_store_fts WHERE memory_store_fts MATCH 'anything'"
        ).fetchall()
        assert rows == []


class TestDurableWriteSurvivesBrokenIndex:
    def test_baseline_write_succeeds_with_a_healthy_index(self, brain):
        kv.save_internal('k', {'v': 1})
        assert kv.get_memory('k') == {'v': 1}

    def test_a_broken_index_is_actually_broken(self, brain):
        """Guard the guard: prove the state really is broken, still.

        Bypasses the recovery wrapper and writes through the raw connection.
        If this ever stops raising, the three tests below would be passing
        against a healthy database and asserting nothing.
        """
        from app.services.memory_conn import conn

        _break_fts_index()
        with pytest.raises(Exception):
            conn().execute(
                "INSERT INTO memory_store (key, value, updated_at) "
                "VALUES ('probe', 'probe', datetime('now'))"
            )

    def test_the_write_survives_and_the_row_is_there(self, brain):
        """The behaviour that matters: data is not lost to a search index."""
        _break_fts_index()
        kv.save_internal('k', {'v': 1})
        assert kv.get_memory('k') == {'v': 1}

    def test_a_healed_index_serves_search_again(self, brain):
        """Repair is not just "the write stopped throwing".

        After the write, the index must be usable again, otherwise every
        search silently returns nothing forever — which is a worse failure
        than the one being fixed, because it looks like "no matches".
        """
        from app.services.memory_conn import conn

        _break_fts_index()
        kv.save_internal('searchable-needle', {'v': 1})
        rows = conn().execute(
            "SELECT key FROM memory_store_fts WHERE memory_store_fts MATCH 'searchable'"
        ).fetchall()
        assert [r['key'] for r in rows] == ['searchable-needle']

    def test_repeated_writes_stay_writable(self, brain):
        """Not a one-shot: a later write must not trip over the same state."""
        _break_fts_index()
        for i in range(5):
            kv.save_internal(f'k{i}', {'v': i})
        for i in range(5):
            assert kv.get_memory(f'k{i}') == {'v': i}


class _FailingOnceConn:
    """A connection proxy whose first memory INSERT raises, then behaves normally.

    Stands in for the contention this path exists for. It is a proxy rather
    than a real second connection because the property under test — "no DDL
    ran" — is observable without racing actual threads, and a test that needed
    a race would itself be the flake. `sqlite3.Connection.execute` is
    read-only, so the proxy stands in for the whole connection rather than
    the method.
    """

    def __init__(self, conn):
        self._conn = conn
        self._raised = False

    def execute(self, sql, *args, **kwargs):
        if not self._raised and 'INSERT INTO memory_store' in sql:
            self._raised = True
            raise sqlite3.OperationalError('database is locked')
        return self._conn.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


class TestRebuildOnlyWhenTheIndexIsActuallyBroken:
    """The architectural half: repair what is broken, not what touched it.

    `_write_with_fts_recovery` used to DROP-and-CREATE on ANY SQLite error
    from a memory write. That is five `DROP TABLE` statements plus a `CREATE
    VIRTUAL TABLE` against a file every thread has open, executed on a REQUEST
    path — so a write that failed only because the file was momentarily busy
    escalated into destructive DDL, and the DROP is precisely what makes some
    *other* connection's next statement fail with `vtable constructor failed`.
    The recovery path was manufacturing the symptom it existed to cure, which
    is why it never reproduced locally and failed CI five times across five
    different tests.
    """

    def test_a_genuinely_broken_index_is_still_rebuilt_and_the_row_lands(self, brain):
        """The property the recovery path exists for must not regress."""
        conn = kv._conn()
        kv.save_internal('before', 'x')
        # Drop one shadow table: the vtable entry survives, the index does not.
        conn.execute('DROP TABLE memory_store_fts_data')
        conn.commit()
        assert not memory_schema.fts_index_intact(conn)

        kv.save_internal('after', 'y')

        assert kv.get_memory('after') == 'y', 'the row was lost to a broken index'
        assert memory_schema.fts_index_intact(conn), 'the index was not repaired'

    def test_a_missing_index_reads_as_broken(self, brain):
        conn = kv._conn()
        assert memory_schema.fts_index_intact(conn)
        conn.execute('DROP TABLE IF EXISTS memory_store_fts')
        conn.commit()
        assert not memory_schema.fts_index_intact(conn)

    def test_contention_does_not_run_ddl(self, brain, monkeypatch):
        """The regression the five CI failures actually were.

        A write that fails for a reason unrelated to the index must not cost
        the file five DROPs. Counted, not timed.
        """
        conn = kv._conn()
        rebuilds: list[int] = []
        monkeypatch.setattr(
            memory_schema, 'rebuild_fts_index', lambda *a, **k: rebuilds.append(1) or True
        )
        monkeypatch.setattr(memory_schema, 'fts_index_intact', lambda *a, **k: True)
        monkeypatch.setattr(kv, '_conn', lambda: _FailingOnceConn(conn))

        kv.save_internal('k', 'v')

        assert rebuilds == [], (
            f'the index was whole and the rebuild still ran {len(rebuilds)}x — this is '
            'the DDL-on-contention path that five CI failures were reporting'
        )

    def test_contention_still_lets_the_write_land(self, brain, monkeypatch):
        """The retry is the point: an intact index must not lose the row."""
        conn = kv._conn()
        monkeypatch.setattr(memory_schema, 'fts_index_intact', lambda *a, **k: True)
        monkeypatch.setattr(
            memory_schema,
            'rebuild_fts_index',
            lambda *a, **k: pytest.fail('rebuilt a whole index over a lock timeout'),
        )
        monkeypatch.setattr(kv, '_conn', lambda: _FailingOnceConn(conn))

        kv.save_internal('retry-key', 'value')

        assert kv.get_memory('retry-key') == 'value', 'a transient failure lost a write'
