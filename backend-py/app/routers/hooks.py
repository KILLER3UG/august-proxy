"""Hooks visibility router — list built-in + user-defined hooks and stats."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix='/api/hooks')


@router.get('')
async def list_hooks(request: Request) -> dict:
    """Registry stats for every hook plus the user/workspace hook specs."""
    from app.services.hooks.registry import registry
    from app.services.hooks.user_hooks import describe

    # Refresh from disk so the UI sees a hand-edited config immediately.
    try:
        from app.services.hooks.user_hooks import ensure_hooks_loaded

        workspace = ''
        session_id = request.query_params.get('sessionId') or ''
        if session_id:
            from app.services.workbench import workbench as wb

            sess = wb.getWorkbenchSession(session_id)
            workspace = str(getattr(sess, 'workspacePath', '') or '') if sess else ''
        ensure_hooks_loaded(workspace or None)
    except Exception:
        pass
    return registry.stats() | {'userHooks': describe()}


@router.post('/reload')
async def reload_hooks(request: Request) -> dict:
    """Force an immediate mtime re-check of every hook config.

    Takes a `sessionId`, never a path. Hooks execute with `shell=True` outside
    the sandbox, so the directory that supplies `<dir>/.aug/hooks.json` is a
    trust boundary: accepting an arbitrary workspace here would let any local
    caller register commands from a directory it chose. The session lookup
    keeps the set of loadable workspaces to the ones August already opened,
    matching how the GET above resolves it.
    """
    from app.services.hooks.user_hooks import ensure_hooks_loaded

    workspace = ''
    session_id = ''
    try:
        body = await request.json()
        if isinstance(body, dict):
            session_id = str(body.get('sessionId') or '')
    except Exception:
        pass
    if session_id:
        from app.services.workbench import workbench as wb

        sess = wb.getWorkbenchSession(session_id)
        workspace = str(getattr(sess, 'workspacePath', '') or '') if sess else ''
    loaded = ensure_hooks_loaded(workspace or None)
    return {'ok': True, 'reloaded': loaded}
