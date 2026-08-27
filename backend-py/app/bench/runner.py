"""B0 — the headless ``august-bench`` run engine.

Wraps the REAL workbench loop in ``agent`` mode (no neutered profile):
same tools, same sandbox, same gates. What the bench adds:

* T9 protocol — typed JSONL event stream, ``--output-schema`` final answer,
  typed exit codes (0 ok / 1 error / 42 input / 53 turn-limit);
* budgets — max API rounds, wall-clock cap, optional cost ceiling;
* headless stance — ``AUGUST_HEADLESS=1`` so the T5 approval axis is
  never-ask (fail-closed), guardMode=full so the real sandbox auto-approves
  without banners while still enforcing capability tiers;
* benchmark integrity — the PRE_TOOL_USE integrity hook (no solution/ reads,
  no test/grader modifications, no answer fetching);
* a complete honest ``trajectory.json`` (ATIF-compatible).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.bench.protocol import (
    EXIT_ERROR,
    EXIT_INPUT,
    EXIT_NAMES,
    EXIT_OK,
    EXIT_TURN_LIMIT,
    JsonlWriter,
    map_workbench_event,
    parse_final_answer,
)
from app.bench.trajectory import TrajectoryBuilder

logger = logging.getLogger(__name__)

_TURN_LIMIT_MARKERS = (
    'exceeded maxworkbenchtoolloops',
    'turn-limit',
    'turn limit',
)


@dataclass
class BenchOptions:
    task: str = ''
    task_file: str = ''
    workspace: str = ''
    model: str = ''
    provider: str = ''
    agent_id: str = ''
    sandbox_mode: str = 'workspace-write'
    network_allowlist: list[str] = field(default_factory=list)
    max_turns: int = 50
    max_duration_s: float = 1800.0
    max_cost_usd: float = 0.0  # 0 = no ceiling
    output_schema: dict[str, Any] | None = None
    trajectory_path: str = 'trajectory.json'
    events_path: str = '-'  # '-' = stdout
    run_id: str = ''

    def resolved_task(self) -> str:
        if self.task.strip():
            return self.task.strip()
        if self.task_file.strip():
            try:
                with open(self.task_file, encoding='utf-8') as f:
                    return f.read().strip()
            except OSError:
                return ''
        return ''


def _is_turn_limit_message(message: str) -> bool:
    low = (message or '').lower()
    return any(marker in low for marker in _TURN_LIMIT_MARKERS)


class _RoundBudget:
    """Watches the event stream for budget exhaustion."""

    def __init__(self, opts: BenchOptions, signal: asyncio.Event) -> None:
        self.opts = opts
        self.signal = signal
        self.rounds = 0
        self.exhausted_reason = ''
        self.started = time.monotonic()

    def observe(self, bench_type: str, payload: dict[str, Any]) -> None:
        if self.signal.is_set():
            return
        if bench_type == 'context/pressure':
            self.rounds += 1
            if self.opts.max_turns > 0 and self.rounds > self.opts.max_turns:
                self.exhausted_reason = (
                    f'turn budget exhausted ({self.opts.max_turns} API rounds)'
                )
                self.signal.set()
        elapsed = time.monotonic() - self.started
        if self.opts.max_duration_s > 0 and elapsed > self.opts.max_duration_s:
            self.exhausted_reason = (
                f'wall-clock budget exhausted ({self.opts.max_duration_s:.0f}s)'
            )
            self.signal.set()

    def check_cost(self, session: Any) -> None:
        if self.signal.is_set() or self.opts.max_cost_usd <= 0:
            return
        try:
            cost = float(getattr(session, 'totalCost', 0.0) or 0.0)
        except (TypeError, ValueError):
            return
        if cost > self.opts.max_cost_usd:
            self.exhausted_reason = (
                f'cost ceiling exhausted (${cost:.4f} > ${self.opts.max_cost_usd:.4f})'
            )
            self.signal.set()


async def run_bench(opts: BenchOptions) -> int:
    """One headless bench run. Returns the T9 exit code."""
    # ── input gate (exit 42) ──────────────────────────────────────────────
    task = opts.resolved_task()
    if not task:
        print('august-bench: no task (use --task or --task-file)', file=sys.stderr)
        return EXIT_INPUT
    if not opts.run_id:
        opts.run_id = f'bench_{time.strftime("%Y%m%d")}_{uuid.uuid4().hex[:8]}'

    # ── headless stance BEFORE anything session-related runs ─────────────
    os.environ['AUGUST_HEADLESS'] = '1'

    from app.bench.integrity import register_integrity_hook
    from app.services.workbench import workbench as wb

    events_stream = sys.stdout
    events_file = None
    if opts.events_path and opts.events_path != '-':
        try:
            events_file = open(opts.events_path, 'w', encoding='utf-8')
        except OSError as exc:
            print(f'august-bench: cannot open events file: {exc}', file=sys.stderr)
            return EXIT_INPUT
        events_stream = events_file
    writer = JsonlWriter(events_stream)

    trajectory = TrajectoryBuilder(
        run_id=opts.run_id,
        task=task,
        model=opts.model,
        provider=opts.provider,
    )
    register_integrity_hook(trajectory.integrity_violations)

    writer.write(
        'run/start',
        runId=opts.run_id,
        task=task[:4000],
        model=opts.model,
        provider=opts.provider,
        workspace=opts.workspace,
        sandboxMode=opts.sandbox_mode,
        networkAllowlist=opts.network_allowlist,
        budgets={
            'maxTurns': opts.max_turns,
            'maxDurationS': opts.max_duration_s,
            'maxCostUsd': opts.max_cost_usd,
        },
    )

    exit_code = EXIT_ERROR
    exit_reason = ''
    final_answer = ''
    final_parsed: Any = None
    session: Any = None
    signal = asyncio.Event()
    budget = _RoundBudget(opts, signal)

    try:
        session = wb.createWorkbenchSession(
            provider=opts.provider,
            agentId=opts.agent_id,
            guardMode='full',  # sandbox auto-approve; the REAL sandbox still enforces
            workspacePath=opts.workspace,
            sandboxMode=opts.sandbox_mode,
            # Network is deny-by-default; an allowlist enables the sandbox
            # network axis and is recorded for the environment (the air-gap
            # adapter enforces host-level filtering at setup).
            sandboxNetwork=bool(opts.network_allowlist),
            headless=True,
        )
        try:
            session.agent_mode = 'agent'  # the real loop in agent mode (§9.3 #1)
        except Exception:
            pass

        def emit(ev: dict[str, Any]) -> None:
            if not isinstance(ev, dict):
                return
            mapped = map_workbench_event(ev)
            if mapped is None:
                return
            bench_type, payload = mapped
            event = writer.write(bench_type, **payload)
            trajectory.ingest(event)
            budget.observe(bench_type, payload)
            budget.check_cost(session)

        try:
            await asyncio.wait_for(
                wb.sendWorkbenchMessageStream(
                    session.id,
                    task,
                    provider=opts.provider,
                    agentId=opts.agent_id,
                    model=opts.model,
                    modelProvider=opts.provider,
                    guardMode='full',
                    emit=emit,
                    signal=signal,
                ),
                timeout=max(opts.max_duration_s + 60.0, 120.0),
            )
        except asyncio.TimeoutError:
            budget.exhausted_reason = budget.exhausted_reason or (
                f'wall-clock budget exhausted ({opts.max_duration_s:.0f}s)'
            )

        # ── final answer: what the model actually said last ──────────────
        final_answer = _extract_final_answer(session, trajectory)
        trajectory.final_answer = final_answer

        # ── exit code: budget/error state first, schema gate second ──────
        # Turn-limit wins over a schema failure it caused (53 is the root).
        if budget.exhausted_reason:
            exit_code = EXIT_TURN_LIMIT
            exit_reason = budget.exhausted_reason
        elif trajectory.error:
            if _is_turn_limit_message(trajectory.error):
                exit_code = EXIT_TURN_LIMIT
                exit_reason = trajectory.error
            else:
                exit_code = EXIT_ERROR
                exit_reason = trajectory.error
        elif signal.is_set():
            exit_code = EXIT_TURN_LIMIT
            exit_reason = 'run aborted by budget signal'
        else:
            exit_code = EXIT_OK
            exit_reason = 'completed'

        # ── output schema gate (only downgrades a completed run) ─────────
        if opts.output_schema is not None:
            ok, parsed, reason = parse_final_answer(final_answer, opts.output_schema)
            final_parsed = parsed
            writer.write(
                'answer/schema', ok=ok, reason=reason, parsed=parsed if ok else None
            )
            if not ok and exit_code == EXIT_OK:
                exit_code = EXIT_ERROR
                exit_reason = f'final answer failed --output-schema: {reason}'
    except Exception as exc:
        logger.exception('august-bench run crashed')
        exit_code = EXIT_ERROR
        exit_reason = f'bench run crashed: {exc}'
        writer.write('run/error', message=exit_reason)
    finally:
        session_totals: dict[str, Any] = {}
        if session is not None:
            session_totals = {
                'sessionId': getattr(session, 'id', ''),
                'turnCount': getattr(session, 'turnCount', 0),
                'mutationCount': getattr(session, 'mutationCount', 0),
                'totalInputTokens': getattr(session, 'totalInputTokens', 0),
                'totalOutputTokens': getattr(session, 'totalOutputTokens', 0),
                'totalCost': getattr(session, 'totalCost', 0.0),
                'cacheHitTokens': getattr(session, 'cacheHitTokens', 0),
            }
        trajectory.finish(
            exit_code=exit_code,
            exit_reason=exit_reason,
            final_answer=final_answer,
            final_answer_parsed=final_parsed,
            budgets={
                'maxTurns': opts.max_turns,
                'roundsObserved': budget.rounds,
                'maxDurationS': opts.max_duration_s,
                'maxCostUsd': opts.max_cost_usd,
                'networkAllowlist': opts.network_allowlist,
            },
            session_totals=session_totals,
        )
        try:
            trajectory.write(opts.trajectory_path)
        except OSError as exc:
            print(f'august-bench: cannot write trajectory: {exc}', file=sys.stderr)
        writer.write(
            'run/end',
            runId=opts.run_id,
            exitCode=exit_code,
            exitName=EXIT_NAMES.get(exit_code, 'unknown'),
            exitReason=exit_reason,
            rounds=budget.rounds,
            trajectoryPath=opts.trajectory_path,
            integrityViolations=len(trajectory.integrity_violations),
        )
        if events_file is not None:
            events_file.close()
        from app.bench.integrity import unregister_integrity_hook

        unregister_integrity_hook()
    return exit_code


def _extract_final_answer(session: Any, trajectory: TrajectoryBuilder) -> str:
    """The model's last assistant text — never fabricated.

    Prefers the session transcript (ground truth); falls back to the last
    assistant step text recorded from the stream.
    """
    try:
        messages = getattr(session, 'messages', None) or []
        for msg in reversed(messages):
            if msg.get('role') != 'assistant':
                continue
            content = msg.get('content', '')
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts = [
                    str(block.get('text', ''))
                    for block in content
                    if isinstance(block, dict) and block.get('type') == 'text'
                ]
                text = '\n'.join(p for p in parts if p.strip())
                if text.strip():
                    return text.strip()
    except Exception:
        logger.debug('bench: transcript final-answer extraction failed', exc_info=True)
    for step in reversed(trajectory.steps):
        text = str(step.get('assistant_text') or '').strip()
        if text:
            return text
    return ''


def load_output_schema(path: str) -> dict[str, Any]:
    """Parse ``--output-schema`` (JSON file). Raises ValueError on bad input."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        raise ValueError(f'cannot read output schema {path!r}: {exc}') from exc
    if not isinstance(data, dict):
        raise ValueError('output schema must be a JSON object')
    return data
