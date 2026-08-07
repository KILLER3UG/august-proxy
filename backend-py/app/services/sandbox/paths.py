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

    Hardline protected paths are blocked first, in every mode and with or
    without a workspace.
    """
    root = resolve_workspace_root(workspace)
    try:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute() and root is not None:
            candidate = root / candidate
        resolved = candidate.resolve(strict=False)
    except OSError as exc:
        return None, f'Error: Invalid path: {exc}'

    from app.services.sandbox.hardline import check_hardline_path

    denial = check_hardline_path(str(resolved), for_write=for_write)
    if denial:
        return None, (
            f'Error: Sandbox hardline blocked {denial}. '
            'This path is protected in every sandbox mode, including Full access.'
        )

    if root is None:
        # No workspace configured: reads resolve freely (shell parity), but
        # WRITES are gated to the system temp area — otherwise a session
        # without a bound folder could scatter files anywhere on the machine.
        if for_write:
            import tempfile

            try:
                resolved.relative_to(Path(tempfile.gettempdir()).resolve())
            except ValueError:
                return None, (
                    'Error: Sandbox blocked write outside a workspace. '
                    'Open a project folder first (the session has no workspace), '
                    'or write under the system temp directory.'
                )
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
            # Resolve relative tokens against the workspace cwd — a bare
            # relative token is not "inside" just because it is relative;
            # `cat ../../etc/passwd` or `echo x > ../../evil.txt` must be
            # caught here (the soft sandbox runs with cwd=workspace).
            p = root / p
        return not is_within_root(p, root)
    except OSError:
        return False
