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

from app.services.sandbox.paths import path_looks_outside_workspace, resolve_workspace_root
from app.services.sandbox.policy import (
    NETWORK_COMMAND_PREFIXES,
    READ_ONLY_BLOCKED_PREFIXES,
    SandboxPolicy,
    SandboxResult,
)

# Part 27 T1: invocation wrappers that hide the real command from `_first_word`.
_INVOCATION_WRAPPERS = frozenset({'sudo', 'env', 'command', 'nohup', 'xargs', 'time', 'exec'})

# Part 27 T1: match redirects WITHOUT requiring a leading space (the old
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

# -c / -e / -Command / -EncodedCommand argument payloads hide path tokens
# inside the payload string (`python -c "open(r'C:\\evil.txt','w')"`) — the
# plain token scan cannot see them (audit finding).
_INTERPRETER_FLAG_PAYLOAD_RE = re.compile(
    r'(?:-c|-e|-command|-encodedcommand)\s+(["\'])(.*?)\1', re.IGNORECASE
)


def _shell_tokens_for_scan(command: str) -> list[str]:
    """Tokens for the outside-workspace scan.

    Windows shlex with ``posix=False`` does NOT group quoted strings — a
    quoted path with spaces splits mid-path and each fragment, once quote-
    stripped, resolves *under* the workspace (``"C:\\Program Files\\x"`` →
    ``C:\\Program`` + ``Files\\x"``). Quoted spans are therefore captured
    whole and checked alongside the shlex tokens, closing the escape.
    """
    try:
        tokens = shlex.split(command, posix=os.name != 'nt')
    except ValueError:
        tokens = command.split()
    for quoted in re.findall(r'"([^"]*)"|\'([^\']*)\'', command):
        tokens.append(quoted[0] or quoted[1])
    return tokens


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

    return command


def _first_word(command: str) -> str:
    text = command.strip()
    if not text:
        return ''
    # Handle env prefixes: FOO=1 bar → bar
    try:
        parts = shlex.split(text, posix=os.name != 'nt')
    except ValueError:
        parts = text.split()
    for part in parts:
        if '=' in part and not part.startswith('-') and Path(part).suffix == '':
            # likely KEY=value
            key, _, _ = part.partition('=')
            if key.isidentifier() or (key and key.replace('_', '').isalnum()):
                continue
        base = Path(part).name.lower()
        if base.endswith('.exe'):
            base = base[:-4]
        # Part 27 T1: skip invocation wrappers so `env rm x` / `sudo curl …` /
        # `command rm …` resolve to the REAL command. The hardline layer already
        # stripped these; the soft layer keyed on the literal wrapper word, so
        # read-only "no writes" and network=False were bypassed by one word.
        if base in _INVOCATION_WRAPPERS:
            continue
        return base
    return parts[0].lower() if parts else ''


def soft_preflight(command: str, policy: SandboxPolicy) -> str | None:
    """Return a denial reason, or None if soft policy allows the command."""
    if policy.is_full_access:
        return None
    first = _first_word(command)
    if policy.is_read_only:
        if first in READ_ONLY_BLOCKED_PREFIXES:
            return f'read-only sandbox blocks mutating command: {first}'
        lowered = command.strip().lower()
        if first in _INTERPRETER_PREFIXES and not lowered.startswith(_VIEWER_REWRITE_PREFIXES):
            return (
                f'read-only sandbox blocks interpreters ({first}) — they can mutate files '
                'regardless of the command; use the file tools or Full access instead.'
            )
        if _REDIRECT_RE.search(command):
            return 'read-only sandbox blocks shell redirects / tee'
    if not policy.network:
        # Part 27 T1: scan EVERY chained segment's first word, not just the
        # command head — `true && curl …` / `foo; wget …` reached the network
        # while the UI reported network=False. _first_word strips wrappers.
        for segment in re.split(r'[;&|]{1,2}', command):
            seg_first = _first_word(segment)
            if seg_first in NETWORK_COMMAND_PREFIXES:
                return f'network disabled in sandbox (blocked: {seg_first})'
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
    for tok in _shell_tokens_for_scan(command):
        if path_looks_outside_workspace(tok, rootStr):
            return f'path outside workspace blocked: {tok}'
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
    *,
    cwd: str | None,
    timeout: float,
    sandboxed: bool,
    enforcement: str,
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
            **agent_subprocess_kwargs(cwd=cwd),
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
        if abort.reason == 'cancelled':
            msg = 'Error: Command cancelled by user.'
        else:
            msg = (
                f'Error: Command timed out after {int(timeout)}s and was killed. '
                'Use non-interactive flags only (no pagers, REPLs, or password prompts).'
            )
        return SandboxResult(
            ok=False,
            stdout='',
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
    return await _spawn(
        command,
        cwd=cwd,
        timeout=timeout,
        sandboxed=True,
        enforcement='soft',
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
