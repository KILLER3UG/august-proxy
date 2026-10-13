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

import os
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
#
# `hooks.json` is here for a different reason than the credential names: it is
# not secret, it is EXECUTION POLICY. `write_file` accepted an absolute path
# inside the data directory (measured: 'Successfully wrote 148 bytes to
# <dataDir>/hooks.json'), and `user_hooks.ensure_hooks_loaded` registers that
# file with no trust decision at all — the trust gate keys on a WORKSPACE origin
# and the user-level file has none (registered: 1). So a model could install a
# shell command for August to run on the next matching event, which is
# privilege escalation with a persistent payload. Reads stay allowed: a hook
# definition is not a secret, and the settings panel shows it.
_PROTECTED_WRITE_PATTERN = re.compile(
    r'(\.env|providers\.json|(?:^|/)credentials(?:/|$)|\.ssh(?:/|$)|'
    r'id_rsa|id_ed25519|\.aws(?:/|$)|\.npmrc|\.pypirc|hooks\.json$)',
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
# re-checking. Those two files are public and stay readable deliberately, and
# so is `id_rsa.pub` — the PUBLIC half, which is the same material
# `authorized_keys` holds, is why the `(?!\w*\.pub)` sits right after `id_`.
# It has to be there: placed after `\w+` the engine backtracks one character
# and matches `id_rs` in `id_rsa.pub`, and the `.pub` file is refused again.
# The rest of `.ssh`'s direct members are refused by name in
# `_ssh_member_reason`, which is the allow side of the same decision.
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
    r'(providers\.json$|(?:^|/)id_(?!\w*\.pub)\w+|\.aws/credentials|\.aws/config$|'
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

# The public members of `.ssh`, named. This is the ALLOW side of the exception
# the comment above describes, and `_ssh_member_reason` refuses everything else
# directly in the directory: a key is a key whatever it is called, and the only
# reason `authorized_keys` was ever readable is that it is a list of PUBLIC keys.
# `*.pub` is the same material in OpenSSH's own naming.
_SSH_PUBLIC_MEMBERS = (
    'config',
    'authorized_keys',
    'authorized_keys2',
    'known_hosts',
    'known_hosts.old',
)

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


def _data_dir_form() -> str:
    """The normalized data directory, or '' when it cannot be resolved.

    Shared by the two rules that anchor on it. Narrow on purpose — this is a
    security guard, and a bare `except Exception` here would hide any future
    import breakage by quietly dropping the rule. The other patterns still run
    either way.
    """
    try:
        from app.config import settings  # lazy: app.config must not import here

        return _strip_dangling_dots(_canonical(str(settings.dataDir))).lower().rstrip('/')
    except (ImportError, AttributeError, OSError, ValueError):
        return ''


# Files under the data directory that decide what August RUNS. They are not
# secret — every settings panel lists them — so they stay readable, and they are
# not refused by NAME the way `providers.json` is: a project owning a
# `mcp-servers.json` or an `automations.json` is ordinary, and the rule is the
# directory, exactly as it is for `config.json`.
#
# `mcp-servers.json` (`tools/mcp_client.py:32`) launches a process per entry;
# `automations.json` (`automations_store.py:33`) carries `jobType: 'shell'` with
# its command. With `<dataDir>/hooks.json` these are the three files where a
# write is a command injection with a persistent payload, and the data directory
# is an allowed root for an absolute `write_file` path — which is precisely how
# the hook file was escalable.
_POLICY_FILE_NAMES = ('mcp-servers.json', 'automations.json')

# The durable memory itself. Writing it bypasses the proposal door, the retire
# machinery and the backup integrity check in one line, and SQLite's journal
# variants count as the same file (`-wal`, `-shm`, and the `-journal` of a
# rollback journal), so this is a prefix, not a name.
#
# `memory_conn.db_path()` is that prefix or the env override of it, so the rule
# reads the same two sources rather than importing the service: naming the
# default alone would miss a deployment that moved the file, and naming the env
# alone would miss one that did not.
_DEFAULT_BRAIN_FILE = 'august_brain.sqlite'
_BRAIN_FILE_ENV = 'AUGUST_BRAIN_SQLITE_FILE'


def _brain_db_prefixes() -> tuple[str, ...]:
    """Absolute, normalized prefixes of the durable-memory database."""
    out: list[str] = []
    data = _data_dir_form()
    if data:
        out.append(f'{data}/{_DEFAULT_BRAIN_FILE}')
    env = (os.environ.get(_BRAIN_FILE_ENV) or '').strip()
    if env:
        form = _strip_dangling_dots(_canonical(env)).lower()
        if form.startswith('/') or re.match(r'^[a-z]:/', form):
            out.append(form)
    return tuple(dict.fromkeys(p for p in out if p))


def _august_secret_files() -> tuple[str, ...]:
    """August's own live secret stores, by absolute path.

    `config.json` is far too common a name to block machine-wide — this is the
    one that holds `serviceConnections.github.token` and a Google `accessToken`,
    so the rule is the data directory, never the filename. `providers.json`
    beside it is already blocked by name, being a key store by definition.
    """
    data = _data_dir_form()
    if not data:
        return ()
    return (f'{data}/config.json',)


def _agent_state_reason(canonical: str) -> str | None:
    """Why `canonical` is August's own instruction or execution state, else None.

    The class is the one `hooks.json` established: a file the RUNTIME reads back
    as policy. Two of them were measured writable by the same door.

      * `<workspace>/.aug/skills/<dir>/SKILL.md` — `skill_service._skillRoots`
        lists that directory as the project-scope layer, `list_all` takes any
        `dir/SKILL.md` in it, and `catalogue()` — the one door every prompt
        surface reads — renders its name and description into the NEXT turn. The
        measured write answered 'Successfully wrote 209 bytes' with a payload
        telling the agent to `curl -d @providers.json` somewhere else, so the
        file was not data, it was an instruction, installed without a proposal,
        without approval, and without the content rails in `harness_rails` that
        the learning pipeline is held to. A `run.sh` beside it is the payload the
        instruction points at; nothing executes it, which is why the whole layer
        is closed rather than one filename.
      * `<dataDir>/skills/**` and `<dataDir>/bots/<id>/skills/**` — the agent
        layer of the same store, reachable by absolute path.

    Reads stay allowed: an agent must be able to read the skill it already has.
    The sanctioned writers (`skill_service`, `harness_self_improve`) use
    `Path.write_text` and are not behind this door, which is the point — closing
    the tool door leaves the pipeline route as the only one the model can take,
    and that route has a proposal, an approval and a rail on it.

    The BUNDLED layer (`<repo>/skills`) is deliberately NOT in here. That is the
    installed application payload or a developer's checkout, editing it is
    ordinary development work, and a human reviews it in a diff — the same reason
    a workspace's own `AGENTS.md` stays writable and the app's state files do not.
    """
    parts = [p for p in canonical.split('/') if p]
    for i in range(1, len(parts)):
        if parts[i] == 'skills' and parts[i - 1] == '.aug':
            return 'agent skill layer (.aug/skills)'
    # Before the data-directory branch: `AUGUST_BRAIN_SQLITE_FILE` can move the
    # memory anywhere on disk, and a rule that only looked inside the data
    # directory would then protect a file that no longer exists.
    for prefix in _brain_db_prefixes():
        if canonical == prefix or canonical.startswith(prefix + '-') or canonical.startswith(prefix + '/'):
            return f'August durable memory ({_DEFAULT_BRAIN_FILE})'
    data = _data_dir_form()
    if not data or not canonical.startswith(data + '/'):
        return None
    inner = [p for p in canonical[len(data) :].split('/') if p]
    if 'skills' in inner:
        return 'agent skill layer (data directory)'
    if inner and inner[-1] in _POLICY_FILE_NAMES:
        return f'August execution policy ({inner[-1]})'
    return None


def _store_match_form(path: str) -> str:
    """The form of a path the store tables are matched against.

    Three spellings defeat pure string matching, all measured on this machine:

      * a home anchor the guard would not otherwise see — `~`, `$HOME`, and cmd's
        `%USERPROFILE%` are expanded by the SHELL, not by Python;
      * an 8.3 short name. `GOOGLE~1` IS `.google_workspace_mcp` on this volume,
        so `cat ~/GOOGLE~1/credentials/account.json` passed the rule that refuses
        the long name, and the terminal route returned the token;
      * a trailing dot or space, which NTFS strips from the component it opens,
        making `.aws./sso/cache/<hash>.json` the SSO cache itself. That one is
        normalised lexically in `_strip_dangling_dots` rather than by resolving,
        so the answer cannot depend on the platform the guard runs on.

    `resolve()` is the only thing that turns a short name back into a long one
    (Windows expands it during path canonicalisation), and it costs more than a
    string scan, so it is paid ONLY when a component actually has the 8.3 shape.
    A path that does not exist still resolves lexically, which is what the
    no-such-file case needs.
    """
    text = _strip_dangling_dots(_canonical(os.path.expandvars(os.path.expanduser(path.strip('"\'')))))
    if _SHORT_NAME_RE.search(text):
        try:
            text = _strip_dangling_dots(_canonical(str(Path(text).resolve())))
        except (OSError, ValueError):
            pass
    return text.lower()


# The 8.3 shape, with the optional short extension a FILE gets (`REPORT~1.TXT`),
# while a directory alias is bare (`GOOGLE~1`). Requiring the component to END at
# `~N` missed every aliased file and, worse, the real case here: the credential
# directory's own short name sits one step above a long-named file.
_SHORT_NAME_RE = re.compile(r'(^|/)[A-Za-z0-9._-]{1,6}~\d+(?:\.[A-Za-z0-9]{1,4})?($|/)')


def _credential_store_subtree_reason(canonical: str) -> str | None:
    """Why a path BELOW a named member of a `.ssh`-style store is secret.

    The two tables are not interchangeable and this is the third distinction:
    `_CREDENTIAL_STORES` refuses the whole subtree for reads and writes, while
    `_CREDENTIAL_DIRECTORIES` (`.ssh`) deliberately keeps ONE named member
    readable — `config`, `authorized_keys`, `known_hosts` are public or benign.
    Matching only the last component left the exception swallowing everything:
    `~/.ssh/keys/deploy_token` is not a named member of the store, it is a file
    inside a folder inside the store, and it read clean while `ls` of that same
    folder was refused. Anything under a subdirectory of the store is where
    private material lives and has no public representative; the direct members
    are judged by name in `_ssh_member_reason`.
    """
    parts = [p for p in canonical.split('/') if p]
    for i, part in enumerate(parts):
        if part in _CREDENTIAL_DIRECTORIES and i + 2 < len(parts):
            return f'credential store {part} subdirectory'
    return None


def _ssh_member_reason(canonical: str) -> str | None:
    r"""Why a file DIRECTLY inside `.ssh` is secret unless it is a public member.

    The `.ssh` exception has always been about named public files — `config`,
    `authorized_keys`, `known_hosts` — and it was written as a DENY list
    (`id_\w+` in the read pattern) instead of as the ALLOW list it describes.
    `cat ~/.ssh/work_github` therefore read clean: a working identity key named
    by hand is exactly what people do when they keep more than one account, and
    OpenSSH does not require the `id_` prefix. The exception is now what it
    always said it was — the public members are named, and anything else in the
    directory is a key until proven otherwise.

    Only a DIRECT member is judged here; a path through a subdirectory of the
    store is the `i + 2 < len(parts)` case that
    `_credential_store_subtree_reason` already owns.
    """
    parts = [p for p in canonical.split('/') if p]
    for i, part in enumerate(parts):
        if part != '.ssh' or i + 1 >= len(parts) or i + 2 < len(parts):
            continue
        member = parts[i + 1]
        if member in _SSH_PUBLIC_MEMBERS or member.endswith('.pub'):
            return None
        return f'credential store .ssh member ({member}) is not a public file'
    return None


def _secret_store_reason(path: str) -> str | None:
    """Why `path` is a store the agent may neither read nor write, else None.

    Reads land in the conversation transcript and go upstream to the provider,
    so this is refused in every mode — the same immunity the two patterns have.
    """
    canonical = _store_match_form(path)
    store = _credential_store(canonical)
    if store:
        return f'credential store {store}'
    subtree = _credential_store_subtree_reason(canonical)
    if subtree:
        return subtree
    member = _ssh_member_reason(canonical)
    if member:
        return member
    if canonical in _august_secret_files():
        return "August's own credential store"
    return None


def is_credential_directory(path: str) -> bool:
    """True when `path` IS a credential store or lives inside one, so listing
    its contents is refused.

    Takes the name from the RESOLVED path, not from a string split. The first
    version stripped a trailing `/` and took the last segment, which a caller
    stepped straight over: `.ssh/`, `.ssh/.` and `.ssh ` all resolved to the
    same directory and all returned 200 with the directory's entries. The
    caller resolves before asking, so a `.` segment is already gone by then —
    and asking on the resolved form is the only form that cannot be dressed
    up with a trailing dot, slash or space.

    The match is on EVERY component, not the last one, and that is the
    difference between this predicate and the read rule. Taking only the last
    component made a directory *inside* the store a legal root, so
    `~/.ssh/keys` — a folder people keep their identities in — listed its
    entries through all four doors while `~/.ssh` itself was refused. Listing
    is the thing this governs: enumerating any level of the store walks out the
    secret set. Reading a NAMED, non-secret member of `.ssh` (`config`,
    `authorized_keys`) stays allowed, which is why `.ssh` is not in
    `_CREDENTIAL_STORES` — that table refuses reads as well.
    """
    try:
        resolved = Path(path).resolve()
    except OSError:
        resolved = None
    canonical = _canonical(str(resolved)) if resolved is not None else _canonical(path)
    lowered = {part.lower() for part in _strip_dangling_dots(canonical).split('/') if part}
    if lowered.intersection(_CREDENTIAL_DIRECTORIES):
        return True
    # A token store is unlistable root AND subtree: enumerating
    # `.google_workspace_mcp` prints every connected account, and the directory
    # below it is the tokens themselves.
    return _credential_store(canonical) is not None

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


# Shell word terminators. A command line is not a list of whitespace-separated
# words: `;`, `&&`, `|`, redirections, subshells and command substitutions all
# end a word without a space in front of them, and `${IFS}` *is* a space as far
# as the shell is concerned.
#
# Both halves mattered, and both were measured as evasions. `ls -la ~/.ssh;`
# produced the token `~/.ssh;`, whose last component is `.ssh;` — not `.ssh` —
# so every one of the four rules below compared a name the shell never opens,
# and running that exact string through `bash -c` printed the store's whole key
# inventory (`authorized_keys config deploy keys known_hosts work_github`)
# through a door the file tools had closed. `ls${IFS}~/.ssh` is the same hole
# with the shell's own separator variable: one token, checked as one token.
#
# Splitting conservatively (quote state ignored) is deliberate. A quoted
# argument that *mentions* a store path is refused by the name patterns today
# anyway — the tokenizer already breaks `"ls -la ~/.ssh"` into `~/.ssh"` and
# strips the quote — so honouring quotes here would buy no coverage for the
# patterns while reopening the `;` hole inside `bash -c "…"`, which is the
# invocation that was defeated.
_SHELL_WORD_END_RE = re.compile(r'[;&|<>()`\n\r{}]')
_IFS_SPACED_RE = re.compile(r'\$\{IFS\}|\$IFS')


def _tokenize(command: str) -> list[str]:
    """The words a shell would open, not the whitespace-separated chunks.

    Every rule in `check_hardline_command` asks a question about a NAME, so the
    tokenizer owns the answer to "where does this name end". A trailing `;` is
    not part of a name, and an `${IFS}` is not inside one.
    """
    words: list[str] = []
    for word in re.split(r'\s+', _IFS_SPACED_RE.sub(' ', command)):
        if not word:
            continue
        for piece in _SHELL_WORD_END_RE.split(word):
            piece = piece.strip('"\'').strip()
            if piece:
                words.append(piece)
    return words


def _strip_dangling_dots(text: str) -> str:
    """Remove the trailing dots/spaces Windows strips from every path component.

    `C:\\Users\\u\\.aws.\\sso\\cache\\x.json` opens `.aws`. NTFS removes a
    trailing dot or space from a name during canonicalisation, so the alias
    addresses the same credential store — and the store tables are matched by
    component, so `.aws.` matched nothing. Measured leaking on this machine:
    `.aws./sso/cache/deadbeef.json` returned the access token, and
    `.ssh./keys/deploy_token`, `.google_workspace_mcp./credentials/account.json`
    and `.config/gh./hosts.yml` each did the same, while
    `is_credential_directory` — which resolves first, and resolve() does this
    stripping on Windows — kept refusing them. One door closed, one open on the
    same target, which is the failure mode this file keeps hitting.

    Done lexically rather than by resolving, because the answer must not depend
    on the platform the guard runs on: on Linux `.aws.` is genuinely another
    directory, and refusing it there costs nothing. No real project keeps a
    directory whose name is a dotted store name plus a dot, whereas CI and a
    developer box are both Linux.

    Pure-dot components are `.` and `..` and stay untouched — they are
    navigation, not names.
    """
    parts: list[str] = []
    for part in text.split('/'):
        if part.strip('.'):
            part = part.rstrip('. ')
        parts.append(part)
    return '/'.join(parts)


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


# `;`, `&&` and `|` end a command; the wrappers that RUN another program are not
# the verb the guards judge.
_SEGMENT_SPLIT_RE = re.compile(r'[;&|]{1,2}')
_EXEC_WRAPPERS = ('sudo', 'xargs', 'env', 'command', 'time', 'nice')


def _segments(command: str) -> list[list[str]]:
    """The segments of a line, each tokenized once.

    One tokenizer for all three readers of a command line. `_is_write_intent`,
    `_enumerates_a_directory` and `check_hardline_command` each used to split
    the text themselves, and they did not split it the same way: the first two
    carried their own `re.split(r'\\s+')` and their own wrapper lists (one had
    `time`/`nice`, the other did not). A `${IFS}` line was therefore a two-word
    command for `check_hardline_command` and a one-word command for the
    enumeration rule, which is the difference between a refusal and a listing of
    `~/.ssh`.
    """
    return [toks for toks in (_tokenize(seg) for seg in _SEGMENT_SPLIT_RE.split(command)) if toks]


def _executable(tokens: list[str]) -> str:
    """The verb a segment runs, looking through `sudo`/`xargs`/`env`/… once."""
    first = _basename(tokens[0])
    if first in _EXEC_WRAPPERS and len(tokens) > 1:
        return _basename(tokens[1])
    return first


def _basename(token: str) -> str:
    return token.split('/')[-1].split('\\')[-1].lower()


def _is_write_intent(command: str) -> bool:
    """True when the command can mutate files (verbs, redirection, non-readers).

    Each ``;``/``&&``/``|`` segment is judged on its own first executable, so
    ``cd x && cat .env`` stays a read while ``python -c '...write...' .env``
    and ``git checkout -- .env`` are treated as writes.
    """
    if _WRITE_VERB_PATTERN.search(command):
        return True
    for tokens in _segments(command):
        if _segment_is_write(_executable(tokens), tokens):
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


def _looks_like_path(token: str) -> bool:
    """Could this shell token be a path the shell will open?

    A command line is full of things that are not paths — `-la`, `2>&1`, `out.txt`,
    a search pattern — and asking `Path.resolve()` about each one both costs time
    and invents denials for words. A path carries a separator, a home anchor or a
    Windows drive; a bare argument does not.
    """
    t = token.strip('"\'')
    if not t or t.startswith('-'):
        return False
    return '/' in t or '\\\\' in t or t.startswith('~') or bool(re.match(r'^[A-Za-z]:', t)) or '%' in t


def _expand_token(token: str) -> str:
    """The path the shell would actually reach, as far as this process can tell.

    `~` is expanded by the shell, not by Python, and `%VAR%` is expanded by cmd.
    Expanding what can be expanded is enough: the store rule looks at whole path
    components, and `~/.ssh`, `%USERPROFILE%\\.ssh` and `C:\\Users\\x\\.ssh` all
    contain a `.ssh` component whether or not the anchor in front of them was real.
    """
    t = token.strip('"\'')
    if t.startswith('~'):
        try:
            t = str(Path(t).expanduser())
        except (OSError, RuntimeError):
            pass
    return t


# The commands whose job is to ENUMERATE a directory. The store rule is about
# listing — `is_credential_directory` refuses a store root and its subtree, so
# `ls ~/.ssh/keys` cannot walk out the names of everything in it — and a shell
# lists with these. A file reader is a different operation: `head -5
# ~/.ssh/authorized_keys` names ONE file, which is the deliberate exception
# `.ssh` keeps (the file-tool tests pin it), and it enumerates nothing.
#
# Existence cannot be the discriminator: a test corpus and a CI home directory
# both name paths that are not there, and a rule that only bites when the
# directory exists is a rule that silently switches itself off on a fresh
# install. The verb is known from the command line itself.
_ENUMERATING_COMMANDS = frozenset(
    {
        'ls', 'dir', 'lld', 'eza', 'exa', 'lsd', 'tree', 'find', 'fd', 'du',
        'stat', 'lsattr', 'ncdu',
        # These searchers walk the given path BY DEFAULT, so there is no flag
        # combination to reason about — every call is enumeration. The grep
        # family is NOT here: it needs the flag, and refusing plain `grep
        # pattern file.txt` would be a guard that cries wolf.
        'rg', 'ripgrep', 'ag', 'ack', 'ack-grep', 'sift', 'ucg',
    }
)

# `grep -rl PRIVKEY ~/.ssh/keys` walked the store and printed every key's NAME
# (`-l`), and with a matching pattern its CONTENT too — through a door that only
# watched for `ls`. The grep family needs its recursive flag: `-r`, `-R`, the
# combined short forms `-rn` / `-lR`, `--recursive`, and GNU's two-token
# `-d recurse`.
_RECURSIVE_SEARCH_COMMANDS = frozenset({'grep', 'egrep', 'fgrep', 'bzgrep', 'zgrep', 'pcregrep'})
_RECURSIVE_SHORT_RE = re.compile(r'^-[A-Za-z]*[rR][A-Za-z]*$')
_RECURSIVE_LONG = frozenset({'--recursive'})
_RECURSIVE_VALUES = frozenset({'recurse', 'skip'})


def _enumerates_a_directory(command: str) -> bool:
    """Does some segment of this command list or walk a directory?

    Wrappers are looked through the same way `_segment_is_write` does it, so
    `sudo ls ~/.ssh` and `xargs -0 ls` are judged on the verb they run, not on
    the word that starts the line. Tokenization is `_tokenize`'s, shared: this
    used to split the line on whitespace itself, so `ls${IFS}~/.ssh` was one
    word here — a word that is not in `_ENUMERATING_COMMANDS` — and the store
    rule never ran, while the same command line was two words for every other
    guard in this module.
    """
    for tokens in _segments(command):
        first = _executable(tokens)
        if first in _ENUMERATING_COMMANDS:
            return True
        if first in _RECURSIVE_SEARCH_COMMANDS:
            for i, tok in enumerate(tokens[1:], start=1):
                if _RECURSIVE_SHORT_RE.match(tok) or tok in _RECURSIVE_LONG:
                    return True
                if tok == '-d' and i + 1 < len(tokens) and tokens[i + 1].lower() in _RECURSIVE_VALUES:
                    return True
    return False


def check_hardline_command(command: str) -> str | None:
    """Return a denial reason if ``command`` touches a hardline path, else None.

    The store rule runs on the token the SHELL would follow, not on the string the
    model typed. `ls ~/.ssh` matched nothing here: `.ssh` is a
    `_CREDENTIAL_DIRECTORY` — refused by `is_credential_directory`, which the two
    file-listing doors call — and the name patterns cover `id_rsa` and friends,
    which is a file inside the store, not the store. So a shell command enumerated
    the whole directory, names and sizes, through a door the file tools had been
    closed on. Same class, same reason, one predicate shared: `is_credential_directory`.

    The predicate is asked only of a command that ENUMERATES (see
    `_enumerates_a_directory`), because the two halves of the `.ssh` decision are
    different operations: a directory under the store is the secret set, and a
    named file inside it is the one member the read rule keeps. Asking the
    directory rule of every token made `cat ~/.ssh/authorized_keys` a refusal —
    which is the exception the file-tool tests pin, deleted by a listing fix.
    """
    if not command or not command.strip():
        return None
    write_intent = _is_write_intent(command)
    enumerates = _enumerates_a_directory(command)
    for raw_tok in _tokenize(command):
        tok = _canonical(raw_tok)
        store = _secret_store_reason(tok)
        if store:
            return f'hardline protected {store} in command: {raw_tok}'
        if (
            enumerates
            and _looks_like_path(raw_tok)
            and is_credential_directory(_expand_token(raw_tok))
        ):
            return f'hardline credential store in command: {raw_tok}'
        if write_intent and _PROTECTED_WRITE_PATTERN.search(tok) and not _is_env_template(tok):
            return f'hardline protected path in command: {raw_tok}'
        if write_intent:
            state = _agent_state_reason(_store_match_form(raw_tok))
            if state:
                return f'hardline protected {state} in command: {raw_tok}'
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
    if for_write:
        state = _agent_state_reason(canonical)
        if state:
            return f'hardline protected {state}: {path}'
    if not for_write and _CREDENTIAL_READ_PATTERN.search(canonical):
        return f'hardline credential read blocked: {path}'
    return None
