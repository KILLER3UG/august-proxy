"""
Characterization test: ``consolidationDaemon.runConsolidation`` routes its
writes through the single-writer ``db_writer`` queue (bug B2 audit).

This pins down the CURRENT behavior that the db_writer queue IS used by the
consolidation daemon (the only caller of ``enqueueWrite``), while the bulk of
the ~33 modules write directly through ``memoryStore``. It is intentionally
small: it stubs the LLM call and the brain event bus, then asserts the
daemon enqueues a write and that the enqueued callable performs a real DB
write against a temp database.

Run with:  python -m pytest tests/test_db_writer_coverage.py -q
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.services.memory_store as memoryStore
import app.services.db_writer as dbWriter
import app.services.consolidation_daemon as consolidationDaemon


@pytest.fixture
def temp_brain(monkeypatch, tmp_path):
    """Temporary brain DB with one seeded heuristic (so the daemon proceeds)."""
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    memoryStore.close()
    memoryStore.init()
    conn = memoryStore._conn()
    conn.execute(
        "INSERT INTO learnedHeuristics (rule, source, category) VALUES (?, ?, ?)",
        ('seed rule', 'auto', 'general'),
    )
    conn.commit()
    yield
    memoryStore.close()


def _plan(promote=None, merge=None, delete=None) -> str:
    return json.dumps({
        'merge': merge or [],
        'promote': promote or [],
        'delete': delete or [],
    })


@pytest.mark.asyncio
async def test_consolidation_routes_writes_through_db_writer(temp_brain):
    """runConsolidation must enqueue its writes via dbWriter.enqueueWrite."""
    captured = []

    async def fake_enqueue(fn, priority='low'):
        captured.append((fn, priority))
        return True

    with patch.object(
        consolidationDaemon,
        '_callHippocampus',
        new=AsyncMock(
            return_value=_plan(
                promote=[{'pattern': 'p', 'factKey': 'fk', 'factValue': 'fv'}]
            )
        ),
    ), patch.object(dbWriter, 'enqueueWrite', new=fake_enqueue), patch(
        'app.services.brain_event_bus.emitBrainEvent', new=MagicMock(return_value={})
    ):
        summary = await consolidationDaemon.runConsolidation()

    assert captured, (
        'expected runConsolidation to enqueue at least one write via db_writer'
    )
    # The enqueued callable should perform a real write (INSERT into facts).
    fn, _priority = captured[0]
    conn = memoryStore._conn()
    before = conn.execute('SELECT count(*) FROM facts').fetchone()[0]
    fn()
    after = conn.execute('SELECT count(*) FROM facts').fetchone()[0]
    assert after == before + 1
    assert summary['promoted'] >= 1
