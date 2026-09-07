"""Browser automation API routes.

Surfaces the headless Playwright browser layer (distinct from desktop
automation). Currently provides screenshot retrieval so the frontend's
browser drawer section can render screenshots captured during tool runs.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.json_narrowing import as_str
from app.lib.paths import dataPath

router = APIRouter(prefix='/api/browser', tags=['browser'])


@router.get('/registered-tools')
async def registeredTools() -> dict[str, object]:
    """The browser/web tools currently registered for the agent.

    Backs Settings → Browser Use: the panel shows the live roster so the
    user sees exactly what the model is offered (and registration gaps
    instead of a silent empty surface).
    """
    from app.services.tool_registry import listRaw

    tools = [
        {'name': as_str(t.get('name'), ''), 'description': as_str(t.get('description'), '')[:220]}
        for t in listRaw()
        if as_str(t.get('name'), '').startswith(('browser_', 'web_search', 'web_fetch'))
    ]
    return {'tools': tools}


def _inside(requested: Path, root: Path) -> bool:
    try:
        requested.relative_to(root)
        return True
    except ValueError:
        return False


@router.get('/screenshot')
async def getScreenshot(path: str) -> FileResponse:
    """Serve a screenshot file by absolute path.

    The path is validated to live under the data/browser_screenshots/ or
    data/desktop_screenshots/ directory so arbitrary file reads aren't
    possible. This lets the frontend <img src="/api/browser/screenshot?path=...">
    render shots captured during headless browser tool runs and desktop
    screenshot captures.
    """
    if not path:
        raise HTTPException(status_code=400, detail='path is required')
    requested = Path(path).resolve()
    roots = [dataPath('browser_screenshots').resolve(), dataPath('desktop_screenshots').resolve()]
    if not any(_inside(requested, root) for root in roots):
        raise HTTPException(status_code=403, detail='path is outside the screenshots directories')
    if not requested.is_file():
        raise HTTPException(status_code=404, detail='screenshot not found')
    return FileResponse(str(requested), media_type='image/png')
