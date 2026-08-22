"""Regression tests for audit round 2: pending-skill upsert (#10), correction
fan-out supersession (#9), and embedding-degradation reporting (#6).

Round 1 fixes live in test_memory_skills_audit_fixes.py. The autouse conftest
fixture already isolates AUGUST_DATA_DIR / AUGUST_BRAIN_SQLITE_FILE, so these
tests talk to the real (temp) brain DB through memory_store — no second
connection is opened.
"""

from __future__ import annotations

import json

# ─── #10: pending_skills re-proposals UPDATE, not vanish ─────────────────────


def _queue(name: str, description: str, body: str) -> None:
    from app.services.memory.background_review import _queue_pending_skill

    _queue_pending_skill(name, description, body)


class TestPendingSkillUpsert:
    def test_first_insert_creates_pending_row(self):
        from app.services.memory_store import _conn

        _queue('my_skill', 'first draft', '## When to Use\nnow')
        row = _conn().execute(
            "SELECT name, description FROM pending_skills WHERE name = 'my_skill'"
        ).fetchone()
        assert row is not None and row['description'] == 'first draft'

    def test_reproposal_updates_draft_and_returns_to_pending(self):
        """The P3-10 fix: an improved draft must replace the queued one."""
        from app.services.memory_store import _conn

        _queue('my_skill', 'v1 — vague', 'body v1')
        _queue('my_skill', 'v2 — concrete steps', 'body v2 with steps')
        rows = _conn().execute(
            "SELECT description, status FROM pending_skills WHERE name = 'my_skill'"
        ).fetchall()
        assert len(rows) == 1, 're-proposal must not create a twin'
        assert rows[0]['description'] == 'v2 — concrete steps'
        assert rows[0]['status'] == 'pending'

    def test_approved_rows_are_never_overwritten(self):
        """An approved skill is live on disk; a new proposal must not clobber it."""
        from app.services.memory_store import _conn

        _queue('live_skill', 'approved version', 'live body')
        conn = _conn()
        conn.execute(
            "UPDATE pending_skills SET status = 'approved' WHERE name = 'live_skill'"
        )
        conn.commit()
        _queue('live_skill', 'rogue rewrite', 'different body')
        row = conn.execute(
            "SELECT description, status FROM pending_skills WHERE name = 'live_skill'"
        ).fetchone()
        assert row['description'] == 'approved version'
        assert row['status'] == 'approved'


# ─── #9: corrections supersede stale facts across stores ─────────────────────


class TestCorrectionSupersession:
    def test_near_dup_fact_is_demoted(self):
        from app.services.memory.auto_memory import saveAutoMemory
        from app.services.memory.background_review import _supersedeStaleFacts
        from app.services.memory_store import _conn

        saveAutoMemory(
            'fact_deploy',
            'august proxy deployments always use docker compose on the staging server',
            category='fact',
            importance=0.9,
            source='auto',
        )
        demoted = _supersedeStaleFacts(
            'never use docker compose for august proxy deployments on the staging server'
        )
        assert demoted == 1
        row = _conn().execute(
            "SELECT importance, confidence FROM auto_memories WHERE key = 'fact_deploy'"
        ).fetchone()
        assert float(row['importance']) <= 0.2
        assert float(row['confidence']) <= 0.2

    def test_user_added_memories_are_never_demoted(self):
        from app.services.memory.auto_memory import saveAutoMemory
        from app.services.memory.background_review import _supersedeStaleFacts
        from app.services.memory_store import _conn

        saveAutoMemory(
            'user_added_note',
            'deploy the august proxy service with docker compose every time',
            category='user',
            importance=0.9,
            source='user',
        )
        demoted = _supersedeStaleFacts(
            'stop deploying the august proxy service with docker compose, use systemd'
        )
        assert demoted == 0
        row = _conn().execute(
            "SELECT importance FROM auto_memories WHERE key = 'user_added_note'"
        ).fetchone()
        assert float(row['importance']) > 0.2

    def test_unrelated_memory_untouched(self):
        from app.services.memory.auto_memory import saveAutoMemory
        from app.services.memory.background_review import _supersedeStaleFacts
        from app.services.memory_store import _conn

        saveAutoMemory(
            'other_fact',
            'the user prefers dark mode in all editors',
            category='preference',
            importance=0.8,
            source='auto',
        )
        demoted = _supersedeStaleFacts(
            'stop deploying the august proxy service with docker compose, use systemd'
        )
        assert demoted == 0
        row = _conn().execute(
            "SELECT importance FROM auto_memories WHERE key = 'other_fact'"
        ).fetchone()
        assert float(row['importance']) > 0.2

    def test_stale_vector_twin_removed(self):
        from app.services.memory import vector_db
        from app.services.memory.auto_memory import saveAutoMemory
        from app.services.memory.background_review import _supersedeStaleFacts

        saveAutoMemory(
            'vec_fact',
            'the august proxy login endpoint is rate limited to five attempts per minute',
            category='fact',
            importance=0.7,
            source='auto',
        )
        before = vector_db.count('auto_memory')
        demoted = _supersedeStaleFacts(
            'the august proxy login endpoint is never rate limited at five attempts per minute'
        )
        after = vector_db.count('auto_memory')
        if before:  # only meaningful when the vector store was populated at all
            assert demoted == 1
            assert after < before or after == 0

    def test_do_review_reports_superseded_count(self, monkeypatch):
        """End-to-end through _doReview with a stubbed LLM."""
        import asyncio

        from app.services.memory import background_review as br
        from app.services.memory.auto_memory import saveAutoMemory
        from app.services.memory_store import _conn

        saveAutoMemory(
            'stale_fact',
            'run the backend tests with plain pytest always verbose output',
            category='fact',
            importance=0.8,
            source='auto',
        )

        async def fake_llm(prompt):  # noqa: ANN001
            return json.dumps(
                {
                    'corrections': [
                        {
                            'rule': 'always run the backend tests with plain pytest always '
                            'verbose output but never with -q'
                        }
                    ],
                    'facts': [],
                    'skills': [],
                    'frustration': False,
                }
            )

        # Isolate skill_service paths like round-1 tests do (no catalogue hits).
        monkeypatch.setattr(br.skill_service, '_agentSkillsDir', lambda: br.skill_service.SKILLS_DIR)
        result = asyncio.run(br._doReview([{'role': 'user', 'content': 'm'}], llm_client=fake_llm, session_id='audit2'))
        assert result.get('reviewed') is True
        assert result.get('corrections_added'), 'correction must be recorded'
        row = _conn().execute(
            "SELECT importance FROM auto_memories WHERE key = 'stale_fact'"
        ).fetchone()
        assert row is not None
        assert float(row['importance']) <= 0.2, 'stale fact must be demoted by the review loop'


# ─── #6: embedding-degradation visibility ────────────────────────────────────


class TestEmbeddingStatus:
    def test_status_flags_char_fallback_in_test_env(self):
        """In pytest the char-freq fallback is the default embedder — status
        must report degraded=True with a reason, never silently 'minilm'."""
        from app.services.memory import vector_db

        status = vector_db.embeddingStatus()
        assert status['degraded'] is True
        assert status['encoder'] == 'char-freq'
        assert isinstance(status['reason'], str) and status['reason']

    def test_embed_fallback_logs_warning_once(self, caplog):
        from app.services.memory import vector_db

        vector_db._char_embed_warned = False  # reset the once-guard
        with caplog.at_level('WARNING'):
            vector_db._embed('probe text for degradation warning')
        warnings = [r for r in caplog.records if 'vector recall degraded' in r.getMessage()]
        assert warnings, 'fallback must log a warning'
        # Once-guard: a second call must not warn again.
        caplog.clear()
        with caplog.at_level('WARNING'):
            vector_db._embed('second probe text')
        assert not [r for r in caplog.records if 'vector recall degraded' in r.getMessage()]

    def test_learning_payload_carries_embedding_status(self):
        """brainLearning is a route handler; call its underlying coroutine."""
        import asyncio

        from app.routers import brain_dashboard

        payload = asyncio.run(brain_dashboard.brainLearning())
        emb = payload.get('embedding')
        assert isinstance(emb, dict)
        assert 'degraded' in emb and 'encoder' in emb
