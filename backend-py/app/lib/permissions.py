"""
Filesystem path access control.
"""

from __future__ import annotations

from pathlib import Path


ALLOWED_ROOTS: list[Path] = []


def allow_path(path: str | Path) -> None:
    ALLOWED_ROOTS.append(Path(path).resolve())


def is_allowed(path: str | Path) -> bool:
    target = Path(path).resolve()
    if not ALLOWED_ROOTS:
        return True  # no restrictions
    for root in ALLOWED_ROOTS:
        if root in target.parents or root == target:
            return True
    return False
