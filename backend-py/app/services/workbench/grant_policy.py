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
"""

from __future__ import annotations

__all__ = ['durable_grant_allowed', 'effective_scope', 'GRANT_SCOPES']

GRANT_SCOPES = ('once', 'session', 'always')

_WILDCARD_SUFFIX = ':*'
_ESCAPE_MARKER = ':sandbox:unsandboxed'


def durable_grant_allowed(grant_key: str) -> tuple[bool, str]:
    """Can this key be granted `always`, and if not, why in one sentence?"""
    key = grant_key or ''
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
    return True, ''


def effective_scope(grant_key: str, requested: str) -> tuple[str, str]:
    """Clamp an inadmissible `always` request. Returns (storedScope, reason)."""
    scope = (requested or 'once').strip().lower()
    if scope not in GRANT_SCOPES:
        scope = 'once'
    if scope != 'always':
        return scope, ''
    allowed, reason = durable_grant_allowed(grant_key)
    if allowed:
        return 'always', ''
    return 'session', reason
