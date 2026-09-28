"""A detached sub-agent task must be cancellable by session teardown.

`POST /api/agents/jobs` started its runner with a bare
`asyncio.create_task(...)` and kept no reference. Two consequences:

  * deleting the session did not cancel it. `_run_api_agent_job` drives a
    full `executeSubAgent`, so the job kept making model calls for minutes on
    a chat that no longer existed — real spend against a deleted session;
  * with no strong reference and no done callback, a failure surfaced much
    later as "Task exception was never retrieved", far from its cause, and
    the job row stayed in a running state with nothing to explain it.

The other half is the registry itself: the done callback used to discard the
task from its set but never removed the now-EMPTY set, so the dict tracked
every session that had ever spawned a sub-agent rather than the live ones.
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.workbench import subagent as sub


@pytest.fixture(autouse=True)
def _clean():
    sub._detached_session_tasks.clear()
    sub._subagent_session_tasks.clear()
    yield
    sub._detached_session_tasks.clear()
    sub._subagent_session_tasks.clear()


class TestDetachedTaskRegistry:
    @pytest.mark.asyncio
    async def test_a_registered_task_is_cancelled_on_teardown(self):
        started = asyncio.Event()

        async def forever() -> None:
            started.set()
            await asyncio.sleep(3600)

        task = asyncio.create_task(forever())
        sub.register_detached_session_task('sess-1', task)
        await asyncio.wait_for(started.wait(), 5)

        assert sub.cancel_subagent_tasks_for_session('sess-1') == 1
        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_the_session_key_is_removed_when_the_task_finishes(self):
        """A discarded task must not leave an empty set behind.

        Otherwise the dict grows with every session that ever ran a
        sub-agent — the same shape of bug as the event-log session rings.
        """
        async def quick() -> str:
            return 'done'

        task = asyncio.create_task(quick())
        sub.register_detached_session_task('sess-2', task)
        await task
        await asyncio.sleep(0)  # let the done callback run

        assert 'sess-2' not in sub._detached_session_tasks

    @pytest.mark.asyncio
    async def test_a_cancelled_task_also_drains_its_key(self):
        async def forever() -> None:
            await asyncio.sleep(3600)

        task = asyncio.create_task(forever())
        sub.register_detached_session_task('sess-3', task)
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

        assert 'sess-3' not in sub._detached_session_tasks

    @pytest.mark.asyncio
    async def test_a_failing_task_is_retrieved_not_left_unretrieved(self):
        """An unretrieved exception is reported far from its cause."""
        async def boom() -> None:
            raise RuntimeError('sub-agent blew up')

        task = asyncio.create_task(boom())
        sub.register_detached_session_task('sess-4', task)
        with pytest.raises(RuntimeError):
            await task
        await asyncio.sleep(0)

        # The callback consumed it, so there is nothing left to warn about
        # later. Reaching `.exception()` here without raising proves it.
        assert task.exception() is not None
        assert 'sess-4' not in sub._detached_session_tasks

    @pytest.mark.asyncio
    async def test_no_session_id_is_a_no_op_rather_than_a_shared_bucket(self):
        """An unbound task must not be filed under a shared '' key.

        Filing them together would make one session's delete cancel another
        session's job — a worse bug than the leak this replaced.
        """
        async def forever() -> None:
            await asyncio.sleep(3600)

        task = asyncio.create_task(forever())
        sub.register_detached_session_task('', task)
        assert sub._detached_session_tasks == {}
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_teardown_only_touches_its_own_session(self):
        started = asyncio.Event()

        async def forever() -> None:
            started.set()
            await asyncio.sleep(3600)

        a = asyncio.create_task(forever())
        b = asyncio.create_task(forever())
        sub.register_detached_session_task('mine', a)
        sub.register_detached_session_task('theirs', b)
        await asyncio.wait_for(started.wait(), 5)

        sub.cancel_subagent_tasks_for_session('mine')
        with pytest.raises(asyncio.CancelledError):
            await a
        assert not b.done(), 'cancelling one session killed another session\'s job'

        b.cancel()
        with pytest.raises(asyncio.CancelledError):
            await b


class TestRecurringAliasStillWorks:
    @pytest.mark.asyncio
    async def test_register_recurring_task_uses_the_same_registry(self):
        async def forever() -> None:
            await asyncio.sleep(3600)

        task = asyncio.create_task(forever())
        sub.register_recurring_task('sess-5', task)
        assert 'sess-5' in sub._detached_session_tasks
        sub.cancel_subagent_tasks_for_session('sess-5')
        with pytest.raises(asyncio.CancelledError):
            await task
