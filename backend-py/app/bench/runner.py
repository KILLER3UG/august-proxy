"""B0 — the headless ``august-bench`` run engine.

Wraps the REAL workbench loop in ``agent`` mode (no neutered profile):
same tools, same sandbox, same gates. What the bench adds:

* T9 protocol — typed JSONL event stream, ``--output-schema`` final answer,
  typed exit codes (0 ok / 1 error / 42 input / 53 turn-limit);
* budgets — max API rounds, wall-clock cap, optional cost ceiling;
* headless stance — ``HARNESS_HEADLESS=1`` so the T5 approval axis is
  never-ask (fail-closed), guardMode=full so the real sandbox auto-approves
  without banners while still enforcing capability tiers;
* benchmark integrity — the PRE_TOOL_USE integrity hook (no solution/ reads,
  no test/grader modifications, no answer fetching);
* a complete honest ``trajectory.json`` (ATIF-compatible).
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.bench.protocol import (
    EXIT_CONTROL,
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
    # Shrink the window the compressor measures against, so an overflow is reached
    # by lowering a number (DS Bot's dev/bench.sh). 0 = use the model's real window.
    context_window: int = 0
    #: Path to a JSON script of canned assistant rounds. When set, the loop talks
    #: to `bench.scripted_provider` instead of a network, so a multi-round tool
    #: turn can be driven with no API credit and every request body is recorded.
    script_path: str = ''
    #: The forced memory arm: '' (inherit), 'on', or 'off'. Published as a
    #: ContextVar by the CLI; carried here so the run can assert it took effect.
    memory_state: str = ''
    #: Path to a JSON array of facts to seed before the run. Without a corpus the
    #: on/off arms render identical prompts and the comparison proves nothing.
    memory_corpus: str = ''
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
    os.environ['HARNESS_HEADLESS'] = '1'

    # Create the brain schema the same way app startup does. The bench drives the
    # loop in-process and never runs the app's lifespan, so on a throwaway data
    # directory there is NO brain database schema at all — measured: a run that
    # called `remember` and `list_facts` left the file with 0 tables while both
    # tools returned ok. `list_facts` reported `count: 0` for a missing table,
    # which is indistinguishable from an empty store, so a broken memory path
    # looked like a memory that simply had nothing in it. Bootstrapping here
    # makes the bench's isolated store behave like a real one.
    try:
        from app.services.memory_conn import conn as _mem_conn
        from app.services.memory_schema import ensure_schema as _ensure_schema

        with _mem_conn() as _schemaConn:
            _ensure_schema(_schemaConn)
    except Exception as exc:
        # Loud, not swallowed: a bench that cannot build its own store must say
        # so, or every later memory assertion is vacuous.
        print(f'august-bench: brain schema bootstrap failed: {exc}', file=sys.stderr)
        return EXIT_ERROR

    # The scripted provider is a test fixture, not a product setting: it is
    # installed for one run and the store it was armed in is put back in the
    # run's `finally`. Without the restore, running the bench rewrote the
    # user's default provider to a dead localhost entry (and created a
    # providers.json in a checkout), so the next normal chat failed until the
    # user found and fixed the store by hand.
    scripted_previous_client: Any = None
    # Bound unbound-safe: `--memory-state` is legal without `--script`, and the
    # arm gate below reads this to decide whether it can assert anything at all.
    scripted_client: Any = None
    saved_providers_store: dict[str, Any] | None = None
    if opts.script_path:
        # The seam (`app.providers.clients.getClient`) is resolved at call time
        # by every caller, so patching it here reaches the real loop without
        # the loop knowing it is being driven.
        from app.bench.scripted_provider import arm_providers_store, install, load_script
        from app.services import config_service

        try:
            scripted_client = load_script(opts.script_path)
        except (OSError, ValueError) as exc:
            print(f'august-bench: cannot read --script: {exc}', file=sys.stderr)
            return EXIT_INPUT
        saved_providers_store = copy.deepcopy(config_service.getProvidersStore())
        try:
            arm_providers_store()
            scripted_previous_client = install(scripted_client)
        except Exception:
            config_service.saveProvidersStore(saved_providers_store)
            raise
        print(
            f'august-bench: scripted provider armed with {len(scripted_client.rounds)} round(s) '
            f'from {opts.script_path} — no request leaves this process',
            file=sys.stderr,
        )

    if opts.memory_corpus:
        seeded, seed_error = _seed_memory_corpus(opts.memory_corpus)
        if seed_error:
            print(f'august-bench: cannot seed --memory-corpus: {seed_error}', file=sys.stderr)
            return EXIT_INPUT
        print(
            f'august-bench: seeded {seeded} fact(s) into '
            f'{os.environ.get("HARNESS_DATA_DIR", "?")} (arm={opts.memory_state or "inherit"})',
            file=sys.stderr,
        )

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

    # The app's lifespan registers the tool families; a bench run has no
    # lifespan, so without this every tool call comes back `Tool "x" not found`
    # — which reads like a loop bug and is a bootstrap gap. Idempotent by
    # construction (the registry keys by name).
    from app.services.tool_registrations import register_all

    register_all()

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

        # ── memory-arm gate: prove the control actually fired ────────────
        # Without this, a lift of zero is ambiguous: it could mean memory does
        # not help, or it could mean both arms ran identical prompts because the
        # corpus was empty, the recall query matched nothing, or the override
        # never reached the loop. Those are different findings and only one of
        # them is about memory.
        if opts.memory_state and scripted_client is not None:
            arm_error, arm_report = _assert_memory_arm_applied(opts.memory_state, scripted_client)
            writer.write('memory/arm', **arm_report)
            if arm_error:
                print(f'august-bench: {arm_error}', file=sys.stderr)
                # A distinct code: the run worked, the CONTROL did not.
                exit_code = EXIT_CONTROL
                exit_reason = arm_error
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
        if scripted_previous_client is not None:
            from app.bench.scripted_provider import uninstall

            uninstall(scripted_previous_client)
        if saved_providers_store is not None:
            from app.services import config_service

            config_service.saveProvidersStore(saved_providers_store)
    return exit_code


_RECALL_MARKER = 'Relevant memory:'


def _seed_memory_corpus(path: str) -> tuple[int, str]:
    """Write the corpus facts into the current store. ``(count_written, error)``.

    Keys are namespaced `bench:` so a seeded corpus is identifiable and can be
    told apart from a real learned fact. The CLI has already refused to get here
    without an explicit `HARNESS_DATA_DIR`, which is what keeps this off the
    user's brain database.
    """
    import json

    from app.services.memory_conn import conn
    from app.services.memory_schema import ensure_schema
    from app.services.memory_store import save_fact

    try:
        raw = json.loads(Path(path).read_text(encoding='utf-8'))
    except OSError as exc:
        return 0, f'{exc}'
    except ValueError as exc:
        return 0, f'not valid JSON: {exc}'
    if not isinstance(raw, list) or not raw:
        return 0, 'corpus must be a non-empty JSON array of fact objects'
    # The bench drives the loop in-process and never runs the app's startup, so
    # on a throwaway data directory the brain schema does not exist yet and the
    # first write dies on `no such table: facts`. Creating it here is the same
    # bootstrap the app performs at boot, not a parallel schema.
    with conn() as migration_conn:
        ensure_schema(migration_conn)
    written = 0
    for entry in raw:
        if not isinstance(entry, dict):
            return written, 'every corpus entry must be an object'
        value = str(entry.get('value') or '').strip()
        if not value:
            return written, 'corpus entry has no non-empty "value"'
        key = str(entry.get('key') or f'fact-{written}').strip()
        save_fact(
            f'bench:{key}',
            value,
            category=str(entry.get('category') or 'general'),
            source='bench',
            kind=str(entry.get('kind') or 'lesson'),
        )
        written += 1
    return written, ''


def _body_has_recall(body: object) -> bool:
    """True when a request body actually carries the recalled-facts tail.

    Deliberately narrow, because the first version of this matched the marker
    anywhere in any message and so passed the `off` arm too: the system prompt
    NAMES the `Relevant memory:` section while describing the memory policy, and
    a substring test cannot tell a section being described from a section being
    shipped. Two constraints fix it — user role only (the tail is appended to the
    user message), and the marker must start a line.

    Never checks tool definitions or the system message, for the same reason: an
    assertion that can be satisfied by prose about the feature is not an
    assertion about the feature.
    """
    if not isinstance(body, dict):
        return False
    messages = body.get('messages')
    if not isinstance(messages, list):
        return False
    for msg in messages:
        if not isinstance(msg, dict) or msg.get('role') != 'user':
            continue
        content = msg.get('content')
        parts: list[str] = []
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get('text'), str):
                    parts.append(block['text'])
        for part in parts:
            if any(line.startswith(_RECALL_MARKER) for line in part.splitlines()):
                return True
    return False


def _assert_memory_arm_applied(state: str, client: Any) -> tuple[str | None, dict[str, Any]]:
    """Require the forced arm to be visible in what would have gone to the provider.

    Returns ``(error_or_None, report)``. The report is emitted either way, so a
    passing run still shows the evidence rather than just a green tick.
    """
    bodies = list(getattr(client, 'requests', []) or [])
    hits = sum(1 for b in bodies if _body_has_recall(b))
    report = {
        'state': state,
        'requests': len(bodies),
        'withRecallBlock': hits,
    }
    if not bodies:
        return (
            'memory arm was not exercised: the scripted provider recorded no '
            'request body, so nothing can be asserted about it',
            report,
        )
    if state == 'on' and hits == 0:
        return (
            f'--memory-state on produced no {_RECALL_MARKER!r} block in any of the '
            f'{len(bodies)} recorded request bodies. Either the corpus did not seed, '
            'the recall query matched nothing, or the override did not reach the '
            'loop. A lift measured here would be a measurement of nothing.',
            report,
        )
    if state == 'off' and hits > 0:
        return (
            f'--memory-state off still produced {_RECALL_MARKER!r} in {hits} of '
            f'{len(bodies)} request bodies — the arm is decorative, so the two '
            'arms are not comparable',
            report,
        )
    return None, report


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
