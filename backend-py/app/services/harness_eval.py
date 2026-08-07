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

import json
import time
from typing import Any, Callable

from app.json_narrowing import as_str

EVAL_RESULTS_KEY = 'harness_eval:runs'


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


async def run_turn(
    monkeypatch: Any,
    *,
    script: list[dict[str, Any]],
    message: str = 'do the task',
    provider_name: str = 'Eval Provider',
    verifier_enforced: bool = False,
    agent_mode: str = '',
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[list[dict[str, Any]], Any]:
    """Run one real workbench turn against a scripted model.

    Returns ``(events, session)``. Events are the SSE-shaped dicts the loop
    emitted (done/error/toolResult/warning/…).
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
    # ONE client instance for the whole turn: getClient is called per round,
    # and a fresh client would replay the script from round 1 every time.
    client = ScriptedClient(script)
    monkeypatch.setattr(clients, 'getClient', lambda provider: client)
    providerConfig: dict[str, object] = {
        'name': provider_name,
        'apiKey': 'test-key',
        'apiMode': 'openaiChat',
        'modelProfiles': {'eval-model': {'maxOutputTokens': 64000, 'contextWindow': 128000}},
    }
    monkeypatch.setattr(wb, '_resolveChatLlm', lambda **kwargs: (providerConfig, 'eval-model'))
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
