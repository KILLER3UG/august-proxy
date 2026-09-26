"""Platform sandbox backends."""

from __future__ import annotations

import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.sandbox.policy import EnforcementBackend, SandboxPolicy, SandboxResult

_SELECT_TTL_S = 30
_select_cache: tuple[float, 'EnforcementBackend'] | None = None

# Tiers that are real OS-level containment. Everything else is policy
# enforcement in the parent process, which the model shares a session with.
# Landlock is absent on purpose: August ships no ruleset launcher, so a
# "landlock" host is a soft host that happens to have a capable kernel.
STRONG_BACKENDS: frozenset[str] = frozenset(
    {'container', 'windows-appcontainer', 'seatbelt', 'bwrap'}
)


def select_backend_name() -> 'EnforcementBackend':
    """Report the best available enforcement backend for this host.

    Probes are memoized for 30s: the platform probes (bwrap lookup,
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


def strong_backend_active() -> bool:
    """True when commands run inside real OS-level containment.

    Code mode and any other path that spawns an interpreter directly must
    consult this: a direct child process is NOT covered by the sandbox
    backends, so a strong backend that is switched on makes the warm kernel
    the weakest link in the chain.
    """
    return select_backend_name() in STRONG_BACKENDS


def enforcement_report() -> dict[str, object]:
    """Requested vs effective enforcement, plus the reason for any gap.

    The distinction doctor/Settings must show. "The user asked for a
    container and did not get one" and "the user never asked" look identical
    if you only report the effective backend, which is how a requested-but-
    unavailable tier previously presented as healthy.
    """
    effective = select_backend_name()
    requested = 'soft'
    reason = ''

    if sys.platform == 'win32':
        from app.services.sandbox.backends import windows as _windows

        if _windows.opt_in():
            requested = 'windows-appcontainer'
            capable, why = _windows.probe()
            if not capable and why:
                reason = why
            elif capable and effective != 'windows-appcontainer':
                # Capable and requested, but a stronger opt-in tier won.
                reason = ''

    from app.services.sandbox.backends.container import container_enabled
    from app.services.sandbox.backends.container import probe as _cprobe

    if container_enabled():
        requested = 'container'
        available, why = _cprobe()
        if not available and why:
            reason = why
        elif available and effective != 'container':
            reason = ''

    if requested == 'soft' and not reason:
        reason = 'no OS-level sandbox tier is enabled on this host'

    return {
        'effective': effective,
        'requested': requested,
        'strong': effective in STRONG_BACKENDS,
        'degraded': requested in STRONG_BACKENDS and effective not in STRONG_BACKENDS,
        'reason': reason,
    }


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
    if name == 'bwrap':
        from app.services.sandbox.backends.linux import run as run_linux

        return await run_linux(command, policy, timeout=timeout)
    if name == 'windows-appcontainer':
        from app.services.sandbox.backends.windows import run as run_windows

        return await run_windows(command, policy, timeout=timeout)

    from app.services.sandbox.backends.fallback import run_soft

    return await run_soft(command, policy, timeout=timeout)
