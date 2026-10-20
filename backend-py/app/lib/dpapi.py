"""Windows DPAPI — the operating system's own key store, reached with ``ctypes``.

August is a Windows desktop app with an NSIS installer, and Windows already
ships a per-user key store: **DPAPI** (``CryptProtectData`` /
``CryptUnprotectData``). The API is part of the platform, so reaching it needs
no dependency at all — no ``cryptography``, no ``keyring``, no lockfile edit.
``ctypes`` is the standard library's door to it.

WHAT DPAPI BUYS, PRECISELY
--------------------------
* A blob protected in the USER scope is encrypted under a key derived from the
  signed-in user's DPAPI master key. That key lives in *that user's* profile
  (``%APPDATA%\\Microsoft\\Protect\\<SID>``) and is itself protected by the
  user's logon credentials. So the blob is bound to BOTH the user and the
  machine: another Windows account on the same box does not hold that key,
  and a copy of the file on another machine has no master key to match.
* The plaintext never reaches the disk. Only the ciphertext does.

WHAT IT DOES NOT BUY
--------------------
* It does not protect against code running **as** that user. A process that
  can read the file can also call ``CryptUnprotectData`` as that user. This
  is the boundary every credential store on the platform shares: it stops a
  copied file, a synced backup, a shared drive and a second account; it does
  not stop the user's own malware.
* The entropy used here is **not a secret** — it is a constant in this file.
  It exists so a blob lifted out of August's store cannot be decrypted by an
  unrelated program running as the same user. The real key is the one DPAPI
  keeps; the entropy only binds the blob to August.

THE PLATFORM FALLBACK IS A SEPARATE DECISION, AND IT IS NOT MADE HERE
--------------------------------------------------------------------
This module refuses to work off Windows: it raises :class:`DpapiUnavailable`.
What a caller does with that — a labelled plaintext fallback, or a hard
failure — is the caller's policy, and it is stated where it is made
(``app/services/secret_store.py``). This module never silently degrades to
"encrypting" something it did not encrypt.
"""

from __future__ import annotations

import ctypes
import os

__all__ = [
    'ENTROPY',
    'DpapiError',
    'DpapiUnavailable',
    'is_supported',
    'protect',
    'unprotect',
]

#: App entropy mixed into every blob this store writes.
#:
#: NOT a secret — it is a constant in this file. It binds a blob to August,
#: so a blob lifted out of the store cannot be decrypted by an unrelated
#: program running as the same user. The actual key is DPAPI's.
ENTROPY = b'AugustProxy.secret-store.v1'

#: ``CRYPTPROTECT_UI_FORBIDDEN`` — never prompt, never show UI. A backend
#: service has no one to answer a dialog, and a prompt is how a store turns
#: into a hang.
_CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DpapiError(RuntimeError):
    """A DPAPI call failed: the OS refused, or the blob is not ours."""


class DpapiUnavailable(DpapiError):
    """This host has no usable Windows DPAPI (Linux, macOS, a container)."""


class _DataBlob(ctypes.Structure):
    """The Win32 ``DATA_BLOB`` — a counted byte buffer.

    ``c_uint32`` rather than ``wintypes.DWORD`` on purpose: it is exactly 32
    bits on every platform, so the structure can be declared at import time
    on a host that will never call it.
    """

    _fields_ = [
        ('cbData', ctypes.c_uint32),
        ('pbData', ctypes.POINTER(ctypes.c_char)),
    ]


_crypt32 = None
_kernel32 = None


def _load():
    """Bind ``crypt32``/``kernel32`` once. Windows only.

    ``getattr(ctypes, 'WinDLL')`` rather than ``ctypes.WinDLL`` so this module
    imports cleanly on a host where the name does not exist — the backend runs
    in Docker and under a bare uvicorn on Linux too.
    """
    global _crypt32, _kernel32
    if _crypt32 is not None and _kernel32 is not None:
        return _crypt32, _kernel32

    if os.name != 'nt':
        raise DpapiUnavailable('Windows DPAPI is not available on this platform')

    win_dll = getattr(ctypes, 'WinDLL', None)
    if win_dll is None:  # pragma: no cover - Windows always has it
        raise DpapiUnavailable('ctypes.WinDLL is not available on this platform')

    crypt32 = win_dll('crypt32', use_last_error=True)
    kernel32 = win_dll('kernel32', use_last_error=True)

    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob),  # pDataIn
        ctypes.c_wchar_p,  # szDataDescr
        ctypes.POINTER(_DataBlob),  # pOptionalEntropy
        ctypes.c_void_p,  # pvReserved
        ctypes.c_void_p,  # pPromptStruct
        ctypes.c_uint32,  # dwFlags
        ctypes.POINTER(_DataBlob),  # pDataOut
    ]
    crypt32.CryptProtectData.restype = ctypes.c_int
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob),  # pDataIn
        ctypes.POINTER(ctypes.c_wchar_p),  # ppszDataDescr
        ctypes.POINTER(_DataBlob),  # pOptionalEntropy
        ctypes.c_void_p,  # pvReserved
        ctypes.c_void_p,  # pPromptStruct
        ctypes.c_uint32,  # dwFlags
        ctypes.POINTER(_DataBlob),  # pDataOut
    ]
    crypt32.CryptUnprotectData.restype = ctypes.c_int
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    _crypt32 = crypt32
    _kernel32 = kernel32
    return _crypt32, _kernel32


def _last_error() -> int:
    """The Win32 error from the last ctypes call, or 0 off Windows.

    ``ctypes.get_last_error`` exists only on Windows; referencing it
    directly makes Linux mypy (the CI platform) fail even though this module
    is never called there. The ``getattr`` keeps one body type-checkable on
    both hosts without a platform-specific ignore.
    """
    getter = getattr(ctypes, 'get_last_error', None)
    return int(getter()) if getter is not None else 0


def is_supported() -> bool:
    """True when this host has a usable Windows DPAPI."""
    if os.name != 'nt':
        return False
    try:
        _load()
    except (OSError, AttributeError, DpapiUnavailable):
        return False
    return True


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    """A ``DATA_BLOB`` over a copy of ``data`` (the buffer must outlive the call)."""
    buf = ctypes.create_string_buffer(data, len(data))
    blob = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf


def protect(data: bytes, *, entropy: bytes = ENTROPY) -> bytes:
    """Encrypt ``data`` with the current user's DPAPI key.

    Returns the raw ``CryptProtectData`` ciphertext (binary, NOT base64 —
    the caller decides how to put it on disk).
    """
    if not data:
        return b''
    crypt32, kernel32 = _load()
    in_blob, _in_buf = _blob(data)
    ent_blob: _DataBlob | None = None
    _ent_buf: ctypes.Array | None = None
    if entropy:
        ent_blob, _ent_buf = _blob(entropy)
    out = _DataBlob()
    ok = crypt32.CryptProtectData(
        ctypes.byref(in_blob),
        None,  # szDataDescr
        ctypes.byref(ent_blob) if ent_blob is not None else None,
        None,  # pvReserved
        None,  # pPromptStruct
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out),
    )
    if not ok:
        raise DpapiError(f'CryptProtectData failed (Windows error {_last_error()})')
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


def unprotect(blob: bytes, *, entropy: bytes = ENTROPY) -> bytes:
    """Decrypt a blob produced by :func:`protect`.

    Raises :class:`DpapiError` when the OS refuses — which is what a blob
    from another user, another machine, a tampered file, or a different
    entropy looks like. The four are indistinguishable to the caller on
    purpose: DPAPI does not say which one it was.
    """
    if not blob:
        raise DpapiError('CryptUnprotectData failed: empty blob')
    crypt32, kernel32 = _load()
    in_blob, _in_buf = _blob(blob)
    ent_blob: _DataBlob | None = None
    _ent_buf: ctypes.Array | None = None
    if entropy:
        ent_blob, _ent_buf = _blob(entropy)
    out = _DataBlob()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,  # ppszDataDescr
        ctypes.byref(ent_blob) if ent_blob is not None else None,
        None,  # pvReserved
        None,  # pPromptStruct
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out),
    )
    if not ok:
        raise DpapiError(f'CryptUnprotectData failed (Windows error {_last_error()})')
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))
