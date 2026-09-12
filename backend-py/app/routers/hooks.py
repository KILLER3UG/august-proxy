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
    """Force an immediate mtime re-check of every hook config."""
    from app.services.hooks.user_hooks import ensure_hooks_loaded

    workspace = ''
    try:
        body = await request.json()
        workspace = str(body.get('workspace') or '') if isinstance(body, dict) else ''
    except Exception:
        pass
    loaded = ensure_hooks_loaded(workspace or None)
    return {'ok': True, 'reloaded': loaded}
