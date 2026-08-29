"""Part 17 Phase A — project memory (workspace md files, scoped retrieval).

Acceptance (plan docs/plans/2026-08-29-project-scoped-memory.md Phase A):
  * parse/write round-trip        → RoundTrip tests
  * free-form tolerance           → hand-edited files re-parse (preamble kept,
                                   missing updated line, empty body)
  * frozen-block byte-stability   → project_block frozen per session intake
  * denylist on the project door  → sensitive topic refused for scope=project
  * subagent block on all doors   → SUBAGENT_BLOCKED_TOOLS pins the full
                                   memory CRUD surface (remember/forget/
                                   list_facts) — no test pinned it before
  * brain_query project store     → ranking + workspace resolution
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.services import project_memory as pm
from app.services.tool_registrations.session_tools import (
    _currentWorkspacePath,
    reset_remember_turn_budget,
)
from app.services.workbench import workbench as wb
from app.services.workbench.context import currentSessionId
from app.services.workbench.subagent import SUBAGENT_BLOCKED_TOOLS

# Session ids created by these tests (autouse fixture drops them after).
_sessionsCreated: list[str] = []


# ── helpers ────────────────────────────────────────────────────────────


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    """A fake non-home workspace with no .aug dir yet."""
    d = tmp_path / 'proj'
    d.mkdir()
    return d


def _writeMd(ws: Path, name: str, text: str) -> None:
    root = pm.memory_root(ws)
    root.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(text, 'utf-8')


def _runRemember(ws: Path, fact: str, **kw: object) -> dict:
    """Invoke the remember tool with a session bound to `ws`."""
    import asyncio

    from app.services.tool_registrations import session_tools as st

    token = currentSessionId.set(_mkSession(ws))
    try:
        reset_remember_turn_budget(str(currentSessionId.get()))
        out = asyncio.run(st._remember(fact, **kw))
        return json.loads(out)
    finally:
        currentSessionId.reset(token)


def _mkSession(ws: Path) -> str:
    """Create (and track for cleanup) a session whose workspacePath is `ws`.

    createWorkbenchSession returns the session OBJECT; the ContextVar and
    every getter take its id string.
    """
    s = wb.createWorkbenchSession(workspacePath=str(ws))
    _sessionsCreated.append(str(s.id))
    return str(s.id)


# ── parse/render round-trip ────────────────────────────────────────────


class TestRoundTrip:
    def test_write_then_reparse_is_stable(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'Build command', 'Run `npm run build` from the root.')
        pm.upsert_entry(ws, 'Lesson: flaky CI', 'Retest 3x before blaming the driver.')
        raw = (pm.memory_root(ws) / 'memory.md').read_text('utf-8')
        pf = pm.parse_memory_md(raw)
        assert [e.title for e in pf.entries] == ['Build command', 'Lesson: flaky CI']
        again = pm.render_memory_md(pf)
        assert again == raw  # byte-stable round-trip

    def test_update_replaces_body_not_entry(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'Build command', 'old body')
        pm.upsert_entry(ws, 'Build command', 'new body')
        entries = pm.read_entries(ws)
        assert len(entries) == 1
        assert entries[0].body == 'new body'

    def test_delete_entry_keeps_others(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'Keep me', 'first')
        pm.upsert_entry(ws, 'Drop me', 'second')
        assert pm.delete_entry(ws, 'Drop me') is True
        titles = [e.title for e in pm.read_entries(ws)]
        assert titles == ['Keep me']

    def test_updated_stamp_refreshed_on_upsert(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'T', 'b1')
        first = pm.read_entries(ws)[0].updated
        assert first  # stamped on create
        pm.upsert_entry(ws, 'T', 'b2')
        assert pm.read_entries(ws)[0].updated >= first

    def test_template_created_on_first_use(self, ws: Path) -> None:
        root = pm.ensure_root(ws)
        main = root / 'memory.md'
        assert main.exists()
        assert 'Project Memory' in main.read_text('utf-8')


# ── free-form hand-edit tolerance ──────────────────────────────────────


class TestFreeFormTolerance:
    def test_preamble_preserved_verbatim(self, ws: Path) -> None:
        raw = (
            '# Project Memory\n\n'
            'Free-form notes here — any hand-typed text.\n'
            'Second preamble line.\n\n'
            '## Entry One\n\nBody one.\n'
        )
        _writeMd(ws, 'memory.md', raw)
        pm.upsert_entry(ws, 'Entry One', 'rewritten body')
        out = (pm.memory_root(ws) / 'memory.md').read_text('utf-8')
        assert 'Free-form notes here — any hand-typed text.' in out
        assert 'Second preamble line.' in out
        assert 'rewritten body' in out
        assert 'Body one.' not in out

    def test_entry_without_updated_line(self, ws: Path) -> None:
        raw = '# H\n\n## A\n\nplain body, no stamp\n'
        _writeMd(ws, 'memory.md', raw)
        entries = pm.read_entries(ws)
        assert entries[0].title == 'A'
        assert entries[0].updated == ''
        assert entries[0].body == 'plain body, no stamp'

    def test_empty_body_entry_is_valid(self, ws: Path) -> None:
        raw = '# H\n\n## Only title\n\n## Next\n\nbody\n'
        _writeMd(ws, 'memory.md', raw)
        entries = pm.read_entries(ws)
        assert [e.title for e in entries] == ['Only title', 'Next']

    def test_hand_edit_between_turns_reparsed(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'A', 'body a')
        # User hand-edits the md directly between sessions:
        raw = (pm.memory_root(ws) / 'memory.md').read_text('utf-8')
        raw += '\n\n## Hand added\n\nhuman text\n'
        _writeMd(ws, 'memory.md', raw)
        titles = [e.title for e in pm.read_entries(ws)]
        assert 'Hand added' in titles

    def test_multiple_md_files(self, ws: Path) -> None:
        _writeMd(ws, 'memory.md', '# H\n\n## Main entry\n\nfrom memory.md\n')
        _writeMd(ws, 'decisions.md', '# D\n\n## DEC-1\n\nuse postgres\n')
        files = [f['file'] for f in pm.list_files(ws)]
        assert files == ['decisions.md', 'memory.md']
        titles = {e.title for e in pm.read_entries(ws)}
        assert titles == {'Main entry', 'DEC-1'}


# ── frozen block byte-stability across turns ──────────────────────────


class TestFrozenBlock:
    def test_project_block_titles_only_and_capped(self, ws: Path) -> None:
        for i in range(30):
            pm.upsert_entry(ws, f'Entry {i:02d}', 'x' * 20)
        block = pm.project_block(ws, cap=400)
        assert block.startswith('<project_memory>')
        assert block.endswith('</project_memory>')
        assert '- Entry 00' in block
        assert 'more' in block  # cap line present
        assert 'x' * 20 not in block  # bodies excluded (titles only)

    def test_frozen_index_survives_file_growth(self, ws: Path) -> None:
        # Simulate two intakes on the same session: entries added AFTER the
        # first freeze must not change what the session's cached block says
        # (fresh entries ride the per-turn tail, not the system prompt).
        sid = _mkSession(ws)
        pm.upsert_entry(ws, 'Before freeze', 'old')
        token = currentSessionId.set(sid)
        try:
            s = wb.get_workbench_session(sid)
            assert s is not None
            first = pm.project_block(str(ws))
            s._frozen_project_index = first  # type: ignore[attr-defined]
            pm.upsert_entry(ws, 'Added later', 'new entry mid-session')
            frozen = getattr(s, '_frozen_project_index', '')
            assert frozen == first
            assert 'Added later' not in frozen
        finally:
            currentSessionId.reset(token)

    def test_empty_workspace_block_empty(self, ws: Path) -> None:
        pm.ensure_root(ws)  # template only, no entries
        assert pm.project_block(ws) == ''


# ── tail block (per-turn recall) ───────────────────────────────────────


class TestTailBlock:
    def test_tagged_project_lines(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'DB port', 'Postgres listens on 5433, not the default.')
        tail = pm.build_project_memory_tail(ws, 'database port number', k=3)
        assert tail.startswith('project:')
        assert 'DB port' in tail
        assert '5433' in tail

    def test_no_match_no_section(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'DB port', 'Postgres on 5433.')
        assert pm.build_project_memory_tail(ws, 'completely unrelated zebras') == ''

    def test_search_ranks_relevant_first(self, ws: Path) -> None:
        pm.upsert_entry(ws, 'UI colors', 'primary is teal')
        pm.upsert_entry(ws, 'DB port', 'postgres 5433')
        hits = pm.search_entries(ws, 'postgres database port', k=2)
        assert hits and hits[0].title == 'DB port'

    def test_build_memory_block_recalled_rows(self, ws: Path) -> None:
        # Phase A.4: the recalled out-param collects the rows the tail
        # actually injected — global + project, scope-tagged (the payload
        # of the recalledMemories SSE event).
        from app.services.memory_store.fact_retrieval import build_memory_block

        pm.upsert_entry(ws, 'DB port', 'Postgres listens on 5433.')
        recalled: list[dict[str, object]] = []
        block, injected = build_memory_block(
            'database port number', workspace=str(ws), recalled=recalled
        )
        assert block  # something was injected
        projRows = [r for r in recalled if r.get('scope') == 'project']
        assert projRows and projRows[0]['key'] == 'project:DB port'
        assert '5433' in str(projRows[0]['snippet'])
        # Without the out-param the call behaves exactly as before.
        block2, injected2 = build_memory_block('database port number', workspace=str(ws))
        assert block2 == block
        assert injected2 == injected


# ── remember/forget through the project door ───────────────────────────


class TestRememberProjectDoor:
    def test_explicit_project_scope_writes_md(self, ws: Path) -> None:
        res = _runRemember(ws, 'Tests run with basetemp outside the repo.', scope='project')
        assert res['ok'] is True
        assert res['scope'] == 'project'
        entries = pm.read_entries(ws)
        assert any('basetemp' in e.body for e in entries)

    def test_default_scope_is_project_inside_workspace(self, ws: Path) -> None:
        # No scope arg inside a non-home workspace → project store.
        res = _runRemember(ws, 'Default scope should land in project memory.')
        assert res['ok'] is True
        assert res['scope'] == 'project'

    def test_global_scope_still_reaches_facts_store(self, ws: Path) -> None:
        from app.services import memory_store

        res = _runRemember(ws, 'Global fact for the everywhere-store test.', scope='global')
        assert res['ok'] is True
        assert res.get('scope', 'global') != 'project'
        fact = memory_store.get_fact(res['key'])
        assert fact is not None

    def test_denylist_refuses_project_scope(self, ws: Path) -> None:
        res = _runRemember(
            ws, 'User takes antidepressant medication daily.', scope='project'
        )
        assert res['ok'] is False
        assert 'sensitive' in res.get('policy', '')
        # And nothing was written to the md:
        assert not any(
            'antidepressant' in e.body for e in pm.read_entries(ws)
        )

    def test_project_scope_without_workspace_errors(self, tmp_path: Path) -> None:
        import asyncio

        from app.services.tool_registrations import session_tools as st

        token = currentSessionId.set('')  # no session → no workspace
        try:
            out = asyncio.run(st._remember('A fact with nowhere project to go.', scope='project'))
            res = json.loads(out)
            assert res['ok'] is False
            assert 'workspace' in res.get('error', '')
        finally:
            currentSessionId.reset(token)


class TestForgetProjectDoor:
    def test_forget_project_prefix(self, ws: Path) -> None:
        import asyncio

        from app.services.tool_registrations import session_tools as st

        pm.upsert_entry(ws, 'CI lesson', 'flake retest before blaming')
        sid = _mkSession(ws)
        token = currentSessionId.set(sid)
        try:
            out = asyncio.run(st._forget('project:CI lesson'))
            res = json.loads(out)
            assert res['ok'] is True
            assert res['scope'] == 'project'
            assert pm.read_entries(ws) == []
        finally:
            currentSessionId.reset(token)

    def test_forget_bare_title_inside_workspace(self, ws: Path) -> None:
        import asyncio

        from app.services.tool_registrations import session_tools as st

        pm.upsert_entry(ws, 'Bare title entry', 'to delete')
        sid = _mkSession(ws)
        token = currentSessionId.set(sid)
        try:
            out = asyncio.run(st._forget('Bare title entry'))
            res = json.loads(out)
            assert res['ok'] is True
            assert res['scope'] == 'project'
        finally:
            currentSessionId.reset(token)

    def test_forget_project_missing_reports_not_found(self, ws: Path) -> None:
        import asyncio

        from app.services.tool_registrations import session_tools as st

        sid = _mkSession(ws)
        token = currentSessionId.set(sid)
        try:
            out = asyncio.run(st._forget('project:No Such Entry'))
            res = json.loads(out)
            assert res['ok'] is False
        finally:
            currentSessionId.reset(token)


class TestListFactsProject:
    def test_project_entries_listed_with_prefix(self, ws: Path) -> None:
        import asyncio

        from app.services.tool_registrations import session_tools as st

        pm.upsert_entry(ws, 'Listed entry', 'project body')
        sid = _mkSession(ws)
        token = currentSessionId.set(sid)
        try:
            out = asyncio.run(st._list_facts())
            res = json.loads(out)
            keys = [f['key'] for f in res['facts']]
            assert 'project:Listed entry' in keys
            row = next(f for f in res['facts'] if f['key'] == 'project:Listed entry')
            assert row['source'] == 'project-file'
            assert row['file'] == 'memory.md'
        finally:
            currentSessionId.reset(token)


# ── brain_query project-memory store ───────────────────────────────────


class TestBrainQueryProjectStore:
    def test_rows_via_workspace_filter(self, ws: Path) -> None:
        from app.services.memory_store.brain import brain_query

        pm.upsert_entry(ws, 'Query row', 'postgres 5433')
        out = brain_query('project-memory', '', filters={'workspace': str(ws)}, limit=5)
        rows = json.loads(out)
        assert any(r['title'] == 'Query row' for r in rows)

    def test_bmw_ranking_beats_file_order(self, ws: Path) -> None:
        from app.services.memory_store.brain import brain_query

        pm.upsert_entry(ws, 'Alpha entry', 'unrelated words about zebras')
        pm.upsert_entry(ws, 'DB port', 'postgres listens on 5433')
        out = brain_query('project-memory', 'postgres port', filters={'workspace': str(ws)}, limit=2)
        rows = json.loads(out)
        assert rows[0]['title'] == 'DB port'

    def test_no_workspace_reports_error(self) -> None:
        from app.services.memory_store.brain import brain_query

        token = currentSessionId.set('')
        try:
            out = brain_query('project-memory', '', limit=5)
            res = json.loads(out)
            assert 'error' in res
        finally:
            currentSessionId.reset(token)


# ── subagent block on all memory doors ────────────────────────────────


class TestSubagentBlock:
    def test_all_memory_crud_tools_blocked(self) -> None:
        # No test pinned this set before Phase A — the Part 17 review found
        # only `remember` was blocked while forget/list_facts stayed open.
        for t in ('remember', 'forget', 'list_facts'):
            assert t in SUBAGENT_BLOCKED_TOOLS, f'{t} must be blocked for sub-agents'

    def test_spawn_tools_still_blocked(self) -> None:
        assert 'spawn_subagent' in SUBAGENT_BLOCKED_TOOLS
        assert 'set_agent_mode' in SUBAGENT_BLOCKED_TOOLS


# ── shadow-git hygiene ────────────────────────────────────────────────


class TestShadowGitExcludes:
    def test_aug_dir_excluded(self) -> None:
        from app.services.workbench import shadow_git

        assert '.aug/' in shadow_git._EXCLUDES
        assert '.aug/spill/' not in shadow_git._EXCLUDES  # superseded by the wider entry


# ── workspace resolution helper ────────────────────────────────────────


class TestWorkspaceResolution:
    def test_current_workspace_path_resolves_session(self, ws: Path) -> None:
        sid = _mkSession(ws)
        token = currentSessionId.set(sid)
        try:
            assert _currentWorkspacePath() == str(ws)
        finally:
            currentSessionId.reset(token)

    def test_no_session_gives_empty(self) -> None:
        token = currentSessionId.set('')
        try:
            assert _currentWorkspacePath() == ''
        finally:
            currentSessionId.reset(token)


# ── router doors (UI write path + import scope) — Phase A.5 ─────────────


class TestMemoryManageProject:
    def test_set_delete_list_roundtrip(self, ws: Path) -> None:
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        r = client.post(
            '/api/august/memory/manage',
            json={
                'action': 'set',
                'key': 'Build command',
                'value': 'Run npm run build.',
                'details': 'From the repo root.',
                'scope': 'project',
                'workspace': str(ws),
            },
        )
        assert r.status_code == 200, r.text
        assert r.json()['ok'] is True
        entries = pm.read_entries(ws)
        assert entries[0].title == 'Build command'
        assert 'npm run build' in entries[0].body

        r = client.post(
            '/api/august/memory/manage',
            json={
                'action': 'list',
                'scope': 'project',
                'workspace': str(ws),
            },
        )
        data = r.json()
        assert data['ok'] is True
        assert any(e['key'] == 'project:Build command' for e in data['entries'])

        r = client.post(
            '/api/august/memory/manage',
            json={
                'action': 'delete',
                'key': 'Build command',
                'scope': 'project',
                'workspace': str(ws),
            },
        )
        assert r.json()['ok'] is True
        assert pm.read_entries(ws) == []

    def test_project_requires_workspace(self) -> None:
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        r = client.post(
            '/api/august/memory/manage',
            json={'action': 'set', 'key': 'K', 'value': 'V', 'scope': 'project'},
        )
        assert r.json()['ok'] is False
        assert 'workspace' in r.json()['error']


class TestImportProjectScope:
    def test_project_import_lands_as_md_entries(self, ws: Path) -> None:
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        r = client.post(
            '/api/august/memory/import',
            json={
                'items': [
                    {'key': 'first note', 'value': 'Always run tests before push.'},
                    {'fact': 'Deploy via MSI', 'details': 'NSIS is legacy here.'},
                ],
                'scope': 'project',
                'workspace': str(ws),
            },
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data['ok'] is True
        assert data['count'] == 2
        assert data['scope'] == 'project'
        titles = {e.title for e in pm.read_entries(ws)}
        assert 'first note' in titles
        assert 'Deploy via MSI' in titles
        body = next(e for e in pm.read_entries(ws) if e.title == 'Deploy via MSI').body
        assert 'NSIS is legacy here.' in body

    def test_project_import_without_workspace_fails(self) -> None:
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)
        r = client.post(
            '/api/august/memory/import',
            json={'items': [{'key': 'k', 'value': 'v'}], 'scope': 'project'},
        )
        assert r.json()['ok'] is False


# Cleanup: sessions created here are module-RAM + on-disk in the app data
# dir; drop them so later suites don't see our scratch workspaces. The tmp
# workspaces themselves vanish with pytest's tmp_path.
@pytest.fixture(autouse=True)
def _cleanupSessions():
    yield
    try:
        for sid in list(_sessionsCreated):
            try:
                wb.delete_workbench_session(sid)
            except Exception:
                pass
        _sessionsCreated.clear()
    except Exception:
        pass
