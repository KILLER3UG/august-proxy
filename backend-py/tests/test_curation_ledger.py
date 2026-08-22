"""Round-5 curation ledger: one decision journal for every loop.

Pins the unification contract: reflection, sleep cycle, model review, and
heuristic promotion all append to ``curation_ledger``; the consolidation
planner and model-review payload consume recent entries so downstream loops
do not redo or contradict upstream decisions.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_md_export(monkeypatch):
    monkeypatch.setenv('AUGUST_MEMORY_MD_EXPORT', '0')


@pytest.fixture()
def ledger(brain_ready):
    from app.services.memory import curation_ledger

    return curation_ledger


class TestRecorderBasics:
    def test_record_and_recent_roundtrip(self, ledger):
        ledger.record('reflection', 'supersede', 'auto_memory', 'pref_1', reason='corrected rule')
        rows = ledger.recent(10)
        assert len(rows) == 1
        assert rows[0]['actor'] == 'reflection'
        assert rows[0]['target_key'] == 'pref_1'
        assert 'corrected' in str(rows[0]['reason'])

    def test_filters(self, ledger):
        ledger.record('reflection', 'save_fact', 'fact', 'coreMemory')
        ledger.record('sleep_cycle', 'merge', 'heuristic', 'heuristic:3')
        assert len(ledger.recent(50, actor='sleep_cycle')) == 1
        assert len(ledger.recent(50, target_kind='fact')) == 1
        assert len(ledger.recent(50)) == 2

    def test_summary_for_prompt(self, ledger):
        ledger.record('reflection', 'supersede', 'auto_memory', 'stale_pref', reason='user corrected this')
        summary = ledger.summary_for_prompt(5)
        assert '[reflection] supersede stale_pref' in summary
        assert 'user corrected this' in summary

    def test_empty_summary(self, ledger):
        assert ledger.summary_for_prompt(5) == ''


class TestActorWiring:
    def test_save_fact_records(self, brain_ready, ledger):
        from app.services.memory.background_review import _saveFact

        _saveFact('add', 'User deploys with docker compose on staging')
        rows = ledger.recent(10)
        assert any(r['action'] == 'save_fact' for r in rows)

    def test_supersede_records_per_demoted_row(self, brain_ready, ledger):
        from app.services.memory.background_review import _supersedeStaleFacts
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) "
            "VALUES ('stale-pref', '\"User prefers unittest over pytest\"', 'preference', 0.8, 'auto', 0, datetime('now'), datetime('now'))"
        )
        conn.commit()
        demoted = _supersedeStaleFacts('From now on the user always prefers pytest over unittest')
        assert demoted == 1
        rows = [r for r in ledger.recent(10) if r['action'] == 'supersede']
        assert len(rows) == 1
        assert rows[0]['target_key'] == 'stale-pref'

    def test_propose_skill_records(self, brain_ready, ledger, monkeypatch, tmp_path):
        monkeypatch.setattr('app.lib.paths.dataDir', lambda: tmp_path)
        from app.services.memory.background_review import _queue_pending_skill

        _queue_pending_skill('deploy-checklist', 'Run the deploy checklist.', '1. step')
        rows = [r for r in ledger.recent(10) if r['action'] == 'propose_skill']
        assert len(rows) == 1
        assert rows[0]['target_key'] == 'deploy-checklist'

    @pytest.mark.asyncio
    async def test_sleep_cycle_merges_recorded(self, brain_ready, monkeypatch, ledger):
        """Apply-path mutations land in both the audit trail and the ledger."""
        import asyncio

        from app.services import consolidation_daemon as cd
        from app.services.memory_store import _conn

        conn = _conn()
        for rule in ('old rule a', 'old rule b', 'fresh rule c'):
            conn.execute(
                "INSERT INTO learned_heuristics (rule, category, confidence, source) VALUES (?, 'general', 0.9, 'auto')",
                (rule,),
            )
        conn.commit()
        ids = [r['id'] for r in conn.execute('SELECT id FROM learned_heuristics ORDER BY id').fetchall()]
        plan = {
            # Keep the middle rule, merge away the OLDEST — with
            # _RECENTProtectionCount=1 the newest row (ids[2]) is protected,
            # so this mirrors real consolidation traffic.
            'merge': [{'keepId': ids[1], 'removeIds': [ids[0]], 'mergedRule': 'merged rule'}],
            'promote': [],
            'delete': [],
            'archiveMemories': [],
        }
        monkeypatch.setattr(cd, '_RECENTProtectionCount', 1)
        await cd._apply_consolidation_plan(plan)
        # Mutations flow through the async db_writer queue — wait for the
        # worker to apply them and their ledger mirror to land.
        merges: list[dict] = []
        for _ in range(60):
            merges = [
                r for r in ledger.recent(20) if r['actor'] == 'sleep_cycle' and r['action'] == 'merge'
            ]
            if merges:
                break
            await asyncio.sleep(0.05)
        assert merges, 'sleep-cycle merge must appear in the unified ledger'


class TestCrossLoopAwareness:
    @pytest.mark.asyncio
    async def test_consolidation_prompt_carries_ledger(self, brain_ready, ledger, monkeypatch):
        from app.services import consolidation_daemon as cd
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) "
            "VALUES ('some-memory', '\"x\"', 'general', 0.8, 'auto', 0, datetime('now'), datetime('now'))"
        )
        conn.commit()
        ledger.record('reflection', 'supersede', 'auto_memory', 'some-memory', reason='just corrected')

        captured: list[str] = []

        async def fake_call(prompt):
            captured.append(prompt)
            return '{"merge": [], "promote": [], "delete": [], "archiveMemories": []}'

        monkeypatch.setattr(cd, '_callHippocampus', fake_call)
        plan = await cd._build_consolidation_plan()
        assert plan is not None
        assert captured and 'Recent curation decisions by other loops' in captured[0]
        assert 'supersede some-memory' in captured[0]

    def test_review_payload_includes_recent_curation(self, brain_ready, ledger):
        from app.services.memory.memory_review import collect_review_payload

        ledger.record('sleep_cycle', 'delete', 'heuristic', 'heuristic:7', reason='stale')
        payload = collect_review_payload(limit=5)
        entries = payload.get('recentCuration') or []
        assert any(e['targetKey'] == 'heuristic:7' and e['actor'] == 'sleep_cycle' for e in entries)
