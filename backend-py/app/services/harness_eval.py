"""
Harness eval — scripted-model golden tasks for the workbench loop.

Drives the REAL workbench turn loop with scripted model behaviors (no LLM
calls, no network) and asserts harness properties: termination within budget,
tool round-trips, malformed-JSON self-heal, verifier gating, stall detection,
stream rules. Every scenario records a result row (``harness_eval:runs`` KV)
so the fleet-trends surface can show whether the harness is improving over
time — the loop-level eval harness (Codex ``core/suite`` pattern).

Usage (pytest)::

    from app.services.harness_eval import run_turn, ScriptedClient, record_eval_run
    events, session = await run_turn(monkeypatch, script=[...])
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)

EVAL_RESULTS_KEY = 'harness_eval:runs'
EVAL_LAST_RUN_KEY = 'harness_eval:last_run'
# Golden suite cadence for the background scheduler (6h; manual runs force).
EVAL_SCHEDULE_INTERVAL_S = 6 * 3600


# ── Result persistence (feeds /api/brain/harness/evals + trends) ─────────


def record_eval_run(
    *,
    task_id: str,
    model: str = 'scripted',
    passed: bool,
    rounds: int,
    duration_ms: int,
    notes: str = '',
) -> None:
    """Persist one eval run. Never raises (eval must not break the suite)."""
    try:
        from app.services.memory_store import get_memory, save_memory

        runs = get_memory(EVAL_RESULTS_KEY)
        entries = runs if isinstance(runs, list) else []
        entries.append(
            {
                'taskId': task_id,
                'model': model,
                'passed': bool(passed),
                'rounds': rounds,
                'durationMs': int(duration_ms),
                'notes': notes[:500],
                'at': time.time(),
            }
        )
        save_memory(EVAL_RESULTS_KEY, entries[-200:])
    except Exception:
        pass


def list_eval_runs(limit: int = 50) -> list[dict[str, Any]]:
    """Recent eval runs, newest first (for the Brain evals surface)."""
    try:
        from app.services.memory_store import get_memory

        runs = get_memory(EVAL_RESULTS_KEY)
        if not isinstance(runs, list):
            return []
        entries: list[dict[str, Any]] = []
        for r in runs[-limit:]:
            entries.append(r if isinstance(r, dict) else {})
        return list(reversed(entries))
    except Exception:
        return []


# ── Scripted model client ─────────────────────────────────────────────────


class ScriptedClient:
    """Fake OpenAI-compatible client replaying a scripted round sequence.

    Each spec:
      ``{'type': 'text', 'text': ...}``          — text answer, stop
      ``{'type': 'tool', 'name', 'arguments': {}}`` — one tool call
      ``{'type': 'malformed_tool', 'name', 'raw'}``  — tool call with raw
        (unparseable) arguments — exercises the self-heal path
      ``{'type': 'empty'}``                      — empty stream (upstream
        failure classification)

    When the script is exhausted, a terminating text answer is emitted so the
    loop always ends (assertions target events, not infinite loops).
    """

    def __init__(self, rounds: list[dict[str, Any]]) -> None:
        self.rounds = list(rounds)
        self.call_count = 0

    def resolveApiKey(self) -> str:
        return 'test-key'

    async def chat_completions_stream(self, body: dict[str, Any]):
        self.call_count += 1
        if self.call_count > len(self.rounds):
            yield {
                'choices': [
                    {
                        'index': 0,
                        'delta': {'content': 'Script exhausted — finishing.'},
                        'finish_reason': 'stop',
                    }
                ],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 4},
            }
            return
        spec = self.rounds[self.call_count - 1]
        stype = as_str(spec.get('type'))
        if stype in ('tool', 'malformed_tool'):
            arguments = (
                as_str(spec.get('raw'))
                if stype == 'malformed_tool'
                else json.dumps(spec.get('arguments') or {})
            )
            tc = {
                'index': 0,
                'id': f'call_{self.call_count}',
                'type': 'function',
                'function': {'name': as_str(spec.get('name'), ''), 'arguments': arguments},
            }
            yield {
                'choices': [
                    {'index': 0, 'delta': {'tool_calls': [tc]}, 'finish_reason': 'tool_calls'}
                ],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 4},
            }
        elif stype == 'empty':
            yield {'choices': [], 'usage': {'prompt_tokens': 5, 'completion_tokens': 0}}
        else:
            yield {
                'choices': [
                    {
                        'index': 0,
                        'delta': {'content': as_str(spec.get('text'), 'ok.')},
                        'finish_reason': 'stop',
                    }
                ],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5},
            }


# ── Turn runner ───────────────────────────────────────────────────────────


class _DirectPatch:
    """Minimal duck-typed stand-in for pytest's monkeypatch: setattr with a
    save/restore stack, so ``run_turn`` works outside pytest (the scheduled
    eval runner + POST /api/brain/harness/evals/run)."""

    def __init__(self) -> None:
        self._stack: list[tuple[object, str, object]] = []

    def setattr(self, obj: object, name: str, value: object) -> None:
        self._stack.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self) -> None:
        for obj, name, old in reversed(self._stack):
            try:
                setattr(obj, name, old)
            except Exception:
                pass


async def run_turn(
    monkeypatch: Any = None,
    *,
    script: list[dict[str, Any]],
    message: str = 'do the task',
    provider_name: str = 'Eval Provider',
    verifier_enforced: bool = False,
    agent_mode: str = '',
    emit: Callable[[dict[str, Any]], None] | None = None,
    session_patch: Callable[[Any], None] | None = None,
) -> tuple[list[dict[str, Any]], Any]:
    """Run one real workbench turn against a scripted model.

    Returns ``(events, session)``. Events are the SSE-shaped dicts the loop
    emitted (done/error/toolResult/warning/…).

    ``monkeypatch`` may be pytest's fixture (tests) or ``None`` (scheduled
    runner / endpoint) — when None, a save/restore stand-in is used so the
    real loop is still driven, just without pytest. ``session_patch`` runs
    on the session before the turn starts (capability flags etc.).
    """
    import app.providers.clients as clients

    # Full tool registry (real run_command / update_state / …) so scenario
    # tools actually dispatch — mirrors app startup.
    from app.services.tool_registrations import register_all
    from app.services.workbench import workbench as wb
    from app.services.workbench.workbench import createWorkbenchSession, sendWorkbenchMessageStream

    register_all()

    session = createWorkbenchSession(provider=provider_name, guardMode='full')
    session.verifierEnforced = verifier_enforced
    if agent_mode:
        session.agent_mode = agent_mode
    if session_patch is not None:
        session_patch(session)
    # ONE client instance for the whole turn: getClient is called per round,
    # and a fresh client would replay the script from round 1 every time.
    client = ScriptedClient(script)
    patcher = _DirectPatch() if monkeypatch is None else monkeypatch
    patcher.setattr(clients, 'getClient', lambda provider: client)
    providerConfig: dict[str, object] = {
        'name': provider_name,
        'apiKey': 'test-key',
        'apiMode': 'openaiChat',
        'modelProfiles': {'eval-model': {'maxOutputTokens': 64000, 'contextWindow': 128000}},
    }
    patcher.setattr(wb, '_resolveChatLlm', lambda **kwargs: (providerConfig, 'eval-model'))
    # Hermetic registry: snapshot what existed before register_all and restore
    # it afterwards — eval scenarios must not leak tools into later tests.
    from app.services import tool_registry

    def _registered_names() -> set[str]:
        return {as_str(t.get('name'), '') for t in tool_registry.listTools()}

    before = _registered_names()
    register_all()
    events: list[dict[str, Any]] = []
    try:
        await sendWorkbenchMessageStream(
            sessionId=session.id,
            message=message,
            provider=provider_name,
            emit=events.append if emit is None else emit,
        )
    finally:
        if isinstance(patcher, _DirectPatch):
            patcher.undo()
        for name in _registered_names() - before:
            try:
                tool_registry.unregister(name)
            except Exception:
                pass
    return events, session


def event_types(events: list[dict[str, Any]]) -> list[str]:
    """Convenience: the ordered event types of a run."""
    return [as_str(e.get('type'), '') for e in events]


def find_event(events: list[dict[str, Any]], etype: str) -> dict[str, Any] | None:
    """First event of a type (or None)."""
    for e in events:
        if as_str(e.get('type'), '') == etype:
            return e
    return None


# ── Golden scenario catalog + scheduled runner ────────────────────────────
# Same scenarios the pytest suite drives (tests/test_harness_evals.py), so
# the background scheduler and the "Run evals" button measure the same
# properties. `eval_probe` is registered by the runner (mirrors the test
# fixture) and unregistered afterwards — the registry stays hermetic.


EVAL_SCENARIOS: list[dict[str, Any]] = [
    {
        'taskId': 'well-behaved-turn',
        'script': [{'type': 'text', 'text': 'hello world'}],
        'expect': ['done'],
        'mustNotHave': ['error'],
    },
    {
        'taskId': 'tool-round-trip',
        'script': [
            {'type': 'tool', 'name': 'eval_probe', 'arguments': {'arg': 1}},
            {'type': 'text', 'text': 'done with the probe'},
        ],
        'expect': ['toolResult', 'done'],
        'mustNotHave': ['error'],
    },
    {
        'taskId': 'malformed-json-self-heal',
        'script': [
            {'type': 'malformed_tool', 'name': 'eval_probe', 'raw': '{"arg": '},
            {'type': 'text', 'text': 'fixed it'},
        ],
        'expect': ['done'],
        'mustHaveText': ['[Validation Error]'],
        'mustNotHaveText': ['probe-ok'],  # never executed with empty args
    },
    {
        'taskId': 'empty-response-error',
        'script': [{'type': 'empty'}],
        'expect': ['error'],
        'mustHaveText': ['empty response'],
    },
    {
        'taskId': 'stall-detection',
        'script': [{'type': 'tool', 'name': 'eval_probe', 'arguments': {}} for _ in range(20)],
        'expect': ['warning'],
        'mustHaveText': ['No progress'],
    },
    {
        'taskId': 'verifier-gate-blocks',
        'script': [
            {'type': 'tool', 'name': 'update_state', 'arguments': {'phase': 'complete'}},
            {'type': 'text', 'text': 'this answer must be withheld'},
        ],
        'verifier_enforced': True,
        'expect': ['verifierBlocked'],
    },
    {
        'taskId': 'verifier-gate-passes',
        'script': [
            {'type': 'tool', 'name': 'run_command', 'arguments': {'command': 'echo ok'}},
            {'type': 'tool', 'name': 'update_state', 'arguments': {'phase': 'complete'}},
            {'type': 'text', 'text': 'verified answer'},
        ],
        'verifier_enforced': True,
        'expect': ['done'],
        'mustNotHave': ['verifierBlocked'],
    },
    {
        'taskId': 'stream-rule-narration',
        'script': [
            {'type': 'text', 'text': "I'll use the read_file tool to check the file"},
        ],
        'expect': ['warning'],
        'mustHaveText': ['narrating'],
    },
    {
        'taskId': 'round-cap-runaway',
        'script': [{'type': 'tool', 'name': 'eval_probe', 'arguments': {}} for _ in range(30)],
        'expect': ['error'],
        # The loop stops via the round cap OR the stall hard-stop — either
        # verdict is a pass (never an infinite loop).
        'mustHaveAnyText': ['Tool loop exceeded', 'did not recover'],
    },
]


def _scenario_passed(events: list[dict[str, Any]], spec: dict[str, Any]) -> tuple[bool, str]:
    types = event_types(events)
    missing = [t for t in as_list_of_str(spec.get('expect')) if t not in types]
    if missing:
        return False, f'missing events: {", ".join(missing)}'
    forbidden = [t for t in as_list_of_str(spec.get('mustNotHave')) if t in types]
    if forbidden:
        return False, f'unexpected events: {", ".join(forbidden)}'
    tool_text = ''.join(as_str(e.get('content'), '') for e in events if e.get('type') == 'toolResult')
    warn_text = ' '.join(as_str(e.get('message'), '') for e in events if e.get('type') == 'warning')
    err = find_event(events, 'error')
    err_text = as_str(err.get('message'), '') if err else ''
    all_text = f'{tool_text} {warn_text} {err_text}'.lower()
    for needle in as_list_of_str(spec.get('mustHaveText')):
        if needle.lower() not in all_text:
            return False, f'missing text: {needle!r}'
    anyText = as_list_of_str(spec.get('mustHaveAnyText'))
    if anyText and not any(n.lower() in all_text for n in anyText):
        return False, f'missing any of: {", ".join(anyText)!r}'
    for needle in as_list_of_str(spec.get('mustNotHaveText')):
        if needle.lower() in all_text:
            return False, f'unexpected text: {needle!r}'
    return True, 'ok'


def as_list_of_str(value: object) -> list[str]:
    return [as_str(v, '') for v in value] if isinstance(value, list) else []


async def run_all_scenarios() -> dict[str, Any]:
    """Run every golden scenario through the REAL loop (no pytest, no LLM).

    Used by the background scheduler and POST /api/brain/harness/evals/run.
    Registers the probe tool for the run (fixture equivalent) and restores
    the registry afterwards.
    """
    from app.services import tool_registry

    async def _probe(**kwargs: object) -> str:
        return 'probe-ok'

    tool_registry.register(
        'eval_probe',
        'Eval probe tool.',
        _probe,
        {'type': 'object', 'properties': {}},
    )
    results: list[dict[str, Any]] = []
    try:
        for spec in EVAL_SCENARIOS:
            t0 = time.time()
            try:
                events, _session = await run_turn(
                    None,
                    script=spec['script'],
                    message=as_str(spec.get('message'), 'do the task'),
                    verifier_enforced=bool(spec.get('verifier_enforced')),
                )
                passed, note = _scenario_passed(events, spec)
            except Exception as exc:  # scenario must never break the suite
                events = []
                passed, note = False, f'runner error: {exc}'
            duration_ms = int((time.time() - t0) * 1000)
            record_eval_run(
                task_id=as_str(spec.get('taskId'), ''),
                passed=passed,
                rounds=len(event_types(events)),
                duration_ms=duration_ms,
                notes=note,
            )
            results.append(
                {
                    'taskId': as_str(spec.get('taskId'), ''),
                    'passed': passed,
                    'note': note,
                    'durationMs': duration_ms,
                }
            )
    finally:
        try:
            tool_registry.unregister('eval_probe')
        except Exception:
            pass
    return {
        'results': results,
        'passed': sum(1 for r in results if r['passed']),
        'total': len(results),
    }


def _last_eval_run() -> float:
    try:
        from app.services.memory_store import get_memory

        v = get_memory(EVAL_LAST_RUN_KEY)
        return float(v) if isinstance(v, (int, float)) else 0.0
    except Exception:
        return 0.0


def _mark_eval_run() -> None:
    try:
        from app.services.memory_store import save_memory

        save_memory(EVAL_LAST_RUN_KEY, time.time())
    except Exception:
        pass


async def maybe_run_scheduled_evals(*, force: bool = False) -> dict[str, Any] | None:
    """Run the suite if the interval elapsed (or when forced). Returns the
    result dict, or None when skipped."""
    if not force and (time.time() - _last_eval_run()) < EVAL_SCHEDULE_INTERVAL_S:
        return None
    _mark_eval_run()
    return await run_all_scenarios()


async def scheduled_evals_loop() -> None:
    """Background cadence loop (started at app boot): runs the golden suite
    every interval. Never raises — the harness must not take the app down."""
    while True:
        try:
            await maybe_run_scheduled_evals()
        except Exception:
            logger.exception('scheduled eval run failed')
        await asyncio.sleep(1800)  # re-check every 30 minutes
