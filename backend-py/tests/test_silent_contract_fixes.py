"""Two silent-contract bugs the triage surfaced (triage #18, #19).

Neither raised. Neither logged. Both were discovered by reading a line without
its neighbour — which is the failure mode this whole audit is about.

#18 `recurring_tasks.check_and_fire` appended to `fired` OUTSIDE its try/except.
`last_fired_at` is the only thing stopping a task firing again on the next call,
so a swallowed write error produced a duplicate notification every cycle.

#19 `wait_for_message` returned the newest queued message without consuming it,
so a second call with nothing new returned the same message forever. Its own
docstring promised "a NEW message".
"""

from __future__ import annotations

import pytest


class TestRecurringTaskIsNotReportedFiredUnlessRecorded:
    """check_and_fire loads tasks via list_tasks and writes via _conn()."""

    @staticmethod
    def _task():
        return {
            'id': 't1',
            'trigger': 'every 1s',
            'message': 'do the thing',
            'model': 'm',
            'last_fired_at': None,
        }

    def test_a_write_failure_is_not_reported_as_a_fire(self, monkeypatch):
        """The receipt is the whole point; without it the task re-fires."""
        from app.services import recurring_tasks as rt

        class _Conn:
            def execute(self, *a, **kw):
                raise RuntimeError('database is locked')

            def commit(self):
                pass

        monkeypatch.setattr(rt, 'list_tasks', lambda **_kw: [self._task()])
        monkeypatch.setattr(rt, '_conn', lambda: _Conn())
        fired = rt.check_and_fire('s1', '')
        assert fired == [], (
            'the task was reported as fired even though last_fired_at was never '
            'written — it will fire again on the very next call'
        )

    def test_a_successful_write_is_still_reported(self, monkeypatch):
        from app.services import recurring_tasks as rt

        class _Conn:
            def __init__(self):
                self.writes = []

            def execute(self, sql, params=()):
                self.writes.append((sql, params))
                return self

            def commit(self):
                pass

        conn = _Conn()
        monkeypatch.setattr(rt, 'list_tasks', lambda **_kw: [self._task()])
        monkeypatch.setattr(rt, '_conn', lambda: conn)
        monkeypatch.setattr(rt, '_record_run', lambda *a, **kw: None)
        fired = rt.check_and_fire('s1', '')
        assert len(fired) == 1, 'a successfully recorded task stopped being reported'
        assert any('UPDATE' in sql.upper() for sql, _ in conn.writes), (
            'no last_fired_at UPDATE was issued'
        )

class TestWaitForMessageConsumes:
    @pytest.mark.asyncio
    async def test_a_second_call_does_not_redeliver(self):
        """The bug: `return q[-1]` never removed anything."""
        from app.services.agent_message_bus import AgentMessageBus

        bus = AgentMessageBus()
        await bus.publish('t:1', {'n': 1})
        first = await bus.wait_for_message('t:1', timeout=0.2)
        second = await bus.wait_for_message('t:1', timeout=0.2)
        assert first == {'n': 1}
        assert second is None, (
            'wait_for_message returned the same message twice — a caller polling '
            'in a loop would spin forever on one delivery and never see the next'
        )

    @pytest.mark.asyncio
    async def test_messages_come_back_in_order(self):
        """It took the NEWEST and dropped everything ahead of it."""
        from app.services.agent_message_bus import AgentMessageBus

        bus = AgentMessageBus()
        for n in (1, 2, 3):
            await bus.publish('t:2', {'n': n})
        got = [(await bus.wait_for_message('t:2', timeout=0.2)) for _ in range(3)]
        assert [m['n'] for m in got] == [1, 2, 3], (
            'the bus is a queue — messages must come back in the order they were '
            'published, and taking the tail discarded what was ahead of it'
        )

    @pytest.mark.asyncio
    async def test_a_message_arriving_later_is_still_seen(self):
        """The polling-loop case the re-delivery bug hid."""
        import asyncio

        from app.services.agent_message_bus import AgentMessageBus

        bus = AgentMessageBus()
        seen: list[dict] = []
        for _ in range(2):
            got = await bus.wait_for_message('t:3', timeout=1.0)
            if got:
                seen.append(got)
        await bus.publish('t:3', {'n': 'late'})
        got = await bus.wait_for_message('t:3', timeout=1.0)
        assert got == {'n': 'late'}, 'a late-arriving message was shadowed by a stale one'

    @pytest.mark.asyncio
    async def test_get_topic_messages_still_does_not_consume(self):
        """The non-consuming path stays, for callers that only look."""
        from app.services.agent_message_bus import AgentMessageBus

        bus = AgentMessageBus()
        await bus.publish('t:4', {'n': 1})
        assert len(bus.get_topic_messages('t:4')) == 1
        assert len(bus.get_topic_messages('t:4')) == 1, 'peeking consumed the queue'
        assert await bus.wait_for_message('t:4', timeout=0.2) == {'n': 1}

    @pytest.mark.asyncio
    async def test_a_drained_topic_is_cleaned_up(self):
        """An emptied topic should not leave an empty list behind forever."""
        from app.services.agent_message_bus import AgentMessageBus

        bus = AgentMessageBus()
        await bus.publish('t:5', {'n': 1})
        await bus.wait_for_message('t:5', timeout=0.2)
        assert 't:5' not in bus._queues, 'the drained topic was left registered'