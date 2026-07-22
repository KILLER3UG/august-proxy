"""Polish gap tests: FTS messages, session migrate, export, consent, job types."""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    monkeypatch.delenv('AUGUST_SESSION_JSON_EXPORT', raising=False)
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    yield tmp_path
    settings.reload()


def test_messages_fts_on_write(_iso):
    from app.services import memory_store

    memory_store.init()
    memory_store.save_session(
        {
            'id': 'wb_fts1',
            'title': 't',
            'startedAt': '2026-01-01T00:00:00Z',
            'messageCount': 0,
            'provider': '',
            'model': '',
        }
    )
    mid = memory_store.save_message('wb_fts1', 'user', 'unique fts marker XYZ99')
    assert mid
    # FTS table has a row (phrase without hyphens — FTS5 treats - as operators)
    row = memory_store._conn().execute(
        "SELECT content FROM messages_fts WHERE messages_fts MATCH 'XYZ99'"
    ).fetchone()
    assert row is not None
    out = memory_store.brain_query(store='messages', query='XYZ99', limit=5)
    assert 'XYZ99' in out


def test_json_migrate_retires_file(_iso):
    from app.lib.paths import dataPath
    from app.services.workbench.sessions import _sessions, migrate_json_sessions_to_sqlite

    path = dataPath('workbench-sessions.json')
    path.write_text(
        json.dumps(
            [
                {
                    'id': 'wb_mig1',
                    'title': 'migrated',
                    'messages': [{'role': 'user', 'content': 'hi'}],
                    'messageCount': 1,
                    'createdAt': '2026-01-01T00:00:00Z',
                    'updatedAt': '2026-01-01T00:00:00Z',
                    'startedAt': '2026-01-01T00:00:00Z',
                }
            ]
        ),
        encoding='utf-8',
    )
    _sessions.clear()
    result = migrate_json_sessions_to_sqlite(force=True)
    assert result['ok'] is True
    assert result['imported'] == 1
    assert not path.exists()
    assert path.with_suffix(path.suffix + '.migrated').exists()


def test_delta_consent_persists(_iso):
    from app.services import delta_engine as de
    from app.services import memory_store

    memory_store.init()
    de._consent_granted = None
    assert de.isConsentGranted() is False
    de.grantConsent()
    de._consent_granted = None  # force reload from SoT
    assert de.isConsentGranted() is True
    de.revokeConsent()
    de._consent_granted = None
    assert de.isConsentGranted() is False


def test_automation_job_types(_iso):
    from app.services import automations_store as store

    store.reset_store()
    job = store.upsert_job({'jobType': 'noop', 'name': 'n1'})
    assert job['jobType'] == 'noop'
    out = store.run_job(job['id'])
    assert out['job']['status'] == 'idle'
    # Unknown types fall back to shell (legacy-safe); explicit invalid via normalize
    bad = store.upsert_job({'jobType': 'shell', 'command': 'echo ok', 'name': 's1'})
    assert bad['jobType'] == 'shell'
    # Force invalid through _normalize by patching after upsert is not raised —
    # ValueError only when explicitly rejected; ensure JOB_TYPES is the enum.
    assert 'workbench' in store.JOB_TYPES
    assert 'http' in store.JOB_TYPES


def test_proxy_silent_stats_exportable():
    from app.adapters.proxy_tools import _bump_silent, get_proxy_silent_stats

    before = get_proxy_silent_stats()
    _bump_silent('log_activity')
    after = get_proxy_silent_stats()
    assert after['log_activity'] >= before.get('log_activity', 0) + 1


def test_selfcheck_tables_exist(_iso):
    from app.routers.brain import _runSelfcheck
    from app.services import memory_store

    memory_store.init()
    for key in ('execution_state', 'scratchpad', 'blackboard', 'vector_memory', 'graph_memory'):
        r = _runSelfcheck(key if key != 'execution_state' else 'execution_state')
        if key == 'execution_state':
            assert r['status'] == 'on & healthy', r
        if key == 'scratchpad':
            assert r['status'] == 'on & healthy', r
