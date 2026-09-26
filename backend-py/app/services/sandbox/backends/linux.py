"""Linux sandbox backend — ``bwrap`` when it exists, otherwise soft.

Landlock is deliberately NOT reported as a tier. Applying a ruleset needs a
launcher August does not ship, so a "landlock" host ran exactly as confined as
a "soft" one — while `enforcement_report()` advertised real OS isolation and
`strong_backend_active()` refused the warm code kernel on a host that had no
isolation to lose. A kernel feature with no enforcer is not enforcement.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from typing import Literal

from app.services.sandbox.backends.fallback import soft_preflight
from app.services.sandbox.paths import resolve_workspace_root
from app.services.sandbox.policy import SandboxPolicy, SandboxResult

LinuxBackend = Literal['bwrap', 'soft']


def is_available() -> bool:
    return os.name != 'nt' and shutil.which('bwrap') is not None


def backend_kind() -> LinuxBackend:
    return 'bwrap' if shutil.which('bwrap') is not None else 'soft'


async def run(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    denial = soft_preflight(command, policy)
    kind = backend_kind()
    if denial:
        return SandboxResult(
            ok=False,
            denial_reason=denial,
            enforcement='bwrap' if kind == 'bwrap' else 'soft',
            sandboxed=True,
        )

    if kind == 'bwrap':
        return await _run_bwrap(command, policy, timeout=timeout)

    from app.services.sandbox.backends.fallback import run_soft

    return await run_soft(command, policy, timeout=timeout)


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
        partialOut = abort.stdout.decode('utf-8', errors='replace') if abort.stdout else ''
        partialErr = abort.stderr.decode('utf-8', errors='replace') if abort.stderr else ''
        if partialOut or partialErr:
            msg += f'\n[killed at {abort.reason} — partial output below]'
            if partialErr:
                msg += '\n' + partialErr
        return SandboxResult(
            ok=False,
            stdout=partialOut,
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
