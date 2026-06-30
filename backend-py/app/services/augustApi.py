"""August self-management API — proxy status, diagnostics, environment info.

Port of backend/services/august-api/august-api.js.
"""
from __future__ import annotations
import os
import platform
from typing import Any

def getProxyInfo() -> dict[str, Any]:
    return {'version': '0.12.0', 'mode': 'python', 'python_version': platform.python_version(), 'platform': platform.system(), 'pid': os.getpid()}

def getProxyDiagnostics() -> dict[str, Any]:
    from app.services.memoryStore import getStats
    return {'proxy': getProxyInfo(), 'memory_stats': getStats(), 'uptime': 0}

def getProxySettings() -> dict[str, Any]:
    from app.config import settings
    return {'port': settings.port, 'data_dir': str(settings.data_dir), 'web_dist': str(settings.web_dist) if settings.web_dist.exists() else None}