"""Platform sandbox backends."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.sandbox.policy import EnforcementBackend, SandboxPolicy, SandboxResult


def select_backend_name() -> 'EnforcementBackend':
    """Report the best available enforcement backend for this host."""
    if sys.platform == 'darwin':
        from app.services.sandbox.backends.macos import is_available

        if is_available():
            return 'seatbelt'
    elif sys.platform.startswith('linux'):
        from app.services.sandbox.backends.linux import backend_kind, is_available

        if is_available():
            return backend_kind()
    elif sys.platform == 'win32':
        from app.services.sandbox.backends.windows import is_available

        if is_available():
            return 'windows-appcontainer'
    return 'soft'


async def run_with_best_backend(
    command: str,
    policy: 'SandboxPolicy',
    *,
    timeout: float,
) -> 'SandboxResult':
    """Dispatch to the strongest available backend, else soft.

    Hardline protected-path rules run first, before any backend and before
    the Full Access short-circuit — they cannot be overridden by mode.
    """
    from app.services.sandbox.hardline import check_hardline_command
    from app.services.sandbox.policy import SandboxResult

    denial = check_hardline_command(command)
    if denial:
        return SandboxResult(ok=False, denial_reason=denial, enforcement='soft', sandboxed=True, hardline=True)

    if policy.is_full_access:
        from app.services.sandbox.backends.fallback import run_unsandboxed

        return await run_unsandboxed(command, policy, timeout=timeout)

    name = select_backend_name()
    if name == 'seatbelt':
        from app.services.sandbox.backends.macos import run as run_macos

        return await run_macos(command, policy, timeout=timeout)
    if name in ('landlock', 'bwrap'):
        from app.services.sandbox.backends.linux import run as run_linux

        return await run_linux(command, policy, timeout=timeout)
    if name == 'windows-appcontainer':
        from app.services.sandbox.backends.windows import run as run_windows

        return await run_windows(command, policy, timeout=timeout)

    from app.services.sandbox.backends.fallback import run_soft

    return await run_soft(command, policy, timeout=timeout)
