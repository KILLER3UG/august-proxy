"""A hanging security guard must deny, not wave the call through (triage #22).

`secret_guard_write` and `sensitive_code` are PRE_TOOL_USE guards: they exist to
stop a credential write. The registry already failed CLOSED when a handler
raised — but returned `action='allow'` when it TIMED OUT, for every event.

That is backwards in two ways. It contradicted the sibling branch a few lines
below, and a timeout is the LIKELIER failure of the two: a guard that shells out
to a subprocess and stops responding never raises at all, so it produced no
error to notice and waved the call straight through.

POST hooks still fail open deliberately — they observe a call that has already
executed, so there is nothing left to hold back. That distinction is pinned here
so the fix cannot be over-applied into wedging every agent on a slow hook.
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.hooks.registry import HookEvent, HookRegistry
from app.services.hooks.types import HookContext


def _ctx(**kw):
    """HookContext needs `event` and `session_id`; build a valid one per kind."""
    kw.setdefault('event', kw.pop('_event', None) or HookEvent.PRE_TOOL_USE)
    kw.setdefault('session_id', 'sess-1')
    return HookContext(**kw)


class TestPreHooksFailClosed:
    @pytest.mark.asyncio
    async def test_a_pre_tool_hook_that_times_out_denies(self):
        reg = HookRegistry()

        async def _hang(ctx):
            await asyncio.sleep(5)
            return None

        reg.register('hanging_guard', HookEvent.PRE_TOOL_USE, _hang, matcher='write_file')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, _ctx(tool_name='write_file'))
        assert any(r.action == 'deny' for r in results), (
            'a security guard that HUNG allowed the call — the one failure that '
            'produces no error to notice was the one that waved it through'
        )

    @pytest.mark.asyncio
    async def test_a_pre_tool_hook_that_raises_denies(self):
        """The behaviour that was already right; pinned so it stays."""
        reg = HookRegistry()

        async def _boom(ctx):
            raise RuntimeError('guard exploded')

        reg.register('broken_guard', HookEvent.PRE_TOOL_USE, _boom, matcher='write_file')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, _ctx(tool_name='write_file'))
        assert any(r.action == 'deny' for r in results)

    @pytest.mark.asyncio
    async def test_the_denial_names_the_hook_and_the_reason(self):
        """A silent deny reads as a policy refusal and sends users hunting."""
        reg = HookRegistry()

        async def _hang(ctx):
            await asyncio.sleep(5)
            return None

        reg.register('hanging_guard', HookEvent.PRE_TOOL_USE, _hang, matcher='write_file')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, _ctx(tool_name='write_file'))
        deny = next(r for r in results if r.action == 'deny')
        assert 'hanging_guard' in (deny.message or ''), (
            'the deny does not say which guard stopped the call'
        )
        assert 'timed out' in (deny.message or '').lower(), (
            'the deny does not say it was a timeout, so it is indistinguishable '
            'from the guard genuinely rejecting the content'
        )


class TestPostHooksStillFailOpen:
    @pytest.mark.asyncio
    async def test_a_post_tool_hook_that_times_out_allows(self):
        """The call already ran; blocking here would be theatre."""
        reg = HookRegistry()

        async def _hang(ctx):
            await asyncio.sleep(5)
            return None

        reg.register('slow_observer', HookEvent.POST_TOOL_USE, _hang, matcher='write_file')
        results = await reg.emit(
            HookEvent.POST_TOOL_USE, _ctx(tool_name='write_file', tool_result='ok', _event=HookEvent.POST_TOOL_USE)
        )
        assert not any(r.action == 'deny' for r in results), (
            'a POST observer was allowed to block an already-executed call'
        )

    @pytest.mark.asyncio
    async def test_a_post_tool_hook_that_raises_allows(self):
        reg = HookRegistry()

        async def _boom(ctx):
            raise RuntimeError('observer exploded')

        reg.register('broken_observer', HookEvent.POST_TOOL_USE, _boom, matcher='write_file')
        results = await reg.emit(
            HookEvent.POST_TOOL_USE, _ctx(tool_name='write_file', tool_result='ok', _event=HookEvent.POST_TOOL_USE)
        )
        assert not any(r.action == 'deny' for r in results)


class TestUnaffectedPaths:
    @pytest.mark.asyncio
    async def test_a_working_pre_hook_still_allows(self):
        """The fix must not turn every hook into a deny."""
        reg = HookRegistry()

        async def _ok(ctx):
            from app.services.hooks.types import HookResult

            return HookResult(action='allow')

        reg.register('fine_guard', HookEvent.PRE_TOOL_USE, _ok, matcher='write_file')
        results = await reg.emit(HookEvent.PRE_TOOL_USE, _ctx(tool_name='write_file'))
        assert not any(r.action == 'deny' for r in results)

    @pytest.mark.asyncio
    async def test_the_breaker_still_opens_after_repeated_timeouts(self):
        """Unchanged behaviour, and load-bearing now that a timeout denies.

        Asserted on the OBSERVABLE effect — the handler stops being called once
        the breaker opens — rather than on an entry attribute. The first draft
        read `reg.hooks` / `reg._hooks`; the breaker drops the hook when it
        opens, so both assertions passed vacuously or failed on a None that was
        the mechanism working correctly.
        """
        reg = HookRegistry()
        calls = {'n': 0}

        async def _hang(ctx):
            calls['n'] += 1
            await asyncio.sleep(5)
            return None

        reg.register('hanging_guard', HookEvent.PRE_TOOL_USE, _hang, matcher='write_file')
        for _ in range(4):
            await reg.emit(HookEvent.PRE_TOOL_USE, _ctx(tool_name='write_file'))
        assert calls['n'] == 3, (
            f'the handler ran {calls["n"]} times — the breaker no longer stops '
            'calling it after the threshold'
        )