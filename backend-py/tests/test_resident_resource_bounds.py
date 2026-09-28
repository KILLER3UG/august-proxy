"""Three resources that outlived the thing that owned them.

Each of these grew for as long as the app was open, and none of them was
visible in normal use — a user sees a chat list, not a map of what the process
is still holding on their behalf.

  * the event log kept a 2000-event replay ring per session, forever, because
    the session dict was append-only;
  * each session's filesystem watcher — a watchdog thread plus an OS
    directory-watch handle — was released only on an explicit delete, while the
    session store itself is a 60-entry recency window;
  * a warm kernel deregistered from its registry only on the explicit
    `shutdown()` path, so the 15-minute idle reap left its entry behind.
"""

from __future__ import annotations

import pytest


class TestEventLogBoundsResidentSessions:
    def test_the_session_dict_is_bounded(self):
        """MAX_IN_MEMORY bounds EVENTS; nothing bounded SESSIONS.

        Every session the process ever saw kept a 2000-entry deque of full SSE
        payloads — tool arguments, tool results, assistant deltas.
        """
        from app.services.event_log import MAX_SESSIONS_RESIDENT, EventLog

        log = EventLog()
        try:
            for i in range(MAX_SESSIONS_RESIDENT + 40):
                log.append(f'sess_{i}', 'turn_start', {'i': i, 'blob': 'x' * 512})
            assert len(log._sessions) <= MAX_SESSIONS_RESIDENT
        finally:
            log._sessions.clear()

    def test_the_newcomer_never_evicts_itself(self):
        """The bug adversarial review found: the ring was inserted, THEN swept.

        When every resident already carried a subscriber the newcomer was the
        only stale candidate, so it evicted itself — and the SSE stream it was
        created for was silently orphaned: gone from the map, so every later
        append built a different ring that was also evicted, and the client
        sat on a live connection receiving nothing but keepalives.
        """
        import asyncio

        from app.services.event_log import MAX_SESSIONS_RESIDENT, EventLog

        log = EventLog()
        try:
            for i in range(MAX_SESSIONS_RESIDENT):
                log.append(f'held_{i}', 'turn_start', {'i': i})
                log._sessions[f'held_{i}'].subscribers.add(object())  # type: ignore[arg-type]
            # Now every resident is subscribed, so only the newcomer is stale.
            log.append('newcomer', 'turn_start', {'i': 0})
            assert 'newcomer' in log._sessions, (
                'the new ring evicted itself, orphaning the stream it was made for'
            )
            held = log._sessions['newcomer']
            log.append('newcomer', 'delta', {'x': 1})
            # The ring the stream holds is still the one in the map, so the
            # event is delivered rather than lost.
            assert log._sessions.get('newcomer') is held
            assert held.events, 'events went to a ring the map no longer holds'
        finally:
            for e in log._sessions.values():
                e.subscribers.clear()
            log._sessions.clear()
        assert asyncio is not None

    def test_eviction_drops_the_oldest_first(self):
        from app.services.event_log import MAX_SESSIONS_RESIDENT, EventLog

        log = EventLog()
        try:
            for i in range(MAX_SESSIONS_RESIDENT + 5):
                log.append(f'sess_{i}', 'turn_start', {'i': i})
            survivors = set(log._sessions)
            # The first few are the ones that aged out; the newest survive.
            assert 'sess_0' not in survivors
            assert f'sess_{MAX_SESSIONS_RESIDENT + 4}' in survivors
        finally:
            log._sessions.clear()

    def test_a_session_with_a_live_subscriber_is_never_evicted(self):
        """Evicting an entry a stream is holding breaks the SSE connection.

        The cap yields to the stream: if every session is subscribed the count
        may exceed the cap, and that is the right thing to give up — a live
        turn is worth more than the bound.
        """
        from app.services.event_log import MAX_SESSIONS_RESIDENT, EventLog

        log = EventLog()
        try:
            # Subscribe to the FIRST session before the others push it out —
            # otherwise it is legitimately the oldest and correctly evicted,
            # which is the behaviour the previous test asserts.
            log.append('busy_0', 'turn_start', {'i': 0})
            log._sessions['busy_0'].subscribers.add(object())  # type: ignore[arg-type]
            for i in range(1, MAX_SESSIONS_RESIDENT + 3):
                log.append(f'busy_{i}', 'turn_start', {'i': i})
            for i in range(MAX_SESSIONS_RESIDENT + 3, MAX_SESSIONS_RESIDENT + 30):
                log.append(f'new_{i}', 'turn_start', {'i': i})
            assert 'busy_0' in log._sessions
        finally:
            for e in log._sessions.values():
                e.subscribers.clear()
            log._sessions.clear()

    def test_per_session_event_ring_is_still_bounded(self):
        from app.services.event_log import MAX_IN_MEMORY, EventLog

        log = EventLog()
        try:
            for i in range(MAX_IN_MEMORY + 50):
                log.append('one', 'delta', {'i': i})
            assert len(log._sessions['one'].events) <= MAX_IN_MEMORY
        finally:
            log._sessions.clear()


class TestEnvironmentChangeBuffer:
    def test_a_record_without_a_timestamp_is_stamped_and_visible(self, tmp_path):
        """The bug this closes: the data was written AND never returned.

        `getRecentChanges` filters on `timestamp`, and the only production
        caller (`cognitive_boot._on_event`) built the dict without one — so
        every change passed `as_float(0.0) >= cutoff` as False, failed its own
        age check, and was invisible while still occupying memory.
        """
        from app.services.environment_watcher import _recentChanges, getRecentChanges, recordChange

        _recentChanges.clear()
        recordChange('s1', {'path': 'a.py', 'kind': 'modify', 'source': 'watcher'})
        assert getRecentChanges('s1') != []
        _recentChanges.clear()

    def test_the_per_session_list_is_capped(self):
        from app.services.environment_watcher import (
            _MAX_CHANGES_PER_SESSION,
            _recentChanges,
            recordChange,
        )

        _recentChanges.clear()
        for i in range(_MAX_CHANGES_PER_SESSION + 100):
            recordChange('s1', {'path': f'f{i}.py', 'kind': 'modify'})
        assert len(_recentChanges['s1']) <= _MAX_CHANGES_PER_SESSION
        _recentChanges.clear()

    def test_forget_drops_the_key_outright(self):
        from app.services.environment_watcher import (
            _recentChanges,
            forgetSessionChanges,
            recordChange,
        )

        _recentChanges.clear()
        recordChange('s1', {'path': 'a.py', 'kind': 'modify'})
        forgetSessionChanges('s1')
        assert 's1' not in _recentChanges
        _recentChanges.clear()


class TestWarmKernelDeregistersItself:
    def test_kill_drops_the_registry_entry(self):
        """The idle timer calls `kill()`; only `shutdown()` used to pop.

        So every kernel that expired after the idle window left its entry — and
        a reference to the dead subprocess and its transport — resident for the
        life of the process.
        """
        from app.services.workbench import kernel as kmod

        kmod._WARM_KERNELS.clear()
        k = kmod.acquire_warm_kernel('/ws', 'sess-1')
        assert kmod._WARM_KERNELS, 'entry should exist while alive'
        k.kill()
        assert kmod._WARM_KERNELS == {}
        kmod._WARM_KERNELS.clear()

    def test_a_never_booted_entry_is_no_longer_unreapable(self):
        """`acquire` registers; the child is created lazily on the first cell.

        So an acquired-but-never-used kernel used to have no armed timer at all
        (the timer was armed in `_boot`) and nothing else removed it.
        """
        from app.services.workbench import kernel as kmod

        kmod._WARM_KERNELS.clear()
        k = kmod.acquire_warm_kernel('/ws', 'sess-2')
        assert k.proc is None, 'this is the never-booted case'
        assert k.last_used > 0.0, 'last_used must be seeded so the window can elapse'
        k.kill()
        assert kmod._WARM_KERNELS == {}
        kmod._WARM_KERNELS.clear()

    def test_kill_does_not_evict_its_successor(self):
        """A kernel replaced in the registry must not unregister the new one.

        `acquire_warm_kernel` installs a fresh entry for a dead key, and a
        late kill from the previous occupant must leave that alone — hence the
        identity check rather than a blind pop.
        """
        from app.services.workbench import kernel as kmod

        kmod._WARM_KERNELS.clear()
        old = kmod.acquire_warm_kernel('/ws', 'sess-3')
        old.kill()  # removes itself
        new = kmod.acquire_warm_kernel('/ws', 'sess-3')
        assert kmod._WARM_KERNELS, 'successor should be registered'

        # A stale kill from the old occupant must not take the new one out.
        old._shutdown = False
        old.kill()
        assert kmod._WARM_KERNELS.get(kmod._warm_key('/ws', 'sess-3')) is new
        kmod._WARM_KERNELS.clear()
