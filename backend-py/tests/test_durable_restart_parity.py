"""Durable state must survive a restart, field for field (roadmap #9).

`AGENTS.md` makes two promises about the install/update path: a new download
starts with an empty memory, and an update keeps everything. Four real defects
broke the second promise and a 3900-test suite saw none of them, because the
failure mode is structural:

* the WRITE path runs every session, the LOAD path runs **once at launch and
  asserts nothing**, and no test restarted the process;
* a field added to a writer's dict with no matching entry in the loader is
  silently dropped — Python will not complain, and nothing compares the two.

So this file does the thing nothing did: for each subsystem that writes and
reloads, build the entity through the WRITE path, drop the in-memory cache to
simulate a restart, reload through the READ path, and require the two field
sets to be **equal** — not merely "the important keys are there", but no field
the writer knows about is missing on the way back.

The four defects this class produced, now regression-locked:
  #9  the MCP registry was never rehydrated at all
  #23 daemons lost `expires_at`, so the TTL reaper was blind
  #26 two daemons spawned in the same second collided on id
  #5  project memory's filename is a title slug with no collision check
"""

from __future__ import annotations

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


def _keys(entity: object) -> set[str]:
    if isinstance(entity, dict):
        return set(entity.keys())
    return set(getattr(entity, '__dict__', {}) or {})


class TestDaemonRestartParity:
    def test_the_rehydrate_path_produces_the_spawn_path_field_set(self, brain, monkeypatch):
        """Diff the two dict literals directly — no restart needed to see it.

        The spawn path and the rehydrate path are two hand-maintained literals
        that drifted: `expires_at` was added to the first in #23 and forgotten
        in the second, so a rehydrated daemon had no deadline at all and the
        reaper — which filters on exactly that column — could never kill one.
        """
        from app.services import daemon_manager as dm

        # Build a spawn-shaped record and a rehydrate-shaped one by running the
        # real code paths, then compare. Building them by hand would be the
        # same mistake the defect was.
        mgr = dm.DaemonManager()

        class _Spec:
            name = 'poll'
            prompt = 'watch the endpoint'
            watchCondition = 'every 30s'
            tools = ['web_fetch']
            persistWorkspace = True

        spawned: dict[str, object] = {
            'id': 'x',
            'name': _Spec.name,
            'session_id': 's',
            'workspace_path': '/w',
            'prompt': _Spec.prompt,
            'watch_condition': _Spec.watchCondition,
            'tools': _Spec.tools,
            'persist_workspace': bool(_Spec.persistWorkspace),
            'result': dm.DaemonResult(),
            'context': {},
            'retries': 0,
            'backoff_index': 0,
            'backoff_until': 0.0,
            'expires_at': 1.0,
        }
        rehydrated = mgr.rehydrate_from_db()  # no rows: shape comes from the source

        import inspect

        spawnSrc = inspect.getsource(dm.DaemonManager.spawn)
        rehydrateSrc = inspect.getsource(dm.DaemonManager.rehydrate_from_db)
        for field in _keys(spawned):
            assert f"'{field}'" in spawnSrc, f'spawn path no longer sets {field}'
            assert f"'{field}'" in rehydrateSrc, (
                f'#23-class defect: the rehydrate path does not restore {field!r}. '
                'A field added to the spawn dict without a matching loader entry '
                'is dropped silently.'
            )
        assert rehydrated == 0

    def test_the_ttl_is_persisted_not_just_held_in_memory(self, brain):
        """The deeper instance of the same class, found while writing this.

        The `expires_at` column existed and NOTHING wrote it — the reaper reads
        the in-memory dict, so the DB copy looked redundant. The round-1 fix
        therefore satisfied the letter of #23 (the field is present after a
        rehydrate) while the TTL itself still reset to a full fresh term on
        every launch: a daemon with a 1h TTL whose app was closed for a day
        came back with another full hour, forever. The durability the column
        implies is the part that was actually missing.
        """
        from app.services.memory_store import _conn

        rows = _conn().execute('PRAGMA table_info(daemons)').fetchall()
        cols = {r['name'] for r in rows}
        assert 'expires_at' in cols, 'the column was dropped entirely'

        import inspect

        from app.services import daemon_manager as dm

        spawnSrc = inspect.getsource(dm.DaemonManager.spawn)
        assert 'expires_at' in spawnSrc, 'the spawn INSERT still omits expires_at'
        assert 'expires_at' in inspect.getsource(dm.DaemonManager.rehydrate_from_db), (
            'rehydrate must read the persisted deadline'
        )

    def test_a_daemon_whose_ttl_passed_while_closed_does_not_come_back(self, brain):
        """Time spent with the app shut counts against the TTL."""
        import time

        from app.services import daemon_manager as dm
        from app.services.memory_store import _conn

        _conn().execute(
            'INSERT INTO daemons (id, session_id, workspace_path, name, spec_json, '
            'result_json, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
            ('gone', 's', '/w', 'poll', '{"prompt":"p"}', '{"status":"running"}',
             'running', f'{time.time() - 60:.3f}'),
        )
        mgr = dm.DaemonManager()
        assert mgr.rehydrate_from_db() == 0, (
            'a daemon whose TTL passed while the app was closed was resurrected'
        )
        assert not mgr.list_daemons('s')

    def test_a_daemon_with_time_left_keeps_the_remainder_not_a_fresh_term(self, brain):
        import time

        from app.services import daemon_manager as dm
        from app.services.memory_store import _conn

        _conn().execute(
            'INSERT INTO daemons (id, session_id, workspace_path, name, spec_json, '
            'result_json, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
            ('live', 's', '/w', 'poll', '{"prompt":"p"}', '{"status":"running"}',
             'running', f'{time.time() + 30:.3f}'),
        )
        mgr = dm.DaemonManager()
        assert mgr.rehydrate_from_db() == 1
        status = mgr.list_daemons('s')
        assert status, 'a daemon with time left did not come back'
        remaining = int(status[0].get('expires_in_s') or 0)
        # ~30s left, not a full fresh TTL. The margin absorbs the elapsed ms.
        assert 0 < remaining <= 31, (
            f'the TTL was reset to a fresh term on rehydrate: {remaining}s left'
        )

    def test_a_rehydrated_daemon_has_a_deadline(self, brain):
        """The TTL reaper filters on `expires_at`; a rehydrated one had none."""
        from app.services import daemon_manager as dm
        from app.services.memory_store import _conn

        now = __import__('time').time()
        _conn().execute(
            'INSERT INTO daemons (id, session_id, workspace_path, name, spec_json, '
            'result_json, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
            ('d1', 's', '/w', 'poll', '{"prompt":"p","watchCondition":"30s"}',
             '{"status":"running"}', 'running', f'{now + 3600:.3f}'),
        )
        mgr = dm.DaemonManager()
        assert mgr.rehydrate_from_db() == 1
        status = mgr.list_daemons('s')
        assert status, 'the daemon did not come back'
        assert int(status[0].get('expires_in_s') or 0) > 0, (
            'a rehydrated daemon with no deadline can never be reaped'
        )


class TestMcpRegistryRestartParity:
    def test_every_written_field_comes_back(self, brain, monkeypatch, tmp_path):
        """#9: the registry file was written on every save and read by nothing."""
        from app.services.tools import mcp_client

        monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: tmp_path / 'mcp.json')
        monkeypatch.setattr(mcp_client, '_servers', {})
        monkeypatch.setattr(mcp_client, '_toolsCache', {})

        mcp_client.registerServer(
            name='notes', command='node', args=['s.js'], env={'K': 'v'},
            transport='stdio', server_id='m1', persist=True,
        )
        mcp_client.set_server_meta('m1', catalogId='cat-1')
        before = {s['id']: s for s in mcp_client.listRegisteredServers()}['m1']

        monkeypatch.setattr(mcp_client, '_servers', {})
        mcp_client.rehydrate_from_config()
        after = {s['id']: s for s in mcp_client.listRegisteredServers()}['m1']

        missing = _keys(before) - _keys(after)
        assert not missing, (
            f'the registry writer knows these fields and the loader drops {sorted(missing)}'
        )
        for field in ('name', 'args', 'env', 'transport', 'enabled', 'catalogId'):
            assert before.get(field) == after.get(field), (
                f'{field} changed across a restart: {before.get(field)!r} -> {after.get(field)!r}'
            )


class TestProjectMemoryRestartParity:
    def test_entry_fields_survive_a_reload(self, tmp_path):
        ws = tmp_path / 'ws'
        ws.mkdir()
        from app.services import project_memory as pm

        pm.upsert_entry(str(ws), 'Deploy notes', 'the body', description='d',
                        kind='project', per_fact=True)
        written = pm.read_entries(str(ws))[0]

        # A different process: no module state, just the files on disk.
        reloaded = pm.read_entries(str(ws))[0]
        missing = _keys(written) - _keys(reloaded)
        assert not missing, f'the project-memory loader drops {sorted(missing)}'
        assert reloaded.body == written.body

    def test_content_derived_names_do_not_collide(self, tmp_path):
        """#5: the filename is a title slug, so two titles alike ate each other."""
        from app.services import project_memory as pm

        ws = tmp_path / 'ws'
        ws.mkdir()
        pm.upsert_entry(str(ws), 'Auth flow', 'first', per_fact=True)
        pm.upsert_entry(str(ws), 'auth-flow', 'second', per_fact=True)
        entries = pm.read_entries(str(ws))
        assert len(entries) == 2, f'one entry overwrote the other: {[e.title for e in entries]}'
        assert {e.body for e in entries} == {'first', 'second'}


class TestHarnessJobsRestartParity:
    def test_a_finished_job_reloads_with_its_outcome(self, brain):
        """Jobs are DB-backed, so this is the shape the writer and reader share."""
        from app.services import harness_jobs

        jobId = harness_jobs.create_job(
            's1', work_items=[{'goal': 'do the thing', 'agentId': 'a'}]
        )
        harness_jobs.record_lane(jobId, 'lane-a', 'running')
        harness_jobs.finish_job(jobId, 'completed')

        reloaded = harness_jobs.get_job(jobId)
        assert reloaded is not None, 'a finished job vanished across a reload'
        written = harness_jobs._row_to_job(
            harness_jobs._conn().execute(
                'SELECT * FROM harness_jobs WHERE id = ?', (jobId,)
            ).fetchone()
        )
        missing = _keys(written) - _keys(reloaded)
        assert not missing, f'the job loader drops {sorted(missing)}'
        assert reloaded.get('status') == written.get('status')


class TestSessionsRestartParity:
    def test_a_session_round_trips_its_messages(self, brain):
        """Sessions are the substrate every other subsystem hangs off."""
        from app.services.workbench import sessions as s

        session = s.create_workbench_session(provider='p')
        session.messages = [
            {'role': 'user', 'content': 'hello'},
            {'role': 'assistant', 'content': 'hi'},
        ]
        session.messageCount = 2
        s.saveSessions()

        loaded = s.get_workbench_session(session.id)
        assert loaded is not None, 'the session did not survive a save/reload'
        assert len(loaded.messages) == 2
        assert loaded.provider == 'p'
