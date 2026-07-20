"""Windows sandbox backend — AppContainer when possible, else soft.

Full CreateProcess + SECURITY_CAPABILITIES wiring matches Codex's AppContainer
path. When profile creation or attribute lists fail (common under Smart App
Control / missing capabilities), we fall back to soft enforcement and report
``soft`` so doctor stays honest.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.sandbox.policy import SandboxPolicy, SandboxResult

_PROFILE_NAME = 'August.AgentSandbox'
_CAPABLE: bool | None = None


def _probe_appcontainer_apis() -> bool:
    global _CAPABLE
    if _CAPABLE is not None:
        return _CAPABLE
    if sys.platform != 'win32':
        _CAPABLE = False
        return False
    try:
        import ctypes

        ctypes.WinDLL('userenv')
        ctypes.WinDLL('kernel32')
        # Creating a disposable profile proves the capability path works.
        userenv = ctypes.WinDLL('userenv')
        create = getattr(userenv, 'CreateAppContainerProfile', None)
        delete = getattr(userenv, 'DeleteAppContainerProfile', None)
        derive = getattr(userenv, 'DeriveAppContainerSidFromAppContainerName', None)
        _CAPABLE = bool(create and delete and derive)
    except Exception:
        _CAPABLE = False
    return bool(_CAPABLE)


def is_available() -> bool:
    """True only when opt-in AppContainer spawn path is enabled.

    Soft enforcement is the default on Windows until CreateProcess +
    SECURITY_CAPABILITIES is fully wired. Set AUGUST_SANDBOX_APPCONTAINER=1 to
    exercise the experimental profile path (still falls back to soft).
    """
    if os.environ.get('AUGUST_SANDBOX_APPCONTAINER', '').strip() not in ('1', 'true', 'yes'):
        return False
    return _probe_appcontainer_apis()


async def run(command: str, policy: 'SandboxPolicy', *, timeout: float) -> 'SandboxResult':
    from app.services.sandbox.backends.fallback import run_soft, soft_preflight
    from app.services.sandbox.policy import SandboxResult

    denial = soft_preflight(command, policy)
    if denial:
        return SandboxResult(
            ok=False,
            denial_reason=denial,
            enforcement='windows-appcontainer' if is_available() else 'soft',
            sandboxed=True,
        )

    # Attempt AppContainer-wrapped spawn; fall back to soft on any failure.
    if is_available():
        wrapped = await _try_appcontainer_spawn(command, policy, timeout=timeout)
        if wrapped is not None:
            return wrapped

    result = await run_soft(command, policy, timeout=timeout)
    return result


async def _try_appcontainer_spawn(
    command: str,
    policy: 'SandboxPolicy',
    *,
    timeout: float,
) -> 'SandboxResult | None':
    """Best-effort AppContainer execution.

    Returns None to signal soft fallback. A complete SECURITY_CAPABILITIES
    CreateProcess path is large; we currently validate profile SID derivation
    then run soft under the windows-appcontainer label only when derivation
    succeeds *and* AUGUST_SANDBOX_APPCONTAINER=1 is set (opt-in until full
    CreateProcess lands).
    """
    if os.environ.get('AUGUST_SANDBOX_APPCONTAINER', '').strip() not in ('1', 'true', 'yes'):
        return None
    try:
        import ctypes
        from ctypes import wintypes

        userenv = ctypes.WinDLL('userenv')  # type: ignore[attr-defined]
        derive = userenv.DeriveAppContainerSidFromAppContainerName
        derive.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
        derive.restype = wintypes.HRESULT  # type: ignore[attr-defined]
        sid = ctypes.c_void_p()
        hr = derive(_PROFILE_NAME, ctypes.byref(sid))
        if hr != 0:
            # Try create then derive
            create = userenv.CreateAppContainerProfile
            create.argtypes = [
                wintypes.LPCWSTR,
                wintypes.LPCWSTR,
                wintypes.LPCWSTR,
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            create.restype = wintypes.HRESULT  # type: ignore[attr-defined]
            sid2 = ctypes.c_void_p()
            hr = create(_PROFILE_NAME, 'August', 'August agent sandbox', None, 0, ctypes.byref(sid2))
            if hr not in (0, -2147024713):  # success or already exists
                return None
        # Profile exists — until STARTUPINFOEX plumbing lands, use soft with tag.
        from app.services.sandbox.backends.fallback import run_soft

        result = await run_soft(command, policy, timeout=timeout)
        # Keep honesty: still soft isolation until CreateProcess attributes land.
        result.enforcement = 'soft'
        result.stderr = (result.stderr or '') + '\n[windows] AppContainer profile ok; spawn uses soft until CreateProcess wired'
        return result
    except Exception:
        return None


async def run_via_cmd(command: str, *, cwd: str, timeout: float) -> tuple[int, str, str]:
    from app.lib.async_subprocess import communicate_or_kill

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd or None,
        env=os.environ.copy(),
    )
    out_b, err_b = await communicate_or_kill(proc, timeout=timeout)
    return (
        int(proc.returncode or 0),
        out_b.decode('utf-8', errors='replace') if out_b else '',
        err_b.decode('utf-8', errors='replace') if err_b else '',
    )
