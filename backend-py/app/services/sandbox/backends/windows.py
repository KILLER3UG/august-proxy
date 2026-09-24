"""Windows sandbox backend — AppContainer only when it is provably real.

HISTORY (read before changing anything here)
--------------------------------------------
This module used to report ``windows-appcontainer`` whenever the AppContainer
symbols merely EXISTED in ``userenv``/``kernel32``, and then fall back to a
plain host-process spawn for every command. That produced a fake security
boundary: doctor printed "Windows AppContainer isolation" while nothing was
contained. The label is now earned, not assumed.

``probe()`` builds a real ``PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES``
attribute list — the exact structure ``CreateProcessW`` would need — and
reports success only when the OS accepts it. Creating a profile or finding a
symbol is not containment; a SECURITY_CAPABILITIES attribute list is.

Known host result: on Windows 11 26200 the OS rejects that attribute with
ERROR_INVALID_PARAMETER (87) even though ``DeriveAppContainerSidFromAppContainerName``
succeeds and other attributes (PARENT_PROCESS, HANDLE_LIST) on the same list
succeed. This host is therefore NOT AppContainer-capable, the tier stays off,
and the honest answer stays ``soft``. Do not work around that rejection by
loosening the probe — a backend that claims a boundary it does not have is
worse than no backend at all.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.sandbox.policy import SandboxPolicy, SandboxResult

_PROFILE_NAME = 'August.AgentSandbox'
_PROFILE_DISPLAY = 'August'
_PROFILE_DESC = 'August agent sandbox'

# PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
_PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009

_ENV_OPTOUT = 'AUGUST_SANDBOX_APPCONTAINER'
_TRUTHY = ('1', 'true', 'yes')
_FALSY = ('0', 'false', 'no', 'off')

# (capable, reason). ``reason`` is empty when capable.
_probe_cache: tuple[bool, str] | None = None


def opt_in() -> bool:
    """True when the user explicitly asked for the AppContainer tier."""
    return os.environ.get(_ENV_OPTOUT, '').strip().lower() in _TRUTHY


def _invalidate_probe() -> None:
    global _probe_cache
    _probe_cache = None


def _build_security_capabilities_attribute() -> tuple[object | None, str]:
    """Build a real SECURITY_CAPABILITIES attribute list.

    Returns ``(attribute_list_holder, reason)``; the reason is non-empty when
    the OS refused the attribute. The returned object must stay alive for as
    long as the list is used (it owns the ctypes buffer), which is why it is
    returned rather than just a boolean.
    """
    if sys.platform != 'win32':
        return None, 'not running on Windows'
    try:
        import ctypes
        from ctypes import wintypes

        userenv = ctypes.WinDLL('userenv')  # type: ignore[attr-defined]
        kernel32 = ctypes.WinDLL('kernel32')  # type: ignore[attr-defined]

        class _SecurityCapabilities(ctypes.Structure):
            _fields_ = [
                ('AppContainerSid', ctypes.c_void_p),
                ('CapabilityCount', wintypes.DWORD),
                ('Capabilities', ctypes.c_void_p),
                ('Reserved', wintypes.DWORD),
            ]

        derive = userenv.DeriveAppContainerSidFromAppContainerName
        derive.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
        derive.restype = ctypes.c_long
        sid = ctypes.c_void_p()
        hr = derive(_PROFILE_NAME, ctypes.byref(sid))
        if hr != 0 or not sid:
            create = userenv.CreateAppContainerProfile
            create.argtypes = [
                wintypes.LPCWSTR,
                wintypes.LPCWSTR,
                wintypes.LPCWSTR,
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            create.restype = ctypes.c_long
            made = ctypes.c_void_p()
            hr = create(
                _PROFILE_NAME,
                _PROFILE_DISPLAY,
                _PROFILE_DESC,
                None,
                0,
                ctypes.byref(made),
            )
            # 0 = created, 0x800700B7 (ERROR_ALREADY_EXISTS) = raced a
            # concurrent create, which is still fine.
            if hr not in (0, -2147024713) or not made:
                return None, f'could not create AppContainer profile (hr={hr:#x})'
            sid = made
        if not sid:
            return None, 'AppContainer SID unavailable'

        initialize = kernel32.InitializeProcThreadAttributeList
        initialize.argtypes = [
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        update = kernel32.UpdateProcThreadAttribute
        update.argtypes = [
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_size_t,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]

        size = ctypes.c_size_t()
        # First call is a size query and is expected to fail.
        initialize(None, 1, 0, ctypes.byref(size))
        if not size.value:
            return None, 'attribute-list size query returned 0'
        buffer = ctypes.create_string_buffer(size.value)
        attribute_list = ctypes.cast(buffer, ctypes.c_void_p)
        if not initialize(attribute_list, 1, 0, ctypes.byref(size)):
            return None, f'InitializeProcThreadAttributeList failed ({ctypes.get_last_error()})'

        caps = _SecurityCapabilities(ctypes.c_void_p(sid.value), 0, None, 0)
        ok = update(
            attribute_list,
            0,
            _PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            ctypes.byref(caps),
            ctypes.sizeof(caps),
            None,
            None,
        )
        if not ok:
            return None, (
                'OS rejected PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES '
                f'(error {ctypes.get_last_error()}) — this host cannot create an AppContainer'
            )
        return _AttributeListHolder(buffer, attribute_list), ''
    except Exception as exc:  # pragma: no cover - defensive, host-specific
        return None, f'AppContainer probe failed: {exc}'


class _AttributeListHolder:
    """Keeps the ctypes buffer alive for as long as the list is referenced."""

    def __init__(self, buffer: object, attribute_list: object) -> None:
        self.buffer = buffer
        self.attribute_list = attribute_list


def probe() -> tuple[bool, str]:
    """``(capable, reason_when_not)`` for the AppContainer tier.

    This proves the OS will accept a SECURITY_CAPABILITIES attribute list —
    the same call ``CreateProcessW`` needs. It does NOT spawn a process, so
    it is cheap enough to sit behind the 30s selection cache.
    """
    global _probe_cache
    if _probe_cache is not None:
        return _probe_cache
    holder, reason = _build_security_capabilities_attribute()
    capable = holder is not None
    _probe_cache = (capable, reason if not capable else '')
    return _probe_cache


def reset_probe() -> None:
    """Test hook — drop the memoized capability result."""
    _invalidate_probe()


def is_available() -> bool:
    """True ONLY when the AppContainer tier is both requested and proven.

    The opt-in check is deliberate: a capable host must not silently take
    over enforcement for a user who never asked for it.
    """
    if not opt_in():
        return False
    capable, _ = probe()
    return capable


async def run(command: str, policy: 'SandboxPolicy', *, timeout: float) -> 'SandboxResult':
    """Run on Windows.

    Until the native ``CreateProcessW`` spawn lands (blocked: see module
    docstring), there is no code path that can honestly return
    ``enforcement='windows-appcontainer'`` — so this always runs soft and
    always says so. Selecting this backend is therefore a no-op, and
    ``select_backend_name()`` will not pick it while the probe fails.
    """
    from app.services.sandbox.backends.fallback import run_soft, soft_preflight
    from app.services.sandbox.policy import SandboxResult

    denial = soft_preflight(command, policy)
    if denial:
        return SandboxResult(ok=False, denial_reason=denial, enforcement='soft', sandboxed=True)

    result = await run_soft(command, policy, timeout=timeout)
    # Belt and braces: whatever the soft runner returns, this backend must not
    # ever be able to report an AppContainer label it did not earn.
    result.enforcement = 'soft'
    return result


async def run_via_cmd(command: str, *, cwd: str, timeout: float) -> tuple[int, str, str]:
    from app.lib.async_subprocess import agent_subprocess_kwargs, communicate_or_kill

    proc = await asyncio.create_subprocess_shell(
        command,
        **agent_subprocess_kwargs(cwd=cwd or None),
    )
    out_b, err_b = await communicate_or_kill(proc, timeout=timeout)
    return (
        int(proc.returncode or 0),
        out_b.decode('utf-8', errors='replace') if out_b else '',
        err_b.decode('utf-8', errors='replace') if err_b else '',
    )
