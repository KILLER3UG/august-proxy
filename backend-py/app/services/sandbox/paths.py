"""Workspace path binding — symlink-aware containment checks."""

from __future__ import annotations

import os
import re
from pathlib import Path

# Env vars the soft sandbox expands BEFORE the containment check. The shell
# expands ANY variable, so only a whitelist is trusted — it covers every var
# that commonly points outside a workspace ($HOME, %USERPROFILE%, %TEMP%…).
# Unlisted vars stay literal: their tokens resolve under the workspace root
# and pass, matching the (advisory) soft-sandbox contract.
_SAFE_EXPAND_ENV = frozenset(
    {
        'HOME',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'TEMP',
        'TMP',
        'SYSTEMROOT',
        'WINDIR',
        'APPDATA',
        'LOCALAPPDATA',
        'PROGRAMFILES',
        'PROGRAMFILES(X86)',
        'PUBLIC',
    }
)
_ENV_TOKEN_RE = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}|%([^%]+)%')


def _expand_safe_env(token: str) -> str:
    """Expand ``$VAR`` / ``${VAR}`` / ``%VAR%`` for the safe whitelist only.

    Unknown variables are substituted with the empty string — the shell would
    expand them to the same empty value (POSIX) or leave them literal
    (cmd.exe), and an empty result resolves to an absolute root that the
    containment check rejects when it is outside the workspace.
    """

    def _sub(m: re.Match[str]) -> str:
        name = m.group(1) or m.group(2) or m.group(3)
        if name.upper() in _SAFE_EXPAND_ENV:
            return os.environ.get(name, '')
        return ''

    return _ENV_TOKEN_RE.sub(_sub, token)


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


def _candidate_paths(token: str) -> list[str]:
    """Path candidates a shell token may hide: the whole token, the value
    after `=` (`if=/etc/passwd`, `--output=/etc/x`), and an attached `-o`
    target (`-o/etc/x`). Part 27 T1 (B5): the old scan only checked the whole
    token, so `dd if=/etc/passwd of=ok.txt` slipped its outside input past."""
    cleaned = token.strip().strip('"').strip("'")
    out = [cleaned]
    if '=' in cleaned:
        out.append(cleaned.partition('=')[2])
    m = re.match(r'^--?[a-zA-Z]+=(.*)$', cleaned)
    if m:
        out.append(m.group(1))
    m2 = re.match(r'^-o(/.*)$', cleaned)
    if m2:
        out.append(m2.group(1))
    return [c for c in out if c]


def _one_points_outside(cleaned: str, root: Path) -> bool:
    if not cleaned or cleaned.startswith('-'):
        return False
    # Windows-style single-letter flags (`find /c`, `/s`, `/q`) are slash +
    # one letter — the naive scan read `/c` as an outside path and blocked
    # legitimate commands. Gated to Windows (B8): on POSIX `/c` IS a real
    # absolute dir, so the exemption must not apply there.
    if os.name == 'nt' and re.fullmatch(r'/[A-Za-z]', cleaned):
        return False
    cleaned = _expand_safe_env(cleaned)
    if cleaned in ('~', '/', '\\') or cleaned.startswith('~/') or cleaned.startswith('~\\'):
        home = Path.home().resolve(strict=False)
        if not is_within_root(home, root):
            return True
    try:
        p = Path(cleaned).expanduser()
        if not p.is_absolute():
            p = root / p
        return not is_within_root(p, root)
    except OSError:
        return False


def path_looks_outside_workspace(token: str, workspace: str | None) -> bool:
    """Heuristic: does a shell token point outside the workspace?"""
    root = resolve_workspace_root(workspace)
    if root is None or not token:
        return False
    return any(_one_points_outside(c, root) for c in _candidate_paths(token))
