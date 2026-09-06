"""Platform sandbox backends."""

from __future__ import annotations

import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.sandbox.policy import EnforcementBackend, SandboxPolicy, SandboxResult

_SELECT_TTL_S = 30
_select_cache: tuple[float, 'EnforcementBackend'] | None = None


def select_backend_name() -> 'EnforcementBackend':
    """Report the best available enforcement backend for this host.

    Probes are memoized for 30s: the platform probes (bwrap/landlock walks,
    AppContainer checks) ran on EVERY command through the hot path. The
    container tier is checked first — it is opt-in (AUGUST_CONTAINER_SANDBOX)
    and strictly stronger than the host-policy tiers, so when the user
    enabled it, it wins.
    """
    global _select_cache
    now = time.monotonic()
    if _select_cache is not None and now - _select_cache[0] < _SELECT_TTL_S:
        return _select_cache[1]

    from app.services.sandbox.backends.container import container_enabled, is_available

    backend: 'EnforcementBackend' = 'soft'
    if container_enabled() and is_available():
        backend = 'container'
    elif sys.platform == 'darwin':
        from app.services.sandbox.backends.macos import is_available

        if is_available():
            backend = 'seatbelt'
    elif sys.platform.startswith('linux'):
        from app.services.sandbox.backends.linux import backend_kind, is_available

        if is_available():
            backend = backend_kind()
    elif sys.platform == 'win32':
        from app.services.sandbox.backends.windows import is_available

        if is_available():
            backend = 'windows-appcontainer'
    _select_cache = (now, backend)
    return backend


def invalidate_backend_cache() -> None:
    """Re-probe on the next selection (after Docker starts/stops, env flips)."""
    global _select_cache
    _select_cache = None


async def run_with_best_backend(
    command: str,
    policy: 'SandboxPolicy',
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
    if name == 'container':
        from app.services.sandbox.backends.container import run as run_container

        return await run_container(command, policy, timeout=timeout)
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
