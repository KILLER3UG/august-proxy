"""Public sandboxed command runner."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

from app.services.sandbox.backends import run_with_best_backend, select_backend_name
from app.services.sandbox.policy import (
    DEFAULT_SANDBOX_MODE,
    SandboxPolicy,
    SandboxResult,
    normalize_sandbox_mode,
)

if TYPE_CHECKING:
    from app.services.sandbox.policy import EnforcementBackend


def command_fingerprint(command: str) -> str:
    digest = hashlib.sha256(command.strip().encode('utf-8')).hexdigest()
    return digest[:16]


def unsandboxed_grant_key(command: str) -> str:
    return f'sandbox:unsandboxed:{command_fingerprint(command)}'


def policy_from_session(
    *,
    sandbox_mode: str | None,
    workspace_path: str | None,
    sandbox_network: bool | None = None,
    allow_unsandboxed: bool = False,
) -> SandboxPolicy:
    mode = normalize_sandbox_mode(sandbox_mode or DEFAULT_SANDBOX_MODE)
    network = bool(sandbox_network) if sandbox_network is not None else False
    if mode == 'danger-full-access':
        network = True
    roots: tuple[str, ...] = ()
    ws = (workspace_path or '').strip()
    if ws:
        roots = (ws,)
    return SandboxPolicy(
        mode=mode,
        workspace_root=ws,
        network=network,
        writable_roots=roots,
        allow_unsandboxed=allow_unsandboxed or mode == 'danger-full-access',
    )


def active_backend() -> 'EnforcementBackend':
    return select_backend_name()


async def run_sandboxed(
    command: str,
    policy: SandboxPolicy,
    *,
    timeout: float = 300.0,
) -> SandboxResult:
    return await run_with_best_backend(command, policy, timeout=timeout)
