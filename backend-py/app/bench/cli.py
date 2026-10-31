"""B0/T9 — ``august-bench`` command-line entry.

Usage:
    python -m app.bench --task "Fix the failing test in src/" \
        --workspace /path/to/repo --model gpt-4o --max-turns 30 \
        --output-schema answer.schema.json --trajectory trajectory.json

Exit codes (T9): 0 ok · 1 error · 42 input · 53 turn-limit.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from contextvars import Token

from app.bench.protocol import EXIT_INPUT
from app.bench.runner import BenchOptions, load_output_schema, run_bench


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='august-bench',
        description=(
            'Headless August harness run for benchmarks (real workbench loop, '
            'agent mode). Emits a typed JSONL event stream and writes an '
            'ATIF-compatible trajectory.json.'
        ),
    )
    parser.add_argument('--task', default='', help='the task prompt')
    parser.add_argument('--task-file', default='', help='read the task prompt from a file')
    parser.add_argument('--workspace', default='', help='workspace directory the run operates on')
    parser.add_argument('--model', default='', help='model id (provider default when empty)')
    parser.add_argument('--provider', default='', help='provider id (default provider when empty)')
    parser.add_argument('--agent-id', default='', help='agent profile id')
    parser.add_argument(
        '--sandbox-mode',
        default='workspace-write',
        help='sandbox capability tier (read-only | workspace-write | full-access)',
    )
    parser.add_argument(
        '--network-allowlist',
        default='',
        help=(
            'comma-separated host allowlist; enables the sandbox network axis '
            'and is recorded for the environment adapter (empty = network denied)'
        ),
    )
    parser.add_argument('--max-turns', type=int, default=50, help='max API rounds (exit 53)')
    parser.add_argument(
        '--max-duration-s', type=float, default=1800.0, help='wall-clock budget in seconds'
    )
    parser.add_argument(
        '--max-cost-usd', type=float, default=0.0, help='cost ceiling in USD (0 = off)'
    )
    parser.add_argument(
        '--output-schema',
        default='',
        help='JSON Schema file the final answer must satisfy',
    )
    parser.add_argument(
        '--trajectory', default='trajectory.json', help='trajectory.json output path'
    )
    parser.add_argument(
        '--events',
        default='-',
        help="JSONL event stream destination ('-' = stdout)",
    )
    parser.add_argument('--run-id', default='', help='run id (generated when empty)')
    parser.add_argument(
        '--memory-state',
        choices=('inherit', 'on', 'off'),
        default='inherit',
        help=(
            'force the recalled-facts lane for this run instead of inheriting the '
            'stored `memoryAutoInject`. This is the arm of a paired lift: run the '
            'same task and script twice, on and off, and the only thing that '
            'differs is the memory tail. Requires an isolated HARNESS_DATA_DIR when '
            'combined with --memory-corpus, and it ASSERTS the arm took effect — '
            'a run where `on` produced no recall block exits 43 rather than '
            'reporting a lift of zero.'
        ),
    )
    parser.add_argument(
        '--memory-corpus',
        default='',
        help=(
            'path to a JSON array of facts to write into the store before the run: '
            '[{"key": "...", "value": "...", "kind": "lesson", "category": "general"}]. '
            'Without a corpus the two arms render identically and the comparison is '
            'vacuous. Refused unless HARNESS_DATA_DIR is set explicitly, because '
            'otherwise this writes durable facts into the real brain database.'
        ),
    )
    parser.add_argument(
        '--context-window',
        type=int,
        default=0,
        help=(
            'shrink the window auto-compact and the overflow rescue measure against '
            '(0 = the model real window; the resolver floors at 8192). This is how a '
            'reactive overflow is forced deterministically instead of by a transcript '
            'big enough to overflow a real model.'
        ),
    )
    parser.add_argument(
        '--script',
        default='',
        help=(
            'path to a JSON script of canned assistant rounds (see '
            'app/bench/scripted_provider.py). When set the loop talks to a scripted '
            'provider instead of a network: a multi-round tool turn can be driven '
            'with no API credit, and every request body the loop built is recorded '
            'so an assertion is about what would have gone to the provider.'
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # The event stream is JSON on stdout, and a workbench event routinely
    # contains a character cp1252 cannot encode — an arrow in a tool receipt, a
    # ± in a measure, box-drawing in a diff. On a Windows console that raised
    # UnicodeEncodeError inside the writer and the run died as
    # "bench run crashed", which looks like a loop bug and is a stream bug.
    # Reconfigure both streams before anything can write to them.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, 'reconfigure', None)
        if callable(reconfigure):
            try:
                reconfigure(encoding='utf-8', errors='replace')
            except (OSError, ValueError):
                pass
    args = build_parser().parse_args(argv)

    opts = BenchOptions(
        task=args.task,
        task_file=args.task_file,
        workspace=args.workspace,
        model=args.model,
        provider=args.provider,
        agent_id=args.agent_id,
        sandbox_mode=args.sandbox_mode,
        network_allowlist=[
            h.strip() for h in (args.network_allowlist or '').split(',') if h.strip()
        ],
        max_turns=args.max_turns,
        max_duration_s=args.max_duration_s,
        max_cost_usd=args.max_cost_usd,
        trajectory_path=args.trajectory,
        events_path=args.events,
        run_id=args.run_id,
        context_window=args.context_window,
        script_path=args.script,
        memory_state='' if args.memory_state == 'inherit' else args.memory_state,
        memory_corpus=args.memory_corpus,
    )
    if args.output_schema:
        try:
            opts.output_schema = load_output_schema(args.output_schema)
        except ValueError as exc:
            print(f'august-bench: {exc}', file=sys.stderr)
            return EXIT_INPUT
    if args.max_turns <= 0:
        print('august-bench: --max-turns must be positive', file=sys.stderr)
        return EXIT_INPUT
    # The corpus is a durable write into whatever store this process points at.
    # `dataDir()` falls back to the live app data directory when HARNESS_DATA_DIR
    # is unset, so without this gate `--memory-corpus` would seed facts into the
    # user's real brain database — the exact isolation failure AGENTS.md records
    # for the old test suite. Refuse rather than default to a safe path, because
    # a silently-chosen temp dir would also make a lift un-reproducible.
    if opts.memory_corpus and not os.environ.get('HARNESS_DATA_DIR'):
        print(
            'august-bench: --memory-corpus writes durable facts, so it requires an '
            'explicit HARNESS_DATA_DIR pointing at a throwaway directory. Refusing to '
            'seed the live store.',
            file=sys.stderr,
        )
        return EXIT_INPUT
    if opts.memory_corpus and not opts.memory_state:
        print(
            'august-bench: --memory-corpus without --memory-state cannot show a '
            'lift; pass --memory-state on and off for the two arms.',
            file=sys.stderr,
        )
        return EXIT_INPUT
    token = _apply_context_window_override(opts.context_window)
    if token is not None:
        print(f'august-bench: context window overridden to {opts.context_window} tokens', file=sys.stderr)
    mem_token = _apply_memory_state_override(opts.memory_state)
    if mem_token is not None:
        print(f'august-bench: memory state forced to {opts.memory_state}', file=sys.stderr)
    try:
        return asyncio.run(run_bench(opts))
    except KeyboardInterrupt:
        print('august-bench: interrupted', file=sys.stderr)
        return EXIT_INPUT
    finally:
        if token is not None:
            from app.services.workbench.context import contextWindowOverride

            contextWindowOverride.reset(token)
        if mem_token is not None:
            from app.services.memory_store.fact_retrieval import memoryStateOverride

            memoryStateOverride.reset(mem_token)


def _apply_memory_state_override(state: str) -> Token[str] | None:
    """Publish the forced memory arm for the whole run, or None when inheriting.

    Same shape as `_apply_context_window_override`: a ContextVar, set before
    `asyncio.run` copies the context into the run's task, and reset in the
    `finally` so a long-lived process that runs the bench twice does not carry
    the first run's arm into the second.
    """
    from app.services.memory_store.fact_retrieval import memoryStateOverride

    if state not in ('on', 'off'):
        return None
    return memoryStateOverride.set(state)


def _apply_context_window_override(tokens: int) -> Token[int] | None:
    """Publish the shrunk window for the whole run, or None when there is none.

    A ContextVar rather than a session field because the loop resolves the window
    from the MODEL (`workbench._resolveModelContextWindow`), not from the session, so
    there is no session attribute it would consult. Set here, before `asyncio.run`
    copies the context into the run's task.
    """
    from app.services.workbench.context import contextWindowOverride

    if tokens <= 0:
        return None
    token: Token[int] = contextWindowOverride.set(tokens)
    return token


if __name__ == '__main__':
    raise SystemExit(main())
