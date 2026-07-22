"""
System tools — process, network, disk, and environment utilities.

Port of backend/services/system/system-tools.js.
"""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
from pathlib import Path


async def getSystemInfo() -> dict[str, object]:
    """Get system information."""
    return {
        'platform': platform.system(),
        'release': platform.release(),
        'version': platform.version(),
        'machine': platform.machine(),
        'processor': platform.processor(),
        'hostname': platform.node(),
        'cwd': os.getcwd(),
        'python_version': platform.python_version(),
    }


async def getDiskUsage(path: str = '.') -> dict[str, object]:
    """Get disk usage information."""
    try:
        usage = shutil.disk_usage(path)
        return {
            'total': usage.total,
            'used': usage.used,
            'free': usage.free,
            'percent_used': round(usage.used / usage.total * 100, 1) if usage.total else 0,
        }
    except (FileNotFoundError, PermissionError) as exc:
        return {'error': str(exc)}


async def listProcesses() -> list[dict[str, object]]:
    """List running processes."""
    try:
        import psutil

        processes = []
        for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent']):
            try:
                processes.append(proc.info)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return sorted(processes, key=lambda p: p.get('cpu_percent', 0), reverse=True)[:50]
    except ImportError:
        try:
            proc = await asyncio.create_subprocess_exec(
                'ps', 'aux', '--sort=-%cpu', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, __ = await asyncio.wait_for(proc.communicate(), timeout=10)
            return [{'raw': line} for line in stdout.decode('utf-8', errors='replace').split('\n')[:30]]
        except (FileNotFoundError, asyncio.TimeoutError):
            return [{'error': 'ps not available'}]


async def getNetworkInfo() -> dict[str, object]:
    """Get network interface information."""
    try:
        import psutil

        interfaces = {}
        for name, addrs in psutil.net_if_addrs().items():
            interfaces[name] = [{'address': a.address, 'family': str(a.family)} for a in addrs]
        return {'interfaces': interfaces}
    except ImportError:
        return {'note': 'Install psutil for network info'}


async def checkPort(port: int) -> dict[str, object]:
    """Check if a port is in use."""
    import socket

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex(('127.0.0.1', port))
        sock.close()
        return {'port': port, 'in_use': result == 0}
    except Exception as exc:
        return {'port': port, 'error': str(exc)}


async def getEnvironmentVars() -> dict[str, str]:
    """Get relevant environment variables (redacted)."""
    safeVars = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'AUGUST_PROXY_PORT', 'AUGUST_DATA_DIR', 'AUGUST_PROXY_ROOT']
    return {var: os.environ.get(var, '') for var in safeVars if os.environ.get(var)}


async def checkFileExists(path: str) -> dict[str, object]:
    """Check if a file or directory exists."""
    p = Path(path)
    return {
        'path': str(p.resolve()),
        'exists': p.exists(),
        'is_file': p.is_file() if p.exists() else False,
        'is_dir': p.is_dir() if p.exists() else False,
        'size': p.stat().st_size if p.exists() and p.is_file() else 0,
    }
