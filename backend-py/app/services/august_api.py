"""August self-management API — proxy status, diagnostics, environment info.

Port of backend/services/august-api/august-api.js.
"""

from __future__ import annotations

import os
import platform
from typing import Any


def get_proxy_info() -> dict[str, Any]:
    return {
        "version": "0.12.0",
        "mode": "python",
        "python_version": platform.python_version(),
        "platform": platform.system(),
        "pid": os.getpid(),
    }


def get_proxy_diagnostics() -> dict[str, Any]:
    from app.services.memory_store import get_stats

    return {
        "proxy": get_proxy_info(),
        "memory_stats": get_stats(),
        "uptime": 0,
    }


def get_proxy_settings() -> dict[str, Any]:
    from app.config import settings

    return {
        "port": settings.port,
        "data_dir": str(settings.data_dir),
        "web_dist": str(settings.web_dist) if settings.web_dist.exists() else None,
    }
