"""
Filesystem path access control.
"""

from __future__ import annotations

from pathlib import Path

ALLOWED_ROOTS: list[Path] = []


def allowPath(path: str | Path) -> None:
    ALLOWED_ROOTS.append(Path(path).resolve())


def isAllowed(path: str | Path) -> bool:
    target = Path(path).resolve()
    if not ALLOWED_ROOTS:
        return True
    for root in ALLOWED_ROOTS:
        if root in target.parents or root == target:
            return True
    return False
