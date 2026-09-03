"""P4.2 (Part 18) — debounced commit for high-frequency per-turn writes.

Per-turn telemetry (``turn_outcomes`` rows, lifecycle events, internal_state
upserts) each issued its own ``conn.commit()`` on the turn thread — three
WAL syncs per turn on the hot path, none of them read back within the turn.
This module batches those commits into ONE debounced commit (≤2s window)
without changing visibility semantics:

* Writes still execute immediately, so same-connection readers (the turn
  thread's own thread-local connection) see them uncommitted, exactly as
  before. Only the COMMIT is deferred.
* Deferral applies ONLY on threads with a running asyncio loop (the turn /
  loop thread). Sync contexts (tests, boot) and ``asyncio.to_thread``
  workers commit immediately — their behavior is unchanged.
* The flush runs on the OWNING thread (loop timers + next-call re-entry):
  sqlite3 connections are ``check_same_thread`` by default and must never
  be committed from a foreign thread.

Durability trade: a hard crash inside the window loses ≤2s of
diagnostics-only rows — accepted by the plan for exactly this class of
write. Anything read cross-thread within the window must keep the
immediate commit.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time

logger = logging.getLogger(__name__)

WINDOW_S = 2.0
# A conn written continuously must not have its commit postponed forever.
_MAX_HOLD_S = 10.0

_lock = threading.Lock()
# id(conn) -> (conn, owner thread id, first defer, due monotonic)
_pending: dict[int, tuple[sqlite3.Connection, int, float, float]] = {}
_timers: dict[int, asyncio.TimerHandle] = {}


def _on_loop_thread() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def _commit(conn: sqlite3.Connection) -> None:
    try:
        if conn.in_transaction:
            conn.commit()
    except sqlite3.ProgrammingError:
        pass  # closed between defer and flush — nothing to persist
    except Exception:
        logger.debug('deferred commit failed', exc_info=True)


def _flush_key(key: int) -> None:
    with _lock:
        entry = _pending.pop(key, None)
        handle = _timers.pop(key, None)
    if handle is not None:
        handle.cancel()
    if entry is not None:
        _commit(entry[0])


def _flush_owned_entries(*, only_due: bool) -> int:
    """Flush entries owned by the CURRENT thread (never a foreign conn)."""
    thread_id = threading.get_ident()
    now = time.monotonic()
    with _lock:
        keys = [
            k
            for k, (_c, owner, _f, due) in _pending.items()
            if owner == thread_id and (not only_due or due <= now)
        ]
    for key in keys:
        _flush_key(key)
    return len(keys)


def flush_thread_pending() -> int:
    """Commit every pending deferred write owned by the calling thread."""
    return _flush_owned_entries(only_due=False)


def defer_commit(conn: sqlite3.Connection, window_s: float = WINDOW_S) -> None:
    """Commit ``conn`` now (sync/worker threads) or on a ≤``window_s`` debounce.

    Call instead of ``conn.commit()`` for high-frequency writes that are not
    read back across threads within the turn.
    """
    if not _on_loop_thread():
        _commit(conn)
        return
    thread_id = threading.get_ident()
    now = time.monotonic()
    with _lock:
        entry = _pending.get(id(conn))
        first = entry[2] if entry else now
        _pending[id(conn)] = (conn, thread_id, first, min(now + window_s, first + _MAX_HOLD_S))
        overdue = [
            k
            for k, (_c, owner, _f, due) in _pending.items()
            if owner == thread_id and due <= now and k != id(conn)
        ]
    for key in overdue:
        _flush_key(key)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    with _lock:
        if id(conn) not in _pending:
            return  # flushed again before the timer could be armed
        old = _timers.get(id(conn))
        _timers[id(conn)] = loop.call_later(window_s + 0.05, _flush_key, id(conn))
    if old is not None:
        old.cancel()
