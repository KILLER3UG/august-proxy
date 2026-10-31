"""Brain SQLite connection helpers (shared by memory_store domains).

Owns thread-local connections, PRAGMA defaults, and path resolution so
CRUD modules stay free of connection boilerplate.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

from app.lib.paths import dataPath

logger = logging.getLogger('august.memory_conn')

_BRAIN_FILE_ENV = 'HARNESS_BRAIN_SQLITE_FILE'
_DEFAULT_BRAIN_FILE = 'august_brain.sqlite'
_TIMEOUT_MS = 10000
# Bounded wait for a concurrent first open of the same database file:
# _WAL_RETRY_ATTEMPTS * _WAL_RETRY_S ≈ 1s.
_WAL_RETRY_ATTEMPTS = 20
_WAL_RETRY_S = 0.05
# Durability must not depend on a graceful exit. The packaged desktop quit is
# `taskkill /T /F`, so main.py's lifespan shutdown tail never runs and whatever
# is still only in the `-wal` sidecar is what survives a power cut. A PASSIVE
# checkpoint folds the WAL back into the database file so the loss window is
# bounded rather than "everything since the last clean close". PASSIVE never
# blocks or waits on a reader, so it is safe to interleave with normal traffic;
# it is best-effort and failures are ignored, because a checkpoint optimises
# durability rather than constituting a write.
#
# SCOPE — read this before relying on it. Every write to the brain database
# routes through :func:`commit`: the deferred lane via
# `deferred_writes._commit`, and every direct writer (memory_store/*, the
# routers, harness services, the episode miner, workstreams, refine/turn-outcome
# ledgers, daemon + bot stores) via `commit as brain_commit`.
# ``tests/test_brain_commit_routing.py`` DISCOVERS those writers rather than
# listing them, so a new one is caught the day it is written; only
# `memory_schema.py` (owns the base schema and runs before the runner) and
# `deferred_writes.py` (is the deferred funnel) are exempt, and the test
# asserts both exemptions still exist with a reason.
#
# A database OTHER than the brain is outside this guarantee by construction —
# it has its own WAL, its own checkpoint schedule, and its own risk.
_CHECKPOINT_EVERY_N_WRITES = 50
# A checkpoint owed but not yet run because the thread that crossed the
# threshold held no brain connection. Drained on the next commit that has one.
_pending_checkpoint = False
_PENDING_CHECKPOINT_LOCK = threading.Lock()
_writes_since_checkpoint = 0
_CHECKPOINT_LOCK = threading.Lock()
_local = threading.local()
_dual_root_warned = False


def db_path() -> Path:
    """Resolve the brain SQLite database path."""
    env_path = os.environ.get(_BRAIN_FILE_ENV)
    if env_path:
        return Path(env_path)
    return dataPath(_DEFAULT_BRAIN_FILE)


def apply_conn_pragmas(conn: sqlite3.Connection) -> None:
    """WAL + busy_timeout always; cache/mmap/sync only when env opts in.

    **Default durability (no env):**
      * ``journal_mode=WAL`` — concurrent readers + single writer
      * ``busy_timeout=10000`` — wait instead of immediate SQLITE_BUSY
      * ``foreign_keys=ON``
      * ``synchronous`` left at SQLite default (**FULL**) — last committed
        transaction survives power loss; do **not** set NORMAL without an
        explicit measure + accept-loss decision

    **Opt-in only (not measured as default wins):**
      * ``HARNESS_SQLITE_SYNC=NORMAL|FULL|OFF`` — NORMAL under WAL can lose the
        last uncheckpointed transaction on hard power loss; OFF is unsafe
      * ``HARNESS_SQLITE_CACHE_KB`` — page cache KiB (negative PRAGMA cache_size)
      * ``HARNESS_SQLITE_MMAP_MB`` — mmap size MiB (0 / unset = do not set)
    """
    # Retry the WAL conversion, and only the WAL conversion. SQLite does NOT
    # invoke the busy handler when a connection has to take the write lock to
    # change journal mode — waiting there could deadlock the two connections
    # against each other — so this statement fails with SQLITE_BUSY on a
    # brand-new database opened by two threads at once even though `timeout=`
    # was passed to connect(). Everything below it does get the busy handler,
    # which is why the pragma after it never flakes.
    #
    # Measured on this machine: 5 failures / 72 concurrent inits of a fresh
    # file, 0 / 72 once WAL is already set. The condition is another thread
    # finishing its own open, so it is transient by construction and retrying
    # is the documented remedy rather than a mask.
    for attempt in range(_WAL_RETRY_ATTEMPTS):
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            break
        except sqlite3.OperationalError as exc:
            if 'locked' not in str(exc).lower() or attempt == _WAL_RETRY_ATTEMPTS - 1:
                raise
            time.sleep(_WAL_RETRY_S)
    conn.execute('PRAGMA busy_timeout=10000')
    conn.execute('PRAGMA foreign_keys=ON')
    # Durability: only change synchronous when explicitly requested.
    sync_env = (os.environ.get('HARNESS_SQLITE_SYNC') or '').strip().upper()
    if sync_env in ('NORMAL', 'FULL', 'OFF'):
        conn.execute(f'PRAGMA synchronous={sync_env}')
    cache_raw = (os.environ.get('HARNESS_SQLITE_CACHE_KB') or '').strip()
    if cache_raw:
        try:
            cache_kb = int(cache_raw)
        except ValueError:
            cache_kb = 0
        if cache_kb != 0:
            conn.execute(f'PRAGMA cache_size={-abs(cache_kb)}')
    mmap_raw = (os.environ.get('HARNESS_SQLITE_MMAP_MB') or '').strip()
    if mmap_raw:
        try:
            mmap_mb = int(mmap_raw)
        except ValueError:
            mmap_mb = 0
        if mmap_mb > 0:
            conn.execute(f'PRAGMA mmap_size={mmap_mb * 1024 * 1024}')


def _warn_dual_data_roots(path: Path) -> None:
    """Phase D hygiene: warn ONCE when a second brain DB exists.

    The dev checkout's ``backend-py/data/august_brain.sqlite`` (the 0.16-era
    default before the AppData move) still holds pre-migration data. When
    the active DB is elsewhere and the stale file exists, log a warning —
    never auto-delete, never migrate silently: the user may have unmerged
    memories there.
    """
    global _dual_root_warned
    if _dual_root_warned:
        return
    _dual_root_warned = True
    try:
        repoStale = (
            Path(__file__).resolve().parent.parent.parent / 'data' / 'august_brain.sqlite'
        )
        if repoStale.resolve() != path.resolve() and repoStale.exists():
            logger.warning(
                'Two brain data roots exist: active=%s and legacy=%s '
                '(%d bytes, %s). The legacy file is ignored — to recover it, '
                'copy it into the brain backups folder named exactly '
                'brain-YYYYMMDDTHHMMSSZ-legacy.sqlite (stamp with no dashes, e.g. '
                'brain-20260922T090000Z-legacy.sqlite; the restore door rejects '
                'any other name) and use Settings → Memory → Restore. The current '
                'database is kept as a .pre-restore copy.',
                path,
                repoStale,
                repoStale.stat().st_size,
                time.strftime('%Y-%m-%d', time.localtime(repoStale.stat().st_mtime)),
            )
    except Exception:
        pass


# Every live thread-local connection, by thread. `threading.local()` makes a
# connection invisible to every other thread BY DESIGN, which is right for
# normal use and exactly wrong for diagnosing a cross-connection race: the
# recurring `vtable constructor failed: memory_store_fts` CI failure is one
# connection's DDL colliding with another's, and there was no way to see the
# other one. This is the registry that makes it visible.
#
# Registration is on the create path and removal is on close, both under a
# lock, and it stores a reference to the connection rather than a copy — a
# census that reported a stale path would be worse than none.
_LIVE: dict[int, dict[str, object]] = {}
_LIVE_LOCK = threading.Lock()


def connection_debug_snapshot() -> list[dict[str, object]]:
    """Every thread currently holding a brain connection.

    For diagnostics only. Cheap enough to call on an error path and never
    called on the happy path, so it costs a normal request nothing.
    """
    with _LIVE_LOCK:
        return [dict(v) for v in _LIVE.values()]


def _register_live(c: sqlite3.Connection, path: Path) -> None:
    with _LIVE_LOCK:
        _LIVE[threading.get_ident()] = {
            'thread': threading.current_thread().name,
            'path': str(path),
            'in_transaction': bool(getattr(c, 'in_transaction', False)),
        }


def commit(c: sqlite3.Connection) -> None:
    """Commit a brain connection AND count the write toward the WAL checkpoint.

    Every brain write should go through here rather than calling
    ``c.commit()`` directly. The reason is durability, not style: the packaged
    desktop quit is ``taskkill /T /F``, so main.py's lifespan flushes never run
    and whatever is still only in the ``-wal`` sidecar is what survives a power
    cut. :func:`note_commit` folds the WAL back into the database file every
    ``_CHECKPOINT_EVERY_N_WRITES`` writes — but only for commits that pass
    through here. Before this helper existed, only the deferred lane did, so
    facts/messages/episodes/consolidation writes were outside the guarantee
    while the docstring claimed otherwise.

    A conformance test (``tests/test_brain_commit_routing.py``,
    ``test_the_brain_writer_set_is_discovered_not_hardcoded``) fails
    when a direct ``.commit()`` reappears on a brain connection, because the
    guarantee is only as good as its completeness.

    Commits also honour :func:`poison`: a unit a writer could not undo is undone
    here, BEFORE this commit, or it lands as part of whatever unrelated write
    happens to come next.
    """
    undo_poison(c)
    try:
        c.commit()
    finally:
        note_commit()
        drainPendingCheckpoint(c)


def poison(repairs: 'list[tuple[str, tuple]]') -> None:
    """Queue the compensating writes that undo a unit this thread could not roll back.

    A writer takes a SAVEPOINT so its undo cannot reach a stranger's uncommitted
    work. When both the commit and that rollback raise, the unit is still pending
    on the thread-local handle, and SQLite cannot leave a transaction open while
    excluding one savepoint from the next COMMIT — so the write that follows it on
    this thread publishes a decision nobody applied. Recording the unit's own row
    writes here moves the undo to the one place that runs before every durable
    write: :func:`commit`.

    Repairs are row-scoped UPDATEs, not a rollback, and that is the whole point.
    A `ROLLBACK TO <sp>` discards EVERYTHING written after the savepoint, which
    includes whatever this thread staged in the meantime — measured: poison, an
    unrelated `save_fact`, one commit, and the user's fact vanished while `commit`
    returned success. An idempotent UPDATE on the unit's own rows cannot do that.

    The list APPENDS. A second poison while one is pending must not replace it,
    or the first unit's spent claim lands — the state this exists to prevent.
    """
    pending = getattr(_local, 'poison_repairs', None) or []
    _local.poison_repairs = [*pending, *repairs]


def pending_poison_count() -> int:
    """How many repairs are waiting on this thread. For tests and diagnostics."""
    return len(getattr(_local, 'poison_repairs', None) or [])


def undo_poison(c: sqlite3.Connection) -> None:
    """Apply the pending repairs before this commit is allowed to land anything.

    Raises when a repair cannot be written: the alternative is committing a
    half-applied decision, and a write that fails loudly is recoverable while a
    memory retired under a proposal that reported failure is not. The queue stays
    marked either way, so the next commit tries again rather than publishing.
    """
    repairs = getattr(_local, 'poison_repairs', None)
    if not repairs:
        return
    try:
        for sql, params in repairs:
            c.execute(sql, params)
    except Exception:
        logger.error('pending memory repair could not be applied; refusing the commit', exc_info=True)
        raise RuntimeError(
            'refused to commit: an un-undoable write unit is pending on this connection'
        ) from None
    _local.poison_repairs = None


def note_commit() -> None:
    """Call after a committed write on a brain connection; folds the WAL back
    into the database file every ``_CHECKPOINT_EVERY_N_WRITES`` writes.

    The counter is GLOBAL, not per-thread. It was keyed by ``thread_ident``,
    which meant the threshold was "per thread": four worker threads (the
    consolidation loop, the episode miner, harness jobs, the deferred lane) each
    writing 49 times produced 196 writes and ZERO checkpoints — precisely the
    shape this backend runs. One counter under the lock is what the guarantee
    describes.

    Best-effort by construction: a checkpoint that fails loses nothing that the
    next one would not recover, so it must never raise into the write path.
    """
    global _writes_since_checkpoint
    with _CHECKPOINT_LOCK:
        _writes_since_checkpoint += 1
        if _writes_since_checkpoint < _CHECKPOINT_EVERY_N_WRITES:
            return
        _writes_since_checkpoint = 0
    c = getattr(_local, 'conn', None)
    if c is not None:
        _checkpoint_one(c)
        return
    # The thread that crossed the threshold may hold no brain connection of its
    # own (a worker that writes only through someone else's). Rather than
    # spend the checkpoint on nothing — which let a non-writing thread burn the
    # threshold and skip the write that should have triggered one — checkpoint
    # on the NEXT connection to be handed to us. A missed checkpoint costs one
    # write of WAL growth; a lost one costs the guarantee.
    with _PENDING_CHECKPOINT_LOCK:
        global _pending_checkpoint
        _pending_checkpoint = True


def _checkpoint_one(c: sqlite3.Connection) -> None:
    """Fold one connection's WAL into the database file. Never raises."""
    try:
        c.execute('PRAGMA wal_checkpoint(PASSIVE)')
    except Exception:  # noqa: BLE001 -- best-effort, must not reach the write path
        pass


def drainPendingCheckpoint(c: sqlite3.Connection) -> None:
    """Run a checkpoint deferred by :func:`note_commit`, if one is owed."""
    global _pending_checkpoint
    with _PENDING_CHECKPOINT_LOCK:
        if not _pending_checkpoint:
            return
        _pending_checkpoint = False
    _checkpoint_one(c)


def conn() -> sqlite3.Connection:
    """Get a thread-local connection to the brain database."""
    if not hasattr(_local, 'conn') or _local.conn is None:
        path = db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _warn_dual_data_roots(path)
        c = sqlite3.connect(str(path), timeout=_TIMEOUT_MS / 1000)
        c.row_factory = sqlite3.Row
        apply_conn_pragmas(c)
        _local.conn = c
        _register_live(c, path)
    return _local.conn


def checkpoint_wal(*, truncate: bool = True) -> dict[str, object]:
    """Fold the write-ahead log back into the database (TRUNCATE by default).

    A WAL larger than its database means no checkpoint has completed — usually
    because a reader is holding an old snapshot, which makes every checkpoint
    return BUSY. Until one succeeds, every write appends: the file grows without
    bound and a crash forces replay of the whole log. Measured on this install
    on 2026-10-17: a 158 MB WAL for a 154 MB database.

    TRUNCATE blocks on the writer lock and cannot pass while a reader is
    mid-read; SQLite reports that as ``busy: 1``, which is "try again later" and
    not an error. PASSIVE is the never-blocking fallback and does the useful
    work whenever it can.

    Deliberately NOT called through the thread-local connection: this is a
    maintenance entry point, a short-lived connection of its own, and it must
    never be invoked inside a transaction.
    """
    try:
        c = sqlite3.connect(str(db_path()), timeout=_TIMEOUT_MS / 1000)
        try:
            # Named columns: PRAGMA wal_checkpoint returns (busy, log,
            # checkpointed) in that order, and reading them by name is what
            # keeps the mapping honest if SQLite ever adds a fourth.
            c.row_factory = sqlite3.Row
            row = c.execute(
                f'PRAGMA wal_checkpoint({"TRUNCATE" if truncate else "PASSIVE"})'
            ).fetchone()
        finally:
            c.close()
        payload = dict(row) if row else {}
        return {
            'ok': int(payload.get('busy', -1)) == 0,
            'busy': int(payload.get('busy', -1)),
            'logPages': int(payload.get('log', -1)),
            'checkpointedPages': int(payload.get('checkpointed', -1)),
        }
    except Exception as exc:
        logger.debug('wal checkpoint failed', exc_info=True)
        return {'ok': False, 'error': str(exc)[:200]}


def close() -> None:
    """Close the thread-local connection."""
    if hasattr(_local, 'conn') and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None
    # Closing the handle discards its open transaction, so a poisoned unit cannot
    # outlive it — and a repair queued onto the NEXT connection would be writing
    # inside someone else's transaction. Clear it with the handle.
    _local.poison_repairs = None
    with _LIVE_LOCK:
        _LIVE.pop(threading.get_ident(), None)
