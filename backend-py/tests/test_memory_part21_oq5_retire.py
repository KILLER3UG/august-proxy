"""Part 21 OQ5 (2026-09-04) — propose-only preference retire + OQ1 retire.

OQ5: a ``preference`` fact untouched for ``preferenceRetireDays`` (default
180) AND never quoted (use_count 0) is PROPOSED for retirement — the scan
flips nothing; a human decides via ``apply_retire_decision`` (approve →
status 'retired', reversible; reject → stays). Non-destructive by
construction so it rides the scheduled consolidation pass.

OQ1: auto_memories is retired (migration 033) — the privacy summary/export
and the memory UI no longer surface it.
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def store(isolatedData):
    from app.services.memory_store import init as init_store

    init_store()
    from app.services import memory_store

    return memory_store


def _backdate(key: str, days: int) -> None:
    from app.services.memory_conn import conn

    conn().execute(
        "UPDATE facts SET created_at = datetime('now', ?), updated_at = datetime('now', ?) "
        "WHERE fact_key = ?",
        (f'-{days} days', f'-{days} days', key),
    )
    conn().commit()


class TestPreferenceRetire:
    def test_stale_never_quoted_preference_is_proposed(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('user:oldpref', {'fact': 'prefers serif fonts'}, kind='preference', title='Serif')
        _backdate('user:oldpref', 200)
        proposed, notes = consolidation._retire_stale_preferences()
        assert proposed == 1
        assert any('Serif' in n for n in notes)
        # The fact is UNTOUCHED — propose-only, non-destructive.
        assert store.get_fact('user:oldpref') is not None
        from app.services.memory_conn import conn

        row = conn().execute(
            "SELECT status FROM facts WHERE fact_key = 'user:oldpref'"
        ).fetchone()
        assert str(row['status']) == 'active'

    def test_recent_preference_not_proposed(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('user:fresh', {'fact': 'prefers dark mode'}, kind='preference', title='Dark')
        _backdate('user:fresh', 30)
        proposed, _ = consolidation._retire_stale_preferences()
        assert proposed == 0

    def test_quoted_preference_not_proposed(self, store):
        from app.services.memory_store import consolidation, touch_fact_usage

        store.save_fact('user:used', {'fact': 'prefers metric units'}, kind='preference', title='Metric')
        _backdate('user:used', 400)
        touch_fact_usage(['user:used'])  # use_count > 0 → never-quoted fails
        proposed, _ = consolidation._retire_stale_preferences()
        assert proposed == 0

    def test_non_preference_kind_ignored(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('proj:stale', {'fact': 'an old project fact'}, kind='fact', title='OldFact')
        _backdate('proj:stale', 400)
        proposed, _ = consolidation._retire_stale_preferences()
        assert proposed == 0

    def test_dedupe_no_double_proposal(self, store):
        from app.services.memory_store import consolidation

        store.save_fact('user:dup', {'fact': 'prefers tabs'}, kind='preference', title='Tabs')
        _backdate('user:dup', 300)
        first, _ = consolidation._retire_stale_preferences()
        second, _ = consolidation._retire_stale_preferences()
        assert first == 1
        assert second == 0  # already has an open proposal

    def test_approve_retires_reversible(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        store.save_fact('user:go', {'fact': 'prefers go'}, kind='preference', title='Go')
        _backdate('user:go', 300)
        consolidation._retire_stale_preferences()
        pid = int(
            conn().execute(
                "SELECT id FROM proposals WHERE proposal_type = 'retire-preference' "
                "AND status = 'pending' ORDER BY id DESC LIMIT 1"
            ).fetchone()['id']
        )
        res = consolidation.apply_retire_decision(pid, approve=True)
        assert res['ok'] and res['retired']
        row = conn().execute("SELECT status FROM facts WHERE fact_key = 'user:go'").fetchone()
        assert str(row['status']) == 'retired'
        # The proposal itself is stamped approved.
        prow = conn().execute('SELECT status FROM proposals WHERE id = ?', (pid,)).fetchone()
        assert str(prow['status']) == 'approved'

    def test_reject_keeps_fact(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import consolidation

        store.save_fact('user:keep', {'fact': 'prefers keep'}, kind='preference', title='Keep')
        _backdate('user:keep', 300)
        consolidation._retire_stale_preferences()
        pid = int(
            conn().execute(
                "SELECT id FROM proposals WHERE proposal_type = 'retire-preference' "
                "AND status = 'pending' ORDER BY id DESC LIMIT 1"
            ).fetchone()['id']
        )
        res = consolidation.apply_retire_decision(pid, approve=False)
        assert res['ok'] and not res['retired']
        row = conn().execute("SELECT status FROM facts WHERE fact_key = 'user:keep'").fetchone()
        assert str(row['status']) == 'active'

    def test_disabled_by_config(self, store, monkeypatch):
        from app.services import brain_config_service
        from app.services.memory_store import consolidation

        monkeypatch.setattr(
            brain_config_service,
            'getRuntimeConfig',
            lambda: {'preferenceRetireEnabled': False},
        )
        store.save_fact('user:off', {'fact': 'prefers off'}, kind='preference', title='Off')
        _backdate('user:off', 300)
        proposed, _ = consolidation._retire_stale_preferences()
        assert proposed == 0


class TestOQ1RetireSurface:
    def test_privacy_summary_has_no_auto_memories(self, store):
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            r = client.get('/api/privacy/summary')
            assert r.status_code == 200
            assert 'autoMemories' not in r.json()['counts']

    def test_privacy_export_has_no_auto_memories(self, store):
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            r = client.post('/api/privacy/export')
            assert r.status_code == 200
            # The export no longer carries the retired store key.
            assert 'autoMemories' not in r.json().get('entries', {})
