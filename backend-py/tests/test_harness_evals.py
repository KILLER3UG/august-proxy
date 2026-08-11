"""Golden loop-level eval scenarios (Codex core/suite pattern).

Each scenario drives the REAL workbench turn loop with a scripted model
(ScriptedClient) and asserts harness properties. Results are recorded via
record_eval_run so the Brain evals surface (/api/brain/harness/evals) can
track harness health over time.
"""

from __future__ import annotations

import time

import pytest
from app.services import tool_registry
from app.services.harness_eval import (
    event_types,
    find_event,
    record_eval_run,
    run_turn,
)


@pytest.fixture
def evalProbe():
    """A registered probe tool whose result is deterministic (async handler)."""

    async def _probe(**kwargs):
        return 'probe-ok'

    tool_registry.register(
        'eval_probe',
        'Eval probe tool.',
        _probe,
        {'type': 'object', 'properties': {}},
    )
    yield 'eval_probe'
    tool_registry.unregister('eval_probe')


def _record(task_id: str, events: list[dict], *, extra: str = '') -> None:
    record_eval_run(
        task_id=task_id,
        passed=not find_event(events, 'error'),
        rounds=len(event_types(events)),
        duration_ms=int(time.monotonic() % 1000),
        notes=extra,
    )


@pytest.mark.asyncio
async def test_well_behaved_turn(monkeypatch, evalProbe):
    """A model that answers directly: done, text present, no error."""
    events, _session = await run_turn(monkeypatch, script=[{'type': 'text', 'text': 'hello world'}])
    types = event_types(events)
    assert 'done' in types
    assert 'error' not in types
    outputs = [e.get('content', '') for e in events if e.get('type') == 'finalOutput']
    assert 'hello world' in ''.join(outputs)
    _record('well-behaved-turn', events)


@pytest.mark.asyncio
async def test_tool_round_trip(monkeypatch, evalProbe):
    """Tool call → deterministic result → answer. Loop terminates at 2 rounds."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'tool', 'name': 'eval_probe', 'arguments': {'arg': 1}},
            {'type': 'text', 'text': 'done with the probe'},
        ],
    )
    toolResults = [e for e in events if e.get('type') == 'toolResult']
    assert toolResults, 'expected a toolResult event'
    assert 'probe-ok' in ''.join(str(e.get('content', '')) for e in toolResults)
    assert 'done' in event_types(events)
    _record('tool-round-trip', events)


@pytest.mark.asyncio
async def test_malformed_json_self_heal(monkeypatch, evalProbe):
    """Malformed tool arguments must NOT execute as {} — self-heal fires."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'malformed_tool', 'name': 'eval_probe', 'raw': '{"arg": '},
            {'type': 'text', 'text': 'fixed it'},
        ],
    )
    toolResults = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'toolResult')
    assert '[Validation Error]' in toolResults
    assert 'Do NOT stop' in toolResults
    assert 'probe-ok' not in toolResults  # never executed with empty args
    _record('malformed-json-self-heal', events)


@pytest.mark.asyncio
async def test_empty_response_is_retried_then_recovers(monkeypatch):
    """An empty upstream stream is RETRYABLE (Phase 2): the loop backs off and
    retries instead of hard-failing the whole turn — a swallowed upstream
    failure (context overflow 400, gateway hiccup) often recovers on the
    retry, which is the biggest weak-model win. Only a persistent empty
    stream errors out."""
    events, _session = await run_turn(monkeypatch, script=[{'type': 'empty'}])
    err = find_event(events, 'error')
    # The scripted client answers text on the retry (script exhausted) — the
    # turn must COMPLETE, not error.
    assert err is None, f'unexpected error event: {err}'
    assert 'done' in event_types(events)
    _record('empty-response-retried', events)

    # A stream that stays empty across retries still surfaces an error
    # (bounded by the retry policy, never an infinite loop).
    from app.services.harness_eval import ScriptedClient

    original = ScriptedClient.chat_completions_stream

    async def always_empty(self, body):
        self.call_count += 1
        yield {'choices': [], 'usage': {'prompt_tokens': 5, 'completion_tokens': 0}}

    ScriptedClient.chat_completions_stream = always_empty  # type: ignore[method-assign]
    try:
        events2, _s2 = await run_turn(monkeypatch, script=[{'type': 'empty'}])
    finally:
        ScriptedClient.chat_completions_stream = original  # type: ignore[method-assign]
    err2 = find_event(events2, 'error')
    assert err2 is not None
    assert 'empty response' in str(err2.get('message', '')).lower()
    _record('empty-response-persistent-error', events2, extra=str(err2.get('message', '')))


@pytest.mark.asyncio
async def test_round_cap_stops_runaway_tools(monkeypatch):
    """A model that never stops calling tools is bounded: the round cap OR the
    stall detector terminates the turn with an error (never an infinite loop)."""
    script = [{'type': 'tool', 'name': 'eval_probe', 'arguments': {}} for _ in range(30)]
    events, _session = await run_turn(monkeypatch, script=script)
    err = find_event(events, 'error')
    assert err is not None
    message = str(err.get('message', ''))
    assert ('Tool loop exceeded' in message) or ('did not recover' in message)
    _record('round-cap-runaway', events, extra=message)


@pytest.mark.asyncio
async def test_stall_detection_nudges(monkeypatch):
    """20 tool rounds with no execution-state progress → reflection nudge."""
    script = [{'type': 'tool', 'name': 'eval_probe', 'arguments': {}} for _ in range(20)]
    events, _session = await run_turn(monkeypatch, script=script)
    warnings = [e for e in events if e.get('type') == 'warning']
    stallWarnings = [w for w in warnings if 'No progress' in str(w.get('message', ''))]
    assert stallWarnings, 'expected the stall-detection warning'
    _record('stall-detection', events, extra=stallWarnings[0].get('message', ''))


@pytest.mark.asyncio
async def test_stream_rule_narration_aborts(monkeypatch):
    """Narrating a tool call mid-stream aborts and nudges (Oh My Pi rule)."""
    events, _session = await run_turn(
        monkeypatch,
        script=[{'type': 'text', 'text': "I'll use the read_file tool to check the file"}],
    )
    warnings = [e for e in events if e.get('type') == 'warning']
    narrationWarnings = [w for w in warnings if 'narrating' in str(w.get('message', ''))]
    assert narrationWarnings, 'expected the stream-rule warning'
    _record('stream-rule-narration', events, extra=narrationWarnings[0].get('message', ''))


@pytest.mark.asyncio
async def test_verifier_gate_blocks_without_receipts(monkeypatch):
    """update_state(phase='complete') without a verification run is blocked;
    the final answer is withheld (verifierBlocked)."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'tool', 'name': 'update_state', 'arguments': {'phase': 'complete'}},
            {'type': 'text', 'text': 'this answer must be withheld'},
        ],
        verifier_enforced=True,
    )
    toolResults = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'toolResult')
    assert 'Verifier gate' in toolResults
    assert find_event(events, 'verifierBlocked') is not None
    outputs = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'finalOutput')
    assert 'withheld' not in outputs  # nothing leaked
    _record('verifier-gate-blocks', events)


@pytest.mark.asyncio
async def test_verifier_gate_passes_with_receipt(monkeypatch):
    """A passing run_command receipt releases the answer."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'tool', 'name': 'run_command', 'arguments': {'command': 'echo ok'}},
            {'type': 'tool', 'name': 'update_state', 'arguments': {'phase': 'complete'}},
            {'type': 'text', 'text': 'verified answer'},
        ],
        verifier_enforced=True,
    )
    assert find_event(events, 'verifierBlocked') is None
    outputs = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'finalOutput')
    assert 'verified answer' in outputs
    _record('verifier-gate-passes', events)


@pytest.mark.asyncio
async def test_code_mode_executes_fenced_block(monkeypatch):
    """Code mode: a fenced ```python block is executed (not treated as prose),
    its output feeds back, and the turn completes."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'text', 'text': '```python\nprint(2 + 2)\n```'},
            {'type': 'text', 'text': 'the answer is four'},
        ],
        agent_mode='code',
    )
    codeResults = [e for e in events if e.get('type') == 'toolResult' and e.get('name') == 'code_run']
    assert codeResults, 'expected a code_run toolResult'
    content = str(codeResults[0].get('content', ''))
    assert '4' in content or 'Exit code: 0' in content
    assert 'done' in event_types(events)
    _record('code-mode-executes', events, extra=content[:200])


@pytest.mark.asyncio
async def test_chat_mode_blocks_tools(monkeypatch, evalProbe):
    """Chat mode: tool calls are blocked with a clear message; the probe never runs."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'tool', 'name': 'eval_probe', 'arguments': {'arg': 1}},
            {'type': 'text', 'text': 'plain answer'},
        ],
        agent_mode='chat',
    )
    toolResults = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'toolResult')
    assert 'Chat mode' in toolResults
    assert 'probe-ok' not in toolResults
    assert 'done' in event_types(events)
    _record('chat-mode-blocks-tools', events)


@pytest.mark.asyncio
async def test_eval_runs_persist(monkeypatch, evalProbe):
    """record_eval_run writes to the KV store; list_eval_runs reads it back."""
    from app.services.harness_eval import list_eval_runs

    record_eval_run(task_id='persist-check', passed=True, rounds=2, duration_ms=1)
    runs = list_eval_runs(limit=5)
    assert any(r.get('taskId') == 'persist-check' and r.get('passed') for r in runs)


@pytest.mark.asyncio
async def test_text_tool_protocol_executes(monkeypatch, evalProbe):
    """toolSurface='text': a [TOOLCALL] line executes like a native tool call,
    the protocol line is stripped from the assistant text, and the loop
    continues to the next round."""
    def _enable_text_protocol(session):
        session._text_tool_protocol = True

    events, _session = await run_turn(
        monkeypatch,
        script=[
            {
                'type': 'text',
                'text': '[TOOLCALL] eval_probe|{"arg": 1}\n\nchecking the probe',
            },
            {'type': 'text', 'text': 'the probe answered'},
        ],
        session_patch=_enable_text_protocol,
    )
    toolResults = [e for e in events if e.get('type') == 'toolResult']
    assert toolResults, 'expected a toolResult from the text protocol call'
    assert 'probe-ok' in ''.join(str(e.get('content', '')) for e in toolResults)
    # The protocol line must not leak into the session history (streamed
    # text before a tool call is displayed by design — history is what the
    # model sees next round).
    hist_text = ''.join(
        str(m.get('content', ''))
        for m in getattr(_session, 'messages', []) or []
        if m.get('role') == 'assistant'
    )
    assert '[TOOLCALL]' not in hist_text
    assert 'checking the probe' in hist_text
    assert 'done' in event_types(events)
    _record('text-tool-protocol', events)


@pytest.mark.asyncio
async def test_anthropic_wire_format_malformed_self_heal(monkeypatch, evalProbe):
    """Anthropic-format scripted client: malformed tool JSON must NOT execute
    as {} — the input_json_delta `_raw` aggregation path surfaces the
    self-heal (previously only the OpenAI `_invalid_json` path was covered)."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'malformed_tool', 'name': 'eval_probe', 'raw': '{"arg": '},
            {'type': 'text', 'text': 'fixed it'},
        ],
        wire_format='anthropic',
    )
    toolResults = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'toolResult')
    assert '[Validation Error]' in toolResults
    assert 'probe-ok' not in toolResults  # never executed with empty args
    _record('anthropic-malformed-json-self-heal', events)


@pytest.mark.asyncio
async def test_anthropic_wire_format_tool_round_trip(monkeypatch, evalProbe):
    """Anthropic-format scripted client: tool_use blocks execute and the loop
    continues to a final answer (covers the messages_stream caller)."""
    events, _session = await run_turn(
        monkeypatch,
        script=[
            {'type': 'tool', 'name': 'eval_probe', 'arguments': {'arg': 7}},
            {'type': 'text', 'text': 'done via anthropic'},
        ],
        wire_format='anthropic',
    )
    toolResults = ''.join(str(e.get('content', '')) for e in events if e.get('type') == 'toolResult')
    assert 'probe-ok' in toolResults
    assert 'done' in event_types(events)
    _record('anthropic-tool-round-trip', events)


@pytest.mark.asyncio
async def test_downgrade_recovers_and_restores_surface(monkeypatch, evalProbe):
    """A6 regression: repeated malformed calls downgrade the tool surface,
    clean rounds restore it — the downgrade is reversible, not a ratchet."""
    script = (
        [{'type': 'malformed_tool', 'name': 'eval_probe', 'raw': '{"arg": '} for _ in range(3)]
        + [{'type': 'tool', 'name': 'eval_probe', 'arguments': {}} for _ in range(4)]
        + [{'type': 'text', 'text': 'recovered'}]
    )
    events, _session = await run_turn(monkeypatch, script=script)
    warnings = ' '.join(str(e.get('message', '')) for e in events if e.get('type') == 'warning')
    assert 'downgrading the tool surface' in warnings
    assert 'Tool surface restored to full' in warnings
    assert 'done' in event_types(events)
    _record('downgrade-recovery-restore', events)


@pytest.mark.asyncio
async def test_late_stall_hard_stop(monkeypatch):
    """A stall that ignores the reflection nudge is HARD-STOPPED, not just
    nudged (the old eval only asserted the nudge; the script ended before
    the +2 hard-stop could fire)."""
    script = [{'type': 'tool', 'name': 'eval_probe', 'arguments': {}} for _ in range(24)]
    events, _session = await run_turn(monkeypatch, script=script)
    err = find_event(events, 'error')
    assert err is not None
    assert 'did not recover' in str(err.get('message', ''))
    _record('stall-hard-stop', events, extra=str(err.get('message', '')))
