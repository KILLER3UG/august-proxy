"""Workspace path binding — symlink-aware containment checks."""

from __future__ import annotations

from pathlib import Path


def resolve_workspace_root(workspace: str | None) -> Path | None:
    raw = (workspace or '').strip()
    if not raw:
        return None
    try:
        root = Path(raw).expanduser().resolve(strict=False)
    except OSError:
        return None
    if not root.exists() or not root.is_dir():
        return None
    return root


def is_within_root(path: Path, root: Path) -> bool:
    """Return True if ``path`` is ``root`` or a descendant (after resolve)."""
    try:
        resolved = path.expanduser().resolve(strict=False)
        root_resolved = root.resolve(strict=False)
    except OSError:
        return False
    try:
        resolved.relative_to(root_resolved)
        return True
    except ValueError:
        return False


def bind_path(path: str, workspace: str | None, *, for_write: bool = False) -> tuple[Path | None, str | None]:
    """Resolve ``path`` and ensure it stays inside the workspace when set.

    Returns ``(resolved_path, error_message)``. On success error is None.
    When workspace is empty, paths resolve freely (legacy / no-workspace sessions).
    """
    root = resolve_workspace_root(workspace)
    try:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute() and root is not None:
            candidate = root / candidate
        resolved = candidate.resolve(strict=False)
    except OSError as exc:
        return None, f'Error: Invalid path: {exc}'

    if root is None:
        return resolved, None

    if not is_within_root(resolved, root):
        action = 'write' if for_write else 'access'
        return None, (
            f'Error: Sandbox blocked {action} outside workspace. '
            f'path={resolved} workspace={root}'
        )
    return resolved, None


def path_looks_outside_workspace(token: str, workspace: str | None) -> bool:
    """Heuristic: does a shell token point outside the workspace?"""
    root = resolve_workspace_root(workspace)
    if root is None or not token:
        return False
    cleaned = token.strip().strip('"').strip("'")
    if not cleaned or cleaned.startswith('-'):
        return False
    # Home / absolute roots that are clearly outside
    if cleaned in ('~', '/', '\\') or cleaned.startswith('~/') or cleaned.startswith('~\\'):
        home = Path.home().resolve(strict=False)
        if not is_within_root(home, root):
            return True
    try:
        p = Path(cleaned).expanduser()
        if not p.is_absolute():
            return False
        return not is_within_root(p, root)
    except OSError:
        return False
