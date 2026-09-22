"""Brain-DB backup / verify / restore — the recovery path that did not exist.

These tests exist because the code under test operates on the user's memory
files: a bug here is not a red test, it is lost data. Every assertion is
written so a silent no-op cannot pass.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from app.services import brain_backup, memory_store
from fastapi.testclient import TestClient


def _fact_count(db: Path) -> int:
    conn = sqlite3.connect(str(db))
    try:
        return int(conn.execute('SELECT COUNT(*) FROM facts').fetchone()[0])
    finally:
        conn.close()


def _save(key: str, body: str) -> None:
    memory_store.save_fact(key, body, title=key)


def test_backup_is_a_real_copy_not_an_empty_file(isolatedData):
    _save('fact:a', 'First memory')
    _save('fact:b', 'Second memory')

    result = brain_backup.create_backup(reason='test')

    assert result['ok'] is True, result
    copy = brain_backup.backups_dir() / str(result['name'])
    assert copy.is_file()
    assert result['bytes'] > 0
    assert _fact_count(copy) == 2


def test_pruning_keeps_the_newest_and_drops_the_oldest(isolatedData):
    directory = brain_backup.backups_dir()
    directory.mkdir(parents=True, exist_ok=True)
    for i in range(brain_backup.KEEP_BACKUPS + 2):
        (directory / f'brain-2026010{i}T000000Z-old.sqlite').write_bytes(b'x' * 512)

    assert brain_backup.create_backup()['ok'] is True

    left = sorted(p.name for p in directory.glob('brain-*.sqlite'))
    assert len(left) == brain_backup.KEEP_BACKUPS
    assert 'brain-20260100T000000Z-old.sqlite' not in left


def test_restore_refuses_a_name_that_is_not_a_backup(isolatedData):
    for bogus in ('../../windows/win.ini', 'notes.txt', '', 'brain-2026-sqlite.sqlite'):
        result = brain_backup.schedule_restore(bogus)
        assert result['ok'] is False, bogus
    assert brain_backup.pending_restore() is None


def test_restore_refuses_an_unhealthy_copy(isolatedData):
    brain_backup.create_backup()
    target = sorted(brain_backup.backups_dir().glob('brain-*.sqlite'))[-1]
    target.write_bytes(b'not a database at all' * 40)

    result = brain_backup.schedule_restore(target.name)

    assert result['ok'] is False and 'healthy' in str(result.get('error'))
    assert brain_backup.pending_restore() is None


def test_staged_restore_replaces_the_database_at_boot_and_keeps_the_old_one(
    isolatedData,
):
    _save('fact:old', 'The memory worth keeping')
    backup = brain_backup.create_backup()
    assert backup['ok'] is True

    # Something goes wrong after the backup — the database now holds a row the
    # user does not want, and the restore must be able to undo it.
    _save('fact:bad', 'Corrupted write')
    assert _fact_count(brain_backup._db_path()) == 2

    staged = brain_backup.schedule_restore(str(backup['name']))
    assert staged['ok'] is True and staged['appliesOn'] == 'next-launch'
    assert brain_backup.pending_restore() == backup['name']

    memory_store.close()
    applied = brain_backup.apply_pending_restore()
    assert applied['ok'] is True and applied['applied'] is True

    memory_store.init()
    assert _fact_count(brain_backup._db_path()) == 1
    assert memory_store.get_fact('fact:old') is not None
    assert memory_store.get_fact('fact:bad') is None
    assert Path(f'{brain_backup._db_path()}{brain_backup.PRE_RESTORE_SUFFIX}').is_file()
    assert brain_backup.pending_restore() is None


def test_a_failing_restore_leaves_the_database_and_the_marker_alone(isolatedData):
    _save('fact:keep', 'Still here')
    backup = brain_backup.create_backup()
    brain_backup.schedule_restore(str(backup['name']))
    (brain_backup.backups_dir() / str(backup['name'])).unlink()

    applied = brain_backup.apply_pending_restore()

    assert applied['ok'] is False and applied['applied'] is False
    assert _fact_count(brain_backup._db_path()) == 1
    # The marker survives so the next launch retries once the file is back.
    assert brain_backup.pending_restore() == backup['name']


def test_cancel_drops_the_staged_restore(isolatedData):
    backup = brain_backup.create_backup()
    brain_backup.schedule_restore(str(backup['name']))

    assert brain_backup.cancel_restore()['cancelled'] is True
    assert brain_backup.pending_restore() is None


def test_quick_check_reports_the_live_database(isolatedData):
    _save('fact:ok', 'Healthy row')
    report = brain_backup.quick_check()
    assert report['ok'] is True and report['detail'] == 'ok'
    assert report['backups'] == 0


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def test_backup_routes_round_trip(isolatedData):
    client = _client()
    _save('fact:route', 'Routed memory')

    created = client.post('/api/brain/backups', json={'reason': 'before-upgrade'})
    assert created.status_code == 200, created.text
    name = created.json()['name']
    assert name.startswith('brain-') and created.json()['appliedVersion'] >= 1

    listed = client.get('/api/brain/backups')
    assert listed.status_code == 200
    assert [b['name'] for b in listed.json()['backups']] == [name]
    assert listed.json()['backups'][0]['healthy'] is True

    assert client.get('/api/brain/integrity').json()['ok'] is True

    staged = client.post('/api/brain/backups/restore', json={'name': name})
    assert staged.status_code == 200 and staged.json()['appliesOn'] == 'next-launch'
    assert client.post('/api/brain/backups/restore', json={'name': 'evil/../../x'}).status_code == 400
    assert client.delete('/api/brain/backups/restore').json()['cancelled'] is True


def test_a_restore_from_a_newer_schema_is_refused(isolatedData):
    """Booting a newer database in an older build used to read as "up to date"
    while the columns that build never learned about stay invisible."""
    backup = brain_backup.create_backup()
    target = brain_backup.backups_dir() / str(backup['name'])
    conn = sqlite3.connect(str(target))
    conn.execute("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (999, 'future')")
    conn.commit()
    conn.close()

    result = brain_backup.schedule_restore(str(backup['name']))

    assert result['ok'] is False and 'this build' in str(result.get('error'))
    assert brain_backup.pending_restore() is None
