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


def test_every_backup_the_writer_accepts_the_restorer_can_use(isolatedData):
    """`create_backup` sanitizes the reason and `_BACKUP_NAME_RE` re-validates it
    on the restore side — two independent expressions of one shape.

    When they disagreed a digit-leading reason (`3d-print`, `2026-export`) wrote a
    copy that `list_backups` reported healthy, so the settings UI offered
    Restore, and the server then answered "not a valid backup name". A user
    finds that out only while trying to recover their memory, so the round trip
    is asserted for every slug shape rather than trusting either regex alone.
    """
    for reason in ('manual', '1', '3d-print', '2026-export'):
        created = brain_backup.create_backup(reason=reason)
        assert created['ok'] is True, reason
        name = str(created['name'])

        listed = [b for b in brain_backup.list_backups() if b['name'] == name]
        assert listed and listed[0]['healthy'] is True, name
        assert brain_backup.schedule_restore(name)['ok'] is True, name

    assert brain_backup.pending_restore() is not None


def test_the_legacy_recovery_hint_names_a_filename_the_restorer_accepts(isolatedData):
    """``memory_conn``'s two-roots warning is the only place that tells a user
    what to call a recovered legacy database, and it names the file inline.

    That sentence and ``_BACKUP_NAME_RE`` are written in different files, so a
    reword can produce an example the restore door rejects — the user then
    follows the documented recovery path precisely and it fails, which is the
    same shape of bug as the digit-slug one above. The template is spelled with
    letters, so only the concrete examples are checked against the gate.
    """
    import inspect
    import re

    from app.services import memory_conn

    examples = re.findall(r'brain-[0-9A-Za-z<>-]+\.sqlite', inspect.getsource(memory_conn))
    assert examples, 'the two-roots hint no longer names a filename to copy to'
    concrete = [e for e in examples if any(c.isdigit() for c in e)]
    assert concrete, examples
    for name in concrete:
        assert brain_backup._BACKUP_NAME_RE.match(name), (
            f'memory_conn tells the user to write {name!r}, which the restore gate '
            'rejects — reword the hint or widen _BACKUP_NAME_RE, never neither'
        )

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


# ── Regressions: an empty copy is not a backup ─────────────────────────────
# `PRAGMA integrity_check` answers 'ok' for a zero-byte file (page_count 0, no
# tables), so verification alone could certify a husk that then restored as an
# amnesic database. These pin the content gate that closes that.

def _seedBrainCopy(path: Path, *, facts: int = 1) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        conn.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
        conn.execute('INSERT OR REPLACE INTO schema_migrations VALUES (46)')
        conn.execute('CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, body TEXT)')
        conn.executemany(
            'INSERT OR REPLACE INTO facts VALUES (?, ?)',
            [(f'fact:{i}', f'body {i}') for i in range(facts)],
        )
        conn.commit()
    finally:
        conn.close()
    return path


def _emptyBackupCopy(name: str) -> Path:
    directory = brain_backup.backups_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(b'')
    return path


def test_zero_byte_copy_is_listed_unhealthy(isolatedData):
    copy = _emptyBackupCopy('brain-20260101T000000Z-empty.sqlite')

    entry = next(e for e in brain_backup.list_backups() if e['name'] == copy.name)
    assert entry['healthy'] is False, 'an empty file must not be offered as a way out'
    assert entry.get('error')


def test_zero_byte_copy_cannot_be_staged_for_restore(isolatedData):
    copy = _emptyBackupCopy('brain-20260101T000001Z-empty.sqlite')

    staged = brain_backup.schedule_restore(copy.name)

    assert staged['ok'] is False, staged
    assert not (brain_backup.backups_dir() / brain_backup.PENDING_FILE).exists()


def test_copy_without_brain_tables_is_refused(isolatedData):
    """Well-formed SQLite, but not a brain database."""
    path = brain_backup.backups_dir() / 'brain-20260101T000002Z-other.sqlite'
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute('CREATE TABLE unrelated (id INTEGER)')
    conn.execute('INSERT INTO unrelated VALUES (1)')
    conn.commit()
    conn.close()

    assert brain_backup.schedule_restore(path.name)['ok'] is False


def test_a_real_backup_still_passes_the_content_gate(isolatedData):
    """Guards against "fixing" the hole by refusing everything."""
    _save('fact:keep', 'Must survive the gate')
    result = brain_backup.create_backup(reason='content-gate')

    assert result['ok'] is True, result
    entry = next(e for e in brain_backup.list_backups() if e['name'] == result['name'])
    assert entry['healthy'] is True, entry
    assert brain_backup.schedule_restore(result['name'])['ok'] is True


# ── Regressions: a restore must not cost the memory it replaces ────────────

def test_restore_keeps_the_wal_of_the_database_it_replaced(isolatedData):
    """Uncheckpointed commits live only in -wal; a main-only .pre-restore
    cannot put them back, and the sidecars used to be deleted before the new
    main file had even landed."""
    _save('fact:live1', 'Memory that must not be lost to a restore')
    _save('fact:live2', 'Second live memory')
    live = brain_backup._db_path()
    assert live.is_file()
    wal = live.with_name(live.name + '-wal')
    wal.write_bytes(b'uncheckpointed memory' * 64)
    walBytes = wal.stat().st_size

    backup = _seedBrainCopy(
        brain_backup.backups_dir() / 'brain-20260101T000003Z-good.sqlite', facts=1,
    )
    assert brain_backup.schedule_restore(backup.name)['ok'] is True

    # The swap publishes with os.replace, which Windows refuses over an open
    # handle — matching the module's own rule that a restore is applied at
    # startup before any brain connection exists.
    memory_store.close()

    applied = brain_backup.apply_pending_restore()

    assert applied['applied'] is True, applied
    preserved = Path(f'{live}{brain_backup.PRE_RESTORE_SUFFIX}-wal')
    assert preserved.is_file(), '.pre-restore must keep the WAL it replaced'
    assert preserved.stat().st_size == walBytes
    assert not wal.exists(), 'the swapped-in main must not be replayed on the old WAL'
    assert _fact_count(live) == 1


def test_failed_swap_leaves_the_live_database_untouched(isolatedData, monkeypatch):
    _save('fact:keepme', 'Must survive a restore that fails mid-copy')
    live = brain_backup._db_path()
    assert live.is_file()
    before = _fact_count(live)
    backup = _seedBrainCopy(
        brain_backup.backups_dir() / 'brain-20260101T000004Z-good.sqlite', facts=1,
    )
    assert brain_backup.schedule_restore(backup.name)['ok'] is True

    def explode(src, dst, *a, **kw):
        if str(dst).endswith('.restoring'):
            raise OSError('disk vanished mid-copy')
        return dst

    monkeypatch.setattr(brain_backup.shutil, 'copy2', explode)

    applied = brain_backup.apply_pending_restore()

    assert applied['applied'] is False, applied
    assert _fact_count(live) == before, 'a failed restore must not truncate the memory'
    assert (brain_backup.backups_dir() / brain_backup.PENDING_FILE).exists(), \
        'the marker stays so the retry is still possible'
    assert not live.with_name(live.name + '.restoring').exists(), 'staging file cleaned up'


def test_a_late_failure_never_deletes_a_verified_copy(isolatedData, monkeypatch):
    """`verified` flips the moment the content gate passes.

    `_prune` and the version read run after that gate; if either raises, the
    cleanup must leave a copy verification already called good on disk rather
    than delete it as if it were a husk.
    """
    _save('fact:survive', 'A verified backup must not be deleted by a later failure')

    def refusePrune(directory: Path) -> list[str]:
        raise OSError('disk full while pruning')

    monkeypatch.setattr(brain_backup, '_prune', refusePrune)
    result = brain_backup.create_backup(reason='prune-fail')

    assert result['ok'] is False, result
    healthy = [entry for entry in brain_backup.list_backups() if entry['healthy']]
    assert healthy, 'the copy passed the content gate, so a later failure must not remove it'


def test_a_swap_that_landed_is_never_reported_as_failed(isolatedData, monkeypatch):
    """After os.replace the restore IS applied — cleanup cannot undo that.

    Reporting `applied: False` with the marker still in place would re-run the
    whole restore on the next boot and copy the *restored* database over
    `.pre-restore`, destroying the only copy of what was replaced.
    """
    _save('fact:landed', 'The restored database is already in place')
    live = brain_backup._db_path()
    # A live sidecar exists so the post-swap cleanup has something to fail on.
    live.with_name(live.name + '-wal').write_bytes(b'uncheckpointed' * 32)
    backup = _seedBrainCopy(
        brain_backup.backups_dir() / 'brain-20260101T000005Z-good.sqlite', facts=1,
    )
    assert brain_backup.schedule_restore(backup.name)['ok'] is True
    memory_store.close()

    realUnlink = Path.unlink

    def lockedSidecar(self: Path, missing_ok: bool = False):
        if self.name.endswith('-wal') and not self.name.startswith(live.name + '.pre-restore'):
            raise OSError('sidecar handle still open')
        return realUnlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, 'unlink', lockedSidecar)
    applied = brain_backup.apply_pending_restore()

    assert applied['applied'] is True, applied
    assert applied['ok'] is True, applied
    assert 'warning' in applied and '-wal' in str(applied['warning']), applied
    assert not (brain_backup.backups_dir() / brain_backup.PENDING_FILE).exists(), \
        'the marker is cleared so the next boot cannot re-run a restore that landed'
    assert live.is_file(), 'the restored database is in place'
