"""Part 10 R-C — CI exit-code mode for August code review.

Headless review of a git changeset for users who wire August review into
pipelines (plan §10.5 R-C; R5: in-app review stays advisory — this CLI is
the ONLY place review exposes gate behavior, and only because the user
explicitly invokes it as a gate):

    python -m app.review_cli --repo . --base HEAD
    git diff main | python -m app.review_cli --diff -

Exit codes:
  0  review ran, no blocking findings
  1  blocking findings present (default: any P0/P1; tune with --block-on)
  2  review did not run (skipped: no model configured, oversized diff,
     failure) — the gate cannot attest; the pipeline decides pass-vs-fail
  3  usage or environment error (bad arguments, git failed)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

EXIT_CLEAN = 0
EXIT_BLOCKING = 1
EXIT_NOT_RUN = 2
EXIT_USAGE = 3

_BLOCK_LEVELS = {'p0': 0, 'p1': 1, 'p2': 2}


def _git_diff(repo: str, base: str) -> tuple[str, list[str]]:
    """Working tree vs ``base`` (tracked changes; untracked files are not
    part of ``git diff``). Raises RuntimeError on git failure."""
    try:
        names = subprocess.run(
            ['git', 'diff', '--name-only', base],
            cwd=repo,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
        )
        diff = subprocess.run(
            ['git', 'diff', base],
            cwd=repo,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
        )
    except OSError as exc:
        raise RuntimeError(f'git unavailable: {exc}') from exc
    if names.returncode != 0 or diff.returncode != 0:
        err = (names.stderr or diff.stderr or '').strip().splitlines()
        raise RuntimeError(err[0] if err else f'git diff failed (exit {diff.returncode})')
    paths = [ln.strip() for ln in names.stdout.splitlines() if ln.strip()]
    return diff.stdout, paths


def _read_diff_file(path: str) -> str:
    if path == '-':
        return sys.stdin.read()
    return Path(path).read_text(encoding='utf-8', errors='replace')


def _print_human(result: dict, repo: str, base: str, blockLevel: int) -> int:
    counts = result.get('counts', {})
    findings = result.get('findings', [])
    blocking = [f for f in findings if int(f.get('severity', 3)) <= blockLevel]
    print(f'August review — {repo}' + (f' (base {base})' if base else ''))
    if result.get('model'):
        print(f"Model: {result['model']} | passes: {result.get('passes', 1)}", end='')
        judge = result.get('judge') or {}
        if judge:
            state = 'ran' if judge.get('ran') else f"skipped ({judge.get('reason', 'n/a')})"
            print(f' | judge: {state}', end='')
        print()
    print(
        'Findings: P0={p0} P1={p1} P2={p2} P3={p3} (dropped ungrounded: {d})'.format(
            p0=counts.get('p0', 0),
            p1=counts.get('p1', 0),
            p2=counts.get('p2', 0),
            p3=counts.get('p3', 0),
            d=result.get('droppedUngrounded', 0),
        )
    )
    for finding in findings:
        where = finding.get('file') or '?'
        line = finding.get('line') or 0
        anchor = f'{where}:{line}' if line else where
        tag = finding.get('tag', 'P?')
        title = finding.get('title', '').strip()
        marker = ' [blocking]' if finding in blocking else ''
        print(f'\n[{tag}] {anchor} — {title}{marker}')
        body = (finding.get('body') or '').strip()
        if body:
            first = body.splitlines()[0]
            print(f'      {first}')
    if blocking:
        print(f'\n{len(blocking)} blocking finding(s) — gate fails.')
        return EXIT_BLOCKING
    print('\nNo blocking findings.')
    return EXIT_CLEAN


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog='august-review',
        description='Advisory AI code review with CI exit codes (plan Part 10 R-C).',
    )
    parser.add_argument('--repo', default='.', help='git repository to review (default: cwd)')
    parser.add_argument('--base', default='HEAD', help='diff base ref (default: HEAD)')
    parser.add_argument(
        '--diff',
        default='',
        help="read the diff from a file instead of git ('-' for stdin)",
    )
    parser.add_argument('--model', default='', help='reviewer model hint')
    parser.add_argument('--judge-model', default='', help='independent judge model hint (R-B)')
    parser.add_argument('--passes', type=int, default=1, help='reviewer passes 1..3 (exhaustive merge)')
    parser.add_argument(
        '--block-on',
        choices=sorted(_BLOCK_LEVELS),
        default='p1',
        help='lowest severity that fails the gate (default: p1 — P0 and P1 block)',
    )
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args(argv)

    repo = str(Path(args.repo).resolve())
    diff_text = ''
    changed_paths: list[str] = []
    base = ''
    try:
        if args.diff:
            diff_text = _read_diff_file(args.diff)
        else:
            base = args.base
            diff_text, changed_paths = _git_diff(repo, base)
    except (OSError, RuntimeError) as exc:
        print(f'august-review: {exc}', file=sys.stderr)
        return EXIT_USAGE

    from app.services.code_review import run_code_review_async

    result = asyncio.run(
        run_code_review_async(
            workspace=repo,
            diff_text=diff_text,
            file_count=len(changed_paths),
            changed_paths=changed_paths or None,
            model_hint=args.model,
            judge_model_hint=args.judge_model,
            max_passes=args.passes,
        )
    )

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    if result.get('skipped'):
        notice = result.get('notice', 'review skipped')
        print(f'august-review: skipped — {notice}', file=sys.stderr)
        return EXIT_NOT_RUN

    blockLevel = _BLOCK_LEVELS[args.block_on]
    if args.json:
        blocking = [f for f in result.get('findings', []) if int(f.get('severity', 3)) <= blockLevel]
        return EXIT_BLOCKING if blocking else EXIT_CLEAN
    return _print_human(result, repo, base, blockLevel)


if __name__ == '__main__':
    raise SystemExit(main())
