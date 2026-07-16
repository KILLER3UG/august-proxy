"""macOS Seatbelt backend via ``sandbox-exec``."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import time
from pathlib import Path

from app.services.sandbox.backends.fallback import soft_preflight
from app.services.sandbox.paths import resolve_workspace_root
from app.services.sandbox.policy import SandboxPolicy, SandboxResult


def is_available() -> bool:
    return os.name != 'nt' and shutil.which('sandbox-exec') is not None


def _seatbelt_profile(policy: SandboxPolicy) -> str:
    root = resolve_workspace_root(policy.workspace_root)
    root_str = str(root) if root else '/tmp'
    # Allow read of system paths; write only inside workspace (+ /tmp).
    network_rule = '(allow network*)' if policy.network else '(deny network*)'
    write_rules = f'''
(allow file-write*
    (subpath "{root_str}")
    (subpath "/tmp")
    (subpath "/private/tmp")
    (subpath "/var/folders"))
'''
    if policy.is_read_only:
        write_rules = '(deny file-write*)'

    return f'''
(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
{write_rules}
{network_rule}
'''


async def run(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    denial = soft_preflight(command, policy)
    if denial:
        return SandboxResult(
            ok=False,
            denial_reason=denial,
            enforcement='seatbelt',
            sandboxed=True,
        )

    root = resolve_workspace_root(policy.workspace_root)
    cwd = str(root) if root is not None else os.getcwd()
    profile = _seatbelt_profile(policy)
    started = time.monotonic()

    profile_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile('w', suffix='.sb', delete=False, encoding='utf-8') as fh:
            fh.write(profile)
            profile_path = fh.name

        shell = os.environ.get('SHELL') or '/bin/bash'
        proc = await asyncio.create_subprocess_exec(
            'sandbox-exec',
            '-f',
            profile_path,
            shell,
            '-lc',
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return SandboxResult(
            ok=proc.returncode == 0,
            stdout=out_b.decode('utf-8', errors='replace') if out_b else '',
            stderr=err_b.decode('utf-8', errors='replace') if err_b else '',
            exit_code=proc.returncode,
            enforcement='seatbelt',
            sandboxed=True,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except asyncio.TimeoutError:
        return SandboxResult(
            ok=False,
            denial_reason=f'Command timed out after {int(timeout)}s',
            enforcement='seatbelt',
            sandboxed=True,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except Exception as exc:
        # Fall back to soft if seatbelt spawn fails
        from app.services.sandbox.backends.fallback import run_soft

        soft = await run_soft(command, policy, timeout=timeout)
        soft.stderr = (soft.stderr or '') + f'\n[seatbelt fallback: {exc}]'
        return soft
    finally:
        if profile_path:
            try:
                Path(profile_path).unlink(missing_ok=True)
            except OSError:
                pass
