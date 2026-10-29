"""Clone-root guard: the self-edit clone is not writable by unattended runs.

Stage 2 of the self-edit loop. The clone (Stage 4 bootstraps it; the shell
points ``AUGUST_CLONE_ROOT`` or ``selfEdit.cloneRoot`` at it) is the only
tree the model is ever allowed to edit as source, and an edit there only
becomes real when a human clicks "Restart to apply". An unattended run —
automation, recurring task, daemon, bot — has no human: an edit it makes
would sit un-reviewed with nobody to click restart, so the default is DENY.

The owner knob is ``selfEdit.cloneAllowUnattendedWrites`` in config.json,
default **off**. When off, every write-door refuses clone paths while the
session is unattended; when on, the gate stands down and the obligation
journal (``clone_journal``) remains the only record of what changed.

Enforcement points, deliberately split:

* **File tools — guaranteed.** ``bind_path`` (the single door every file
  tool passes) asks :func:`clone_write_denial` after the hardline check.
  Whether the session is unattended arrives through :data:`currentUnattended`,
  a ContextVar the turn dispatch sets beside ``currentSessionId`` —
  ``bind_path`` has no session parameter and must not grow one.
* **Shell — best-effort guardrail, NOT a guarantee.** ``run_command`` is
  denied when its ``cwd`` is inside the clone or a command token that looks
  like a path points into it. A shell is Turing-complete: a script can
  reference the clone through a variable, an indirect path, or code the
  matcher cannot see. This is stated in every receipt and in the Stage 2
  verdict — the guarantee for shell lives at the env/URL layers (Stage 1)
  and in the journal's ability to restore, not in the matcher.

With no clone configured (the state until Stage 4), every function here is
a cheap no-op: ``clone_root()`` returns ``None`` and the gates vanish.
"""

from __future__ import annotations

import contextvars
import os
import re
from pathlib import Path

#: Set by the turn dispatch beside ``currentSessionId``: True while the
#: running session is unattended (headless flag, ``AUGUST_HEADLESS``, or a
#: daemon context — the same predicate the never-ask stance uses). Subagent
#: dispatch sets it for its own tasks so workers inherit the parent's stance.
currentUnattended: contextvars.ContextVar[bool] = contextvars.ContextVar(
    'clone_gate_unattended', default=False
)


def is_unattended_session(session: object) -> bool:
    """The never-ask stance's signals, without the per-session policy.

    ``session.headless`` is what automation runs and gateway bridges stamp at
    creation; ``AUGUST_HEADLESS`` and the daemon context are the process-wide
    forms. The approval policy's ``never_ask`` is deliberately NOT consulted
    here: a attended session configured never-to-ask still has a human who
    can click "Restart to apply".
    """
    if bool(getattr(session, 'headless', False)):
        return True
    if os.environ.get('AUGUST_HEADLESS', '').strip().lower() in ('1', 'true', 'yes'):
        return True
    try:
        from app.services.tool_registry import isDaemonContext

        if isDaemonContext():
            return True
    except (ImportError, AttributeError):
        pass
    return False


def clone_root() -> Path | None:
    """The configured self-edit clone root, or None when none is configured.

    ``AUGUST_CLONE_ROOT`` (set by the desktop shell, Stage 4) wins over the
    ``selfEdit.cloneRoot`` config key so a dev session can point the gates at
    a scratch checkout without touching the user's config.
    """
    raw = (os.environ.get('AUGUST_CLONE_ROOT') or '').strip()
    if not raw:
        try:
            from app.services.config_service import getConfig

            section = getConfig().get('selfEdit')
            if isinstance(section, dict):
                raw = str(section.get('cloneRoot') or '').strip()
        except (ImportError, AttributeError, OSError, ValueError):
            raw = ''
    if not raw:
        return None
    try:
        return Path(raw).expanduser().resolve(strict=False)
    except OSError:
        return None


def clone_allow_unattended_writes() -> bool:
    """The owner knob: unattended clone writes allowed? Default off."""
    try:
        from app.services.config_service import getConfig

        section = getConfig().get('selfEdit')
        if isinstance(section, dict):
            return bool(section.get('cloneAllowUnattendedWrites', False))
    except (ImportError, AttributeError, OSError, ValueError):
        pass
    return False


def running_from_clone() -> bool:
    """True when THIS process is running out of the self-edit clone.

    The runtime pin (Stage 4): the shell resolves the backend entry the same
    way every boot, and with the self-edit switch on that entry is the clone
    — so "Restart to apply" is real only while this returns True. Read from
    ``AUGUST_PROXY_ROOT`` (set by the shell at spawn since long before Stage
    4; until Stage 4 nothing in backend-py read it).
    """
    try:
        from app.config import settings

        proxy_root = str(getattr(settings, 'proxyRoot', '') or '').strip()
    except (ImportError, AttributeError, OSError, ValueError):
        return False
    if not proxy_root:
        return False
    return is_clone_path(proxy_root)


def _canonical(text: str) -> str:
    return text.replace('\\', '/')


def _match_forms(path: str | Path) -> list[str]:
    """Literal and resolved canonical forms of ``path`` (lower-cased).

    Two forms, both checked: the literal spelling (a not-yet-existing path
    still has to match) and the resolved one (a link under the workspace
    must be judged by its target). Same shape hardline's store matching
    uses; failure to resolve just leaves the literal form, which is still
    checked.
    """
    text = _canonical(str(path)).lower().rstrip('/')
    forms = [text]
    try:
        resolved = _canonical(str(Path(str(path)).expanduser().resolve(strict=False))).lower()
        if resolved != text:
            forms.append(resolved)
    except (OSError, ValueError, RuntimeError):
        pass
    return forms


def is_clone_path(path: str | Path) -> bool:
    """True when ``path`` is the clone root or lives under it."""
    root = clone_root()
    if root is None:
        return False
    root_form = _canonical(str(root)).lower().rstrip('/')
    if not root_form:
        return False
    for form in _match_forms(path):
        if form == root_form or form.startswith(root_form + '/'):
            return True
    return False


def clone_write_denial(
    path: str | Path, *, for_write: bool, unattended: bool | None = None
) -> str | None:
    """The unattended-writes refusal for a clone path, else None.

    Asked from ``bind_path`` for every file-tool write. Attended sessions
    and the ``cloneAllowUnattendedWrites`` knob both stand the gate down;
    reads are never gated.
    """
    if not for_write:
        return None
    root = clone_root()
    if root is None:
        return None
    if not is_clone_path(path):
        return None
    if unattended is None:
        unattended = currentUnattended.get()
    if not unattended or clone_allow_unattended_writes():
        return None
    return (
        f'Error: this is an unattended run and {path} is inside the self-edit '
        f'clone ({root}). Clone writes wait for an attended session — there is '
        'no one here to click "Restart to apply", so nothing may change the '
        'source (selfEdit.cloneAllowUnattendedWrites is off). Do not retry; '
        'finish the turn and report the change you would have made.'
    )


_PATH_LIKE_RE = re.compile(r'([A-Za-z]:[\\/][^\s;|&]*|/[^\s;|&]+|\.[/\\][^\s;|&]+)')


def shell_command_denial(
    command: str, cwd: str | None = None, *, unattended: bool | None = None
) -> str | None:
    """Best-effort unattended refusal for a shell command touching the clone.

    GUARDRAIL, NOT A GUARANTEE: the cwd check is exact, the path scan is a
    token sweep that a variable-indirect or computed path walks straight
    past. The layers that do not depend on seeing the path are Stage 1's
    (credential-less children, locked push URL) and the journal's restore.
    """
    root = clone_root()
    if root is None:
        return None
    if unattended is None:
        unattended = currentUnattended.get()
    if not unattended or clone_allow_unattended_writes():
        return None
    denial = (
        'Error: this is an unattended run and the command targets the self-edit '
        f'clone ({root}) — clone writes wait for an attended session '
        '(selfEdit.cloneAllowUnattendedWrites is off). Shell writes cannot be '
        'fully detected, so this is a guardrail; do not attempt to route around '
        'it — finish the turn and report the change instead.'
    )
    if cwd and is_clone_path(cwd):
        return denial
    for token in _PATH_LIKE_RE.findall(command or ''):
        if is_clone_path(token.strip('"\'')):
            return denial
    return None
