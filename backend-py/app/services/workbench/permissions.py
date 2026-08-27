"""T5 — Two-axis permissions: sandbox capability tier × approval policy.

Axis 1 (capability) is the real sandbox in ``app/services/sandbox`` — it stays
the ground truth for what a command *can* touch. Axis 2 (approval) is this
module: it decides whether a command the sandbox could run should run without
asking, needs user approval, or is denied outright by a durable user rule.

Design rules (plan §9.4 T5, merged with #10):

- Durable allow/deny rules are user-configured command prefixes. A rule is
  *arity-aware*: ``git commit`` (2 tokens) matches ``git commit -m "x"`` but
  not bare ``git`` — the command must carry at least the rule's tokens.
- External-directory asks are derived from parsing the command for absolute /
  home-relative paths that resolve outside the workspace root.
- Destructive annotations ALWAYS ask — auto-approve categories never cover
  them.
- Model-flagged ``requires_approval`` on a command is advisory on top: it
  forces an ask, it can never force an allow.
- A rejected request returns reject-with-feedback to the model so it can
  adjust its approach instead of retrying verbatim.
- Approval grants are one-shot (``allowed-once`` for exactly the asked
  action); the answerer may only pick from a closed outcome enum. A missing,
  throwing, or absent answerer resolves to DENY (fail-closed).
- Unattended/headless runs use a never-ask stance so no prompt can hang the
  process — anything that would ask becomes a deny-with-feedback.

The module is pure policy logic (no I/O except the durable-rule config
helpers); the workbench loop mounts it via ``resolve_command_approval``.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field

# Tools whose commands pass through the approval axis.
COMMAND_TOOLS: frozenset[str] = frozenset({'run_command', 'bash', 'terminal_command'})

# Closed category vocabulary. ``general`` is implied when nothing else
# matches — it is auto-approvable like any other category (destructive is
# not, ever).
CATEGORIES: tuple[str, ...] = ('read', 'build', 'network', 'external', 'destructive', 'general')

# Categories auto-approved when the policy is enabled without an explicit
# list. Network/external/destructive ask by default; the sandbox still
# enforces capability either way.
DEFAULT_AUTO_APPROVE: frozenset[str] = frozenset({'read', 'build', 'general'})

# ---------------------------------------------------------------------------
# Command tokenization
# ---------------------------------------------------------------------------

# Operators that chain or redirect — their presence invalidates simple
# first-token classification for the benign categories (read/build), because
# `ls && rm -rf /` must not classify as read. Destructive/network scans look
# at every segment regardless.
_CHAIN_RE = re.compile(r'(?:&&|\|\||[;|`]|>>?|\$\()')


def tokenize_command(command: str) -> list[str]:
    """Split a command line into tokens (quote-aware, best-effort).

    Uses non-POSIX mode so Windows backslash paths survive intact, then
    strips matching surrounding quotes from each token.
    """
    text = (command or '').strip()
    if not text:
        return []
    try:
        raw = shlex.split(text, posix=False)
    except ValueError:
        raw = text.split()
    out: list[str] = []
    for tok in raw:
        if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in ('"', "'"):
            tok = tok[1:-1]
        out.append(tok)
    return out


def _segments(command: str) -> list[list[str]]:
    """Token lists per chained segment (split on ; && || |)."""
    text = (command or '').strip()
    if not text:
        return []
    parts = re.split(r'&&|\|\||[;|]', text)
    out: list[list[str]] = []
    for part in parts:
        toks = tokenize_command(part)
        if toks:
            out.append(toks)
    return out or [tokenize_command(text)]


# ---------------------------------------------------------------------------
# Prefix rules (durable allow/deny, arity-aware)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PrefixRule:
    """A meaningful command prefix, e.g. ``git commit`` → ('git', 'commit')."""

    tokens: tuple[str, ...]
    raw: str = ''

    @property
    def arity(self) -> int:
        return len(self.tokens)


def parse_prefix_rule(text: str) -> PrefixRule | None:
    """Parse user text like ``git commit`` into a rule; None when empty."""
    tokens = tuple(t for t in tokenize_command(text) if t)
    if not tokens:
        return None
    return PrefixRule(tokens=tuple(t.lower() for t in tokens), raw=(text or '').strip())


def rule_matches(rule: PrefixRule, tokens: list[str]) -> bool:
    """Arity-aware match: command must carry ALL of the rule's leading tokens.

    ``git commit`` matches ``git commit -m "x"`` (extra args ok) but not
    ``git`` (too few tokens) and not ``git commits`` (different token).
    Comparison is case-insensitive.
    """
    if len(tokens) < rule.arity:
        return False
    return all(tokens[i].lower() == rule.tokens[i] for i in range(rule.arity))


def _rule_hits_any_segment(rule: PrefixRule, command: str) -> bool:
    return any(rule_matches(rule, seg) for seg in _segments(command))


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

_READ_FIRST = frozenset(
    {
        'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'grep',
        'rg', 'egrep', 'fgrep', 'find', 'fd', 'wc', 'which', 'where', 'pwd',
        'echo', 'stat', 'file', 'du', 'df', 'tree', 'hostname', 'whoami',
        'date', 'env', 'printenv', 'uname', 'basename', 'dirname', 'realpath',
    }
)

_BUILD_FIRST = frozenset(
    {
        'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'uv', 'cargo', 'make',
        'go', 'rustc', 'gcc', 'g++', 'clang', 'tsc', 'msbuild', 'dotnet',
        'javac', 'mvn', 'gradle', 'pytest', 'cmake', 'ninja',
    }
)

_NETWORK_FIRST = frozenset(
    {
        'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat',
        'telnet', 'ping', 'nmap', 'dig', 'nslookup', 'aria2c', 'fetch',
        'gh', 'git',  # git only for push/fetch/clone/pull — refined below
    }
)

_GIT_NETWORK_SUB = frozenset({'push', 'fetch', 'clone', 'pull'})

_DESTRUCTIVE_FIRST = frozenset(
    {
        'rm', 'rmdir', 'shred', 'truncate', 'mkfs', 'dd', 'fdisk', 'parted',
        'diskpart', 'format', 'shutdown', 'reboot', 'halt', 'poweroff',
        'del', 'erase', 'rd', 'remove-item',
    }
)

_RECURSIVE_FLAG_RE = re.compile(r'^-[a-z]*[rf][a-z]*$', re.IGNORECASE)

_WIN_ABS_RE = re.compile(r'^[A-Za-z]:[\\/]')
_UNC_RE = re.compile(r'^\\\\')


def _git_destructive(tokens: list[str]) -> bool:
    if len(tokens) < 2 or tokens[0].lower() != 'git':
        return False
    sub = tokens[1].lower()
    rest = [t.lower() for t in tokens[2:]]
    if sub == 'push' and any(t in ('--force', '-f', '--force-with-lease', '--delete', '-d') for t in rest):
        return True
    if sub == 'reset' and '--hard' in rest:
        return True
    if sub == 'clean' and any(t.startswith('-') and 'f' in t for t in rest):
        return True
    if sub == 'branch' and '-D' in rest:
        return True
    if sub == 'checkout' and '--' in rest and '.' in rest:
        return True
    return False


def _first_token_destructive(tokens: list[str]) -> bool:
    if not tokens:
        return False
    first = tokens[0].lower().rsplit('/', 1)[-1]  # /bin/rm → rm
    rest = tokens[1:]
    if first == 'rm' or first in ('del', 'erase', 'rmdir', 'shred'):
        # Windows-style flags are short /x tokens; anything else starting
        # with '/' is a path target, not a flag.
        flags = [t for t in rest if t.startswith('-') or re.match(r'^/[A-Za-z?]{1,3}$', t)]
        targets = [t for t in rest if t not in flags]
        if any(_RECURSIVE_FLAG_RE.match(f) for f in flags):
            return True
        if any(f.lower() in ('--recursive', '--force', '-r', '-f', '-rf', '-fr', '/s', '/q', '/f') for f in flags):
            return True
        # Broad targets: /, ~, /*, or a bare home/root path.
        for t in targets:
            if t in ('/', '~', '/*', '/etc', '/usr', '/var', '/home'):
                return True
        return False
    if first in ('rd', 'rmdir') and any(f.lower() in ('/s', '/s/q', '-recurse') for f in rest):
        return True
    if first == 'remove-item' and any(f.lower() in ('-recurse', '-force') for f in rest):
        return True
    if first.startswith('mkfs') or first in ('fdisk', 'parted', 'diskpart', 'shred'):
        return True
    if first == 'dd' and any(t.startswith('if=') or t.startswith('of=') for t in rest):
        return True
    if first == 'format':
        return True
    if first in ('shutdown', 'reboot', 'halt', 'poweroff'):
        return True
    if first == 'init' and rest and rest[0] in ('0', '6'):
        return True
    if first in ('chmod', 'chown') and '-R' in rest:
        return True
    return False


def is_destructive(command: str) -> bool:
    """True when any segment of the command is annotated destructive."""
    text = command or ''
    if ':|:&' in text.replace(' ', ''):  # fork bomb pattern
        return True
    for seg in _segments(text):
        if _first_token_destructive(seg) or _git_destructive(seg):
            return True
    return False


def extract_external_paths(command: str, workspace_root: str) -> list[str]:
    """Best-effort: absolute/home paths in the command outside the workspace.

    Only unambiguous path tokens are considered (absolute POSIX paths, ``~``,
    ``C:\\…`` Windows paths, UNC shares). URLs and relative tokens are
    ignored — the sandbox axis is the real protection; this only decides
    whether to ask.
    """
    ws = (workspace_root or '').strip()
    ws_norm = os.path.normcase(os.path.normpath(os.path.abspath(ws))) if ws else ''
    found: list[str] = []
    for seg in _segments(command):
        for tok in seg:
            if tok.startswith('-') or '://' in tok:
                continue
            if not (tok.startswith('/') or tok.startswith('~') or _WIN_ABS_RE.match(tok) or _UNC_RE.match(tok)):
                continue
            # A bare drive root like C:\ is external by definition.
            candidate = os.path.expanduser(tok)
            try:
                resolved = os.path.normcase(os.path.normpath(os.path.abspath(candidate)))
            except (OSError, ValueError):
                continue
            if ws_norm and (resolved == ws_norm or resolved.startswith(ws_norm + os.sep)):
                continue
            if tok not in found:
                found.append(tok)
    return found


def classify_command(command: str, workspace_root: str) -> frozenset[str]:
    """Classify a command into permission categories (may be several)."""
    text = (command or '').strip()
    cats: set[str] = set()
    if not text:
        return frozenset()
    segs = _segments(text)
    chained = bool(_CHAIN_RE.search(text)) or len(segs) > 1
    first_tokens = [seg[0].lower().rsplit('/', 1)[-1] for seg in segs if seg]

    if is_destructive(text):
        cats.add('destructive')

    # Network: any segment starts with a network program; git counts only
    # for its network subcommands.
    for seg in segs:
        if not seg:
            continue
        first = seg[0].lower().rsplit('/', 1)[-1]
        if first in _NETWORK_FIRST - {'git'}:
            cats.add('network')
        elif first == 'git' and len(seg) > 1 and seg[1].lower() in _GIT_NETWORK_SUB:
            cats.add('network')

    if extract_external_paths(text, workspace_root):
        cats.add('external')

    # Benign first-token classes only hold for single, unchained commands
    # with no redirection — a chain could hide anything.
    if not chained and segs:
        first = first_tokens[0] if first_tokens else ''
        if first in _READ_FIRST:
            cats.add('read')
        elif first in _BUILD_FIRST:
            cats.add('build')
        elif first == 'python' and len(segs[0]) > 2 and segs[0][1] == '-m' and segs[0][2] in ('pytest', 'ruff', 'mypy', 'black', 'flake8'):
            cats.add('build')
        elif first == 'git' and len(segs[0]) > 1 and segs[0][1].lower() in (
            'status', 'diff', 'log', 'show', 'branch', 'remote', 'stash', 'rev-parse', 'ls-files',
        ):
            cats.add('read')

    return frozenset(cats)


# ---------------------------------------------------------------------------
# Approval policy (axis 2 state) + decision
# ---------------------------------------------------------------------------

ApprovalOutcome = str  # closed enum: 'allow_once' | 'allow_always' | 'deny'
OUTCOMES: tuple[str, ...] = ('allow_once', 'allow_always', 'deny')


def normalize_outcome(raw: str | None) -> str:
    """Clamp an answerer reply to the closed enum; unknown/missing → deny."""
    text = (raw or '').strip().lower().replace(' ', '_').replace('-', '_')
    aliases = {
        'allow': 'allow_once',
        'once': 'allow_once',
        'allow_once': 'allow_once',
        'always': 'allow_always',
        'allow_always': 'allow_always',
        'deny': 'deny',
        'no': 'deny',
        'reject': 'deny',
    }
    return aliases.get(text, 'deny')


@dataclass
class ApprovalPolicy:
    """Axis-2 configuration. ``enabled=False`` makes the whole axis inert."""

    enabled: bool = False
    auto_approve: frozenset[str] = field(default_factory=lambda: DEFAULT_AUTO_APPROVE)
    allow_rules: tuple[PrefixRule, ...] = ()
    deny_rules: tuple[PrefixRule, ...] = ()
    never_ask: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            'enabled': self.enabled,
            'autoApprove': sorted(self.auto_approve),
            'allowRules': [r.raw or ' '.join(r.tokens) for r in self.allow_rules],
            'denyRules': [r.raw or ' '.join(r.tokens) for r in self.deny_rules],
            'neverAsk': self.never_ask,
        }


def policy_from_dict(raw: dict[str, object] | None) -> ApprovalPolicy:
    """Parse a stored policy dict; tolerant of missing/malformed fields."""
    d = raw or {}
    auto_raw = d.get('autoApprove')
    if isinstance(auto_raw, (list, tuple, set, frozenset)):
        auto = frozenset(str(c).strip().lower() for c in auto_raw if str(c).strip())
        auto = frozenset(c for c in auto if c in CATEGORIES)
    else:
        auto = DEFAULT_AUTO_APPROVE

    def _rules(key: str) -> tuple[PrefixRule, ...]:
        vals = d.get(key)
        if not isinstance(vals, (list, tuple)):
            return ()
        out: list[PrefixRule] = []
        for v in vals:
            rule = parse_prefix_rule(str(v))
            if rule is not None:
                out.append(rule)
        return tuple(out)

    return ApprovalPolicy(
        enabled=bool(d.get('enabled', False)),
        auto_approve=auto,
        allow_rules=_rules('allowRules'),
        deny_rules=_rules('denyRules'),
        never_ask=bool(d.get('neverAsk', False)),
    )


@dataclass(frozen=True)
class Decision:
    action: str  # 'allow' | 'ask' | 'deny'
    reason: str
    categories: frozenset[str] = frozenset()
    feedback: str = ''  # reject-with-feedback text for the model (deny/ask-denied)


def _deny_feedback(command: str, reason: str, hint: str) -> str:
    return (
        f'[permission:denied] "{command[:300]}" was not approved: {reason}. '
        f'{hint} Do not retry the identical command.'
    )


def decide(
    command: str,
    workspace_root: str,
    policy: ApprovalPolicy,
    *,
    requires_approval: bool = False,
) -> Decision:
    """Decide allow / ask / deny for one command under an approval policy.

    Precedence: deny rules → destructive (always ask) → external paths
    (always ask) → allow rules → model flag (ask) → auto-approve categories
    → network / uncategorized (ask).
    """
    cats = classify_command(command, workspace_root)
    if not policy.enabled:
        return Decision('allow', 'approval axis disabled', cats)

    for rule in policy.deny_rules:
        if _rule_hits_any_segment(rule, command):
            label = rule.raw or ' '.join(rule.tokens)
            return Decision(
                'deny',
                f"matches the user's deny rule '{label}'",
                cats,
                _deny_feedback(
                    command,
                    f"it matches the user's deny rule '{label}'",
                    'Choose a different approach, or ask the user (in chat) to change the rule.',
                ),
            )

    if 'destructive' in cats:
        return Decision('ask', 'destructive commands always require approval', cats)

    if 'external' in cats:
        return Decision('ask', 'command touches paths outside the workspace', cats)

    for rule in policy.allow_rules:
        if _rule_hits_any_segment(rule, command):
            return Decision('allow', f"matches the user's allow rule '{rule.raw or ' '.join(rule.tokens)}'", cats)

    if requires_approval:
        return Decision('ask', 'the model flagged this command as requiring approval', cats)

    effective_cats = cats or frozenset({'general'})
    if effective_cats & policy.auto_approve:
        return Decision('allow', 'category auto-approved: ' + ', '.join(sorted(effective_cats)), cats)

    if 'network' in cats:
        return Decision('ask', 'network commands require approval', cats)
    return Decision('ask', 'command category is not auto-approved', cats)


def unattended_denial(command: str, decision: Decision) -> str:
    """Reject-with-feedback for an ask that can never be answered (headless)."""
    return _deny_feedback(
        command,
        f'{decision.reason}, and no approver is available in this unattended context',
        'Rewrite the command to stay non-destructive and inside the workspace, '
        'or skip this step and tell the user what needs manual approval.',
    )
