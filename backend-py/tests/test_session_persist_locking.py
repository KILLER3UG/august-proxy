"""Concurrent session persists must not lose a write to a lock collision.

`save_workbench_sessions` → `_persist_sessions_snapshot` takes two locks:
`_sessions_lock` for the in-memory copy, and `_persist_io_lock` around the
SQLite write. Only the second one serializes writers, and it is the one that
matters: two concurrent persists outside it contend for the brain SQLite file
and the loser gets `sqlite3.OperationalError: database is locked`. The write
is wrapped in a try/except that logs and moves on, so the failure is SILENT —
the session simply is not saved, and nothing surfaces it except a test that
looks for the row afterwards.

That is not hypothetical. Moving the write block outside `_persist_io_lock`
while adding the watcher teardown passed 3796 local tests and then failed in
CI, where 4 vCPUs make the collision reachable. The local suite ran it once
per process; CI runs it under contention.

So: hammer `save_sessions` from several threads at once and assert every
session that was marked dirty is actually readable afterwards.
"""

from __future__ import annotations

import threading

import pytest


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


class TestConcurrentPersistDoesNotLoseWrites:
    @pytest.mark.asyncio
    async def test_parallel_saves_all_land(self, brain, isolatedData):
        from app.services import memory_store
        from app.services.workbench.sessions import (
            WorkbenchSession,
            _dirty_sids,
            _sessions,
            save_sessions,
        )

        ids = [f'concurrent-{i}' for i in range(12)]
        for sid in ids:
            _sessions[sid] = WorkbenchSession(
                id=sid,
                title=f'concurrent {sid}',
                provider='test',
                model='m1',
                createdAt='2026-01-01T00:00:00Z',
                startedAt='2026-01-01T00:00:00Z',
                updatedAt='2026-01-01T00:00:00Z',
                messages=[{'role': 'user', 'content': f'marker-{sid}'}],
                messageCount=1,
            )
            _dirty_sids.add(sid)

        errors: list[BaseException] = []

        def _save() -> None:
            try:
                save_sessions(immediate=True)
            except BaseException as exc:  # noqa: BLE001 — reported below
                errors.append(exc)

        threads = [threading.Thread(target=_save) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f'save_sessions raised: {errors}'

        # The point: a `database is locked` loser does not raise, it logs and
        # skips. Only reading the rows back shows the write was lost.
        missing = [sid for sid in ids if memory_store.get_session(sid) is None]
        assert missing == [], f'{len(missing)} sessions were silently not saved'

        for sid in ids:
            _sessions.pop(sid, None)
            _dirty_sids.discard(sid)

    @pytest.mark.asyncio
    async def test_the_io_lock_is_actually_held_across_the_sqlite_write(self, brain, isolatedData):
        """Pin the ordering directly, so the regression cannot come back quiet.

        Asserting the outcome alone is a probabilistic test — a collision needs
        two writers to overlap. Observing the lock from inside the write is
        deterministic.
        """
        from app.services import memory_store
        from app.services.workbench import sessions as sessions_mod

        _sessions = sessions_mod._sessions
        _sessions['lockprobe-1'] = sessions_mod.WorkbenchSession(
            id='lockprobe-1',
            title='lock probe',
            provider='test',
            model='m1',
            createdAt='2026-01-01T00:00:00Z',
            startedAt='2026-01-01T00:00:00Z',
            updatedAt='2026-01-01T00:00:00Z',
            messages=[{'role': 'user', 'content': 'probe'}],
            messageCount=1,
        )
        sessions_mod._dirty_sids.add('lockprobe-1')

        held: list[bool] = []
        real_init = memory_store.init

        def spy_init() -> None:
            # `init()` is called at the top of the write block. If the write
            # ever runs outside `_persist_io_lock`, the lock is unheld here.
            held.append(sessions_mod._persist_io_lock.locked())
            real_init()

        memory_store.init = spy_init  # type: ignore[assignment]
        try:
            sessions_mod.save_sessions(immediate=True)
        finally:
            memory_store.init = real_init  # type: ignore[assignment]
            sessions_mod._sessions.pop('lockprobe-1', None)
            sessions_mod._dirty_sids.discard('lockprobe-1')

        assert held == [True], 'the SQLite write ran outside _persist_io_lock'
