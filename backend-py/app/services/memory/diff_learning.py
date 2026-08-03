"""Diff learning — durable correction rules learned from git history.

The conversation review learns from what the user says; the edit-diff engine
learns from live edits. This pass learns from the third signal: the record of
changes the user actually committed. Filtered diffs of the most recent commits
are summarized by the configured model into durable correction rules
(specific, with WHY, anti-patterns, opinionated over best practices), which
land in ``learned_heuristics`` with a confidence score.

Gating: feature flag ``diff_learning`` (default on; toggle in the Brain →
Cognitive Ops → Feature flags UI) plus a per-workspace interval (default 6h,
env ``AUGUST_DIFF_LEARN_INTERVAL_S``). Non-git workspaces and repos without
commits are cheap no-ops.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Awaitable, Callable

_log = logging.getLogger(__name__)

_DIFF_LEARN_INTERVAL_S = 6 * 3600
_MAX_COMMITS = 20
_MAX_TOTAL_CHARS = 12000
_MAX_PER_COMMIT_CHARS = 3000
_LAST_RUN_PREFIX = 'diff_learn:last_run:'

# Paths that carry no learning signal — lockfiles, build output, vendored code.
_NOISE_PATH_PATTERNS = re.compile(
    r'(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|'
    r'Gemfile\.lock|composer\.lock|.*\.lock$|dist/|build/|out/|node_modules/|\.git/|'
    r'__pycache__|.*\.min\.js$|.*\.map$|.*\.pyc$|\.DS_Store|.*\.log$)',
    re.IGNORECASE,
)

_LEARN_PROMPT = """You analyze code changes to learn the developer's coding taste.

Below are recent commit diffs (noise-filtered). Derive DURABLE correction rules the
developer revealed through their edits — the patterns they keep applying.

Requirements:
- Be SPECIFIC, not generic: "Use branded types for entity IDs instead of any", not "Use TypeScript".
- Capture the WHY where the diff makes it visible (renames, rewrites, migrations).
- Record ANTI-PATTERNS: patterns the developer repeatedly removes or reverts.
- Prefer OPINIONATED preferences over industry best practices — the goal is taste
  that makes their code distinctly theirs.
- Never record one-off task details, generic tool preferences, or version bumps.
- When nothing durable is revealed, respond with an empty list.

Respond with a JSON object only (no markdown, no code fences):
{"corrections": [{"rule": "...", "confidence": 0.0-1.0}]}
"""


def _last_run_key(workspace_path: str) -> str:
    digest = hashlib.sha256(workspace_path.encode('utf-8')).hexdigest()[:16]
    return f'{_LAST_RUN_PREFIX}{digest}'


def _interval_seconds() -> int:
    raw = os.environ.get('AUGUST_DIFF_LEARN_INTERVAL_S', '').strip()
    if not raw:
        return _DIFF_LEARN_INTERVAL_S
    try:
        return max(60, int(raw))
    except ValueError:
        return _DIFF_LEARN_INTERVAL_S


def _is_due(workspace_path: str) -> bool:
    from app.services.memory_store import get_memory

    raw = get_memory(_last_run_key(workspace_path))
    if not isinstance(raw, dict):
        return True
    at = str(raw.get('at') or '')
    if not at:
        return True
    try:
        last = datetime.fromisoformat(at.replace('Z', '+00:00'))
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    age_s = (datetime.now(timezone.utc) - last).total_seconds()
    return age_s >= _interval_seconds()


def _mark_run(workspace_path: str) -> None:
    from app.services.memory_store import save_memory

    save_memory(
        _last_run_key(workspace_path),
        {'at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')},
    )


def _run_git(args: list[str], cwd: str) -> str:
    """Run a git command in ``cwd``; returns stdout or '' on any failure."""
    try:
        result = subprocess.run(
            ['git', *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ''
    if result.returncode != 0:
        return ''
    return result.stdout


def _is_noise_path(path: str) -> bool:
    return bool(_NOISE_PATH_PATTERNS.search(path))


def collect_correction_diffs(
    workspace_path: str,
    max_commits: int = _MAX_COMMITS,
    max_chars: int = _MAX_TOTAL_CHARS,
) -> str:
    """Collect noise-filtered diffs from the most recent commits.

    Returns a bounded, labeled diff context ('' for non-git or empty repos).
    """
    hashes = [
        h
        for h in _run_git(
            ['log', f'-n{max_commits}', '--pretty=format:%H'], workspace_path
        ).splitlines()
        if h.strip()
    ]
    if not hashes:
        return ''
    parts: list[str] = []
    total = 0
    for commit_hash in hashes:
        if total >= max_chars:
            break
        names = [
            p
            for p in _run_git(
                ['show', '--format=', '--name-only', commit_hash], workspace_path
            ).splitlines()
            if p.strip()
        ]
        paths = [p for p in names if not _is_noise_path(p)]
        if not paths:
            continue
        diff = _run_git(
            ['show', '--format=', '--unified=1', commit_hash, '--', *paths],
            workspace_path,
        )
        if not diff.strip():
            continue
        diff = diff[: _MAX_PER_COMMIT_CHARS]
        header = f'--- commit {commit_hash[:8]} ---'
        block = f'{header}\n{diff}'
        total += len(block)
        if total > max_chars:
            block = block[: max_chars - (total - len(block))]
        parts.append(block)
    return '\n\n'.join(parts)


def _parse_corrections(raw: str) -> list[dict[str, object]]:
    text = raw.strip()
    if text.startswith('```'):
        lines = text.split('\n', 1)
        text = lines[1] if len(lines) > 1 else ''
        if text.endswith('```'):
            text = text[:-3]
    text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        text = text.replace("'", '"')
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
    corrections = data.get('corrections') if isinstance(data, dict) else None
    if not isinstance(corrections, list):
        return []
    out: list[dict[str, object]] = []
    for c in corrections:
        if isinstance(c, str):
            out.append({'rule': c})
        elif isinstance(c, dict):
            rule = str(c.get('rule') or '').strip()
            if rule:
                out.append({'rule': rule, 'confidence': c.get('confidence')})
    return out


async def learn_from_diffs(
    workspace_path: str,
    llm_client: Callable[[list[dict[str, object]]], Awaitable[str]] | None = None,
) -> dict[str, object]:
    """Learn correction rules from recent git history (gated + background-safe).

    Returns ``{'learned': n, 'skipped': n, 'reason': str}``. Every gate
    (feature flag, interval, git availability, empty diffs, missing client)
    is a cheap early return so this can be spawned after every turn.
    """
    result: dict[str, object] = {'learned': 0, 'skipped': 0, 'reason': ''}
    try:
        from app.services.cognitive_config import get_features

        features = get_features()
        if not features.get('diff_learning', True) or not features.get('heuristics', True):
            result['reason'] = 'feature_disabled'
            return result
    except Exception:
        result['reason'] = 'feature_check_failed'
        return result
    if not workspace_path or not workspace_path.strip():
        result['reason'] = 'no_workspace'
        return result
    if llm_client is None:
        result['reason'] = 'no_llm_client'
        return result
    if not _is_due(workspace_path):
        result['reason'] = 'interval'
        return result
    try:
        diffs = collect_correction_diffs(workspace_path)
    except Exception:
        diffs = ''
    if not diffs.strip():
        result['reason'] = 'no_diffs'
        return result
    try:
        raw = await llm_client(
            [
                {'role': 'system', 'content': _LEARN_PROMPT},
                {'role': 'user', 'content': diffs[: _MAX_TOTAL_CHARS]},
            ]
        )
    except Exception:
        result['reason'] = 'llm_failed'
        return result
    corrections = _parse_corrections(raw)
    if not corrections:
        _mark_run(workspace_path)
        result['reason'] = 'nothing_durable'
        return result
    from app.services.heuristics_service import addHeuristic

    learned = 0
    skipped = 0
    for c in corrections:
        try:
            added = addHeuristic(
                str(c.get('rule') or '').strip(),
                source='diff',
                category='correction',
                confidence=c.get('confidence'),
            )
            if added is not None:
                learned += 1
            else:
                skipped += 1
        except Exception as exc:
            skipped += 1
            _log.warning('diff_learning: heuristic write failed: %s', exc)
    # Only mark the interval when everything succeeded — otherwise real
    # failures would suppress learning for the whole interval invisibly.
    if skipped == 0:
        _mark_run(workspace_path)
    result['learned'] = learned
    result['skipped'] = skipped
    return result
