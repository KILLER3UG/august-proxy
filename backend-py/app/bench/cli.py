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
import sys

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
    return parser


def main(argv: list[str] | None = None) -> int:
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
    try:
        return asyncio.run(run_bench(opts))
    except KeyboardInterrupt:
        print('august-bench: interrupted', file=sys.stderr)
        return EXIT_INPUT


if __name__ == '__main__':
    raise SystemExit(main())
