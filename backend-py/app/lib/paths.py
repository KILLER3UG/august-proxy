"""
Resolve data directory paths. Respects AUGUST_DATA_DIR env var.
"""

from __future__ import annotations

import os
from pathlib import Path


def data_dir() -> Path:
    override = os.environ.get("AUGUST_DATA_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent.parent.parent / "data"


def data_path(*parts: str) -> Path:
    return data_dir().joinpath(*parts)
