"""Regression tests for round 4: TTL sweep, vector-mirror reconciliation,
consolidation skip honesty, review-gate persistence, todo retirement.

Companion to test_memory_loop_round2_fixes.py / round3: each test pins one
audit finding so the behavior can't silently regress again.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def _no_md_export(monkeypatch):
    monkeypatch.setenv('AUGUST_MEMORY_MD_EXPORT', '0')


# ─── 1. TTL sweep: expired rows die even when nobody recalls ────────────────


class TestTtlSweep:
    def test_prune_removes_only_expired_unpinned(self, brain_ready):
        conn = brain_ready
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, expires_at, created_at, updated_at) "
            "VALUES ('gone', '\"x\"', 'general', 0.5, 'auto', 0, '2000-01-01T00:00:00Z', datetime('now'), datetime('now'))"
        )
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, expires_at, created_at, updated_at) "
            "VALUES ('pinned-forever', '\"x\"', 'general', 0.9, 'auto', 1, '2000-01-01T00:00:00Z', datetime('now'), datetime('now'))"
        )
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, expires_at, created_at, updated_at) "
            "VALUES ('still-fresh', '\"x\"', 'general', 0.5, 'auto', 0, '2999-01-01T00:00:00Z', datetime('now'), datetime('now'))"
        )
        conn.commit()
        from app.services.memory.auto_memory import prune_expired_memories

        assert prune_expired_memories(limit=10) == 1
        keys = {r['key'] for r in conn.execute('SELECT key FROM auto_memories').fetchall()}
        assert 'gone' not in keys
        assert {'pinned-forever', 'still-fresh'} <= keys

    @pytest.mark.asyncio
    async def test_run_consolidation_reports_sweep_and_skip(self, brain_ready, monkeypatch):
        from app.services import consolidation_daemon as cd

        async def fake_plan():
            return None

        monkeypatch.setattr(cd, '_build_consolidation_plan', fake_plan)
        stats = await cd.runConsolidation(apply=True)
        assert stats.get('skipped') == 'no_data'
        assert 'pruned_expired' in stats
        last = cd.get_last_run()
        assert last is not None and 'skipped' in last and 'pruned_expired' in last


# ─── 2. Consolidation honesty: skip reasons are recorded ────────────────────


class TestConsolidationSkipHonesty:
    @pytest.mark.asyncio
    async def test_no_data_reason(self, brain_ready):
        from app.services import consolidation_daemon as cd

        assert await cd._build_consolidation_plan() is None
        assert cd.get_last_skip_reason() == 'no_data'

    @pytest.mark.asyncio
    async def test_empty_reply_reason(self, brain_ready, monkeypatch):
        from app.services import consolidation_daemon as cd

        conn = cd._memory_conn() if hasattr(cd, '_memory_conn') else None
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            "INSERT INTO learned_heuristics (rule, category, confidence, source) VALUES ('r1', 'general', 0.8, 'test')"
        )
        conn.commit()

        async def empty_reply(_prompt):
            return ''

        monkeypatch.setattr(cd, '_callHippocampus', empty_reply)
        assert await cd._build_consolidation_plan() is None
        assert cd.get_last_skip_reason() == 'empty_reply'

    @pytest.mark.asyncio
    async def test_invalid_json_reason(self, brain_ready, monkeypatch):
        from app.services import consolidation_daemon as cd
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            "INSERT INTO learned_heuristics (rule, category, confidence, source) VALUES ('r2', 'general', 0.8, 'test')"
        )
        conn.commit()

        async def bad_json(_prompt):
            return 'I think we should merge things :)'

        monkeypatch.setattr(cd, '_callHippocampus', bad_json)
        assert await cd._build_consolidation_plan() is None
        assert cd.get_last_skip_reason() == 'invalid_json'

    @pytest.mark.asyncio
    async def test_valid_plan_clears_reason(self, brain_ready, monkeypatch):
        from app.services import consolidation_daemon as cd
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            "INSERT INTO learned_heuristics (rule, category, confidence, source) VALUES ('r3', 'general', 0.8, 'test')"
        )
        conn.commit()

        async def good_json(_prompt):
            return '{"merge": [], "promote": [], "delete": [], "archiveMemories": []}'

        monkeypatch.setattr(cd, '_callHippocampus', good_json)
        plan = await cd._build_consolidation_plan()
        assert plan is not None
        assert cd.get_last_skip_reason() == ''


# ─── 3. Vector-mirror reconciliation ────────────────────────────────────────


class TestVectorMirrorReconciliation:
    def test_missing_twin_skipped_while_degraded(self, brain_ready, monkeypatch):
        monkeypatch.setenv('AUGUST_VECTOR_CHAR_EMBED', '1')
        from app.services.memory import vector_mirror
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) "
            "VALUES ('twin-less', '\"prefers pytest\"', 'preference', 0.8, 'auto', 0, datetime('now'), datetime('now'))"
        )
        conn.commit()
        report = vector_mirror.reconcile_vector_mirror()
        assert report['missing'] == 1
        assert report['missing_degraded'] == 1
        assert report['missing_repaired'] == 0

    def test_missing_twin_repaired_when_encoder_healthy(self, brain_ready, monkeypatch):
        from app.services.memory import vector_db, vector_mirror
        from app.services.memory_store import _conn

        monkeypatch.setattr(
            vector_db,
            'embeddingStatus',
            lambda: {'encoder': 'minilm', 'degraded': False, 'reason': '', 'dimension': 384, 'entries': 0},
        )
        conn = _conn()
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) "
            "VALUES ('needs-twin', '\"likes sqlite\"', 'general', 0.8, 'auto', 0, datetime('now'), datetime('now'))"
        )
        conn.commit()
        report = vector_mirror.reconcile_vector_mirror()
        assert report['missing_repaired'] == 1
        assert 'needs-twin' in vector_mirror._vector_rows()

    def test_orphan_twin_removed(self, brain_ready, monkeypatch):
        monkeypatch.setenv('AUGUST_VECTOR_CHAR_EMBED', '1')
        from app.services.memory import vector_db, vector_mirror

        vector_db.insert('ghost memory text', metadata={'key': 'ghost-key'}, namespace='auto_memory')
        assert 'ghost-key' in vector_mirror._vector_rows()
        report = vector_mirror.reconcile_vector_mirror()
        assert report['orphans'] == 1
        assert report['orphans_removed'] == 1
        assert 'ghost-key' not in vector_mirror._vector_rows()

    def test_report_persisted_for_dashboard(self, brain_ready, monkeypatch):
        monkeypatch.setenv('AUGUST_VECTOR_CHAR_EMBED', '1')
        from app.services.memory import vector_mirror

        vector_mirror.reconcile_vector_mirror()
        last = vector_mirror.last_reconciliation()
        assert last is not None
        assert 'scanned' in last and 'at' in last


# ─── 4. Review gates survive restart ────────────────────────────────────────


class TestReviewGatePersistence:
    @pytest.mark.asyncio
    async def test_fired_review_persists_markers(self, monkeypatch):
        from app.services.memory import background_review as br

        reviewed: list[str] = []

        async def fake_review(*args, **kwargs):
            reviewed.append('fired')

        monkeypatch.setattr(br, '_doReview', fake_review)
        session = SimpleNamespace(id='s1', messageCount=8, metadata={})
        snapshot = [{'role': 'user'}, {'role': 'assistant'}] * 4
        await br.tryBackgroundReview(session, snapshot)
        await asyncio.sleep(0)  # let the create_task'd review run its first step
        assert reviewed == ['fired']
        assert session.metadata['reviewGateTurn'] == 4
        assert session.metadata['reviewGateToolRounds'] == 0

    @pytest.mark.asyncio
    async def test_restarted_session_restores_gates(self, monkeypatch):
        from app.services.memory import background_review as br

        reviewed: list[str] = []

        async def fake_review(*args, **kwargs):
            reviewed.append('fired')

        monkeypatch.setattr(br, '_doReview', fake_review)
        # Same session after a "restart": metadata survived, dynamic attrs
        # did not. The restored markers must keep the gates quiet.
        session = SimpleNamespace(
            id='s1',
            messageCount=8,
            metadata={'reviewGateTurn': 4, 'reviewGateToolRounds': 0},
        )
        snapshot = [{'role': 'user'}, {'role': 'assistant'}] * 4
        await br.tryBackgroundReview(session, snapshot)
        assert reviewed == []
        assert getattr(session, '_last_reviewed_at_turn') == 4


# ─── 5. Todos retire when checked off ───────────────────────────────────────


class TestTodoLifecycle:
    @staticmethod
    def _storedTodos() -> list[str]:
        import json as _json

        from app.services.memory_store import _conn

        row = _conn().execute("SELECT content FROM auto_memories WHERE key = 'todos'").fetchone()
        if row is None:
            return []
        try:
            parsed = _json.loads(row['content'])
        except (ValueError, TypeError):
            return []
        return [str(t) for t in parsed] if isinstance(parsed, list) else []

    def test_completed_todo_removed(self, brain_ready):
        from app.services.memory.auto_memory import extractAndSaveTodos, saveAutoMemory

        saveAutoMemory('todos', ['write docs', 'ship release'], category='tasks', source='auto')
        messages = [
            {
                'role': 'assistant',
                'content': 'Progress:\n- [x] write docs\n- [ ] add tests\n',
            }
        ]
        todos = extractAndSaveTodos(messages, session_id='s-todo')
        assert todos == ['add tests']
        stored = self._storedTodos()
        assert 'write docs' not in stored, 'checked-off todo must be retired'
        assert 'ship release' in stored, 'unrelated prior todo must survive the merge'
        assert 'add tests' in stored

    def test_union_merge_across_turns(self, brain_ready):
        from app.services.memory.auto_memory import extractAndSaveTodos, saveAutoMemory

        saveAutoMemory('todos', ['earlier item'], category='tasks', source='auto')
        extractAndSaveTodos(
            [{'role': 'assistant', 'content': '- [ ] newer item\n'}], session_id='s-union'
        )
        stored = self._storedTodos()
        assert 'earlier item' in stored, 'prior todo must not be replaced by the new turn'
        assert 'newer item' in stored

    def test_no_changes_no_rewrite(self, brain_ready):
        from app.services.memory.auto_memory import extractAndSaveTodos, saveAutoMemory

        saveAutoMemory('todos', ['stable item'], category='tasks', source='auto')
        messages = [{'role': 'assistant', 'content': 'Nothing to do here.'}]
        assert extractAndSaveTodos(messages) == []
        assert self._storedTodos() == ['stable item']

    def test_checked_off_history_no_churn(self, brain_ready, monkeypatch):
        """Round-6 P0: once a ``- [x]`` exists in history the old gate
        (``doneSet or …``) stayed true forever → identical row re-saved (and
        re-embedded via the vector mirror) every turn. Save must fire only on
        an actual merged-state change."""
        from app.services.memory import auto_memory
        from app.services.memory.auto_memory import extractAndSaveTodos, saveAutoMemory

        saveAutoMemory('todos', ['done deal', 'still open'], category='tasks', source='auto')
        messages = [
            {'role': 'assistant', 'content': '- [x] done deal\n- [ ] still open\n'}
        ]
        first = extractAndSaveTodos(messages, session_id='s-churn')
        assert first == ['still open']
        stored = self._storedTodos()
        assert 'done deal' not in stored and 'still open' in stored

        calls = {'n': 0}
        real_save = auto_memory.saveAutoMemory

        def _counting(*args: object, **kwargs: object) -> object:
            calls['n'] += 1
            return real_save(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(auto_memory, 'saveAutoMemory', _counting)
        # Identical history replayed on the next turn must be a no-op.
        assert extractAndSaveTodos(messages, session_id='s-churn') == ['still open']
        assert extractAndSaveTodos(messages, session_id='s-churn') == ['still open']
        assert calls['n'] == 0, f'state unchanged — save fired {calls["n"]}x'
        assert self._storedTodos() == stored

        # A genuine change still saves exactly once.
        messages2 = [
            {'role': 'assistant', 'content': '- [ ] still open\n- [ ] fresh item\n'}
        ]
        assert extractAndSaveTodos(messages2, session_id='s-churn') == [
            'still open',
            'fresh item',
        ]
        assert calls['n'] == 1
        assert 'fresh item' in self._storedTodos()
