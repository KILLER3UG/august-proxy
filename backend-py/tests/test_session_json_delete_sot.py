"""Prove session history survives deleting workbench-sessions.json."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    monkeypatch.delenv('AUGUST_SESSION_JSON_EXPORT', raising=False)
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    yield
    settings.reload()


def test_json_delete_history_loads_from_sqlite():
    from app.lib.paths import dataPath
    from app.services import memory_store
    from app.services.memory_store import save_workbench_session_sot
    from app.services.workbench.sessions import (
        WorkbenchSession,
        _sessions,
        reload_sessions_from_sot,
        save_sessions,
    )

    memory_store.init()
    sess = WorkbenchSession(
        id='wb_json_del_test',
        title='survive',
        messages=[{'role': 'user', 'content': 'history-marker-ABC'}],
        messageCount=1,
        createdAt='2026-01-01T00:00:00Z',
        updatedAt='2026-01-01T00:00:00Z',
        startedAt='2026-01-01T00:00:00Z',
    )
    _sessions[sess.id] = sess
    save_sessions()  # SQLite only (export off)

    json_path = dataPath('workbench-sessions.json')
    assert not json_path.exists() or 'wb_json_del_test' not in json_path.read_text()

    # Write JSON then delete it — SoT must still load
    json_path.write_text('[]', encoding='utf-8')
    json_path.unlink()
    _sessions.clear()

    n = reload_sessions_from_sot()
    assert n >= 1
    loaded = _sessions.get('wb_json_del_test')
    assert loaded is not None
    assert loaded.title == 'survive'
    msgs = memory_store.get_messages('wb_json_del_test')
    assert any('history-marker-ABC' in str(m.get('content', '')) for m in msgs)


def test_vector_graph_sqlite_sot(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain2.sqlite'))
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services import memory_store
    from app.services.memory import graph_memory, vector_db

    memory_store.init()
    # Reset migration flags
    vector_db._json_migrated = False
    graph_memory._json_migrated = False
    e = vector_db.insert('hello sqlite vector', namespace='t')
    assert e['id']
    assert vector_db.count('t') >= 1
    ent = graph_memory.addEntity('NodeA', entityType='thing')
    assert ent['name'] == 'NodeA'
    graph_memory.addRelation('NodeA', 'NodeB', 'links')
    stats = graph_memory.graphStats()
    assert stats['entities'] >= 2
    assert stats['relations'] >= 1
