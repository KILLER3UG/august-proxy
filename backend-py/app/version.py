"""
Backend-reported version — single source of truth for health endpoints.

Packaged desktop builds stage the app version into ``backend-runtime.json``
beside ``backend-py/``; a repo checkout reads the root ``package.json``. Both
sit one level above the package root, so one pair of candidates covers dev and
installed runs.

The previous implementation walked four ``.parent`` steps from this file —
landing one directory ABOVE the repo root — so it never found the checkout's
``package.json`` and every dev / backend-only run reported the ``0.1.0``
fallback on ``/api/health`` while the app was really on 0.18.x. A model that
read its own version out of ``diagnose_proxy`` was told something false.
"""

from __future__ import annotations

import json
from pathlib import Path

_VERSION_CACHE: str | None = None
# .../backend-py in a checkout, .../resources/backend-py when packaged.
_PKG_ROOT = Path(__file__).resolve().parents[1]


def _readVersion(path: Path) -> str:
    """The version of a staged runtime manifest or a package.json, or ''."""
    try:
        if not path.is_file():
            return ''
        data = json.loads(path.read_text(encoding='utf-8', errors='replace'))
        if not isinstance(data, dict):
            return ''
        for key in ('appVersion', 'version'):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        return ''
    return ''


def backend_version() -> str:
    """The version August reports on /api/health (never raises)."""
    global _VERSION_CACHE
    if _VERSION_CACHE is not None:
        return _VERSION_CACHE
    above = _PKG_ROOT.parent
    _VERSION_CACHE = (
        _readVersion(above / 'backend-runtime.json') or _readVersion(above / 'package.json') or '0.1.0'
    )
    return _VERSION_CACHE
