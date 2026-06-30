"""August self-management API — proxy status, diagnostics, environment info.

Port of backend/services/august-api/august-api.js.
"""
from __future__ import annotations
import os
import platform

def getProxyInfo() -> dict[str, object]:
    return {'version': '0.12.0', 'mode': 'python', 'python_version': platform.python_version(), 'platform': platform.system(), 'pid': os.getpid()}

def getProxyDiagnostics() -> dict[str, object]:
    from app.services.memoryStore import getStats
    return {'proxy': getProxyInfo(), 'memory_stats': getStats(), 'uptime': 0}

def getProxySettings() -> dict[str, object]:
    from app.config import settings
    return {'port': settings.port, 'data_dir': str(settings.dataDir), 'web_dist': str(settings.webDist) if settings.webDist.exists() else None}