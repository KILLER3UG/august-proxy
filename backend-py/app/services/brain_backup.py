"""Offline copies of the brain database: verify, back up, and restore safely.

The brain SQLite file is the user's memory. Before this module the only copy
the app ever made was ``<db>.pre-migration`` — one rolling file that nothing
reads back, taken only when a migration was pending. A corrupted or
accidentally-deleted database therefore had no recovery path at all.

Two constraints shape the design:

* **A restore cannot happen while the app is running.** ``memory_store.close()``
  closes only the *thread-local* connection; other threads keep handles on the
  live file, and replacing it underneath them yields half-old, half-new reads
  (and on Windows, a failed rename). So a restore is *staged* and applied at the
  next startup, before any connection exists — and the response says so.
* **The pending marker is a file, not a row.** The situation where a restore is
  needed is precisely the one where the database may not open.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Final

logger = logging.getLogger('brain_backup')

KEEP_BACKUPS: Final = 5
BACKUP_SUBDIR: Final = 'backups'
PENDING_FILE: Final = 'brain-restore.pending'
PRE_RESTORE_SUFFIX: Final = '.pre-restore'
# Reason is model/user input, so the accepted name is a strict shape: a restore
# that could name an arbitrary path would be a file-write primitive wearing a
# settings button. The slug class below must accept every name ``create_backup``
# can write — a copy whose name this rejects still lists as "verified" with
# Restore enabled, and then fails, which is worse than refusing it at write time.
_BACKUP_NAME_RE: Final = re.compile(r'^brain-\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]{0,20}\.sqlite$')
# The same name split into its two parts, so a reader gets WHEN and WHY without
# parsing a filename. `create_backup` is the only writer, and this accepts every
# slug it can produce.
_BACKUP_NAME_PARTS: Final = re.compile(
    r'^brain-(\d{8})T(\d{6})Z-([a-z0-9][a-z0-9-]{0,20})\.sqlite$'
)


def reason_of(name: str) -> str:
    """Why a copy was taken, as the slug ``create_backup`` wrote into its name.

    The filename is the only durable record of the reason, so this is the door
    the settings UI reads through: showing the raw name asked the user to
    decode ``brain-20260924T063947Z-startup.sqlite`` when "Auto-copy at startup,
    Sep 24 6:39 AM" is the same fact in words. '' when the name is not ours.
    """
    match = _BACKUP_NAME_PARTS.match(name or '')
    return match.group(3) if match else ''


def _db_path() -> Path:
    from app.services.memory_conn import db_path

    return db_path()


def backups_dir() -> Path:
    return _db_path().parent / BACKUP_SUBDIR


def _open_read_only(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _check(conn: sqlite3.Connection) -> str:
    """``integrity_check`` result, or an error string — never an exception."""
    try:
        row = conn.execute('PRAGMA integrity_check').fetchone()
        return str(row[0]) if row else 'no result'
    except sqlite3.Error as exc:
        return f'check failed: {exc}'


def _content_reason(conn: sqlite3.Connection) -> str | None:
    """Why this copy cannot hold memory, or None when it provably can.

    ``PRAGMA integrity_check`` is not proof of content: a zero-byte file is a
    well-formed SQLite image (it reports ``ok`` with ``page_count`` 0 and no
    tables), so without this gate an empty copy is written by a failed backup,
    listed as healthy, offered in Settings, and restores as an amnesic
    database. One predicate, shared by create/list/restore so they cannot drift.
    """
    try:
        row = conn.execute('PRAGMA page_count').fetchone()
        pages = int(row[0]) if row and row[0] is not None else 0
    except sqlite3.Error:
        return 'copy is unreadable'
    if pages < 1:
        return 'copy holds no pages'
    try:
        tables = {
            str(t[0])
            for t in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    except sqlite3.Error:
        return 'copy has no readable schema'
    if not tables:
        return 'copy has no tables'
    if 'schema_migrations' not in tables and 'facts' not in tables:
        return 'copy has no brain tables'
    return None


def _applied_version(conn: sqlite3.Connection) -> int:
    try:
        row = conn.execute('SELECT MAX(version) FROM schema_migrations').fetchone()
    except sqlite3.Error:
        return 0
    return int(row[0]) if row and row[0] is not None else 0


def _code_version() -> int:
    """Highest migration this build knows how to apply.

    Read from the migration runner's own discovery so the two can never drift:
    a backup from a NEWER app is refused rather than booted and silently
    reported "up to date".
    """
    from app.lib.migrations import _discover_migrations

    found = _discover_migrations()
    return found[-1][0] if found else 0


def _prune(directory: Path) -> list[str]:
    """Delete all but the newest ``KEEP_BACKUPS`` backups; return removed names."""
    files = sorted(
        (p for p in directory.glob('brain-*.sqlite')),
        key=lambda p: p.name,
        reverse=True,
    )
    removed: list[str] = []
    for stale in files[KEEP_BACKUPS:]:
        try:
            stale.unlink()
            removed.append(stale.name)
        except OSError as exc:
            # A backup we could not delete is worth a log line: silently
            # keeping a full disk is how the next backup fails too.
            logger.warning('Could not prune old backup %s: %s', stale.name, exc)
    return removed


def create_backup(reason: str = 'manual') -> dict[str, object]:
    """Take a verified online copy of the brain DB. Never touches the original.

    Uses SQLite's backup API against a read-only handle, so a WAL-mode database
    is copied consistently without a checkpoint or a write lock on the live
    file. The copy is checked before it is reported as good.
    """
    source = _db_path()
    slug = re.sub(r'[^a-z0-9-]+', '-', str(reason or 'manual').lower()).strip('-')[:20] or 'manual'
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = f'brain-{stamp}-{slug}.sqlite'
    directory = backups_dir()
    if not source.exists():
        return {'ok': False, 'error': f'no brain database at {source}'}
    verified = False
    try:
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / name
        src = _open_read_only(source)
        try:
            dst = sqlite3.connect(str(target))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        check_conn = _open_read_only(target)
        try:
            check = _check(check_conn)
            empty = None if check != 'ok' else _content_reason(check_conn)
        finally:
            check_conn.close()
        if check != 'ok':
            target.unlink(missing_ok=True)
            return {'ok': False, 'error': f'backup failed verification: {check}'}
        if empty is not None:
            # Refusing here also stops the next prune/ensure cycle mistaking a
            # husk for the newest good copy.
            target.unlink(missing_ok=True)
            return {'ok': False, 'error': f'backup failed verification: {empty}'}
        # Past this line the copy is proven good, so the cleanup in the except
        # must leave it alone: `_prune` or the version read failing afterwards
        # is not a reason to delete a backup that verification already passed.
        verified = True
        removed = _prune(directory)
        verify_conn = _open_read_only(target)
        try:
            version = _applied_version(verify_conn)
        finally:
            verify_conn.close()
        return {
            'ok': True,
            'name': name,
            'bytes': target.stat().st_size,
            'appliedVersion': version,
            'pruned': removed,
        }
    except (sqlite3.Error, OSError) as exc:
        logger.warning('Brain backup failed: %s', exc)
        # ``sqlite3.connect`` creates the file before anything is written to it,
        # so a failure here leaves a zero-byte husk that integrity_check calls
        # "ok". Only an unverified copy is removed — never a good backup.
        if not verified:
            try:
                (directory / name).unlink(missing_ok=True)
            except OSError as cleanup_exc:
                logger.warning('Could not remove unfinished backup %s: %s', name, cleanup_exc)
        return {'ok': False, 'error': str(exc)}


def list_backups() -> list[dict[str, object]]:
    """Newest first, each labelled with its own health — a stale or corrupt
    backup is not a way out."""
    directory = backups_dir()
    if not directory.is_dir():
        return []
    out: list[dict[str, object]] = []
    for path in sorted(directory.glob('brain-*.sqlite'), key=lambda p: p.name, reverse=True):
        entry: dict[str, object] = {
            'name': path.name,
            'reason': reason_of(path.name),
            'bytes': path.stat().st_size,
            'createdAt': datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(),
            'healthy': False,
            'appliedVersion': 0,
            'fromTheFuture': False,
        }
        try:
            conn = _open_read_only(path)
            try:
                check = _check(conn)
                empty = None if check != 'ok' else _content_reason(conn)
                entry['healthy'] = check == 'ok' and empty is None
                if check != 'ok':
                    entry['error'] = check
                elif empty is not None:
                    entry['error'] = empty
                version = _applied_version(conn)
                entry['appliedVersion'] = version
                entry['fromTheFuture'] = version > _code_version()
            finally:
                conn.close()
        except sqlite3.Error as exc:
            entry['error'] = str(exc)
        out.append(entry)
    return out


def _validate_restore_target(name: str) -> tuple[Path | None, str | None]:
    """Return (path, error). Rejects anything that is not a well-named backup in
    the backups directory, and any copy that is unhealthy or newer than this
    build."""
    if not _BACKUP_NAME_RE.match(name or ''):
        return None, 'not a valid backup name'
    path = backups_dir() / name
    if not path.is_file():
        return None, f'no backup named {name}'
    try:
        conn = _open_read_only(path)
    except sqlite3.Error as exc:
        return None, f'cannot open backup: {exc}'
    try:
        check = _check(conn)
        if check != 'ok':
            return None, f'backup is not healthy: {check}'
        empty = _content_reason(conn)
        if empty is not None:
            return None, f'backup is not healthy: {empty}'
        version = _applied_version(conn)
        limit = _code_version()
        if version > limit:
            return None, (
                f'backup is at schema {version:03d}, this build knows up to {limit:03d}; '
                'restore it with the app version that made it'
            )
    finally:
        conn.close()
    return path, None


def schedule_restore(name: str) -> dict[str, object]:
    """Stage a verified restore for the next launch."""
    path, error = _validate_restore_target(name)
    if error or path is None:
        return {'ok': False, 'error': error or 'invalid backup'}
    pending = backups_dir() / PENDING_FILE
    try:
        pending.write_text(path.name, encoding='utf-8')
    except OSError as exc:
        return {'ok': False, 'error': str(exc)}
    return {
        'ok': True,
        'name': path.name,
        'appliesOn': 'next-launch',
        'note': 'The running app holds the database open, so the swap happens at '
        'startup. Restart August to apply it; until then this can be cancelled.',
    }


def cancel_restore() -> dict[str, object]:
    pending = backups_dir() / PENDING_FILE
    if not pending.exists():
        return {'ok': True, 'cancelled': False}
    try:
        pending.unlink()
    except OSError as exc:
        return {'ok': False, 'error': str(exc)}
    return {'ok': True, 'cancelled': True}


def pending_restore() -> str | None:
    pending = backups_dir() / PENDING_FILE
    try:
        text = pending.read_text(encoding='utf-8').strip()
    except OSError:
        return None
    return text if _BACKUP_NAME_RE.match(text) else None


def apply_pending_restore() -> dict[str, object]:
    """Swap a staged backup into place. Call before any brain connection exists.

    Keeps one ``.pre-restore`` copy of the database it replaced, so a restore
    that turns out to be the wrong backup is itself undoable. Any failure *up
    to the swap* leaves the marker in place and the current database untouched
    — a failed restore must never cost the memory that still exists. Once the
    swap has landed the restore is reported as applied whatever cleanup does,
    because re-running it on the next boot would copy the restored database
    over ``.pre-restore`` and destroy the only copy of what was replaced.
    """
    name = pending_restore()
    if not name:
        return {'ok': True, 'applied': False}
    source = _db_path()
    target, error = _validate_restore_target(name)
    if error or target is None:
        logger.error('Staged brain restore "%s" refused: %s — keeping the current database', name, error)
        return {'ok': False, 'applied': False, 'error': error}
    staging = source.with_name(f'{source.name}.restoring')
    try:
        if source.exists():
            # Keep the pre-restore database *with* its WAL. Uncheckpointed
            # commits live only in -wal, so a main-only .pre-restore cannot put
            # that memory back — and the sidecars used to be deleted here,
            # before the new main file had even landed.
            shutil.copy2(source, f'{source}{PRE_RESTORE_SUFFIX}')
            for suffix in ('-wal', '-shm'):
                side = Path(f'{source}{suffix}')
                if side.exists():
                    shutil.copy2(side, f'{source}{PRE_RESTORE_SUFFIX}{suffix}')
        # Copy beside the live file and publish it with os.replace. A failure
        # part-way through then leaves the current database untouched, where
        # writing it in place could truncate the only copy of the user's memory.
        shutil.copy2(target, staging)
        os.replace(staging, source)
    except OSError as exc:
        logger.error('Brain restore failed for %s: %s', name, exc)
        try:
            staging.unlink(missing_ok=True)
        except OSError as cleanup_exc:
            logger.warning('Could not remove staging file for %s: %s', name, cleanup_exc)
        return {'ok': False, 'applied': False, 'error': str(exc)}

    # The swap has landed — from here every step is cleanup, and none of it may
    # turn the result back into a failure (see the docstring).
    warnings: list[str] = []
    try:
        (backups_dir() / PENDING_FILE).unlink(missing_ok=True)
    except OSError as cleanup_exc:
        # The staged restore is already in place; a marker that survives means
        # the next boot repeats a restore that already happened.
        logger.warning('Brain restore applied but marker for %s could not be cleared: %s', name, cleanup_exc)
        warnings.append(f'marker not cleared: {cleanup_exc}')
    for suffix in ('-wal', '-shm'):
        # A swapped-in main must not be replayed against the *previous*
        # database's WAL, so the old sidecars go only now that it landed.
        try:
            Path(f'{source}{suffix}').unlink(missing_ok=True)
        except OSError as cleanup_exc:
            logger.error(
                'Brain restore applied but stale %s%s survived: %s — remove it '
                'before the next open or the restored database can be corrupted',
                source.name, suffix, cleanup_exc,
            )
            warnings.append(f'stale {suffix} not removed: {cleanup_exc}')
    logger.info('Brain database restored from %s (previous copy at %s%s)', name, source.name, PRE_RESTORE_SUFFIX)
    result: dict[str, object] = {'ok': True, 'applied': True, 'name': name}
    if warnings:
        result['warning'] = '; '.join(warnings)
    return result


def ensure_current_backup(max_age_hours: float = 12.0, reason: str = 'startup') -> dict[str, object]:
    """Take a backup only when the newest one has gone stale.

    Called once at startup, after migrations, so an upgrade always leaves a
    verified copy behind. Deliberately not wired into the migration snapshot
    itself: that runs inside an open write transaction, and SQLite's backup API
    needs a read lock — the same collision that made the old snapshot hang a
    boot on a busy database.
    """
    existing = list_backups()
    if existing:
        newest = str(existing[0].get('createdAt') or '')
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(newest)).total_seconds()
            if age < max_age_hours * 3600:
                return {'ok': True, 'skipped': True, 'ageSeconds': int(age)}
        except ValueError:
            pass  # unparseable stamp — treat as stale and back up
    return create_backup(reason=reason)


def quick_check() -> dict[str, object]:
    """Health of the live database, for the settings/health surface."""
    source = _db_path()
    if not source.exists():
        return {'ok': True, 'exists': False, 'detail': 'no database yet'}
    try:
        conn = _open_read_only(source)
        try:
            detail = _check(conn)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        detail = f'cannot open: {exc}'
    backups = list_backups()
    return {
        'ok': detail == 'ok',
        'exists': True,
        'detail': detail,
        'path': str(source),
        'backups': len([b for b in backups if b.get('healthy')]),
        'pendingRestore': pending_restore(),
    }
