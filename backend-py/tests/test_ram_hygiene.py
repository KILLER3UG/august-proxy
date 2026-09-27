"""RAM hygiene for two structures that only ever grew.

Neither of these is a memory hog in isolation. Both are objects the process
acquires once per session or per answer and never gives back, in an app whose
backend is a long-lived desktop sidecar that can run for days. They are
pinned here because the failure mode is silent: nothing throws, the app just
uses more memory over time, and the only way to notice is to measure a
process that has been open all week.
"""

from __future__ import annotations

import pytest
from app.services.workbench import workbench as wb


class TestTurnLockLifecycle:
    def teardown_method(self) -> None:
        wb._turnLocks.clear()

    def test_gate_is_created_on_demand(self):
        assert wb._sessionTurnLock('s1') is wb._sessionTurnLock('s1')

    def test_release_drops_an_idle_gate(self):
        wb._sessionTurnLock('s1')
        assert wb.release_turn_lock('s1') is True
        assert 's1' not in wb._turnLocks

    def test_release_of_an_unknown_session_is_a_no_op(self):
        assert wb.release_turn_lock('never-existed') is False

    @pytest.mark.asyncio
    async def test_release_refuses_while_a_turn_holds_the_gate(self):
        """The whole point of the gate is that one session runs one turn.

        Dropping a LOCKED entry would let the next turn mint a second lock for
        the same session, and the two turns would interleave their message
        appends — the exact race the gate was added to stop. So release must
        decline and leave the entry alone.
        """
        lock = wb._sessionTurnLock('s1')
        await lock.acquire()
        try:
            assert wb.release_turn_lock('s1') is False
            assert wb._turnLocks.get('s1') is lock
        finally:
            lock.release()

    @pytest.mark.asyncio
    async def test_prune_keeps_every_gate_a_live_turn_is_holding(self):
        """The bound is a backstop, not a licence to break a running turn."""
        held = wb._sessionTurnLock('held')
        await held.acquire()
        try:
            wb._MAX_TURN_LOCKS = 4
            for i in range(40):
                wb._sessionTurnLock(f's{i}')
            assert wb._turnLocks.get('held') is held
            assert len(wb._turnLocks) <= 40
        finally:
            wb._MAX_TURN_LOCKS = 512
            held.release()

    def test_prune_bounds_the_dict_under_far_more_sessions(self):
        original_max = wb._MAX_TURN_LOCKS
        wb._MAX_TURN_LOCKS = 16
        try:
            for i in range(5000):
                wb._sessionTurnLock(f'session-{i}')
            assert len(wb._turnLocks) <= 17
            # The newest session must still be usable — a prune that dropped
            # the live end would break the next turn.
            assert 'session-4999' in wb._turnLocks
        finally:
            wb._MAX_TURN_LOCKS = original_max
