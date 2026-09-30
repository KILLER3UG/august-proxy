"""Recall quality has to be measurable, or every constant is a guess (roadmap #13).

Every knob in the recall path — ``k=5``, the 0.05 boost weight, the 0.5
prior-turn weight, ``_DECAY_HALF_LIFE_DAYS = 30``, ``_MIN_QUERY_CHARS = 8``, the
two char caps — is a tuned constant with no feedback loop. Recall is BM25 over a
few hundred facts, which is genuinely hard to tune by intuition, and item #12
showed a growth in profile facts silently starving keyword recall with no signal
anywhere.

The raw material has been written all along: migration 050 persists
``facts_injected`` per turn, and the ``facts`` table has carried
``use_count``/``last_used_at`` for longer. Neither was read for evaluation.
"""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _save(key: str) -> None:
    from app.services import memory_store

    memory_store.save_fact(key, f'body for {key}', category='general', title=key)


def _record_turn(keys: list[str]) -> None:
    from app.services.turn_outcomes import record_turn_outcome

    record_turn_outcome(
        model='m', provider='p', task_type='agent', ok=True,
        facts_injected=list(keys),
    )


class TestRecallQuality:
    def test_an_empty_window_is_null_not_zero(self, brain):
        """'No measurements' and 'measured, no hits' are different facts.

        A 0.0 here would read as "recall is getting nothing right" on a fresh
        install, and would be the kind of number that moves a constant.
        """
        from app.services.memory_store.fact_retrieval import recall_quality

        q = recall_quality(30)
        assert q['precisionAtK'] is None
        assert q['hits'] is None
        assert q['turns'] == 0

    def test_precision_is_the_share_of_injected_facts_that_were_used(self, brain):
        from app.services.memory_conn import conn
        from app.services.memory_store.fact_retrieval import recall_quality

        for k in ('used.one', 'used.two', 'cold.one', 'cold.two'):
            _save(k)
        conn().execute("UPDATE facts SET use_count = 3 WHERE fact_key = 'used.one'")
        conn().execute("UPDATE facts SET use_count = 1 WHERE fact_key = 'used.two'")
        conn().commit()
        _record_turn(['used.one', 'used.two', 'cold.one', 'cold.two'])

        q = recall_quality(30)
        assert q['turns'] == 1
        assert q['injected'] == 4
        assert q['hits'] == 2
        assert q['precisionAtK'] == 0.5

    def test_a_key_injected_twice_is_judged_once(self, brain):
        """k is a window, not a counter — the same fact is not two chances."""
        from app.services.memory_conn import conn
        from app.services.memory_store.fact_retrieval import recall_quality

        _save('twice.one')
        conn().execute("UPDATE facts SET use_count = 1 WHERE fact_key = 'twice.one'")
        conn().commit()
        _record_turn(['twice.one'])
        _record_turn(['twice.one'])

        q = recall_quality(30)
        assert q['turns'] == 2
        assert q['injected'] == 1, 'the same fact was counted as two injections'

    def test_a_fact_forgotten_after_injection_is_not_a_miss(self, brain):
        """It left the index, so it can be neither a hit nor a judged miss."""
        from app.services.memory_conn import conn
        from app.services.memory_store.fact_retrieval import recall_quality

        _save('stays.one')
        _save('goes.one')
        conn().execute("UPDATE facts SET use_count = 1 WHERE fact_key = 'stays.one'")
        conn().execute("DELETE FROM facts WHERE fact_key = 'goes.one'")
        conn().commit()
        _record_turn(['stays.one', 'goes.one'])

        q = recall_quality(30)
        assert q['injected'] == 2
        assert q['precisionAtK'] == 1.0, (
            'a deleted fact was scored as a recall miss — it is not in the '
            'index any more, so the recall had no opportunity to hit it'
        )

    def test_malformed_json_does_not_poison_the_aggregate(self, brain):
        from app.services.memory_conn import conn
        from app.services.memory_store.fact_retrieval import recall_quality

        _save('good.one')
        conn().execute(
            "UPDATE turn_outcomes SET facts_injected = ? WHERE rowid = "
            '(SELECT MAX(rowid) FROM turn_outcomes)',
            ('not json at all',),
        )
        conn().commit()

        q = recall_quality(30)
        assert q['injected'] == 0
        assert q['precisionAtK'] is None

    def test_the_window_is_bounded(self, brain):
        from app.services.memory_store.fact_retrieval import recall_quality

        assert recall_quality(0)['days'] == 1
        assert recall_quality(10_000)['days'] == 90


class TestItIsOnAPreviewSurface:
    def test_memory_context_preview_reports_it(self, brain):
        """It has to be visible where someone would look, or it is not a loop."""
        from app.services.memory_store.fact_retrieval import memory_context_preview

        preview = memory_context_preview('anything')
        assert 'recallQuality' in preview, (
            'the measurement is computed and then never shown, which is the '
            'same failure as computing it and never writing it'
        )
        assert preview['recallQuality']['precisionAtK'] is None

    def test_it_survives_a_broken_facts_table(self, brain, monkeypatch):
        """A diagnostics read must never take down the preview."""
        from app.services.memory_store import fact_retrieval as fr

        def _boom(*_a, **_kw):
            raise RuntimeError('facts unavailable')

        monkeypatch.setattr(fr, '_conn', _boom)
        q = fr.recall_quality(30)
        assert q['precisionAtK'] is None
        assert q['turns'] == 0

    def test_json_is_importable_for_the_aggregate(self):
        """Cheap guard: the module parses facts_injected with json."""
        import app.services.memory_store.fact_retrieval as fr

        assert hasattr(fr, 'json')
        assert json.loads('[1, 2]') == [1, 2]
