"""Regression tests for the memory/skills loop audit fixes.

Covers five findings:
1. ReviewGates tool-round delta — cumulative tool counts must not re-fire
   the reflection gate on every turn once the interval is passed once.
2. _parseRecommendations JSON repair — apostrophes in extracted rules must
   survive; trailing commas / prose-wrapped objects must still parse.
3. Skill usage telemetry — load_skill bumps viewCount; reflection writes
   bump patchCount (authorship), NOT useCount.
4. Lifecycle wiring — recall records 'retrieved' events; consolidation
   marks never-retrieved memories stale.
5. Graph 1-hop expansion — recall pulls directly-linked graph neighbors
   without displacing direct hits.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from types import SimpleNamespace

import pytest
from app.services.memory.background_review import (
    ReviewGates,
    _parseRecommendations,
    tryBackgroundReview,
)

# ─── 1. Reflection gate: tool-round delta ────────────────────────────────────


class TestReviewGateToolRoundDelta:
    def test_cumulative_rounds_do_not_refire(self):
        """6 cumulative rounds fired once; no NEW rounds must not re-fire."""
        gates = ReviewGates(turn_interval=3, tool_round_interval=6)
        assert gates.shouldReview(sessionTurns=1, toolRounds=6, lastReviewedAtTurn=0, lastReviewedToolRounds=0) is True
        # After that review (markers at turns=1/rounds=6): same cumulative
        # count and +2 rounds → neither interval reached.
        assert gates.shouldReview(sessionTurns=2, toolRounds=6, lastReviewedAtTurn=1, lastReviewedToolRounds=6) is False
        assert gates.shouldReview(sessionTurns=3, toolRounds=8, lastReviewedAtTurn=1, lastReviewedToolRounds=6) is False
        # Only 6 NEW rounds since last review fire again.
        assert gates.shouldReview(sessionTurns=3, toolRounds=12, lastReviewedAtTurn=1, lastReviewedToolRounds=6) is True

    def test_turn_interval_still_works_with_round_marker(self):
        gates = ReviewGates(turn_interval=3, tool_round_interval=6)
        # +2 turns / 0 new rounds: neither reached.
        assert gates.shouldReview(sessionTurns=5, toolRounds=99, lastReviewedAtTurn=3, lastReviewedToolRounds=99) is False
        # +3 turns fires even with zero NEW tool rounds.
        assert gates.shouldReview(sessionTurns=6, toolRounds=99, lastReviewedAtTurn=3, lastReviewedToolRounds=99) is True

    @pytest.mark.asyncio
    async def test_try_background_review_records_round_marker(self):
        """The session marker for reviewed tool rounds is stored on fire."""
        called: list[bool] = []

        async def dummyLlm(_: object) -> str:
            called.append(True)
            return '{}'

        messages = [{'role': 'user'}, {'role': 'assistant'}] + [
            {'role': 'tool'} for _ in range(6)
        ]
        session = SimpleNamespace(messageCount=2)
        await tryBackgroundReview(
            session,
            messages,
            gates=ReviewGates(turn_interval=100, tool_round_interval=6),
            llm_client=dummyLlm,
        )
        await asyncio.sleep(0.05)
        assert called == [True]
        assert getattr(session, '_last_reviewed_tool_rounds', None) == 6

        # Second call with no new rounds and no new turns must NOT re-fire.
        called.clear()
        await tryBackgroundReview(
            session,
            messages,
            gates=ReviewGates(turn_interval=100, tool_round_interval=6),
            llm_client=dummyLlm,
        )
        await asyncio.sleep(0.05)
        assert called == []


# ─── 2. Recommendation parsing: apostrophe-safe repair ───────────────────────


class TestParseRecommendations:
    def test_clean_json_parses(self):
        got = _parseRecommendations('{"facts": ["User uses uv"], "frustration": false}')
        assert got['facts'] == ['User uses uv']

    def test_fenced_json_parses(self):
        got = _parseRecommendations('```json\n{"facts": []}\n```')
        assert got == {'facts': []}

    def test_apostrophes_survive_repair(self):
        raw = "{'corrections': [{'rule': \"don't use unittest\", 'confidence': 0.9}]}"
        got = _parseRecommendations(raw)
        rule = str(got.get('corrections', [{}])[0].get('rule', ''))
        assert "don't" in rule

    def test_trailing_comma_repaired(self):
        got = _parseRecommendations('{"facts": ["a", "b",], "frustration": false,}')
        assert got.get('facts') == ['a', 'b']
        assert got.get('frustration') is False

    def test_prose_wrapped_object_parses(self):
        got = _parseRecommendations('Here is the result:\n{"facts": ["x"]}\nDone.')
        assert got.get('facts') == ['x']

    def test_garbage_returns_empty_shape(self):
        got = _parseRecommendations('not json at all')
        assert got == {'corrections': [], 'facts': [], 'skills': [], 'frustration': False}


# ─── 3. Skill telemetry: view on load, patch (not use) on authorship ─────────


@pytest.fixture()
def isolatedCurator(tmp_path, monkeypatch):
    """Point the curator sidecar + skill roots at temp dirs.

    SkillCurator() instances constructed after this fixture read/write the
    temp sidecar (its __init__ resolves dataDir from settings, which conftest
    already isolates) — no class patching needed.
    """
    from app.services import skill_service

    agentRoot = tmp_path / 'agent-skills'
    bundledRoot = tmp_path / 'bundled-skills'
    agentRoot.mkdir()
    bundledRoot.mkdir()
    monkeypatch.setattr(skill_service, '_agentSkillsDir', lambda: agentRoot)
    monkeypatch.setattr(skill_service, 'SKILLS_DIR', bundledRoot)
    skill_service._flat_migrate_done = False

    from app.services.skills.curator import SkillCurator
    from app.services.workbench import prompt_segments_cache

    prompt_segments_cache.clear()
    curator = SkillCurator(dataDir=tmp_path)
    yield curator, skill_service
    prompt_segments_cache.clear()
    skill_service._flat_migrate_done = False


@pytest.mark.asyncio
async def test_load_skill_bumps_view(isolatedCurator):
    curator, skill_service = isolatedCurator
    skill_service.createSkill(
        'telemetry-skill',
        'A skill for telemetry checks.',
        '## When to Use\n\nWhenever.\n\n## How to Run\n\n1. Run it.',
        createdBy='agent',
    )

    from app.services.tool_registrations.skill_tools import _loadSkill

    out = await _loadSkill('telemetry-skill')
    assert 'telemetry-skill' in out
    # The loader bumps via its own curator instance persisted to the shared
    # sidecar — re-read before asserting.
    curator._load()
    rec = curator.get_record('telemetry-skill')
    assert rec is not None and rec.viewCount == 1


def test_skill_authorship_bumps_patch_not_use(isolatedCurator):
    """Reflection-driven create/patch must not inflate useCount."""
    from app.services.memory.background_review import _emitSkillEvent

    curator, __ = isolatedCurator
    _emitSkillEvent('authored-skill', 'create', 'desc')
    # The event emitter bumps via its own curator instance persisted to the
    # shared sidecar — re-read before asserting.
    curator._load()
    rec = curator.get_record('authored-skill')
    assert rec is not None
    assert rec.patchCount == 1
    assert rec.useCount == 0


def test_catalogue_with_usage_includes_telemetry_and_quality(isolatedCurator):
    curator, skill_service = isolatedCurator
    skill_service.createSkill(
        'scored-skill',
        'A skill that should carry a quality score.',
        '## When to Use\n\nNow.\n\n## How to Run\n\n1. Do it.\n2. Verify output.',
        createdBy='agent',
    )
    curator.bump_view('scored-skill')
    entries = {str(e['name']): e for e in skill_service.catalogue_with_usage()}
    entry = entries['scored-skill']
    assert entry['viewCount'] == 1
    assert isinstance(entry.get('quality'), dict) and entry['quality']['score'] >= 0


# ─── 4. Lifecycle wiring ─────────────────────────────────────────────────────


@pytest.fixture()
def brain_conn(tmp_path, monkeypatch):
    """Fresh brain DB wired into memory_store._conn (same pattern as
    test_lifecycle_friction.py)."""
    from app.services.memory_schema import ensure_schema

    db_file = tmp_path / 'test_brain.sqlite'
    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    ensure_schema(conn)

    import app.services.memory_store as ms

    monkeypatch.setattr(ms, '_conn', lambda: conn)
    yield conn
    conn.close()


def test_recall_records_lifecycle_retrieved(brain_conn):
    from app.services.memory.auto_memory import getRelevantMemories, saveAutoMemory

    saveAutoMemory('fact_uv_migration', 'This repo migrates to uv for package management',
                   category='fact', importance=0.9, source='user')
    hits = getRelevantMemories('uv package management', limit=5)
    assert hits, 'recall should find the saved memory'
    rows = brain_conn.execute(
        "SELECT memory_key, event FROM memory_lifecycle WHERE event = 'retrieved'"
    ).fetchall()
    keys = {r['memory_key'] for r in rows}
    assert 'fact_uv_migration' in keys


def test_consolidation_marks_stale_memories(brain_conn, monkeypatch):
    """runConsolidation calls mark_stale_memories (previously orphaned)."""
    old = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() - 40 * 86400))
    brain_conn.execute(
        'INSERT INTO memory_lifecycle (memory_key, event, created_at) VALUES (?, ?, ?)',
        ('never_recalled_fact', 'created', old),
    )
    brain_conn.commit()

    from app.services import consolidation_daemon as cd

    async def noopPlan(*a, **kw):
        return {'merged': 0, 'promoted': 0, 'deleted_stale': 0, 'errors': []}

    monkeypatch.setattr(cd, '_build_consolidation_plan', noopPlan)

    stats = asyncio.run(cd.runConsolidation(apply=True))
    assert stats['deleted_stale'] == 0
    row = brain_conn.execute(
        "SELECT COUNT(*) AS c FROM memory_lifecycle WHERE memory_key = 'never_recalled_fact' AND event = 'stale'"
    ).fetchone()
    assert int(row['c']) == 1


# ─── 5. Graph 1-hop expansion in recall ──────────────────────────────────────


def test_recall_expands_graph_neighbors(brain_conn):
    """A graph-only neighbor (FTS-invisible) is pulled in and flagged."""
    from app.services.memory import graph_memory
    from app.services.memory.auto_memory import getRelevantMemories, saveAutoMemory

    saveAutoMemory('project_august_proxy', 'August proxy backend service details',
                   category='fact', importance=0.9, source='user')
    # Neighbor shares NO tokens with the query — only the graph edge links it.
    saveAutoMemory('related_stack_note', 'FastAPI plus SQLite stack decision recorded earlier',
                   category='fact', importance=0.8, source='auto')

    graph_memory.addRelation('project_august_proxy', 'related_stack_note', 'related')

    hits = getRelevantMemories('august proxy backend', limit=5)
    keys = [str(h.get('key')) for h in hits]
    assert 'project_august_proxy' in keys, 'direct FTS hit missing'
    assert 'related_stack_note' in keys, 'graph neighbor was not pulled in'
    neighbor = next(h for h in hits if h.get('key') == 'related_stack_note')
    assert neighbor.get('viaGraph') is True


def test_graph_expansion_respects_durable_filter(brain_conn):
    from app.services.memory import graph_memory
    from app.services.memory.auto_memory import getRelevantMemories, saveAutoMemory

    saveAutoMemory('durable_anchor', 'Durable anchor fact about deployment pipeline',
                   category='fact', importance=0.9, source='user')
    saveAutoMemory('conv_summary_20260821_120000', 'User asked: hi (session wb_x)',
                   category='conversation', importance=0.4, source='auto')
    graph_memory.addRelation('durable_anchor', 'conv_summary_20260821_120000', 'related')

    hits = getRelevantMemories('deployment pipeline', limit=5, durable_only=True)
    keys = [str(h.get('key')) for h in hits]
    assert 'conv_summary_20260821_120000' not in keys, 'non-durable neighbor leaked via graph path'


def test_graph_expansion_never_displaces_direct_hits(brain_conn):
    from app.services.memory import graph_memory
    from app.services.memory.auto_memory import getRelevantMemories, saveAutoMemory

    saveAutoMemory('direct_hit_a', 'Primary fact about retry backoff policy',
                   category='fact', importance=0.9, source='user')
    saveAutoMemory('neighbor_b', 'Linked note mentioning retry backoff too',
                   category='fact', importance=0.8, source='user')
    saveAutoMemory('neighbor_c', 'Another linked note about retry backoff behavior',
                   category='fact', importance=0.8, source='user')
    graph_memory.addRelation('direct_hit_a', 'neighbor_b', 'related')
    graph_memory.addRelation('direct_hit_a', 'neighbor_c', 'related')

    hits = getRelevantMemories('retry backoff policy', limit=1)
    assert len(hits) <= 2, 'expansion blew past the half-limit budget'
    assert str(hits[0].get('key')) == 'direct_hit_a', 'a graph neighbor displaced the top hit'
