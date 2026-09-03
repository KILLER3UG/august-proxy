"""Part 18 P3.1 — early-dispatch telemetry: ``toolArgsReadyToStreamEndMs``.

The plan item is measure-then-decide: record when the last tool call's
arguments finished arriving (``mark_tool_args_ready``, provider parse sites)
and diff that against stream-end so the trailing stream tail — the window an
early tool dispatch could save — is a NUMBER in turn telemetry, not a vibe.
No behavior change: the field measures; nothing dispatches early.

Three surfaces, each tested:
1. ``PerfTrace.mark_tool_args_ready`` sets ``meta['toolArgsReadyPerf']``
   (ungated: persisted even when spans are disabled — it feeds a column).
2. The turn loop diffs the marker against turn-end and reports
   ``toolArgsReadyToStreamEndMs`` ≥ 0 (only when a marker exists).
3. ``record_turn_outcome`` persists the field in the ``tool_args_ready_ms``
   column (migration 030), and the SSE ``turnTelemetry`` event carries it.
"""

from __future__ import annotations

import asyncio
import time

import pytest


class TestMarkerPrimitives:
    def test_marker_sets_meta_ungated(self):
        """The marker writes perf_counter into meta even when tracing is OFF
        (spans disabled) — persisted telemetry must not depend on the env."""
        from app.lib.perf_timing import PerfTrace, clear_current, current_trace, start_trace

        clear_current()
        tr = start_trace('p31', force=False)  # _enabled False without env
        try:
            assert not tr.enabled
            before = time.perf_counter()
            from app.lib.perf_timing import mark_tool_args_ready

            mark_tool_args_ready()
            after = time.perf_counter()
            stored = tr.meta.get('toolArgsReadyPerf')
            assert stored is not None
            assert before <= float(stored) <= after
        finally:
            clear_current()

    def test_marker_noop_without_current_trace(self):
        from app.lib.perf_timing import clear_current, mark_tool_args_ready

        clear_current()
        mark_tool_args_ready()  # must not raise


class TestTurnEndField:
    def test_helper_diffs_marker_against_now(self, monkeypatch):
        """``tool_args_ready_to_stream_end_ms`` diffs the perf mark against
        NOW (stream end); None/absent marker → 0 (nothing to measure)."""
        import time as _time

        from app.lib import perf_timing
        from app.lib.perf_timing import PerfTrace, clear_current, start_trace

        clear_current()
        tr = start_trace('p31', force=False)
        try:
            # No marker yet → 0.
            assert perf_timing.tool_args_ready_to_stream_end_ms() == 0
            # Marker 100ms in the past → ~100.
            tr.meta['toolArgsReadyPerf'] = _time.perf_counter() - 0.1
            val = perf_timing.tool_args_ready_to_stream_end_ms()
            assert 90 <= val <= 1000
        finally:
            clear_current()

    def test_helper_zero_without_trace(self):
        from app.lib import perf_timing
        from app.lib.perf_timing import clear_current

        clear_current()
        assert perf_timing.tool_args_ready_to_stream_end_ms() == 0

    def test_record_turn_outcome_persists_the_column(self, isolatedData):
        """Migration 030: tool_args_ready_to_stream_end_ms lands in the row."""
        from app.services import turn_outcomes
        from app.services.memory_conn import conn
        from app.services.memory_store import init

        init()
        turn_outcomes.record_turn_outcome(
            model='m',
            provider='p',
            task_type='agent',
            ok=True,
            session_id='s-p31',
            tool_args_ready_to_stream_end_ms=137,
        )
        row = conn().execute(
            "SELECT tool_args_ready_to_stream_end_ms FROM turn_outcomes WHERE session_id = 's-p31'"
        ).fetchone()
        assert row is not None
        assert int(row[0]) == 137


class TestSSEEvent:
    def test_turn_telemetry_event_carries_the_field(self):
        """The turnTelemetry payload includes toolArgsReadyToStreamEndMs
        when a marker exists (0 is a valid measurement; absent when not)."""
        # Shape check against the emit-site construction (workbench.py) —
        # the SSE payload must include the key for observability parity.
        import inspect

        from app.services.workbench import workbench as wb

        src = inspect.getsource(wb)
        assert 'toolArgsReadyToStreamEndMs' in src, (
            'turnTelemetry SSE event does not carry toolArgsReadyToStreamEndMs'
        )


class TestProviderCallSitesMark:
    """The provider parse sites must call the marker once per tool block —
    the twin landed these; this pins them so refactors cannot drop them."""

    def test_openai_parse_site_marks(self):
        import inspect

        from app.services.workbench import providers as prov

        src = inspect.getsource(prov.call_openai_workbench)
        assert 'mark_tool_args_ready' in src

    def test_anthropic_native_site_marks(self):
        import inspect

        from app.services.workbench import stream_translate as st

        src = inspect.getsource(st)
        assert 'mark_tool_args_ready' in src


class TestWorkbenchLoopWiring:
    """End-to-end through the real loop: a scripted provider that emits one
    tool call must produce toolArgsReadyToStreamEndMs in the SSE event and
    the persisted row."""

    @pytest.fixture
    def wb_env(self, isolatedData, monkeypatch, tmp_path):
        from app.services.memory_store import init

        init()
        monkeypatch.setenv('AUGUST_PERF_TIMING', '1')
        from app.lib import perf_timing

        perf_timing.clear_traces()
        # Canonical loop-test isolation (tests/test_workbench_tool_loop.py):
        # redirect the data dir, clear in-memory sessions, stub resolution.
        from app.config import settings
        from app.services.workbench import workbench as wb

        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        settings.reload()
        from app.services.workbench import sessions as sessions_mod

        empty_sessions: dict = {}
        monkeypatch.setattr(sessions_mod, '_sessions', empty_sessions)
        monkeypatch.setattr(wb, '_sessions', empty_sessions)

        stub_provider = {
            'name': 'stub-openai',
            'apiMode': 'openai',
            'default_model': 'stub-model',
            'model_profiles': {},
        }
        monkeypatch.setattr(
            'app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: stub_provider
        )
        monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-model')
        monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')

        # Scripted OpenAI-format provider: round 1 returns one tool call
        # (args arrive HERE, before the trailing usage/finish — the mark
        # fires at the parse site inside call_openai_workbench, so drive the
        # REAL provider function and only stub the stream), round 2 text.
        calls = {'n': 0}

        class _ScriptedStream:
            """Stub upstream client yielding scripted OpenAI SSE chunks."""

            def resolveApiKey(self) -> str:
                return 'stub-key'

            async def chat_completions_stream(self, body):
                calls['n'] += 1
                await asyncio.sleep(0)
                if calls['n'] == 1:
                    yield {
                        'id': 'c1',
                        'object': 'chat.completion.chunk',
                        'choices': [
                            {
                                'index': 0,
                                'delta': {
                                    'role': 'assistant',
                                    'tool_calls': [
                                        {
                                            'index': 0,
                                            'id': 'call_1',
                                            'type': 'function',
                                            'function': {'name': 'echo_probe', 'arguments': '{"text": "hi"}'},
                                        }
                                    ],
                                },
                                'finish_reason': None,
                            }
                        ],
                    }
                    yield {
                        'id': 'c1',
                        'object': 'chat.completion.chunk',
                        'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}],
                    }
                    yield {
                        'id': 'c1',
                        'object': 'chat.completion.chunk',
                        'choices': [],
                        'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15},
                    }
                    # Trailing tail: the args finished ABOVE; this sleep is
                    # the window early dispatch would save.
                    await asyncio.sleep(0.03)
                else:
                    # The final answer round is TEXT-ONLY and takes real
                    # generation time — the persisted value must stay the
                    # last TOOLED round's tail (≈30ms), never inherit the
                    # text round's duration (stale-mark inflation).
                    await asyncio.sleep(0.12)
                    yield {
                        'id': 'c2',
                        'object': 'chat.completion.chunk',
                        'choices': [
                            {
                                'index': 0,
                                'delta': {'role': 'assistant', 'content': 'done'},
                                'finish_reason': None,
                            }
                        ],
                    }
                    yield {
                        'id': 'c2',
                        'object': 'chat.completion.chunk',
                        'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                    }
                    yield {
                        'id': 'c2',
                        'object': 'chat.completion.chunk',
                        'choices': [],
                        'usage': {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13},
                    }

        import app.providers.clients as clientsMod
        from app.services import provider_credentials as providerCredsMod

        monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})

        def fakeGetClient(provider):
            return _ScriptedStream()

        monkeypatch.setattr(clientsMod, 'getClient', fakeGetClient)
        monkeypatch.setattr('app.providers.clients.getClient', fakeGetClient)

        from app.services.tool_registrations import register_all

        register_all()
        from app.services.tool_registry import register as reg

        async def fakeTool(*, text: str = ''):
            return f'echo: {text}'

        reg('echo_probe', 'test echo tool', fakeTool, {'type': 'object', 'properties': {}})
        return wb

    def test_loop_records_positive_field(self, wb_env):
        wb = wb_env
        events: list[dict[str, object]] = []
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                wb.sendWorkbenchMessageStream(
                    sessionId='p31-e2e',
                    message='probe',
                    model='stub-model',
                    emit=events.append,
                )
            )
        finally:
            # P4.2: the telemetry row's commit is debounced (≤2s) on this
            # thread — flush before querying cross-connection.
            try:
                from app.services.deferred_writes import flush_thread_pending

                flush_thread_pending()
            except Exception:
                pass
            loop.close()
        telemetry = [e for e in events if e.get('type') == 'turnTelemetry']
        assert telemetry, (
            f'turnTelemetry event not emitted (events: {[e.get("type") for e in events][:12]})'
        )
        assert 'toolArgsReadyToStreamEndMs' in telemetry[0]
        val = telemetry[0].get('toolArgsReadyToStreamEndMs')
        assert isinstance(val, int), f'field not an int: {val!r}'
        assert val >= 0
        # The value is the LAST TOOLED round's tail (the scripted 30ms sleep
        # after the args chunk) — the 120ms text-only final round must NOT
        # inflate it (the tool-args perf mark persists across rounds; only a
        # round that actually received tool calls may overwrite the value).
        assert 5 <= val < 100, f'tail inflated by the text round: {val!r}'
        # Persisted row matches the SSE event.
        from app.services.memory_conn import conn

        row = conn().execute(
            'SELECT tool_args_ready_to_stream_end_ms FROM turn_outcomes ORDER BY id DESC LIMIT 1'
        ).fetchone()
        assert row is not None
        assert int(row[0]) == val


class TestMarkerOnlyForRealToolCalls:
    def test_no_tool_call_means_zero_field(self, monkeypatch, tmp_path, isolatedData):
        """A text-only turn must NOT record a marker-based field (nothing to
        measure — early dispatch has no meaning without tool calls)."""
        from app.services.memory_store import init

        init()
        monkeypatch.setenv('AUGUST_PERF_TIMING', '1')
        from app.lib import perf_timing

        perf_timing.clear_traces()
        from app.config import settings
        from app.services.workbench import workbench as wb

        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        monkeypatch.setattr(settings, 'dataDir', tmp_path)
        settings.reload()
        from app.services.workbench import sessions as sessions_mod

        empty_sessions: dict = {}
        monkeypatch.setattr(sessions_mod, '_sessions', empty_sessions)
        monkeypatch.setattr(wb, '_sessions', empty_sessions)

        stub_provider = {
            'name': 'stub-openai',
            'apiMode': 'openai',
            'default_model': 'stub-model',
            'model_profiles': {},
        }
        monkeypatch.setattr(
            'app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: stub_provider
        )
        monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-model')
        monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')

        class _TextOnlyStream:
            def resolveApiKey(self) -> str:
                return 'stub-key'

            async def chat_completions_stream(self, body):
                await asyncio.sleep(0)
                yield {
                    'id': 'c1',
                    'object': 'chat.completion.chunk',
                    'choices': [
                        {
                            'index': 0,
                            'delta': {'role': 'assistant', 'content': 'hello'},
                            'finish_reason': None,
                        }
                    ],
                }
                yield {
                    'id': 'c1',
                    'object': 'chat.completion.chunk',
                    'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                }
                yield {
                    'id': 'c1',
                    'object': 'chat.completion.chunk',
                    'choices': [],
                    'usage': {'prompt_tokens': 5, 'completion_tokens': 2, 'total_tokens': 7},
                }

        import app.providers.clients as clientsMod
        from app.services import provider_credentials as providerCredsMod

        monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})

        def fakeGetClient(provider):
            return _TextOnlyStream()

        monkeypatch.setattr(clientsMod, 'getClient', fakeGetClient)
        monkeypatch.setattr('app.providers.clients.getClient', fakeGetClient)

        from app.services.tool_registrations import register_all

        register_all()

        events: list[dict[str, object]] = []
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                wb.sendWorkbenchMessageStream(
                    sessionId='p31-text', message='hi', model='stub-model', emit=events.append
                )
            )
        finally:
            loop.close()
        telemetry = [e for e in events if e.get('type') == 'turnTelemetry']
        assert telemetry, (
            f'turnTelemetry event not emitted (events: {[e.get("type") for e in events][:12]})'
        )
        assert telemetry[0].get('toolArgsReadyToStreamEndMs', -1) == 0
