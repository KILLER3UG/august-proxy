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

_REDIRECT_RE = re.compile(r'(?:^|[\s;|&])(?:>>?|tee\s+)\s*([^\s;|&]+)')


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
        safe = path.replace('"', '')
        return f'cmd /c dir /b "{safe}"'

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
        if re.search(r'(?:^|[\s;|&])(?:>>?|tee\b)', command):
            return 'read-only sandbox blocks shell redirects / tee'
    if not policy.network and first in NETWORK_COMMAND_PREFIXES:
        return f'network disabled in sandbox (blocked: {first})'
    # Absolute path tokens / redirects outside workspace
    root = resolve_workspace_root(policy.workspace_root)
    if root is not None:
        for match in _REDIRECT_RE.finditer(command):
            target = match.group(1)
            if path_looks_outside_workspace(target, policy.workspace_root):
                return f'write redirect outside workspace blocked: {target}'
        try:
            tokens = shlex.split(command, posix=os.name != 'nt')
        except ValueError:
            tokens = command.split()
        for tok in tokens:
            if path_looks_outside_workspace(tok, policy.workspace_root):
                return f'path outside workspace blocked: {tok}'
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
        from app.lib.async_subprocess import communicate_or_kill

        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd or None,
            env=os.environ.copy(),
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
    except asyncio.TimeoutError:
        return SandboxResult(
            ok=False,
            denial_reason=f'Command timed out after {int(timeout)}s',
            enforcement=enforcement,  # type: ignore[arg-type]
            sandboxed=sandboxed,
            elapsed_ms=int((time.monotonic() - started) * 1000),
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
