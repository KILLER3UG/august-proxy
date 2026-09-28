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


def app_logs_root() -> Path | None:
    """The app's own log directory (``dataDir/logs``) as a READ-ONLY extra root.

    Self-diagnosis needs this: when August dogfoods on a project, the model
    must be able to read ``backend.log`` (update failures, startup races,
    port conflicts) without flipping the whole session to Full access. The
    scope is deliberately the logs subdirectory ONLY — ``providers.json``
    (API keys), the brain SQLite and every other data-dir file stay outside
    every sandbox root. Writes there remain blocked; only reads through
    ``bind_path`` and read-only viewer commands get through.
    """
    try:
        from app.config import settings

        logs = Path(str(settings.dataDir)).expanduser() / 'logs'
        return logs if logs.is_dir() else None
    except Exception:
        return None


def is_within_app_logs(path: Path) -> bool:
    root = app_logs_root()
    return root is not None and is_within_root(path, root)


def _allowlist_denied(resolved: Path, root: Path | None) -> str | None:
    """Enforce the user's "Computer access" allowlist, when they set one.

    `security.filesystemScope` / `security.allowedRoots` are written and read
    back by the Settings UI (ComputerAccessSettings) and enforced NOWHERE —
    the only references to those keys in the whole backend were this file's
    own getter/setter. So a user who restricted computer access to a couple of
    project folders was told a protection existed that did not, while the
    per-session workspace still permitted anything inside it. A security
    setting that silently does nothing is worse than no setting: it is
    relied upon.

    Semantics, and the judgement call in them:

      * scope `root` — the user explicitly chose unrestricted access. No gate.
      * scope `allowlist` with a NON-EMPTY list — the real gate: the resolved
        path must sit inside one of those roots, or inside the session's own
        workspace.
      * scope `allowlist` with an EMPTY list — treated as NOT CONFIGURED, and
        no gate applies.

    That last one is deliberate and is the whole reason this is safe to
        land. The stored default is `allowlist` + `[]`, so reading it
        literally would deny every file operation for every user who never
        opened the setting — the feature is opt-in in practice, and the empty
        list is "not set up yet", not "nothing is permitted". Only a
        configured list restricts anything.

    The session workspace stays implicitly allowed. It is where the user
        pointed this conversation, and an allowlist that excluded it would
        contradict that rather than express it.
    """
    try:
        from app.json_narrowing import as_dict, as_list, as_str
        from app.services.config_service import getConfig
    except Exception:
        return None
    try:
        cfg = getConfig()
        sec = as_dict((cfg or {}).get('security')) if cfg is not None else {}
    except Exception:
        return None
    if as_str(sec.get('filesystemScope') or 'allowlist') == 'root':
        return None
    configured = [str(r).strip() for r in as_list(sec.get('allowedRoots')) if str(r).strip()]
    if not configured:
        return None
    if root is not None and is_within_root(resolved, root):
        return None
    for entry in configured:
        try:
            if is_within_root(resolved, Path(entry).expanduser()):
                return None
        except OSError:
            continue
    return (
        f'Error: Sandbox blocked access outside your allowed roots. '
        f'path={resolved} allowedRoots={configured}. '
        f'Add the folder under Settings → Computer access, or switch the scope to the whole computer.'
    )


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
        # With no workspace there is nothing to be implicitly allowed, so the
        # user's allowlist — if they configured one — is the only gate left.
        denied = _allowlist_denied(resolved, None)
        return (None, denied) if denied else (resolved, None)

    if not is_within_root(resolved, root):
        # Reads of the app's own logs are the one sanctioned exception —
        # the model diagnoses August itself without Full access (see
        # app_logs_root). Writes never are.
        if not for_write and is_within_app_logs(resolved):
            return resolved, None
        action = 'write' if for_write else 'access'
        return None, (
            f'Error: Sandbox blocked {action} outside workspace. '
            f'path={resolved} workspace={root}'
        )
    # Inside the workspace already, so the allowlist gate below can only
    # pass — checked anyway, because it is cheap and because the workspace
    # being implicitly allowed is an explicit design decision, not a
    # coincidence worth relying on silently.
    return resolved, _allowlist_denied(resolved, root)


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


# Null sinks discard output — they are not workspace writes. `2>/dev/null`
# (and `>nul` on Windows) is the most common stderr-suppression idiom and was
# being blocked as an "outside-workspace redirect".
NULL_SINKS = frozenset({'/dev/null', '/dev/stdout', '/dev/stderr', 'nul', './dev/null'})


def is_null_sink(token: str) -> bool:
    """True for redirect targets that discard output (`/dev/null`, `nul`, …)."""
    cleaned = (token or '').strip().strip('"').strip("'").lower().rstrip('\\/')
    return cleaned in NULL_SINKS


def _one_points_outside(cleaned: str, root: Path, *, allow_app_logs: bool = False) -> bool:
    if not cleaned or cleaned.startswith('-'):
        return False
    # Windows-style flags are slash + letter, optionally with an attached
    # value: `find /c`, `/s`, `/q` and — the case that blocked `findstr
    # /c:"ToolSearch" file` — `/c:"ToolSearch"` (audit finding 2026-09-15 #1;
    # the old single-letter-only exemption read the switch's value as a path).
    # Gated to Windows (B8): on POSIX `/c` IS a real absolute dir, so the
    # exemption must not apply there. `/c:/Windows`-style MSYS paths keep their
    # colon-free shape and are still scanned.
    if os.name == 'nt' and re.fullmatch(r'/[A-Za-z](?::.*)?', cleaned):
        return False
    if is_null_sink(cleaned):
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
        if not is_within_root(p, root):
            # Viewer commands may read the app's own logs (see app_logs_root).
            if allow_app_logs and is_within_app_logs(p):
                return False
            return True
        return False
    except OSError:
        return False


def path_looks_outside_workspace(
    token: str, workspace: str | None, *, allow_app_logs: bool = False
) -> bool:
    """Heuristic: does a shell token point outside the workspace?

    ``allow_app_logs`` carves out the app's own ``logs`` directory for
    read-only viewer commands (set by the preflight only when the command
    head provably cannot write).
    """
    root = resolve_workspace_root(workspace)
    if root is None or not token:
        return False
    return any(
        _one_points_outside(c, root, allow_app_logs=allow_app_logs)
        for c in _candidate_paths(token)
    )
