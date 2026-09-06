"""Container execution backend: real OS-level isolation via Docker.

The policy layer (path scans, redirect checks, denylists) is advisory on a
desktop host — this backend is the enforceable tier. When enabled and Docker
is reachable, `run_command` executes inside a container with the workspace
bind-mounted at /workspace, no host filesystem access beyond that mount, and
``--network none`` unless the policy allows network.

Opt-in by design: desktop users without Docker must not regress, so this
backend activates only when ``AUGUST_CONTAINER_SANDBOX`` is truthy AND the
Docker daemon answers. Selection lives in backends/__init__ (container wins
over the platform backends when enabled — the user asked for it).

Image: ``AUGUST_SANDBOX_IMAGE`` (default ``python:3.12-slim``) — it must
carry a POSIX shell. Resource caps: ``AUGUST_SANDBOX_MEMORY`` (default 2g),
``AUGUST_SANDBOX_CPUS`` (default 2).
"""

from __future__ import annotations

import os
import shutil
import time
import uuid
from pathlib import Path

from app.services.sandbox.paths import resolve_workspace_root
from app.services.sandbox.policy import SandboxPolicy, SandboxResult

_PROBE_TTL_S = 60
_probe_cache: tuple[float, bool] | None = None


def container_enabled() -> bool:
    """Opt-in flag — the container tier never activates silently."""
    return os.environ.get('AUGUST_CONTAINER_SANDBOX', '').strip().lower() in (
        '1',
        'true',
        'yes',
    )


def is_available() -> bool:
    """Docker CLI present AND the daemon answers. Probed at most once/minute."""
    global _probe_cache
    now = time.monotonic()
    if _probe_cache is not None and now - _probe_cache[0] < _PROBE_TTL_S:
        return _probe_cache[1]
    available = False
    docker = shutil.which('docker')
    if docker:
        try:
            import subprocess

            probe = subprocess.run(
                [docker, 'version', '--format', '{{.Server.Version}}'],
                capture_output=True,
                text=True,
                timeout=10,
            )
            available = probe.returncode == 0
        except (OSError, subprocess.SubprocessError):
            available = False
    _probe_cache = (now, available)
    return available


def build_docker_argv(command: str, policy: SandboxPolicy, name: str) -> list[str] | None:
    """The docker invocation for one command; None when unrunnable (no workspace)."""
    docker = shutil.which('docker')
    if not docker:
        return None
    root = resolve_workspace_root(policy.workspace_root)
    if root is None:
        return None
    mount = str(Path(root).resolve()).replace('\\', '/')
    mount_spec = f'{mount}:/workspace'
    if policy.is_read_only:
        mount_spec += ':ro'
    argv = [
        docker,
        'run',
        '--rm',
        '--name',
        name,
        '-v',
        mount_spec,
        '--workdir',
        '/workspace',
        '--memory',
        os.environ.get('AUGUST_SANDBOX_MEMORY', '2g'),
        '--cpus',
        os.environ.get('AUGUST_SANDBOX_CPUS', '2'),
        '-e',
        'TERM=dumb',
        '-e',
        'PYTHONDONTWRITEBYTECODE=1',
    ]
    if not policy.network:
        argv += ['--network', 'none']
    image = os.environ.get('AUGUST_SANDBOX_IMAGE', 'python:3.12-slim')
    argv += [image, 'sh', '-lc', command]
    return argv


async def run(command: str, policy: SandboxPolicy, *, timeout: float) -> SandboxResult:
    import asyncio

    from app.lib.async_subprocess import (
        SubprocessAborted,
        agent_subprocess_kwargs,
        communicate_or_kill,
    )

    started = time.monotonic()
    name = f'august-sbx-{uuid.uuid4().hex[:10]}'
    argv = build_docker_argv(command, policy, name)
    if argv is None:
        # No workspace to mount (home-anchored Tasks sessions) or no CLI —
        # fall through to the host soft backend rather than failing the tool.
        from app.services.sandbox.backends.fallback import run_soft

        return await run_soft(command, policy, timeout=timeout)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            **agent_subprocess_kwargs(),
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
            enforcement='container',
            sandboxed=True,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except SubprocessAborted as abort:
        # Killing the docker CLI leaves the container running — stop it too.
        try:
            import asyncio as _asyncio

            docker = shutil.which('docker')
            if docker:
                _asyncio.create_task(
                    _asyncio.create_subprocess_exec(
                        docker, 'kill', name,
                        stdout=_asyncio.subprocess.DEVNULL,
                        stderr=_asyncio.subprocess.DEVNULL,
                    )
                )
        except (OSError, Exception):
            pass
        elapsed = int((time.monotonic() - started) * 1000)
        if abort.reason == 'cancelled':
            msg = 'Error: Command cancelled by user.'
        else:
            msg = (
                f'Error: Command timed out after {int(timeout)}s and was killed '
                '(container stopped). Use non-interactive flags only.'
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
            enforcement='container',
            sandboxed=True,
            elapsed_ms=elapsed,
        )
    except Exception as exc:
        return SandboxResult(
            ok=False,
            denial_reason=f'Container backend failed to start: {exc}',
            enforcement='container',
            sandboxed=True,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
