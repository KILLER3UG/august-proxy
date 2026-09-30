"""Regression cover for the deep-scan round-2/round-3 fixes.

Each test here failed against the pre-fix working tree. They are pinned at the
behaviour level — a fact must still exist, a server must come back, a slug must
not eat its neighbour — rather than at the shape of the fix.

Covered here:
  * #3  consolidation must never delete a fact whose text went nowhere
  * #42 a merge chain must keep every pair's (merged from: ...) provenance
  * #9  the MCP registry must survive a restart
  * #5  two titles that slug identically must not overwrite each other
"""

from __future__ import annotations

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _save(key: str, value: str, title: str = '') -> None:
    from app.services import memory_store

    memory_store.save_fact(key, value, category='general', title=title or key)


def _raw_value(key: str) -> str | None:
    from app.services.memory_conn import conn

    row = conn().execute('SELECT fact_value FROM facts WHERE fact_key = ?', (key,)).fetchone()
    return None if row is None else str(row['fact_value'])


def _all_keys() -> set[str]:
    from app.services.memory_conn import conn

    return {str(r['fact_key']) for r in conn().execute('SELECT fact_key FROM facts').fetchall()}


def _survivor_of(originals: set[str]) -> tuple[str, str]:
    """The one key left standing out of ``originals``, and its raw stored value.

    Which key survives depends on the newest-first ordering and the rows landing
    in the same second, so tests must not assume WHICH one — only that exactly
    one is left and that it carries the merged text.
    """
    left = _all_keys() & originals
    assert len(left) == 1, f'expected exactly one survivor out of {sorted(originals)}, got {sorted(left)}'
    key = left.pop()
    return key, _raw_value(key) or ''


# ── #3 / #42 — the merge loop ────────────────────────────────────────────────


class TestConsolidationMergeLoop:
    def test_no_fact_is_deleted_without_its_text_surviving(self, brain):
        """Every delete must be preceded by a write that actually landed.

        A GUARD rather than a red/green regression for #3: this chain's pairs
        all name the same survivor, so it exercises the rowcount check but not
        the survivor-already-removed interleaving (that needs the cross-slug
        BM25 path to make one fact a survivor and then an absorbed row, which
        this shape does not produce). Kept because it is the invariant the fix
        restores, and it is cheap.
        """
        from app.services.memory_store import consolidation

        # Three DISTINCT keys that all slug to 'deploy-friday' — the exact
        # shape that makes group[0] the survivor of two sequential pairs.
        for key in ('deploy.friday', 'deploy friday', 'deploy-friday'):
            _save(key, 'the deployment pipeline runs on fridays only')

        merged, notes = consolidation._merge_duplicates()
        assert merged >= 2, f'the chain never merged: {notes}'

        remaining = _all_keys()
        assert remaining, 'consolidation deleted every fact in the chain'
        # Whatever survived must actually carry one of the original bodies.
        bodies = ' '.join(_raw_value(k) or '' for k in remaining)
        assert 'fridays' in bodies, (
            f'no surviving fact carries the original text; keys={sorted(remaining)} '
            f'notes={notes}'
        )
        # One merge retires exactly one fact, so the counter can never exceed
        # the number of facts that went in.
        assert merged <= 3

    def test_a_merge_chain_keeps_every_provenance_note(self, brain):
        """A chain must accumulate notes, not rebuild from the pre-loop snapshot.

        Regression: the survivor's value came from the dict captured when the
        pairs were built, so the second merge in A->B->C overwrote the first
        pair's '(merged from: ...)' note with a value derived from the ORIGINAL
        A — so only the last pair's provenance survived.
        """
        from app.services.memory_store import consolidation

        for key in ('chain.entry', 'chain entry', 'chain-entry'):
            _save(key, 'kubernetes ingress controller notes for the staging cluster')

        merged, _notes = consolidation._merge_duplicates()
        assert merged >= 2, 'the three-fact chain did not produce two merges'

        _key, survivor = _survivor_of({'chain.entry', 'chain entry', 'chain-entry'})
        # Two merges means two absorbed facts, so TWO provenance notes must be
        # present on the survivor. The pre-fix code left exactly one, because
        # the second merge rebuilt from the value snapshotted before the loop.
        assert survivor.count('(merged from:') == 2, (
            f'the chain rebuilt from the pre-loop snapshot and lost provenance: {survivor!r}'
        )

    def test_a_single_pair_still_records_its_note(self, brain):
        """The one-pair baseline the chain test builds on — passes either way."""
        from app.services.memory_store import consolidation

        _save('solo.entry', 'the redis cache is flushed every night at midnight')
        _save('solo entry', 'the redis cache is flushed every night at midnight')

        merged, _notes = consolidation._merge_duplicates()
        assert merged == 1, f'the pair did not merge exactly once: {_notes}'
        _key, survivor = _survivor_of({'solo.entry', 'solo entry'})
        assert '(merged from:' in survivor, f'the pair merged without a provenance note: {survivor!r}'


# ── #9 — the MCP registry must survive a restart ─────────────────────────────


class TestMcpRegistrySurvivesRestart:
    def test_rehydrate_restores_what_save_wrote(self, monkeypatch, tmp_path):
        """_saveConfig wrote the registry and NOTHING ever read it back.

        Regression: `_loadConfig` had no callers anywhere in the backend, so
        `_servers` started empty on every boot and the file's contents were dead
        on every load — users re-entered each integration after each restart.
        """
        from app.services.tools import mcp_client

        monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: tmp_path / 'mcp-servers.json')
        monkeypatch.setattr(mcp_client, '_servers', {})
        monkeypatch.setattr(mcp_client, '_toolsCache', {})

        mcp_client.registerServer(
            name='local notes',
            command='node',
            args=['server.js'],
            env={'GH_TOKEN': 'ghp_secret'},
            transport='stdio',
            server_id='mcp_fixed',
            persist=True,
        )
        mcp_client.set_server_meta('mcp_fixed', catalogId='cat-9')

        # Simulate the restart: in-memory registry gone, file on disk intact.
        monkeypatch.setattr(mcp_client, '_servers', {})
        assert mcp_client.listRegisteredServers() == [], 'precondition: registry is empty'

        restored = mcp_client.rehydrate_from_config()
        assert restored == 1

        rows = {str(s['id']): s for s in mcp_client.listRegisteredServers()}
        assert 'mcp_fixed' in rows, 'the server did not come back'
        row = rows['mcp_fixed']
        # The fields that make a server usable must all survive the round trip.
        assert str(row.get('name')) == 'local notes'
        assert list(row.get('args') or []) == ['server.js']
        assert (row.get('env') or {}).get('GH_TOKEN') == 'ghp_secret'
        assert bool(row.get('enabled')) is True
        # The detail-pane save path depends on these two surviving too.
        assert str(row.get('catalogId') or '') == 'cat-9'

    def test_rehydrate_is_idempotent_and_safe_on_an_empty_registry(self, monkeypatch, tmp_path):
        from app.services.tools import mcp_client

        monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: tmp_path / 'mcp-servers.json')
        monkeypatch.setattr(mcp_client, '_servers', {})
        monkeypatch.setattr(mcp_client, '_toolsCache', {})

        assert mcp_client.rehydrate_from_config() == 0  # no file at all

        mcp_client.registerServer('a', 'node', server_id='mcp_one', persist=True)
        monkeypatch.setattr(mcp_client, '_servers', {})
        assert mcp_client.rehydrate_from_config() == 1
        # A second call must not duplicate the entry.
        assert mcp_client.rehydrate_from_config() == 1
        assert len(mcp_client.listRegisteredServers()) == 1


# ── #5 — slug collisions must not overwrite ──────────────────────────────────


class TestProjectMemorySlugCollisions:
    def test_two_titles_that_slug_alike_both_survive(self, tmp_path):
        from app.services import project_memory as pm

        ws = tmp_path / 'ws'
        ws.mkdir()
        pm.upsert_entry(str(ws), 'Auth flow', 'the login sequence and its redirects',
                        description='login', kind='project', per_fact=True)
        pm.upsert_entry(str(ws), 'auth-flow', 'something else entirely, must not be lost',
                        description='other', kind='project', per_fact=True)

        entries = pm.read_entries(str(ws))
        bodies = ' '.join(e.body for e in entries)
        assert len(entries) == 2, f'one memory overwrote the other: {[e.title for e in entries]}'
        assert 'login sequence' in bodies
        assert 'must not be lost' in bodies

    def test_the_same_title_still_updates_in_place(self, tmp_path):
        """The collision guard must not turn an update into a second entry."""
        from app.services import project_memory as pm

        ws = tmp_path / 'ws'
        ws.mkdir()
        pm.upsert_entry(str(ws), 'Auth flow', 'first body', per_fact=True)
        pm.upsert_entry(str(ws), 'Auth flow', 'second body', per_fact=True)
        entries = pm.read_entries(str(ws))
        assert len(entries) == 1, f'an update created a duplicate: {[e.title for e in entries]}'
        assert 'second body' in entries[0].body