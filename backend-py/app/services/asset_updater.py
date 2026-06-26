"""Desktop asset updater — manages web-dist and other bundled assets."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def get_web_dist_path() -> Path | None:
    """Get the web-dist directory path."""
    from app.config import settings
    p = settings.web_dist
    return p if p.is_dir() else None


def get_asset_info() -> dict[str, Any]:
    """Get information about bundled assets."""
    web = get_web_dist_path()
    assets = {}
    if web:
        files = list(web.rglob("*"))
        assets = {
            "path": str(web),
            "files": len(files),
            "size_bytes": sum(f.stat().st_size for f in files if f.is_file()),
        }
    return {"web_dist": assets}
