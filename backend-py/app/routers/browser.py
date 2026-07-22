"""Browser automation API routes.

Surfaces the headless Playwright browser layer (distinct from desktop
automation). Currently provides screenshot retrieval so the frontend's
browser drawer section can render screenshots captured during tool runs.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.lib.paths import dataPath

router = APIRouter(prefix='/api/browser', tags=['browser'])


@router.get('/screenshot')
async def getScreenshot(path: str) -> FileResponse:
    """Serve a screenshot file by absolute path.

    The path is validated to live under the data/browser_screenshots/
    directory so arbitrary file reads aren't possible. This lets the
    frontend <img src="/api/browser/screenshot?path=..."> render shots
    captured during headless browser tool runs.
    """
    if not path:
        raise HTTPException(status_code=400, detail='path is required')
    requested = Path(path).resolve()
    root = dataPath('browser_screenshots').resolve()
    try:
        requested.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail='path is outside the screenshots directory')
    if not requested.is_file():
        raise HTTPException(status_code=404, detail='screenshot not found')
    return FileResponse(str(requested), media_type='image/png')
