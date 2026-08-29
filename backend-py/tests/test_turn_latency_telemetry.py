"""Phase L (Part 17): per-turn latency + prompt-cache telemetry.

``turn_outcomes`` gains ttft_ms / cache_hit_tokens / cache_miss_tokens
(027 migration + ensure_column), so "chat feels slow" becomes a number:
first-token time and the upstream cache split, recorded on every turn.
"""

from __future__ import annotations


def test_columns_exist_after_init(isolatedData):
    from app.services import memory_store
    from app.services.memory_conn import conn as _conn

    memory_store.init()
    cols = {r['name'] for r in _conn().execute('PRAGMA table_info(turn_outcomes)').fetchall()}
    assert {'ttft_ms', 'cache_hit_tokens', 'cache_miss_tokens'} <= cols


def test_record_turn_outcome_carries_latency_fields(isolatedData):
    from app.services import memory_store, turn_outcomes
    from app.services.memory_conn import conn as _conn

    memory_store.init()
    turn_outcomes.record_turn_outcome(
        model='test-model',
        provider='test-provider',
        task_type='agent',
        ok=True,
        duration_ms=4200,
        session_id='s-telemetry',
        ttft_ms=41000,
        cache_hit_tokens=0,
        cache_miss_tokens=29500,
    )
    row = _conn().execute(
        "SELECT ttft_ms, cache_hit_tokens, cache_miss_tokens FROM turn_outcomes "
        "WHERE session_id='s-telemetry'"
    ).fetchone()
    assert row is not None
    assert row['ttft_ms'] == 41000
    assert row['cache_hit_tokens'] == 0
    assert row['cache_miss_tokens'] == 29500


def test_record_turn_outcome_tolerates_old_callers(isolatedData):
    """The old signature (no latency kwargs) must keep working — older
    call sites and tests must not break."""
    from app.services import memory_store, turn_outcomes
    from app.services.memory_conn import conn as _conn

    memory_store.init()
    turn_outcomes.record_turn_outcome(
        model='m', provider='p', task_type='agent', ok=True, duration_ms=10, session_id='s-old'
    )
    row = _conn().execute(
        "SELECT ttft_ms, cache_hit_tokens, cache_miss_tokens FROM turn_outcomes "
        "WHERE session_id='s-old'"
    ).fetchone()
    assert row['ttft_ms'] == 0
    assert row['cache_hit_tokens'] == 0
    assert row['cache_miss_tokens'] == 0


def test_warm_boot_upgrade_adds_columns(isolatedData, monkeypatch):
    """A v11 DB (027 not yet applied) must gain the telemetry columns on
    the next ensure_schema — the migration runner executes 027 and the
    ensure_column warm path re-asserts them."""
    from app.services import memory_schema, memory_store
    from app.services.memory_conn import conn as _conn

    memory_store.init()
    conn = _conn()
    # Simulate the pre-Phase-L state: columns absent, 027 unapplied, v11.
    for col in ('ttft_ms', 'cache_hit_tokens', 'cache_miss_tokens'):
        conn.execute(f'ALTER TABLE turn_outcomes DROP COLUMN {col}')
    conn.execute('DELETE FROM schema_migrations WHERE version=27')
    conn.execute('PRAGMA user_version=11')
    conn.commit()

    memory_schema.ensure_schema(_conn())
    cols = {r['name'] for r in _conn().execute('PRAGMA table_info(turn_outcomes)').fetchall()}
    assert {'ttft_ms', 'cache_hit_tokens', 'cache_miss_tokens'} <= cols
