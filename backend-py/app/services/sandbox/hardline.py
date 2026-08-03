"""Hardline protected-path rules for the sandbox.

These rules are intentionally immune to sandbox mode — including Full
Access — because credential material (``.env``, private keys, provider
stores) must never be written by the agent, and private-key / provider
store material must never be read into the conversation. ``.env`` reads
stay allowed so debugging workflows keep working.

Scope: shell commands (checked before any backend runs, sandboxed or
unsandboxed) and file-tool paths (checked by ``bind_path``). MCP-server
file access is out of scope.
"""

from __future__ import annotations

import re

# Paths that must never be written, in any mode. Env-named files ending in
# `.example` / `.sample` / `.template` are the documented commit-able
# templates and stay writable (checked in ``_is_env_template``).
_PROTECTED_WRITE_PATTERN = re.compile(
    r'(\.env|providers\.json|credentials|\.ssh(?:[\\/]|$)|'
    r'id_rsa|id_ed25519|\.aws(?:[\\/]|$)|\.npmrc|\.pypirc)',
    re.IGNORECASE,
)

# Credential files that must never be read into the conversation (.env is
# intentionally absent — debugging reads are allowed).
_CREDENTIAL_READ_PATTERN = re.compile(
    r'(providers\.json|id_rsa|id_ed25519|\.aws/credentials|'
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----)',
    re.IGNORECASE,
)

# Tokens that mark a command as mutating. `install`/`scp`/`rsync` included so
# copying a protected file elsewhere (or restoring into a protected path) is
# caught, not just in-place edits.
_WRITE_VERB_PATTERN = re.compile(
    r'(>>?|tee\s+|\b(?:rm|rmdir|mv|cp|dd|truncate|chmod|chown|touch|install|ln|shred|unlink|scp|rsync)\b)',
    re.IGNORECASE,
)

_ENV_TEMPLATE_SUFFIX = re.compile(r'\.(?:example|sample|template)$', re.IGNORECASE)


def _is_env_template(token: str) -> bool:
    """True when the token names an env template (`.env.example` and friends).

    Only applies to env-named paths — the write guard is relaxed for the
    documented commit-able templates, never for real env files.
    """
    if '.env' not in token.lower():
        return False
    return bool(_ENV_TEMPLATE_SUFFIX.search(token))


def _tokenize(command: str) -> list[str]:
    return [tok.strip('"\'').strip() for tok in re.split(r'\s+', command) if tok.strip()]


def check_hardline_command(command: str) -> str | None:
    """Return a denial reason if ``command`` touches a hardline path, else None."""
    if not command or not command.strip():
        return None
    write_intent = bool(_WRITE_VERB_PATTERN.search(command))
    for tok in _tokenize(command):
        if write_intent and _PROTECTED_WRITE_PATTERN.search(tok) and not _is_env_template(tok):
            return f'hardline protected path in command: {tok}'
        if not write_intent and _CREDENTIAL_READ_PATTERN.search(tok):
            return f'hardline credential read blocked: {tok}'
    return None


def check_hardline_path(path: str, *, for_write: bool) -> str | None:
    """Return a denial reason for a file-tool path, else None."""
    if not path:
        return None
    if for_write and _PROTECTED_WRITE_PATTERN.search(path) and not _is_env_template(path):
        return f'hardline protected path: {path}'
    if not for_write and _CREDENTIAL_READ_PATTERN.search(path):
        return f'hardline credential read blocked: {path}'
    return None
