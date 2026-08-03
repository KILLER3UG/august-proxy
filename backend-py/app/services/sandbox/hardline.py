"""Hardline protected-path rules for the sandbox.

These rules are intentionally immune to sandbox mode — including Full
Access — because credential material (``.env``, private keys, provider
stores) must never be written by the agent, and private-key / provider
store material must never be read into the conversation. ``.env`` reads
stay allowed so debugging workflows keep working.

Enforcement model:
- Paths are canonicalized (``\\`` → ``/``) before matching, so Windows
  backslash paths are covered on every platform.
- A command is a WRITE when it carries a mutating verb/redirection OR its
  first executable is not a pure reader (``cat``/``head``/``grep``/...).
  Interpreters (``python -c``, ``node -e``), ``git checkout/restore``,
  ``curl -o``, ``cmd``/``powershell`` and friends therefore cannot touch
  protected paths — even in Full Access.
- READS of credential files (private keys, ``.aws/credentials``,
  ``providers.json``, any ``.pem``/``.key``) are blocked outright; bare
  ``credentials`` filenames and globs under protected dirs are covered.

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
    r'(\.env|providers\.json|credentials|\.ssh(?:/|$)|'
    r'id_rsa|id_ed25519|\.aws(?:/|$)|\.npmrc|\.pypirc)',
    re.IGNORECASE,
)

# Credential files that must never be read into the conversation (.env is
# intentionally absent — debugging reads are allowed).
_CREDENTIAL_READ_PATTERN = re.compile(
    r'(providers\.json|id_rsa|id_ed25519|\.aws/credentials|'
    r'(?:^|/)credentials$|\.(?:pem|key)$|'
    r'\.aws/[^\s]*\*|\.ssh/[^\s]*\*|'
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----)',
    re.IGNORECASE,
)

# Explicit mutating markers (in-place edits, deletes, copies, network fetch).
_WRITE_VERB_PATTERN = re.compile(
    r'(>>?|tee\s+|\b(?:rm|rmdir|mv|cp|dd|truncate|chmod|chown|touch|install|ln|shred|unlink|scp|rsync)\b)',
    re.IGNORECASE,
)

# Pure readers: the ONLY executables allowed to reference protected paths
# without tripping write intent. Anything else (interpreters, git, curl,
# cmd, powershell, package managers, editors...) touching a protected path
# is treated as a write.
_READER_COMMANDS = frozenset(
    {
        'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep',
        'find', 'ls', 'dir', 'echo', 'printf', 'date', 'pwd', 'which',
        'whoami', 'id', 'stat', 'file', 'wc', 'sort', 'uniq', 'cut', 'tr',
        'sed', 'awk', 'env', 'printenv', 'type', 'test', 'true', 'false',
        'cd',
    }
)

_ENV_TEMPLATE_SUFFIX = re.compile(r'\.(?:example|sample|template)$', re.IGNORECASE)


def _canonical(text: str) -> str:
    """Canonicalize a path token for matching (backslash → slash)."""
    return text.replace('\\', '/')


def _tokenize(command: str) -> list[str]:
    return [tok.strip('"\'').strip() for tok in re.split(r'\s+', command) if tok.strip()]


def _is_write_intent(command: str) -> bool:
    """True when the command can mutate files (verbs, redirection, non-readers).

    Each ``;``/``&&``/``|`` segment is judged on its own first executable, so
    ``cd x && cat .env`` stays a read while ``python -c '...write...' .env``
    and ``git checkout -- .env`` are treated as writes.
    """
    if _WRITE_VERB_PATTERN.search(command):
        return True
    for segment in re.split(r'[;&|]{1,2}', command):
        tokens = _tokenize(segment)
        if not tokens:
            continue
        first = tokens[0].split('/')[-1].split('\\')[-1].lower()
        # Strip common invocation prefixes (sudo, xargs, env KEY=...).
        if first in ('sudo', 'xargs', 'env', 'command'):
            first = tokens[1].split('/')[-1].split('\\')[-1].lower() if len(tokens) > 1 else first
        if first not in _READER_COMMANDS:
            return True
    return False


def _is_env_template(token: str) -> bool:
    """True when the token names an env template (`.env.example` and friends).

    Only applies to env-named paths — the write guard is relaxed for the
    documented commit-able templates, never for real env files.
    """
    if '.env' not in _canonical(token).lower():
        return False
    return bool(_ENV_TEMPLATE_SUFFIX.search(_canonical(token)))


def check_hardline_command(command: str) -> str | None:
    """Return a denial reason if ``command`` touches a hardline path, else None."""
    if not command or not command.strip():
        return None
    write_intent = _is_write_intent(command)
    for raw_tok in _tokenize(command):
        tok = _canonical(raw_tok)
        if write_intent and _PROTECTED_WRITE_PATTERN.search(tok) and not _is_env_template(tok):
            return f'hardline protected path in command: {raw_tok}'
        if not write_intent and _CREDENTIAL_READ_PATTERN.search(tok):
            return f'hardline credential read blocked: {raw_tok}'
    return None


def check_hardline_path(path: str, *, for_write: bool) -> str | None:
    """Return a denial reason for a file-tool path, else None."""
    if not path:
        return None
    canonical = _canonical(path)
    if for_write and _PROTECTED_WRITE_PATTERN.search(canonical) and not _is_env_template(canonical):
        return f'hardline protected path: {path}'
    if not for_write and _CREDENTIAL_READ_PATTERN.search(canonical):
        return f'hardline credential read blocked: {path}'
    return None
