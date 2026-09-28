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

import pytest
from app.services.memory_store import kv


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _break_fts_index() -> None:
    """Leave `memory_store_fts` registered but with its shadow tables gone.

    That is the state SQLite reports as `vtable constructor failed`: the
    vtable entry is in sqlite_master, so `CREATE VIRTUAL TABLE IF NOT EXISTS`
    skips it, but the `_content`/`_idx`/`_docsize`/`_config` tables the
    constructor needs are not there.
    """
    from app.services.memory_conn import conn

    c = conn()
    for shadow in ('memory_store_fts_docsize', 'memory_store_fts_idx'):
        c.execute(f'DROP TABLE IF EXISTS {shadow}')
    c.commit()


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
