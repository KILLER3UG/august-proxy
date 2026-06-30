"""
System stats — CPU / memory usage.
"""
from __future__ import annotations
import os

def cpuCount() -> int:
    return os.cpu_count() or 1

def memoryMb() -> dict[str, object]:
    """Approximate memory info (cross-platform)."""
    import psutil
    try:
        mem = psutil.virtual_memory()
        return {'total_mb': mem.total // 1024 // 1024, 'available_mb': mem.available // 1024 // 1024}
    except ImportError:
        return {'total_mb': 0, 'available_mb': 0}