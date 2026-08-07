"""
Backend-reported version — single source of truth for health endpoints.

Reads the root ``package.json`` version when running from the repo (dev,
FastAPI-only runs) and falls back to ``0.1.0`` when packaged (the installer
stamp is the authoritative version there).
"""

from __future__ import annotations

import json
from pathlib import Path

_VERSION_CACHE: str | None = None


def backend_version() -> str:
    """The version August reports on /api/health (never raises)."""
    global _VERSION_CACHE
    if _VERSION_CACHE is not None:
        return _VERSION_CACHE
    try:
        pkg = Path(__file__).resolve().parent.parent.parent.parent / 'package.json'
        _VERSION_CACHE = str(json.loads(pkg.read_text('utf-8')).get('version', '0.1.0'))
    except Exception:
        _VERSION_CACHE = '0.1.0'
    return _VERSION_CACHE
