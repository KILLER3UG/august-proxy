"""Git worktree helpers for isolated sub-agent workspaces (best-effort)."""

from __future__ import annotations

import logging
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger('workbench.worktree')


def _run_git(cwd: Path, *args: str, timeout: float = 60.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['git', *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def is_git_repo(workspace: str) -> bool:
    if not workspace:
        return False
    p = Path(workspace)
    if not p.is_dir():
        return False
    r = _run_git(p, 'rev-parse', '--is-inside-work-tree')
    return r.returncode == 0 and 'true' in (r.stdout or '').lower()


def create_agent_worktree(
    workspace: str,
    *,
    session_id: str = '',
    agent_label: str = 'agent',
) -> dict[str, Any]:
    """Create a linked git worktree next to the repo. Returns path or error."""
    if not workspace or not is_git_repo(workspace):
        return {
            'ok': False,
            'error': 'Workspace is not a git repository — isolation skipped.',
            'path': workspace or '',
        }
    root = Path(workspace).resolve()
    slug = f"{agent_label[:24].replace(' ', '-')}-{uuid.uuid4().hex[:8]}"
    # Sibling folder: ../.august-worktrees/<slug>
    parent = root.parent / '.august-worktrees' / (session_id or 'session')
    parent.mkdir(parents=True, exist_ok=True)
    dest = parent / slug
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    branch = f'august/{slug}'
    # Prefer new branch from HEAD
    r = _run_git(root, 'worktree', 'add', '-b', branch, str(dest))
    if r.returncode != 0:
        # Fallback: detached worktree
        r2 = _run_git(root, 'worktree', 'add', '--detach', str(dest))
        if r2.returncode != 0:
            return {
                'ok': False,
                'error': (r.stderr or r2.stderr or 'git worktree add failed').strip()[:400],
                'path': workspace,
            }
        branch = 'HEAD'
    return {
        'ok': True,
        'path': str(dest),
        'branch': branch,
        'message': f'Isolated worktree at {dest}',
    }


def remove_agent_worktree(workspace: str, worktree_path: str) -> dict[str, Any]:
    """Remove a worktree created by create_agent_worktree."""
    if not workspace or not worktree_path:
        return {'ok': False, 'error': 'missing paths'}
    root = Path(workspace).resolve()
    wt = Path(worktree_path).resolve()
    if not is_git_repo(str(root)):
        shutil.rmtree(wt, ignore_errors=True)
        return {'ok': True, 'removed': str(wt)}
    r = _run_git(root, 'worktree', 'remove', '--force', str(wt))
    if r.returncode != 0:
        shutil.rmtree(wt, ignore_errors=True)
    return {'ok': True, 'removed': str(wt)}


createAgentWorktree = create_agent_worktree
removeAgentWorktree = remove_agent_worktree
isGitRepo = is_git_repo
