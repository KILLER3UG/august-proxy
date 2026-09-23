"""Soft sandbox + unsandboxed host runner.

Soft enforcement is honest: it is NOT OS isolation. It forces cwd to the
workspace, blocks obvious network prefixes when network=False, blocks
read-only mutations, and rejects absolute path tokens outside the workspace.
"""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import time
from pathlib import Path

from app.services.sandbox.paths import (
    is_null_sink,
    path_looks_outside_workspace,
    resolve_workspace_root,
)
from app.services.sandbox.policy import (
    NETWORK_COMMAND_PREFIXES,
    READ_ONLY_BLOCKED_PREFIXES,
    SandboxPolicy,
    SandboxResult,
)

# Invocation wrappers that hide the real command from `_first_word`.
_INVOCATION_WRAPPERS = frozenset({
    'sudo', 'env', 'command', 'nohup', 'xargs', 'time', 'exec', 'start', 'runas'
})

# PowerShell execution cmdlets can run arbitrary nested code or egress. Treat
# them as wrappers for preflight rather than as ordinary read-only verbs.
_POWERSHELL_EXECUTION_COMMANDS = frozenset({
    'invoke-expression', 'iex', 'invoke-command', 'icm', 'start-process', 'saps'
})

# PowerShell network cmdlets are not named after the Unix tools above, but
# they provide the same egress and must be caught when network=False.
_POWERSHELL_NETWORK_COMMANDS = frozenset({
    'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
    'start-bitstransfer', 'net', 'net.exe',
}) | _POWERSHELL_EXECUTION_COMMANDS

# Match redirects WITHOUT requiring a leading space (the old
# `(?:^|[\s;|&])` anchor let `echo x>/etc/passwd` through) and cover `2>`/`&>`/
# `&>>`/`2>>`. A negative lookbehind keeps code arrows (`->`, `=>`) from
# matching as redirects.
_REDIRECT_RE = re.compile(
    r'(?<![=!<>-])(?:[0-9]*&?>{1,2}|tee\s+)\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s;|&]+))'
)

# Interpreters can mutate anything regardless of the first word (`python -c
# "open('x','w')..."`, `node -e`, `bash -c "rm -rf ..."`) — read-only mode
# blocks them wholesale (audit finding). Our own Windows viewer rewrites
# (powershell Get-Content / cmd dir /b) are exempt below — they are read-only
# by construction and the model cannot inject commands through them.
_INTERPRETER_PREFIXES: frozenset[str] = frozenset(
    {
        'python',
        'python3',
        'py',
        'node',
        'nodejs',
        'bun',
        'deno',
        'bash',
        'sh',
        'zsh',
        'pwsh',
        'powershell',
        'cmd',
        'perl',
        'ruby',
        'php',
        'lua',
    }
)
_VIEWER_REWRITE_PREFIXES = (
    'powershell -noprofile -noninteractive -command get-content',
    'cmd /c dir /b',
)

# PowerShell accepts unambiguous parameter prefixes. These command-bearing
# aliases are recognized consistently by payload extraction and read-only
# classification; encoded payloads remain opaque and fail closed.
_POWERSHELL_COMMAND_FLAGS = frozenset(
    '-command'[:size] for size in range(2, len('-command') + 1)
)
_POWERSHELL_ENCODED_FLAGS = frozenset(
    '-encodedcommand'[:size] for size in range(2, len('-encodedcommand') + 1)
) | {'-ec'}


def _powershell_payload_flag(token: str) -> str | None:
    flag = token.lower()
    if any(flag == prefix or flag.startswith(prefix + '=') for prefix in _POWERSHELL_COMMAND_FLAGS):
        return 'command'
    if any(flag == prefix or flag.startswith(prefix + '=') for prefix in _POWERSHELL_ENCODED_FLAGS):
        return 'encoded'
    return None


# -c / -e / -Command / -EncodedCommand argument payloads hide path tokens
# inside the payload string (`python -c "open(r'C:\\evil.txt','w')"`) — the
# plain token scan cannot see them (audit finding).
_INTERPRETER_FLAG_PAYLOAD_RE = re.compile(
    r'(?:-c|-e|-command|-encodedcommand)\s+(["\'])(.*?)\1', re.IGNORECASE
)


def _shell_tokens_for_scan(command: str, *, platform: str | None = None) -> list[str]:
    """Tokens for the outside-workspace scan.

    Windows shlex with ``posix=False`` does NOT group quoted strings — a
    quoted path with spaces splits mid-path and each fragment, once quote-
    stripped, resolves *under* the workspace (``"C:\\Program Files\\x"`` →
    ``C:\\Program`` + ``Files\\x"``). Quoted spans are therefore captured
    whole and checked alongside the shlex tokens, closing the escape.
    """
    posix = (platform or os.name) not in ('nt', 'windows', 'win32', 'cmd')
    try:
        tokens = shlex.split(command, posix=posix)
    except ValueError:
        tokens = command.split()
    for quoted in re.findall(r'"([^"]*)"|\'([^\']*)\'', command):
        tokens.append(quoted[0] or quoted[1])
    return tokens


def _is_nt_platform(platform: str | None) -> bool:
    return (platform or os.name) in ('nt', 'windows', 'win32', 'cmd')


def _shell_tokens(command: str, *, platform: str | None = None) -> list[str]:
    """Tokenize a segment using the shell that will execute it."""
    posix = (platform or os.name) not in ('nt', 'windows', 'win32', 'cmd')
    try:
        return shlex.split(command, posix=posix)
    except ValueError:
        return command.split()


def _is_env_assignment(token: str) -> bool:
    if '=' not in token or token.startswith('-'):
        return False
    key = token.partition('=')[0]
    return bool(key and (key.isidentifier() or key.replace('_', '').isalnum()))


def _strip_outer_quotes(value: str) -> str:
    value = (value or '').strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


# Wrapper options that consume a separate argument. Keeping this table narrow
# prevents an option such as ``sudo -u`` from being mistaken for the command.
_WRAPPER_VALUE_OPTIONS: dict[str, frozenset[str]] = {
    'sudo': frozenset({'-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt'}),
    'env': frozenset({'-u', '--unset'}),
    'xargs': frozenset({
        '-n', '--max-args', '-s', '--max-chars', '-P', '--max-procs',
        '-I', '--replace', '-E', '--eof', '-d', '--delimiter', '-L', '--max-lines',
    }),
    'exec': frozenset({'-a', '--argv0'}),
    'runas': frozenset({'-u', '--user', '-p', '--password'}),
}


def _skip_wrapper_arguments(
    tokens: list[str], idx: int, wrapper: str, *, platform: str | None = None
) -> int:
    """Move past wrapper options and return the index of the real command."""
    idx += 1
    nt = _is_nt_platform(platform)
    skipped_title = False
    while idx < len(tokens):
        argument = tokens[idx]
        if argument == '--':
            return idx + 1
        if _is_env_assignment(argument):
            idx += 1
            continue
        is_option = argument.startswith('-') or (nt and argument.startswith('/'))
        if is_option:
            idx += 1
            if argument in _WRAPPER_VALUE_OPTIONS.get(wrapper, frozenset()) and idx < len(tokens):
                # Embedded values (``--user=name``) do not consume another
                # token. Separate values are skipped unless they look like an
                # option for the wrapped command.
                if not tokens[idx].startswith('-') and not (nt and tokens[idx].startswith('/')):
                    idx += 1
            continue
        if wrapper == 'start' and nt and not skipped_title:
            # ``start`` consumes a window title before the executable. An
            # empty quoted title is represented as an empty token by shlex.
            skipped_title = True
            idx += 1
            continue
        return idx
    return idx


def _shell_payload(
    tokens: list[str], *, platform: str | None = None
) -> tuple[str | None, str | None, bool]:
    """Return a wrapped shell payload, its shell kind, and opaque-flag.

    The return shape is ``(payload, platform, encoded)``. ``encoded`` is true
    for PowerShell ``-EncodedCommand``, which cannot be inspected safely.
    """
    idx = 0
    while idx < len(tokens):
        token = tokens[idx]
        if _is_env_assignment(token):
            idx += 1
            continue
        base = Path(token).name.lower()
        if base.endswith('.exe'):
            base = base[:-4]
        if base in _INVOCATION_WRAPPERS:
            idx = _skip_wrapper_arguments(tokens, idx, base, platform=platform)
            continue
        if base in ('cmd', 'cmd.exe'):
            for pos in range(idx + 1, len(tokens)):
                flag = tokens[pos].lower()
                if flag in ('/c', '/k', '/r'):
                    payload = ' '.join(tokens[pos + 1 :])
                    return _strip_outer_quotes(payload), 'nt', False
            return None, None, False
        if base in ('bash', 'sh', 'zsh', 'ksh', 'dash'):
            for pos in range(idx + 1, len(tokens)):
                flag = tokens[pos].lower()
                if flag in ('-c', '--command') or (
                    flag.startswith('-') and flag.endswith('c') and len(flag) > 2
                ):
                    payload = ' '.join(tokens[pos + 1 :])
                    return _strip_outer_quotes(payload), 'posix', False
            return None, None, False
        if base in ('powershell', 'pwsh'):
            for pos in range(idx + 1, len(tokens)):
                flag = tokens[pos].lower()
                payload_kind = _powershell_payload_flag(flag)
                if payload_kind == 'encoded':
                    return None, 'powershell', True
                if payload_kind == 'command':
                    payload = ' '.join(tokens[pos + 1 :])
                    return _strip_outer_quotes(payload), 'powershell', False
            return None, None, False
        # A non-wrapper executable ends the search; its own flags are not a
        # shell payload for preflight purposes.
        return None, None, False
    return None, None, False


def _substitution_contents(command: str) -> list[str]:
    """Extract shell/PowerShell command-substitution bodies."""
    out: list[str] = []
    idx = 0
    while idx < len(command):
        if command.startswith('$(', idx):
            depth = 1
            pos = idx + 2
            while pos < len(command) and depth:
                if command.startswith('$(', pos):
                    depth += 1
                    pos += 2
                    continue
                if command[pos] == ')':
                    depth -= 1
                    if depth == 0:
                        out.append(command[idx + 2 : pos])
                        idx = pos + 1
                        break
                pos += 1
            else:
                # Unterminated substitution is shell syntax error; treating it
                # as opaque keeps the conservative preflight fail-closed.
                out.append(command[idx + 2 :])
                break
            continue
        if command[idx] == '`':
            end = command.find('`', idx + 1)
            if end < 0:
                out.append(command[idx + 1 :])
                break
            out.append(command[idx + 1 : end])
            idx = end + 1
            continue
        if command.startswith('${', idx):
            end = command.find('}', idx + 2)
            if end >= 0:
                body = command[idx + 2 : end]
                # Ordinary ${VAR} expansion is harmless; command-like bodies
                # (whitespace or a known verb) are inspected conservatively.
                if re.search(r'\s', body) or re.match(
                    r'(?i)(?:curl|wget|cat|type|rm|bash|sh|cmd|powershell|pwsh|python|node)\b',
                    body,
                ):
                    out.append(body)
                idx = end + 1
                continue
        idx += 1
    return out


def _iter_command_fragments(
    command: str, *, platform: str | None = None, _depth: int = 0
):
    """Yield outer and nested command text that preflight must inspect."""
    yield command, platform, False
    if _depth >= 4:
        return
    for segment in _split_shell_segments(command, platform=platform):
        tokens = _shell_tokens(segment, platform=platform)
        payload, payload_platform, encoded = _shell_payload(tokens, platform=platform)
        if encoded:
            yield '', payload_platform, True
            continue
        if payload:
            yield payload, payload_platform, False
            yield from _iter_command_fragments(
                payload, platform=payload_platform, _depth=_depth + 1
            )
        for nested in _substitution_contents(segment):
            yield nested, platform, False
            yield from _iter_command_fragments(
                nested, platform=platform, _depth=_depth + 1
            )


def _has_command_substitution(command: str) -> bool:
    return bool(_substitution_contents(command))


def _network_api_intent(command: str, platform: str | None) -> bool:
    """Detect network APIs hidden inside interpreter payloads."""
    first = _first_word(command, platform=platform)
    if first not in ('python', 'python3', 'py', 'node', 'nodejs', 'bun', 'deno', 'powershell', 'pwsh'):
        return False
    text = command.lower()
    return bool(
        re.search(
            r'(?i)(?:\b(?:requests|urllib|http\.client|aiohttp|httpx|socket|websocket|axios|fetch|'
            r'https?\.get|https?\.request|net\.connect|tls\.connect|dgram|xmlhttprequest|'
            r'invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer)\b|'
            r'\brequire\s*\(\s*[\'\"]https?[\'\"])',
            text,
        )
    )


def _network_preflight(command: str, policy: SandboxPolicy, *, platform: str | None = None) -> str | None:
    if policy.network:
        return None
    prefixes = NETWORK_COMMAND_PREFIXES | _POWERSHELL_NETWORK_COMMANDS
    for fragment, fragment_platform, encoded in _iter_command_fragments(command, platform=platform):
        if encoded:
            return 'network disabled in sandbox (blocked: encoded command payload)'
        for segment in _split_shell_segments(fragment, platform=fragment_platform):
            seg_first = _first_word(segment, platform=fragment_platform)
            if seg_first in prefixes:
                return f'network disabled in sandbox (blocked: {seg_first})'
            if _network_api_intent(segment, fragment_platform):
                return f'network disabled in sandbox (blocked: {seg_first or "interpreter payload"})'
    return None


def _ps_literal(path: str) -> str:
    """Single-quoted PowerShell literal with escaped quotes."""
    return "'" + (path or '').replace("'", "''") + "'"


def rewrite_command_for_platform(command: str) -> str:
    """Translate common Unix file viewers to PowerShell on Windows.

    Models often emit ``head``/``tail``/``cat``/``ls``; cmd.exe does not have
    those builtins, which otherwise surfaces as exit 255 for beginners.
    """
    if os.name != 'nt':
        return command
    text = (command or '').strip()
    if not text:
        return command

    # head -n N file | head -N file | head file
    m = re.match(
        r'^head(?:\s+-n\s+(\d+)|\s+-(\d+))?(?:\s+--)?\s+(.+)$',
        text,
        flags=re.IGNORECASE,
    )
    if m:
        n = m.group(1) or m.group(2) or '10'
        path = m.group(3).strip().strip('"').strip("'")
        return (
            'powershell -NoProfile -NonInteractive -Command '
            f'Get-Content -LiteralPath {_ps_literal(path)} -TotalCount {int(n)}'
        )

    # tail -n N file | tail -N file | tail file
    m = re.match(
        r'^tail(?:\s+-n\s+(\d+)|\s+-(\d+))?(?:\s+--)?\s+(.+)$',
        text,
        flags=re.IGNORECASE,
    )
    if m:
        n = m.group(1) or m.group(2) or '10'
        path = m.group(3).strip().strip('"').strip("'")
        return (
            'powershell -NoProfile -NonInteractive -Command '
            f'Get-Content -LiteralPath {_ps_literal(path)} -Tail {int(n)}'
        )

    # cat file (simple single-path form)
    m = re.match(r'^cat(?:\s+--)?\s+(.+)$', text, flags=re.IGNORECASE)
    if m and '|' not in text and ';' not in text:
        path = m.group(1).strip().strip('"').strip("'")
        if path and not path.startswith('-'):
            return (
                'powershell -NoProfile -NonInteractive -Command '
                f'Get-Content -LiteralPath {_ps_literal(path)} -Raw'
            )

    # ls [path] — bare listing only (skip flag-heavy invocations)
    m = re.match(r'^ls(?:\s+([^-].*))?$', text, flags=re.IGNORECASE)
    if m:
        path = (m.group(1) or '.').strip().strip('"').strip("'") or '.'
        if path == '.':
            return 'cmd /c dir /b'
        # cmd.exe treats & | < > ^ as command separators even inside quotes
        # (`ls a & whoami` would run `whoami"` half) — only rewrite plain
        # paths; anything with metacharacters stays untouched and fails
        # loudly in cmd (audit finding).
        if re.search(r'[&|<>^"\']', path):
            return command
        return f'cmd /c dir /b "{path}"'

    # Piped viewer forms: `find . | head -5` / `git log | tail -20`. The
    # anchored rewrites above only see the command head, so a trailing
    # head/tail segment was left to fail in cmd.exe (no such builtin).
    # Rewrite just the viewer segment into a PowerShell stdin filter.
    m = re.match(
        r'^(.*\|\s*)(head|tail)(?:\s+-n)?\s+(\d+)\s*$',
        text,
        flags=re.IGNORECASE,
    )
    if m and 'powershell' not in text.lower():
        verb = 'First' if m.group(2).lower() == 'head' else 'Last'
        return (
            f'{m.group(1)}powershell -NoProfile -NonInteractive -Command '
            f'"$input | Select-Object -{verb} {int(m.group(3))}"'
        )

    return command


def _first_word(command: str, *, platform: str | None = None) -> str:
    text = command.strip()
    if not text:
        return ''
    parts = _shell_tokens(text, platform=platform)
    idx = 0
    while idx < len(parts):
        part = parts[idx]
        if _is_env_assignment(part):
            idx += 1
            continue
        base = Path(part).name.lower().rstrip(';,')
        if base.endswith('.exe'):
            base = base[:-4]
        # Strip grouping tokens used by PowerShell script blocks and cmd
        # parentheses so the real verb is visible to the policy checks.
        while base in ('{', '}', '(', ')', '&'):
            idx += 1
            if idx >= len(parts):
                return ''
            part = parts[idx]
            base = Path(part).name.lower()
            if base.endswith('.exe'):
                base = base[:-4]
        # Skip invocation wrappers so `env rm x` / `sudo curl …` /
        # `command rm …` resolve to the REAL command. The hardline layer already
        # stripped these; the soft layer keyed on the literal wrapper word, so
        # read-only "no writes" and network=False were bypassed by one word.
        if base in _INVOCATION_WRAPPERS:
            idx = _skip_wrapper_arguments(parts, idx, base, platform=platform)
            continue
        if base in ('cmd', 'cmd.exe'):
            payload, payload_platform, _ = _shell_payload(parts[idx:], platform=platform)
            if payload:
                nested = _first_word(payload, platform=payload_platform)
                if nested:
                    return nested
            return base
        if base in ('bash', 'sh', 'zsh', 'ksh', 'dash', 'powershell', 'pwsh'):
            payload, payload_platform, _ = _shell_payload(parts[idx:], platform=platform)
            if payload:
                nested = _first_word(payload, platform=payload_platform)
                if nested:
                    return nested
            return base
        return base
    return ''


# Cmdlets that only read: a powershell -Command payload whose every pipeline
# segment starts with one of these (and carries no redirect) cannot write to
# disk, so naming an outside path in it is a read, not a write.
_PS_READ_ONLY_CMDLETS = frozenset({
    'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'type',
    'select-string', 'sls', 'test-path', 'tp', 'get-item', 'gi',
    'get-itemproperty', 'gip', 'get-member', 'gm', 'resolve-path',
})

_PS_MUTATING_CMDLET_RE = re.compile(
    r'\b(?:set-content|add-content|remove-item|rm|del|erase|new-item|ni|mkdir|md|'
    r'copy-item|cp|move-item|mv|rename-item|rni|ren|set-item|clear-content|out-file|'
    r'tee-object|invoke-expression|iex|invoke-command|icm|start-process|saps|'
    r'invoke-webrequest|iwr|invoke-restmethod|irm|save-[a-z-]+|export-[a-z-]+)\b',
    re.IGNORECASE,
)


def _powershell_payload(command: str) -> tuple[str | None, bool]:
    """Return a PowerShell -Command payload and whether it is encoded."""
    tokens = _shell_tokens(command, platform='powershell')
    payload, _, encoded = _shell_payload(tokens, platform='powershell')
    return payload, encoded


# Shell commands whose path ARGUMENTS are provably reads (they cannot write a
# file given only a path operand — `sort -o`, `find -delete`, interpreters and
# tee are deliberately NOT here). The preflight lets these touch the app's own
# logs directory (paths.app_logs_root) so the model can read backend.log for
# self-diagnosis; every other out-of-workspace token stays blocked, and write
# redirects are scanned separately with no such exemption.
_READ_ONLY_VIEWER_HEADS = frozenset({
    'type', 'cat', 'head', 'tail', 'more', 'less', 'grep', 'rg', 'findstr',
    'wc', 'ls', 'dir', 'nl',
})

# Heads whose remaining arguments are literal TEXT, not filesystem operands.
# The token scan read `echo before c:/d after` as an attempt to touch
# `c:/d` (audit finding 2026-09-15 #1). Kept deliberately short: `set`/`export`
# were dropped from it because `set /p x=<C:\outside\f` reads a file through an
# input redirect, which the token scan used to catch and the redirect scan does
# not (it only matches `>`/`tee`).
_TEXT_EMITTER_HEADS = frozenset({'echo', 'printf', 'title'})

# Command substitution or any redirect turns a "text emitter" into a file
# reader (`echo $(cat /etc/passwd)`, `printf < /etc/passwd`), so such a segment
# is scanned despite its head.
_NOT_PURE_TEXT_RE = re.compile(r'\$\(|`|\$\{|[<>]')

# Windows-style switch shape: slash + letter, optionally an attached value
# (`/c`, `/s`, `/c:"ToolSearch"`) — the same regex paths._one_points_outside
# exempts, which is gated there to Windows hosts (B8: on POSIX `/c` IS a
# real absolute dir).
_NT_SWITCH_RE = re.compile(r'/[A-Za-z](?::.*)?')


def _split_shell_segments(command: str, *, platform: str | None = None) -> list[str]:
    """Split separators using the native shell quoting, preserving source text."""
    kind = (platform or os.name).lower()
    posix = kind not in ('nt', 'windows', 'win32', 'cmd')
    powershell = kind == 'powershell'
    segments: list[str] = []
    buf: list[str] = []
    quote = ''
    idx = 0
    text = command or ''
    while idx < len(text):
        ch = text[idx]
        nxt = text[idx + 1 : idx + 2]
        if powershell and ch == '`' and nxt:
            # PowerShell's backtick escapes the next character even inside a
            # quoted string. Keep both characters so later token scans see the
            # literal payload rather than treating it as syntax.
            buf.extend((ch, nxt))
            idx += 2
            continue
        # Backslashes are literal in POSIX single quotes and everywhere in cmd.
        escape = (
            posix and ch == '\\'
            and (not quote or (quote == '"' and nxt in ('"', '\\', '$', '`', '\n')))
        ) or (not posix and not powershell and not quote and ch == '^')
        if escape and nxt:
            buf.extend((ch, nxt))
            idx += 2
            continue
        if quote:
            if ch == quote:
                quote = ''
        elif ch == '"' or ((posix or powershell) and ch == "'"):
            quote = ch
        elif ch in (';&|\n' if posix or powershell else '&|'):
            segments.append(''.join(buf))
            buf = []
            idx += 2 if text[idx : idx + 2] in ('&&', '||') else 1
            continue
        buf.append(ch)
        idx += 1
    segments.append(''.join(buf))
    return [seg for seg in segments if seg.strip()]


def _scan_path_tokens(
    command: str, rootStr: str, *, platform: str | None = None
) -> str | None:
    """Containment scan over path-shaped tokens, scoped per command segment.

    Two scoping rules the original whole-command scan lacked (audit finding
    2026-09-15 #1):

    - the read-only-viewer log exemption follows the **segment's** head, so
      `cd /d X && dir "%APPDATA%\\…\\logs"` keeps it — the old scan keyed on
      the command's first word and lost the exemption after any `&&`;
    - segments headed by a pure text emitter (`echo`, `printf`) are skipped,
      because their arguments are prose rather than filesystem operands —
      unless the segment also substitutes or redirects, which makes even
      `echo` a reader.

    Interpreter payload literals are still scanned by the caller over the
    whole command, so nothing that can actually open a file escapes here.
    """
    for segment in _split_shell_segments(command, platform=platform):
        head = _first_word(segment, platform=platform)
        if head in _TEXT_EMITTER_HEADS and not _NOT_PURE_TEXT_RE.search(segment):
            continue
        allowLogs = head in _READ_ONLY_VIEWER_HEADS
        for tok in _shell_tokens_for_scan(segment, platform=platform):
            cleaned = tok.strip().strip('"').strip("'")
            if _is_nt_platform(platform) and _NT_SWITCH_RE.fullmatch(cleaned):
                # Declared-nt command semantics (or a Windows host): `/c`,
                # `/b`, `/c:"Tool"` are switches, not paths. paths.py gates
                # the same shape to Windows hosts so a POSIX host still
                # blocks a real `/c` dir — extend that to a command that
                # DECLARES nt while the host is POSIX, so both evaluation
                # contexts agree on what the token means.
                continue
            if path_looks_outside_workspace(tok, rootStr, allow_app_logs=allowLogs):
                return (
                    f'path outside workspace blocked: {tok} '
                    f'(workspace root: {rootStr}). Use a path inside the workspace, '
                    'or the file tools. This is a workspace-boundary rule, not a '
                    'permissions or network one — Full access is not the fix.'
                )
    return None


def _is_read_only_powershell(
    command: str, *, platform: str | None = None
) -> bool:
    """True for a single powershell/pwsh -Command invocation that provably
    cannot write files: every pipeline segment in the payload starts with a
    read-only cmdlet, the payload has no redirect, and nothing is chained
    outside the quoted payload. Such commands are exempt from the
    outside-workspace path scans — reading e.g. %USERPROFILE%\\Pictures is
    the whole point of them (the scans punished exactly that)."""
    command_tokens = _shell_tokens(command, platform='powershell')
    first_token = Path(command_tokens[0]).name.lower() if command_tokens else ''
    if first_token.endswith('.exe'):
        first_token = first_token[:-4]
    if first_token not in ('powershell', 'pwsh'):
        return False
    tokens = command_tokens
    payload: str | None = None
    for idx, token in enumerate(tokens):
        payload_kind = _powershell_payload_flag(token)
        if payload_kind == 'encoded':
            return False
        if payload_kind == 'command':
            payload = ' '.join(tokens[idx + 1 :])
            break
    if not payload:
        return False
    payload = _strip_outer_quotes(payload)
    if re.search(r'[><`$]|\$\(|&&|\|\|', payload):
        return False
    # Anything chained outside the -Command payload rides along unchecked.
    payload_pos = command.find(payload)
    if payload_pos >= 0:
        remainder = command[:payload_pos] + command[payload_pos + len(payload) :]
        if re.search(r'[;&|<>`$]', remainder):
            return False
    for seg in _split_shell_segments(payload, platform='powershell'):
        seg = seg.strip()
        if not seg:
            continue
        # `$x = Get-ChildItem …` stores in a variable (no disk write) — check
        # the cmdlet after the assignment.
        assign = re.match(r'^\$?\w+\s*=\s*(.+)$', seg)
        if assign:
            seg = assign.group(1).strip()
        head = _first_word(seg, platform='powershell').lstrip('$')
        if head not in _PS_READ_ONLY_CMDLETS:
            return False
    return True


def soft_preflight(
    command: str, policy: SandboxPolicy, *, platform: str | None = None
) -> str | None:
    """Return a denial reason, or None if soft policy allows the command."""
    if policy.is_full_access:
        return None
    first = _first_word(command, platform=platform)
    if policy.is_read_only:
        if _has_command_substitution(command):
            return 'read-only sandbox blocks command substitution — it can execute mutating commands'
        if first in READ_ONLY_BLOCKED_PREFIXES:
            return f'read-only sandbox blocks mutating command: {first}'
        shell_payload = _shell_payload(
            _shell_tokens(command, platform=platform), platform=platform
        )
        lowered = command.strip().lower()
        viewer_payload = bool(
            shell_payload[1] is not None
            and lowered.startswith(_VIEWER_REWRITE_PREFIXES)
        )
        if (shell_payload[1] is not None and not viewer_payload) or (
            first in _INTERPRETER_PREFIXES and not viewer_payload
        ):
            blocked = shell_payload[1] if shell_payload[1] is not None else first
            return (
                f'read-only sandbox blocks wrapped interpreters ({blocked}) — they can mutate files '
                'regardless of the command; use the file tools or Full access instead.'
            )
        # Redirects to null sinks discard output — harmless even in read-only
        # mode; only real writes are blocked.
        redirectTargets = [
            m.group(1) or m.group(2) or m.group(3) or ''
            for m in _REDIRECT_RE.finditer(command)
        ]
        if redirectTargets and not all(is_null_sink(t) for t in redirectTargets):
            return 'read-only sandbox blocks shell redirects / tee'
    powershell_tokens = _shell_tokens(command, platform='powershell')
    outer_first = Path(powershell_tokens[0]).name.lower() if powershell_tokens else ''
    if outer_first.endswith('.exe'):
        outer_first = outer_first[:-4]
    if outer_first in ('powershell', 'pwsh'):
        payload, encoded = _powershell_payload(command)
        if encoded or (
            payload
            and not _is_read_only_powershell(command, platform='powershell')
            and (_PS_MUTATING_CMDLET_RE.search(payload) or re.search(r'\{[^}]*\}', payload))
        ):
            return (
                'workspace-write sandbox blocks PowerShell payload that cannot be proven read-only'
            )
    networkDenial = _network_preflight(command, policy, platform=platform)
    if networkDenial:
        return networkDenial
    # Absolute path tokens / redirects outside workspace. Part 27 T2 (B6):
    # when no workspace_root is configured (scheduler/automation jobs with an
    # empty cwd), fall back to the process cwd — the directory the subprocess
    # actually runs in — instead of skipping every containment check (fail-open).
    effective_root = resolve_workspace_root(policy.workspace_root) or Path.cwd()
    rootStr = str(effective_root)
    for match in _REDIRECT_RE.finditer(command):
        target = match.group(1) or match.group(2) or match.group(3)
        if path_looks_outside_workspace(target, rootStr):
            return f'write redirect outside workspace blocked: {target}'
    # A provably read-only powershell payload (see _is_read_only_powershell)
    # cannot write outside the workspace, so its path arguments are reads —
    # exempt it from the token + payload-literal containment scans.
    if not _is_read_only_powershell(command, platform=platform):
        for fragment, fragment_platform, encoded in _iter_command_fragments(
            command, platform=platform
        ):
            if encoded:
                return 'path outside workspace blocked: encoded command payload cannot be inspected'
            tokenDenial = _scan_path_tokens(
                fragment, rootStr, platform=fragment_platform
            )
            if tokenDenial:
                return tokenDenial
        # String literals inside interpreter payloads (`python -c "..."`,
        # `node -e "..."`, `powershell -Command "..."`) can name paths the
        # token scan never sees — scan them against the same containment rule.
        for m in _INTERPRETER_FLAG_PAYLOAD_RE.finditer(command):
            payload = m.group(2)
            for lit in re.findall(r"['\"]([^'\"]+)['\"]", payload):
                if path_looks_outside_workspace(lit, rootStr):
                    return f'path inside interpreter payload blocked: {lit}'
    return None


async def _spawn(
    command: str,
    cwd: str | None,
    timeout: float,
    sandboxed: bool,
    enforcement: str,
    extra_env: dict[str, str] | None = None,
) -> SandboxResult:
    started = time.monotonic()
    try:
        from app.lib.async_subprocess import (
            SubprocessAborted,
            agent_subprocess_kwargs,
            communicate_or_kill,
            prefix_line_buffering,
        )

        proc = await asyncio.create_subprocess_shell(
            prefix_line_buffering(command),
            **agent_subprocess_kwargs(cwd=cwd, extra_env=extra_env),
        )
        stdout_b, stderr_b = await communicate_or_kill(proc, timeout=timeout)
        stdout = stdout_b.decode('utf-8', errors='replace') if stdout_b else ''
        stderr = stderr_b.decode('utf-8', errors='replace') if stderr_b else ''
        code = proc.returncode
        return SandboxResult(
            ok=code == 0,
            stdout=stdout,
            stderr=stderr,
            exit_code=code,
            enforcement=enforcement,  # type: ignore[arg-type]
            sandboxed=sandboxed,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except SubprocessAborted as abort:
        elapsed = int((time.monotonic() - started) * 1000)
        # A killed command's partial output is far better than nothing —
        # before this, two 110 s scans that timed out returned literally
        # zero bytes.
        partialOut = abort.stdout.decode('utf-8', errors='replace') if abort.stdout else ''
        partialErr = abort.stderr.decode('utf-8', errors='replace') if abort.stderr else ''
        if abort.reason == 'cancelled':
            msg = 'Error: Command cancelled by user.'
        else:
            msg = (
                f'Error: Command timed out after {int(timeout)}s and was killed. '
                'Use non-interactive flags only (no pagers, REPLs, or password prompts).'
            )
        if partialOut or partialErr:
            msg += f'\n[killed at {abort.reason} — partial output below]'
            if partialErr:
                msg += '\n' + partialErr
        return SandboxResult(
            ok=False,
            stdout=partialOut,
            stderr=msg,
            exit_code=-1,
            enforcement=enforcement,  # type: ignore[arg-type]
            sandboxed=sandboxed,
            elapsed_ms=elapsed,
        )
    except Exception as exc:
        return SandboxResult(
            ok=False,
            denial_reason=f'Failed to start command: {exc}',
            enforcement=enforcement,  # type: ignore[arg-type]
            sandboxed=sandboxed,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )


async def run_soft(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    command = rewrite_command_for_platform(command)
    reason = soft_preflight(command, policy)
    if reason:
        return SandboxResult(
            ok=False,
            denial_reason=reason,
            enforcement='soft',
            sandboxed=True,
        )
    root = resolve_workspace_root(policy.workspace_root)
    cwd = str(root) if root is not None else os.getcwd()
    # Enforced egress: when the policy disables network, HTTP clients get a
    # loopback filter proxy env-injected (CONNECT refused with 403) instead
    # of relying only on the shell denylist, which interpreters bypass.
    from app.services.sandbox.egress import proxy_env_for_policy

    extra_env = await proxy_env_for_policy(policy.network)
    return await _spawn(
        command,
        cwd=cwd,
        timeout=timeout,
        sandboxed=True,
        enforcement='soft',
        extra_env=extra_env,
    )


async def run_unsandboxed(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    command = rewrite_command_for_platform(command)
    root = resolve_workspace_root(policy.workspace_root)
    cwd = str(root) if root is not None else os.getcwd()
    result = await _spawn(
        command,
        cwd=cwd,
        timeout=timeout,
        sandboxed=False,
        enforcement='soft',
    )
    result.sandboxed = False
    return result
