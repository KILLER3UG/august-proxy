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
- Credential STORES are blocked by directory, read and write alike
  (``_CREDENTIAL_STORES``), because the two patterns above are name lists and
  name lists go stale: a token one level inside ``credentials/``, an OAuth
  verifier beside it, or an SSO cache file named after a hash matches none of
  them. ``{dataDir}/config.json`` joins that rule by absolute path — it carries
  live service tokens, and the filename alone could never be refused without
  refusing every project's config.

Scope: shell commands (checked before any backend runs, sandboxed or
unsandboxed) and file-tool paths (checked by ``bind_path``). MCP-server
file access is out of scope.
"""

from __future__ import annotations

import re
from pathlib import Path

# Paths that must never be written, in any mode. Env-named files ending in
# `.example` / `.sample` / `.template` are the documented commit-able
# templates and stay writable (checked in ``_is_env_template``).
#
# `credentials` is COMPONENT-ANCHORED for the same reason `id_\w+` is on the
# read side: unanchored it also matched `credentials.md`, so a project
# documenting its own credential setup could not be written at all. A
# directory named `credentials` is still protected — the anchor requires the
# component to end there.
_PROTECTED_WRITE_PATTERN = re.compile(
    r'(\.env|providers\.json|(?:^|/)credentials(?:/|$)|\.ssh(?:/|$)|'
    r'id_rsa|id_ed25519|\.aws(?:/|$)|\.npmrc|\.pypirc)',
    re.IGNORECASE,
)

# Credential files that must never be read into the conversation (.env is
# intentionally absent — debugging reads are allowed).
# `id_rsa|id_ed25519` missed every other OpenSSH key type
# (id_ecdsa, id_dsa, …) and the git/netrc/aws-config credential stores, so
# those read straight into the transcript even under Full Access. `id_\w+`
# covers all key types; the added alternatives cover the common stores.
#
# `id_\w+` is COMPONENT-ANCHORED, and that matters. Unanchored, it matches
# anywhere in the path, so it fired on ordinary files and folders that merely
# contain the letters: a path through `grid_layout/` matches `id_l`, one
# through `user_id_seed.py` matches `id_seed`, and a pytest tmpdir named
# `test_..._id_still_...` matches `id_still`. Those files are not credentials,
# and silently refusing to read them is a real bug — a model asked to inspect
# one reports that it does not exist.
#
# Anchoring costs no coverage. OpenSSH keys live in `.ssh/` and are named
# `id_<type>` as a whole component, so they match the anchored form, which is
# what actually does the work here. A previous version of this comment
# claimed the `\.ssh/[^\s]*\*` alternative "covers anything else inside
# `.ssh/` by directory" — that was simply false: it requires a literal `*` in
# the name, so `~/.ssh/known_hosts` and `~/.ssh/config` are readable. The
# claim was worse than the gap, because it would stop the next person
# re-checking. Those two files are public and stay readable deliberately.
# `providers\.json` is component-anchored for the same reason `id_\w+` is —
# unanchored it blocked `providers.json.example`, a template file.
#
# Note the read pattern deliberately does NOT treat `.ssh` as a directory
# boundary, even though the write pattern does. `~/.ssh/authorized_keys` is a
# list of PUBLIC keys and stays readable — a considered decision, pinned by
# test_credential_reads_blocked. What the directory does need is to be
# unLISTABLE, which is a different question with a different answer: listing
# `.ssh` returns every key name and size in one response. That is
# `is_credential_directory` below, used by the file-tree route.
_CREDENTIAL_READ_PATTERN = re.compile(
    r'(providers\.json$|(?:^|/)id_\w+|\.aws/credentials|\.aws/config$|'
    r'(?:^|/)credentials$|\.git-credentials$|\.netrc$|\.(?:pem|key)$|'
    r'\.aws/[^\s]*\*|\.ssh/[^\s]*\*|'
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----)',
    re.IGNORECASE,
)

# Directories that are credential STORES rather than credential files.
# Reading one specific non-secret member of `.ssh` is allowed, so this cannot
# be folded into the read pattern; but enumerating the store is the whole
# secret set in a single response, and no legitimate file tree shows it.
_CREDENTIAL_DIRECTORIES = ('.ssh', '.aws', '.gnupg')

# Stores whose ENTIRE subtree is secret material, matched on the directory
# rather than the filename. The two patterns above are name lists, and name
# lists go stale — this gap was found by listing what a real install keeps, not
# by reading the guard:
#   * `.google_workspace_mcp/credentials/<account>.json` — the anchor
#     `credentials$` names a FILE, so a token one level inside it matched
#     nothing. The live store also keeps `oauth_states.json` and per-account
#     `pkce<account>.json` verifiers in that same directory;
#   * `.aws/sso/cache/<hash>.json`, `.kube/config`, `.docker/config.json` —
#     tokens under names no credential filename list would ever guess.
# Matching the directory also solves the collision the name list creates:
# `config.json` is secret-bearing inside `.docker` and ordinary in any project
# tree, and `credentials/` is a token store in a home directory and a component
# module in a repo.
#
# `.ssh` is deliberately absent — `authorized_keys` and `config` stay readable by
# the decision recorded above, and its keys are already named by the read
# pattern. A leading dot is load-bearing: it keeps `aws/` and `.dockerignore` out.
_CREDENTIAL_STORES = (
    '.aws',
    '.gnupg',
    '.google_workspace_mcp',
    '.docker',
    '.kube',
    '.azure',
    '.config/gh',
    '.config/gcloud',
)


def _credential_store(canonical: str) -> str | None:
    """The credential store a canonical path lives in or is, else None.

    Padded so every store matches on whole components only.
    """
    padded = f'/{_canonical(canonical).strip("/")}/'.lower()
    for store in _CREDENTIAL_STORES:
        if f'/{store}/' in padded:
            return store
    return None


def _august_secret_files() -> tuple[str, ...]:
    """August's own live secret stores, by absolute path.

    `config.json` is far too common a name to block machine-wide — this is the
    one that holds `serviceConnections.github.token` and a Google `accessToken`,
    so the rule is the data directory, never the filename. `providers.json`
    beside it is already blocked by name, being a key store by definition.
    """
    try:
        from app.config import settings  # lazy: app.config must not import here

        data = _canonical(str(settings.dataDir)).lower().rstrip('/')
    except (ImportError, AttributeError, OSError, ValueError):
        # Narrow on purpose — this is a security guard, and a bare
        # `except Exception` here would hide any future import breakage by
        # quietly dropping the rule. The other patterns still run either way.
        return ()
    return (f'{data}/config.json',)


def _secret_store_reason(path: str) -> str | None:
    """Why `path` is a store the agent may neither read nor write, else None.

    Reads land in the conversation transcript and go upstream to the provider,
    so this is refused in every mode — the same immunity the two patterns have.
    """
    canonical = _canonical(path).lower()
    store = _credential_store(canonical)
    if store:
        return f'credential store {store}'
    if canonical in _august_secret_files():
        return "August's own credential store"
    return None


def is_credential_directory(path: str) -> bool:
    """True when `path` IS a credential store, so its contents must not be listed.

    Takes the name from the RESOLVED path, not from a string split. The first
    version stripped a trailing `/` and took the last segment, which a caller
    stepped straight over: `.ssh/`, `.ssh/.` and `.ssh ` all resolved to the
    same directory and all returned 200 with the directory's entries. The
    caller resolves before asking, so a `.` segment is already gone by then —
    and asking on the resolved form is the only form that cannot be dressed
    up with a trailing dot, slash or space.
    """
    try:
        resolved = Path(path).resolve()
    except OSError:
        resolved = None
    if resolved is None:
        name = _canonical(path).rstrip('/').rsplit('/', 1)[-1].lower()
        return name in _CREDENTIAL_DIRECTORIES
    if resolved.name.lower() in _CREDENTIAL_DIRECTORIES:
        return True
    # A token store is unlistable root AND subtree: enumerating
    # `.google_workspace_mcp` prints every connected account, and the directory
    # below it is the tokens themselves.
    return _credential_store(_canonical(str(resolved))) is not None

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

# Readers that can still mutate files in place via flags. A "reader"
# carrying one of these is treated as a writer — `sed -i`, `awk -i
# inplace` and `find -delete` can otherwise edit/remove `.env`,
# `providers.json` and `~/.ssh/*` even in Full Access.
_MUTATING_FLAG_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    'sed': (re.compile(r'^(?:-i|--in-place)(?:\.[A-Za-z0-9_.-]+)?$', re.IGNORECASE),),
    'awk': (re.compile(r'^-i.*inplace', re.IGNORECASE),),
    'find': (
        re.compile(
            r'^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$', re.IGNORECASE
        ),
    ),
    'sort': (re.compile(r'^-o$', re.IGNORECASE),),
}


def _canonical(text: str) -> str:
    """Canonicalize a path token for matching (backslash → slash)."""
    return text.replace('\\', '/')


def _tokenize(command: str) -> list[str]:
    return [tok.strip('"\'').strip() for tok in re.split(r'\s+', command) if tok.strip()]


def _segment_is_write(first: str, tokens: list[str]) -> bool:
    """Judge one command segment's mutating potential.

    Non-readers are always writers; readers are writers when they carry a
    mutating flag (``sed -i``, ``awk -i inplace``, ``find -delete``,
    ``sort -o``…).
    """
    if first not in _READER_COMMANDS:
        return True
    patterns = _MUTATING_FLAG_PATTERNS.get(first)
    if not patterns:
        return False
    for i, tok in enumerate(tokens[1:], start=1):
        for pat in patterns:
            if pat.match(tok):
                return True
        # gawk's two-token in-place form: `awk -i inplace '...' file`
        if first == 'awk' and tok == '-i' and i + 1 < len(tokens) and tokens[i + 1].lower() == 'inplace':
            return True
    return False


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
        if _segment_is_write(first, tokens):
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
        store = _secret_store_reason(tok)
        if store:
            return f'hardline protected {store} in command: {raw_tok}'
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
    store = _secret_store_reason(canonical)
    if store:
        return f'hardline protected {store}: {path}'
    if for_write and _PROTECTED_WRITE_PATTERN.search(canonical) and not _is_env_template(canonical):
        return f'hardline protected path: {path}'
    if not for_write and _CREDENTIAL_READ_PATTERN.search(canonical):
        return f'hardline credential read blocked: {path}'
    return None
