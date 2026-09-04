"""Phase P exit gate — permanent checks that must stay green to call Phase P closed.

These are not optional smoke: they encode the verification lessons from the
Phase P audit (app-path FTS, durable SQLite defaults, gateway emit contract).
"""

from __future__ import annotations

from pathlib import Path

import pytest


def test_fts_query_hygiene_static_scan_clean():
    """App source must not contain FTS anti-patterns (alias/content MATCH)."""
    from scripts._check_fts_query_hygiene import static_scan

    fails = static_scan()
    assert fails == [], fails


def test_fts_hygiene_script_importable_and_known_tables():
    from scripts._check_fts_query_hygiene import KNOWN_FTS

    assert 'memory_store_fts' in KNOWN_FTS
    # auto_memories_fts retired (Part 21 OQ1 / migration 033) — no longer a
    # known FTS table (Part 25 Phase 7.4).
    assert 'auto_memories_fts' not in KNOWN_FTS


def test_workbench_emit_types_include_finalOutput_not_only_snake():
    from app.services.workbench.emit_types import (
        ASSISTANT_TEXT_EMIT_TYPES,
        WORKBENCH_EMIT_TYPES,
    )

    assert 'finalOutput' in WORKBENCH_EMIT_TYPES
    assert 'finalOutput' in ASSISTANT_TEXT_EMIT_TYPES
    # legacy accepted for gateway only
    assert 'final_output' in ASSISTANT_TEXT_EMIT_TYPES
    assert 'final_output' not in WORKBENCH_EMIT_TYPES


def test_sqlite_defaults_are_durable(isolatedData, monkeypatch):
    monkeypatch.delenv('AUGUST_SQLITE_SYNC', raising=False)
    from app.services import memory_store

    memory_store.close()
    memory_store.init()
    conn = memory_store._conn()
    assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    assert int(conn.execute('PRAGMA synchronous').fetchone()[0]) == 2  # FULL


def test_phase_p_modules_import():
    """Smoke: hot-path modules load (regression if package split breaks imports)."""
    from app.lib import batched_emit  # noqa: F401
    from app.services import memory_store  # noqa: F401
    from app.services.workbench import (  # noqa: F401
        chat_stages,
        emit_types,
        parallel_tools,
        stream_translate,  # noqa: F401
    )

    assert callable(memory_store.save_internal)
    assert callable(memory_store.get_messages)
    assert callable(memory_store.close)


def test_developer_guide_documents_phase_p_knobs():
    root = Path(__file__).resolve().parents[2]
    guide = (root / 'docs' / 'DEVELOPER_GUIDE.md').read_text(encoding='utf-8')
    for needle in (
        'AUGUST_P1_TOOL_CACHE',
        'AUGUST_P1_PARALLEL_TOOLS',
        'AUGUST_SQLITE_SYNC',
    ):
        # AUGUST_P1_PROMPT_CACHE dropped from the required-docs list (Part 25
        # Phase 7.2): it is never read in the code, so it should not be
        # documented as a live knob (removed from the guides too).
        assert needle in guide, f'missing knob/docs: {needle}'
