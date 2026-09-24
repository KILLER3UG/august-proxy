"""Which grants may outlive the chat.

An approval scope is a statement about *future* calls: `once` covers this one,
`session` covers this conversation, `always` is written to disk and covers
every later run of the same key. That last one is only safe while the key is
specific to the arguments that were approved — and argument-specific is
exactly what the keys produced by the failure fallbacks are not.

`_mutation_grant_key` normally fingerprints the command or path (`run_command:
cmd:<fp>`), so "always" means "always for this command", which is a meaningful
choice a user can make. Two shapes are different:

* `run_command:sandbox:unsandboxed:*` — produced when the sandbox-escape
  fingerprint helper itself raises. It matches every future unsandboxed run.
* any `<tool>:*` wildcard.

Granting `always` to those converts a one-time "run this unsandboxed" click
into a permanent, on-disk, invisible policy — reachable from a transient
exception. Such requests are recorded as `session` instead, and the caller is
told so the UI can say "this chat" rather than "always".

A second, orthogonal guard covers the *shape* of the request rather than the
shape of the key: a command the permission axis classified as ``destructive``
or ``network`` may never be made permanent. A command-specific key would still
make `rm -rf build` or `git push --force` auto-run on every later turn in the
project, and an approval card that offers "always" for those is one mis-click
away from a durable, invisible grant. The UI hides the choice; this module
enforces it, so a hand-rolled request cannot route around the banner.
"""

from __future__ import annotations

from collections.abc import Iterable

__all__ = [
    'durable_grant_allowed',
    'effective_scope',
    'GRANT_SCOPES',
    'NON_DURABLE_CATEGORIES',
]

GRANT_SCOPES = ('once', 'session', 'always')

#: Permission-axis categories whose approvals may not outlive the chat.
#: ``external`` is deliberately absent: the workspace boundary is already
#: enforced by the sandbox axis, and it carries no destructive/network
#: capability of its own.
NON_DURABLE_CATEGORIES = frozenset({'destructive', 'network'})

_WILDCARD_SUFFIX = ':*'
_ESCAPE_MARKER = ':sandbox:unsandboxed'


def durable_grant_allowed(
    grant_key: str,
    categories: Iterable[str] | None = None,
) -> tuple[bool, str]:
    """Can this key be granted `always`, and if not, why in one sentence?"""
    key = grant_key or ''
    cats = {str(c).strip().lower() for c in (categories or ())}
    blocked = sorted(cats & NON_DURABLE_CATEGORIES)
    if key.endswith(_WILDCARD_SUFFIX):
        return False, (
            f'"{key}" covers every future call to this tool, so it cannot be '
            'made permanent — recorded for this chat instead'
        )
    if _ESCAPE_MARKER in key:
        return False, (
            'unsandboxed-escape approvals are per chat and are never written to '
            f'disk — recorded for this chat instead (key "{key}")'
        )
    if blocked:
        return False, (
            f'{blocked[0]} commands are approved per chat and are never written '
            'to disk, so later turns still ask — recorded for this chat instead'
        )
    return True, ''


def effective_scope(
    grant_key: str,
    requested: str,
    categories: Iterable[str] | None = None,
) -> tuple[str, str]:
    """Clamp an inadmissible `always` request. Returns (storedScope, reason)."""
    scope = (requested or 'once').strip().lower()
    if scope not in GRANT_SCOPES:
        scope = 'once'
    if scope != 'always':
        return scope, ''
    allowed, reason = durable_grant_allowed(grant_key, categories)
    if allowed:
        return 'always', ''
    return 'session', reason
