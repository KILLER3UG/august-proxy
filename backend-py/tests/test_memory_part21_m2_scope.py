"""Part 21 M-2 (2026-09-04, ruling OQ5) — the facts scope column.

One additive column (migration 032) gives memory a home axis: a Bot's
canonical chat writes ``bot:<agentId>`` rows, everything else stays
``global``. Retrieval unions global ∪ this-scope (a Bot still recalls the
user's shared memory; its private notes stay private; one Bot never sees
another's). The skills catalogue prepends a bot root so a Bot can carry its
own skills. All existing rows keep DEFAULT 'global' — additive + reversible.
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def store(isolatedData):
    from app.services.memory_store import init as init_store

    init_store()
    from app.services import memory_store

    return memory_store


# ── schema: the column exists + defaults to global ─────────────────────────


class TestScopeColumn:
    def test_facts_table_has_scope_column(self, store):
        from app.services.memory_conn import conn

        cols = {
            r['name'] for r in conn().execute('PRAGMA table_info(facts)').fetchall()
        }
        assert 'scope' in cols

    def test_scope_index_exists(self, store):
        from app.services.memory_conn import conn

        idx = {
            r['name']
            for r in conn().execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='facts'"
            ).fetchall()
        }
        assert 'idx_facts_scope' in idx

    def test_save_fact_defaults_to_global(self, store):
        store.save_fact('user:pref', {'fact': 'likes terse answers'}, title='Terse')
        from app.services.memory_conn import conn

        row = conn().execute(
            'SELECT scope FROM facts WHERE fact_key = ?', ('user:pref',)
        ).fetchone()
        assert str(row['scope']) == 'global'

    def test_legacy_rows_stay_global(self, store):
        # A row written before any scope was supplied (the migration's
        # DEFAULT) reads back global — the additive/reversible guarantee.
        from app.services.memory_conn import conn

        conn().execute(
            "INSERT INTO facts (fact_key, fact_value, title) VALUES ('old:key', '\"v\"', 'Old')"
        )
        conn().commit()
        row = conn().execute(
            'SELECT scope FROM facts WHERE fact_key = ?', ('old:key',)
        ).fetchone()
        assert str(row['scope']) == 'global'


# ── union retrieval ─────────────────────────────────────────────────────────


class TestUnionRetrieval:
    def test_global_scope_sees_only_global(self, store):
        from app.services.memory_store import fact_retrieval

        store.save_fact('g:shared', {'fact': 'the release cadence is weekly'}, title='Cadence')
        store.save_fact(
            'b:private', {'fact': 'the release cadence is nightly'}, title='Nightly',
            scope='bot:alpha',
        )
        hits = fact_retrieval.retrieve_relevant_facts('release cadence weekly nightly', k=5)
        keys = {h['key'] for h in hits}
        assert 'g:shared' in keys
        assert 'b:private' not in keys

    def test_bot_scope_sees_global_plus_own(self, store):
        from app.services.memory_store import fact_retrieval

        store.save_fact('g:shared', {'fact': 'quarterly board deck template'}, title='Deck')
        store.save_fact(
            'b:own', {'fact': 'quarterly board deck checklist'}, title='Checklist',
            scope='bot:alpha',
        )
        store.save_fact(
            'c:rival', {'fact': 'quarterly board deck rival'}, title='Rival',
            scope='bot:beta',
        )
        hits = fact_retrieval.retrieve_relevant_facts(
            'quarterly board deck', k=5, scope='bot:alpha'
        )
        keys = {h['key'] for h in hits}
        assert 'g:shared' in keys  # global ∪ …
        assert 'b:own' in keys  # … ∪ this-scope
        assert 'c:rival' not in keys  # never another bot's

    def test_build_memory_block_honors_scope(self, store):
        from app.services.memory_store import fact_retrieval

        store.save_fact(
            'b:secret', {'fact': 'the api rotation schedule'}, title='Rotation',
            scope='bot:alpha',
        )
        block, _ = fact_retrieval.build_memory_block('api rotation schedule', scope='bot:alpha')
        assert 'Rotation' in block
        block2, _ = fact_retrieval.build_memory_block('api rotation schedule', scope='global')
        assert 'Rotation' not in block2


# ── write door: scope is stamped + immutable on update ──────────────────────


class TestWriteDoor:
    def test_update_keeps_original_scope(self, store):
        from app.services.memory_conn import conn

        store.save_fact('k:one', {'fact': 'v1'}, title='One', scope='bot:alpha')
        # Part 26 6.5: a cross-scope write from a DIFFERENT non-global scope
        # is refused (ValueError) instead of silently rewriting the private
        # value under its original scope; an explicit override (consolidation,
        # rollback restore) updates in place and still never rewrites scope.
        import pytest as _pytest

        with _pytest.raises(ValueError):
            store.save_fact('k:one', {'fact': 'v2'}, title='One', scope='bot:beta')
        store.save_fact('k:one', {'fact': 'v2'}, title='One', scope='global', allow_scope_override=True)
        row = conn().execute('SELECT scope FROM facts WHERE fact_key = ?', ('k:one',)).fetchone()
        assert str(row['scope']) == 'bot:alpha'
        assert 'v2' in str(row[0] if False else conn().execute('SELECT fact_value FROM facts WHERE fact_key = ?', ('k:one',)).fetchone()['fact_value'])

    def test_normalize_scope_rejects_junk(self):
        from app.services.session_scope import normalize_scope

        assert normalize_scope('bot:x') == 'bot:x'
        assert normalize_scope('global') == 'global'
        assert normalize_scope('../../etc') == 'global'
        assert normalize_scope('') == 'global'


# ── resolve_scope: bot home vs everything else ──────────────────────────────


class TestResolveScope:
    def test_canonical_bot_chat_resolves_to_bot_scope(self, isolatedData):
        from app.services import session_scope
        from app.services.bot_mode import roster
        from app.services.tools import agent_registry

        agent = agent_registry.createAgent(name='scoper', description='', role='')
        agent_id = str(agent['id'])
        chat = roster.ensure_canonical_bot_chat(agent_id)
        assert session_scope.resolve_scope(chat) == f'bot:{agent_id}'

    def test_regular_session_is_global(self, isolatedData):
        from app.services import session_scope
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        assert session_scope.resolve_scope(sess) == 'global'

    def test_dm_run_context_resolves(self, isolatedData):
        from app.services import session_scope
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        meta = dict(sess.metadata or {})
        meta['botAgentId'] = 'bot-9'
        sess.metadata = meta
        assert session_scope.resolve_scope(sess) == 'bot:bot-9'


# ── skills: bot root + shadowing ────────────────────────────────────────────


class TestSkillBotRoot:
    def _write_skill(self, root, name, desc):
        root.mkdir(parents=True, exist_ok=True)
        (root / name).mkdir(exist_ok=True)
        (root / name / 'SKILL.md').write_text(
            f'---\nname: {name}\ndescription: {desc}\n---\n\nbody\n', 'utf-8'
        )

    def test_bot_root_precedes_and_shadows(self, isolatedData, tmp_path, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        from app.services import skill_service

        # A bundled-style agent skill named 'report' exists globally…
        self._write_skill(tmp_path / 'skills', 'report', 'global report skill')
        # …and the bot has its own 'report' skill.
        bot_root = tmp_path / 'bots' / 'alpha' / 'skills'
        self._write_skill(bot_root, 'report', 'alpha private report')

        roots = skill_service._skillRoots(None, 'alpha')
        assert roots[0][0] == 'bot'  # bot root is FIRST (highest precedence)

        # With the bot agent, the bot's 'report' wins.
        got = skill_service.get('report', agent_id='alpha')
        assert got is not None
        assert 'alpha private' in str(got.get('description', ''))
        # Without it, the global one is served.
        got2 = skill_service.get('report', agent_id='')
        assert got2 is not None
        assert 'global report' in str(got2.get('description', ''))

    def test_no_agent_id_no_bot_root(self, isolatedData):
        from app.services import skill_service

        scopes = [s for s, _ in skill_service._skillRoots(None, '')]
        assert 'bot' not in scopes
