"""Linux sandbox backend — prefer ``bwrap``, else soft (Landlock tagged when probe ok)."""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from typing import Literal

from app.services.sandbox.backends.fallback import soft_preflight
from app.services.sandbox.paths import resolve_workspace_root
from app.services.sandbox.policy import SandboxPolicy, SandboxResult

LinuxBackend = Literal['bwrap', 'landlock', 'soft']


def _landlock_probe() -> bool:
    """Best-effort: Landlock is available on modern kernels (ABI via syscall)."""
    try:
        # Full Landlock ruleset application needs a helper; probe host only.
        uname = getattr(os, 'uname', None)
        return os.path.exists('/proc/sys/kernel') and uname is not None and uname().sysname == 'Linux'
    except Exception:
        return False


def is_available() -> bool:
    return os.name != 'nt' and (shutil.which('bwrap') is not None or _landlock_probe())


def backend_kind() -> LinuxBackend:
    if shutil.which('bwrap') is not None:
        return 'bwrap'
    if _landlock_probe():
        return 'landlock'
    return 'soft'


async def run(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    denial = soft_preflight(command, policy)
    kind = backend_kind()
    if denial:
        return SandboxResult(
            ok=False,
            denial_reason=denial,
            enforcement='bwrap' if kind == 'bwrap' else 'landlock' if kind == 'landlock' else 'soft',
            sandboxed=True,
        )

    if kind == 'bwrap':
        return await _run_bwrap(command, policy, timeout=timeout)

    # Landlock without a dedicated launcher → soft with landlock tag when probe ok
    # (full Landlock ruleset application needs a small C/Rust helper; soft stays honest).
    from app.services.sandbox.backends.fallback import run_soft

    result = await run_soft(command, policy, timeout=timeout)
    if kind == 'landlock' and result.denial_reason is None:
        # Soft enforcement only — do not claim Landlock isolation.
        result.enforcement = 'soft'
    return result


async def _run_bwrap(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    root = resolve_workspace_root(policy.workspace_root)
    cwd = str(root) if root is not None else os.getcwd()
    started = time.monotonic()

    args: list[str] = [
        'bwrap',
        '--die-with-parent',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/bin',
        '/bin',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--ro-bind-try',
        '/etc',
        '/etc',
        '--tmpfs',
        '/tmp',
        '--chdir',
        cwd,
    ]
    if root is not None:
        if policy.is_read_only:
            args.extend(['--ro-bind', str(root), str(root)])
        else:
            args.extend(['--bind', str(root), str(root)])
    if not policy.network:
        args.extend(['--unshare-net'])
    args.extend(['--', 'bash', '-lc', command])

    from app.lib.async_subprocess import (
        SubprocessAborted,
        agent_subprocess_kwargs,
        communicate_or_kill,
    )

    try:
        spawn_kwargs = agent_subprocess_kwargs(cwd=None)
        # bwrap already sets --chdir; do not override with host cwd.
        spawn_kwargs.pop('cwd', None)
        proc = await asyncio.create_subprocess_exec(*args, **spawn_kwargs)
        out_b, err_b = await communicate_or_kill(proc, timeout=timeout)
        return SandboxResult(
            ok=proc.returncode == 0,
            stdout=out_b.decode('utf-8', errors='replace') if out_b else '',
            stderr=err_b.decode('utf-8', errors='replace') if err_b else '',
            exit_code=proc.returncode,
            enforcement='bwrap',
            sandboxed=True,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except SubprocessAborted as abort:
        elapsed = int((time.monotonic() - started) * 1000)
        msg = (
            'Error: Command cancelled by user.'
            if abort.reason == 'cancelled'
            else (
                f'Error: Command timed out after {int(timeout)}s and was killed. '
                'Use non-interactive flags only (no pagers, REPLs, or password prompts).'
            )
        )
        return SandboxResult(
            ok=False,
            stdout='',
            stderr=msg,
            exit_code=-1,
            enforcement='bwrap',
            sandboxed=True,
            elapsed_ms=elapsed,
        )
    except Exception as exc:
        from app.services.sandbox.backends.fallback import run_soft

        soft = await run_soft(command, policy, timeout=timeout)
        soft.stderr = (soft.stderr or '') + f'\n[bwrap fallback: {exc}]'
        return soft
