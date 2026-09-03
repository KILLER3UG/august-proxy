"""TTFT always records — persisted telemetry must not need AUGUST_PERF_TIMING.

Part 18 §6 follow-up ruling: production rows showed ttft_ms=0 everywhere
because mark_ttft was gated on the debug env var, while the sibling persisted
metric (mark_tool_args_ready) was deliberately ungated. mark_ttft now follows
the same rule: TTFT + tool-args-ready always record; spans / ring / logging
stay behind AUGUST_PERF_TIMING.
"""

from __future__ import annotations

import asyncio


def test_mark_ttft_records_without_env(monkeypatch):
    """Unit contract: force=False + env unset still fills ttft_ms, but spans
    and the ring stay empty — the env gates everything EXCEPT the marks that
    feed persisted turn telemetry."""
    import time

    monkeypatch.delenv('AUGUST_PERF_TIMING', raising=False)
    from app.lib.perf_timing import PerfTrace, clear_traces, recent_traces

    clear_traces()
    tr = PerfTrace(name='unit', force=False)
    assert tr.enabled is False, 'env unset + force=False must keep spans off'
    with tr.span('prompt_build'):
        time.sleep(0.001)
    tr.mark_ttft()
    assert tr.ttft_ms is not None and tr.ttft_ms >= 0
    summary = tr.finish()
    assert summary['ttft_ms'] is not None, 'finish() summary must carry ttft'
    assert summary['spans'] == {}, 'spans must stay env-gated'
    assert recent_traces() == [], 'ring must stay env-gated'
    clear_traces()


def test_turn_records_ttft_without_env(monkeypatch, tmp_path, isolatedData):
    """Live loop: a text-only turn WITHOUT the env var must persist a real
    ttft (turnTelemetry SSE + turn_outcomes row), while the trace ring stays
    empty — the exact production condition that showed ttft_ms=0."""
    from app.services.memory_store import init

    init()
    monkeypatch.delenv('AUGUST_PERF_TIMING', raising=False)
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
                sessionId='ttft-noenv', message='hi', model='stub-model', emit=events.append
            )
        )
    finally:
        # turn_outcomes commit is debounced on this thread — flush before
        # querying cross-connection (see test_early_dispatch_telemetry).
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
    assert telemetry[0].get('ttftMs', 0) > 0, (
        f'ttftMs must record without AUGUST_PERF_TIMING: {telemetry[0]!r}'
    )
    # Persisted row matches the SSE event (nonzero ttft in the DB). The
    # requested sessionId is a NEW session — the loop generates a wb_* id,
    # so query the latest row (same approach as test_early_dispatch_telemetry).
    from app.services.memory_conn import conn

    row = conn().execute(
        'SELECT ttft_ms FROM turn_outcomes ORDER BY id DESC LIMIT 1'
    ).fetchone()
    assert row is not None, 'turn_outcomes row missing for the turn'
    assert int(row['ttft_ms']) > 0, f'DB ttft_ms must be real, got {row["ttft_ms"]!r}'
    # Spans/ring stay gated: the ring must NOT have grown without the env.
    assert perf_timing.recent_traces() == [], 'ring must stay env-gated'
    perf_timing.clear_traces()
