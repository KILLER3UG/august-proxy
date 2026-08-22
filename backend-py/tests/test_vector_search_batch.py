"""Round-5 vector search: cached batched scoring, cap override, parity.

The old search re-decoded every stored embedding per query under the global
lock; the new one parses rows once per data version and scores in a single
batched matmul when numpy is available, with an identical-results pure-Python
fallback when it is not.
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def vec_db(brain_ready, monkeypatch):
    """Char embeddings + isolated brain DB + clean search-cache state.

    The parsed-bundle cache and data version are module globals; without a
    reset they would leak rows across tests (each test gets a fresh DB file
    while the version counter keeps climbing).
    """
    monkeypatch.setenv('AUGUST_VECTOR_CHAR_EMBED', '1')
    from app.services.memory import vector_db

    monkeypatch.setattr(vector_db, '_dataVersion', 0)
    vector_db._bundleCache.clear()
    yield vector_db
    vector_db._bundleCache.clear()


def _seed(vec_db, items: list[tuple[str, str]]) -> None:
    for text, key in items:
        vec_db.insert(text, metadata={'key': key}, namespace='auto_memory')


class TestSearchParity:
    def test_numpy_and_fallback_agree(self, vec_db, monkeypatch):
        _seed(
            vec_db,
            [
                ('docker compose deploys the staging stack', 'a'),
                ('pytest fixtures parametrize the auth suite', 'b'),
                ('sqlite migrations move the graph store', 'c'),
                ('the rate limiter guards the login endpoint', 'd'),
            ],
        )
        top_numpy = [r['metadata']['key'] for r in vec_db.search('docker compose deploy', top_k=3)]

        import app.services.memory.vector_db as vdb

        monkeypatch.setattr(vdb, '_np', None)
        # Force a rebuild so the fallback path builds its own bundle.
        vdb._bumpVersion()
        top_fallback = [r['metadata']['key'] for r in vec_db.search('docker compose deploy', top_k=3)]

        # Char-freq embeddings rank lossily — parity between paths is the
        # contract here, not which key wins.
        assert top_numpy == top_fallback
        assert set(top_numpy) <= {'a', 'b', 'c', 'd'}

    def test_scores_match_python_cosine(self, vec_db):
        _seed(vec_db, [('alpha beta gamma', 'x'), ('unrelated words entirely', 'y')])
        hits = vec_db.search('alpha beta', top_k=2)
        assert len(hits) == 2
        assert hits[0]['metadata']['key'] == 'x'
        assert hits[0]['score'] > hits[1]['score']


class TestCacheInvalidation:
    def test_new_insert_visible_without_stale_cache(self, vec_db):
        assert vec_db.search('quantum flux capacitor', top_k=3) == []
        vec_db.insert('the quantum flux capacitor needs calibrating', metadata={'key': 'q'}, namespace='auto_memory')
        hits = vec_db.search('quantum flux capacitor', top_k=3)
        assert len(hits) >= 1
        assert hits[0]['metadata']['key'] == 'q'

    def test_delete_removes_hit(self, vec_db):
        vec_db.insert('kubernetes rollout restart pods', metadata={'key': 'k'}, namespace='auto_memory')
        assert vec_db.search('kubernetes rollout', top_k=1)
        assert vec_db.deleteByKey('k') == 1
        assert vec_db.search('kubernetes rollout', top_k=1) == []


class TestCapOverride:
    def test_env_cap_trims_table(self, vec_db, monkeypatch):
        monkeypatch.setenv('AUGUST_VECTOR_MAX_ENTRIES', '10')
        for i in range(15):
            vec_db.insert(f'cap test row number {i}', namespace='auto_memory')
        assert vec_db.count('auto_memory') <= 10

    def test_default_cap_raised(self, vec_db, monkeypatch):
        monkeypatch.delenv('AUGUST_VECTOR_MAX_ENTRIES', raising=False)
        from app.services.memory.vector_db import _MAXEntries, _maxEntries

        assert _maxEntries() == _MAXEntries
        assert _MAXEntries > 2000, 'cap must exceed the old 2000-row ceiling'
