"""The bench's window override — DS Bot's `dev/bench.sh`, ported.

There, `CONTEXT_WINDOW` is shrunk so context relief happens on demand instead of
requiring a transcript big enough to overflow a real model. August could not do that:
the loop resolves the window from the MODEL (`workbench._resolveModelContextWindow`,
`app/services/workbench/workbench.py:1274`), so there was no session field, flag or
env var that could force it for one run without editing the providers store that every
other chat reads.

Scope, stated honestly after checking what already existed: the **reactive** overflow
arm is already driven through the loop — `tests/test_workbench_tool_loop.py:1069-1086`
monkeypatches this resolver to 1000, feeds a 60-message history and asserts the
`Context overflow — reduced context` warning plus `callCount == 2`, with a window-0
fall-through control at `:1088-1104`. That arm is gated on `_isContextOverflowError`
(`workbench.py:3806-3817`), so a small window alone cannot fire it — a lying provider
is the *design* of that test, not an artifact. What this flag adds is the deterministic
pre-turn decision: the same transcript, two windows, relief happening in one and not
the other, with no provider asked to pretend anything.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator

import pytest
from app.services.workbench import workbench as wb

STUB_PROVIDER = {'name': 'stub', 'apiMode': 'anthropicMessages', 'default_model': 'stub-claude'}



@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services import memory_store
    from app.services.workbench import sessions as sessions_mod

    memory_store.init()
    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr(asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro))
    monkeypatch.setattr(
        'app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: STUB_PROVIDER
    )
    monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod

    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    holder: dict[str, object] = {}
    monkeypatch.setattr(clientsMod, 'getClient', lambda provider: holder['client'])
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: holder['client'])
    from app.services.tool_registrations import register_all

    register_all()
    yield holder




class TestTheResolverHonoursTheOverride:
    def test_the_override_replaces_the_models_window(self, isolatedData):
        from app.services.workbench.context import contextWindowOverride

        # Compare against the store's own answer rather than a number: the stub
        # model may resolve to anything, and the property being pinned is
        # "the override wins", not "the window is 12000 by arithmetic".
        unset = wb._resolveModelContextWindow('stub-claude', None)
        chosen = unset + 12345
        token = contextWindowOverride.set(chosen)
        try:
            assert wb._resolveModelContextWindow('stub-claude', None) == chosen
        finally:
            contextWindowOverride.reset(token)
        assert wb._resolveModelContextWindow('stub-claude', None) == unset, 'reset did not restore'

    def test_zero_means_no_override(self, isolatedData):
        from app.services.workbench.context import contextWindowOverride

        unset = wb._resolveModelContextWindow('stub-claude', None)
        token = contextWindowOverride.set(0)
        try:
            assert wb._resolveModelContextWindow('stub-claude', None) == unset
        finally:
            contextWindowOverride.reset(token)
        assert unset >= 8192, f'the store path must still floor: {unset}'

    def test_a_ridiculously_small_window_is_floored_not_zeroed(self, isolatedData):
        """The same floor the resolver already applies to the store's value: an
        override must not be able to produce a window the compressor cannot work
        with, or the bench would measure a broken loop instead of a small model."""
        from app.services.workbench.context import contextWindowOverride

        token = contextWindowOverride.set(10)
        try:
            assert wb._resolveModelContextWindow('stub-claude', None) == 8192
        finally:
            contextWindowOverride.reset(token)


class TestTheFlagExistsAndIsBounded:
    def test_cli_accepts_the_flag_and_threads_it(self):
        from app.bench.cli import build_parser

        args = build_parser().parse_args(['--task', 't', '--context-window', '9000'])
        assert args.context_window == 9000
        assert build_parser().parse_args(['--task', 't']).context_window == 0

    def test_the_override_lives_only_for_the_run(self, monkeypatch):
        """Reset matters more here than for most knobs: a leaked window would make
        every later turn in the same process act like a small model."""
        from app.bench import cli
        from app.services.workbench.context import contextWindowOverride

        seen: dict[str, object] = {}

        async def fake_run(opts):
            seen['window'] = contextWindowOverride.get()
            seen['opts'] = opts.context_window
            return 0

        monkeypatch.setattr(cli, 'run_bench', fake_run)
        before = contextWindowOverride.get()
        assert cli.main(['--task', 't', '--context-window', '9000', '--events', os.devnull]) == 0
        assert seen['window'] == 9000, 'the run never saw the override'
        assert seen['opts'] == 9000
        assert contextWindowOverride.get() == before, 'the override leaked past the run'

        async def boom(opts):
            raise RuntimeError('run failed')

        monkeypatch.setattr(cli, 'run_bench', boom)
        with pytest.raises(RuntimeError):
            cli.main(['--task', 't', '--context-window', '9000', '--events', os.devnull])
        assert contextWindowOverride.get() == before, 'the override leaked past a FAILED run'
