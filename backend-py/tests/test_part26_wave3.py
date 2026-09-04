"""Part 26 Wave 3 — memory correctness regressions.

  * 6.1 brain_query hides superseded/expired facts (was reproduced live: the
    exact-key fast path and the LIKE fallback had no status/expiry clause)
  * 6.2 remember/forget share ONE scope rule: visible-union rows updatable,
    foreign private scopes refused
  * 6.5 save_fact refuses cross-scope private overwrites; rollback restore
    restores the row's birth scope instead of leaking it to global
  * 5.1 privacy purge erases the learning corpus (episodes, fingerprints,
    turn outcomes) — without it the next consolidation pass re-mined the
    surviving transcripts into NEW facts about the user
  * 6.3 tail-strip at persist (durability helper)
"""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def store(isolatedData):
    from app.services.memory_store import init, rest

    init()
    return rest


# ── 6.1 brain_query visibility ────────────────────────────────────────────


class TestBrainQueryVisibility:
    def test_superseded_and_expired_hidden_from_model_tool(self, store):
        from app.services.memory_conn import conn
        from app.services.memory_store import brain

        store.save_fact('p26:active', 'active value')
        store.save_fact('p26:old', 'old value')
        store.save_fact('p26:promo', 'PROMO20 works')
        c = conn()
        c.execute("UPDATE facts SET status='superseded' WHERE fact_key='p26:old'")
        c.execute("UPDATE facts SET expires_at='2020-01-01T00:00:00Z' WHERE fact_key='p26:promo'")
        c.commit()

        assert 'old value' not in brain.brain_query('facts', 'p26:old')
        assert 'PROMO20' not in brain.brain_query('facts', 'p26:promo')
        assert 'active value' in brain.brain_query('facts', 'p26:active')
        # The LIKE fallback hides them too.
        assert 'old value' not in brain.brain_query('facts', 'old')
        assert 'PROMO20' not in brain.brain_query('facts', 'promo')


# ── 6.5 save_fact scope guard ─────────────────────────────────────────────


class TestSaveFactScopeGuard:
    def test_cross_scope_private_overwrite_refused(self, store):
        store.save_fact('p26:guard', 'alpha secret', scope='bot:alpha')
        with pytest.raises(ValueError):
            store.save_fact('p26:guard', 'beta override', scope='bot:beta')
        with pytest.raises(ValueError):
            store.save_fact('p26:guard', 'global override', scope='global')
        row = store.get_fact('p26:guard')
        assert 'alpha secret' in str(row.get('factValue'))
        assert str(row.get('scope')) == 'bot:alpha'

    def test_same_scope_update_and_global_target_allowed(self, store):
        store.save_fact('p26:ok', 'v1', scope='bot:alpha')
        store.save_fact('p26:ok', 'v2', scope='bot:alpha')
        assert 'v2' in str(store.get_fact('p26:ok').get('factValue'))
        # global → global stays fine; a bot may update a global row (6.2).
        store.save_fact('p26:shared', 'g1', scope='global')
        store.save_fact('p26:shared', 'g2', scope='bot:alpha')
        assert 'g2' in str(store.get_fact('p26:shared').get('factValue'))
        assert str(store.get_fact('p26:shared').get('scope')) == 'global'

    def test_override_updates_in_place_without_rewriting_scope(self, store):
        from app.services.memory_conn import conn

        store.save_fact('k:one', {'fact': 'v1'}, title='One', scope='bot:alpha')
        store.save_fact(
            'k:one', {'fact': 'v2'}, title='One', scope='global', allow_scope_override=True
        )
        row = conn().execute('SELECT scope, fact_value FROM facts WHERE fact_key = ?', ('k:one',)).fetchone()
        assert str(row['scope']) == 'bot:alpha'
        assert 'v2' in str(row['fact_value'])


# ── 5.1 privacy purge covers the learning corpus ──────────────────────────


class TestPrivacyPurgeLearningCorpus:
    def test_purge_empties_episodes_fingerprints_outcomes(self, isolatedData):
        from app.routers import privacy
        from app.services.memory_conn import conn

        c = conn()
        c.execute(
            "INSERT INTO episodes (session_id, kind, events, outcome, tier, created_at) "
            "VALUES ('s1', 'correction_accepted', '{\"events\": []}', 'resolved', 1, datetime('now'))"
        )
        c.execute(
            "INSERT INTO failure_fingerprints (fingerprint, episode_count, first_seen, last_seen, flagged) "
            "VALUES ('p26:test-fp', 1, datetime('now'), datetime('now'), 0)"
        )
        c.commit()
        import asyncio

        result = asyncio.run(privacy.purgeMemories())
        deleted = result['deleted']
        assert deleted.get('episodes', 0) >= 1
        assert deleted.get('failure_fingerprints', 0) >= 1
        assert 'turn_outcomes' in deleted
        assert c.execute('SELECT COUNT(*) FROM episodes').fetchone()[0] == 0


# ── 6.3 tail patches never persist ────────────────────────────────────────


class TestTailStrip:
    def test_barrier_flush_strips_tail_and_is_non_mutating(self, isolatedData):
        from types import SimpleNamespace

        from app.services.workbench.durability import strip_tail_patches

        base = {'role': 'user', 'content': 'please fix the login bug'}
        patched = {
            **base,
            '_tailPatched': True,
            'content': base['content'] + '\n\n<memory>\nrecalled\n</memory>\n\n<session_state>\nphase: implement\n</session_state>',
        }
        out = strip_tail_patches([patched, {'role': 'assistant', 'content': 'done'}])
        assert out[0]['content'] == 'please fix the login bug'
        assert '_tailPatched' not in out[0]
        # Non-mutating: the working copy keeps the patch for the wire calls.
        assert patched.get('_tailPatched') is True
        assert '\n\n<memory>' in str(patched['content'])
        # Plain messages pass through untouched (user text containing the
        # literal tag must not be truncated).
        plain = [{'role': 'user', 'content': 'explain <memory> semantics'}]
        assert strip_tail_patches(plain)[0]['content'] == plain[0]['content']
