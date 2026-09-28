"""Hooks visibility router — list built-in + user-defined hooks and stats."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix='/api/hooks')


def _workspace_for_session(session_id: str) -> str:
    """The workspace behind a session id, or ''.

    Hooks execute with `shell=True` outside the sandbox, so the directory that
    supplies `<dir>/.aug/hooks.json` is a trust boundary. Every route here
    therefore takes a `sessionId` and never a path: accepting a caller-chosen
    directory would let any local caller trust (and thereby arm) a directory it
    picked. The session lookup keeps the set of addressable workspaces to the
    ones August already has open.
    """
    if not session_id:
        return ''
    try:
        from app.services.workbench import workbench as wb

        sess = wb.getWorkbenchSession(session_id)
        return str(getattr(sess, 'workspacePath', '') or '') if sess else ''
    except Exception:
        return ''


@router.get('')
async def list_hooks(request: Request) -> dict:
    """Registry stats for every hook plus the user/workspace hook specs."""
    from app.services.hooks.registry import registry
    from app.services.hooks.user_hooks import (
        describe,
        ensure_hooks_loaded,
        inactive_workspace_hooks,
        is_workspace_trusted,
    )

    # Refresh from disk so the UI sees a hand-edited config immediately.
    try:
        workspace = _workspace_for_session(request.query_params.get('sessionId') or '')
        ensure_hooks_loaded(workspace or None)
    except Exception:
        workspace = ''
    return registry.stats() | {
        'userHooks': describe(),
        'workspaceTrusted': bool(workspace) and is_workspace_trusted(workspace),
        # Hooks this workspace DEFINES that are not running. Reported because
        # `workspaceTrusted: false` alone is not the same fact: a workspace
        # with no hooks file at all is also untrusted and has nothing
        # suppressed, and a consumer that treats the two as equivalent either
        # shows a warning about nothing or stays silent about a real one.
        'inactiveWorkspaceHooks': inactive_workspace_hooks(),
    }


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

    session_id = ''
    try:
        body = await request.json()
        if isinstance(body, dict):
            session_id = str(body.get('sessionId') or '')
    except Exception:
        pass
    workspace = _workspace_for_session(session_id)
    loaded = ensure_hooks_loaded(workspace or None)
    return {'ok': True, 'reloaded': loaded}


@router.post('/trust-workspace')
async def trust_workspace(request: Request) -> dict:
    """Approve running this session's workspace `.aug/hooks.json`.

    The consent step for a capability that runs `shell=True` outside the
    sandbox. It has to be explicit and per-workspace: the file arrives with a
    clone, so a config file inside a repo is not itself a trust decision —
    the person who wrote it need not be the person who opened it.

    Persisted, because trust is a durable decision and a restart must not
    silently re-arm a workspace the user has since stopped trusting.
    """
    from app.services.hooks.user_hooks import ensure_hooks_loaded
    from app.services.hooks.user_hooks import trust_workspace as _trust

    try:
        body = await request.json()
    except Exception:
        body = {}
    session_id = str(body.get('sessionId') or '') if isinstance(body, dict) else ''
    workspace = _workspace_for_session(session_id)
    if not workspace:
        return {'ok': False, 'error': 'No workspace for that session'}
    if not _trust(workspace):
        return {'ok': False, 'error': 'Could not persist workspace trust'}
    return {'ok': True, 'workspace': workspace, 'loaded': ensure_hooks_loaded(workspace)}


@router.post('/revoke-workspace')
async def revoke_workspace(request: Request) -> dict:
    """Withdraw that approval, and unregister the handlers it armed.

    Revoking has to disarm live registrations, not just forget the record —
    otherwise the commands keep running until the process exits.
    """
    from app.services.hooks.user_hooks import revoke_workspace as _revoke

    try:
        body = await request.json()
    except Exception:
        body = {}
    session_id = str(body.get('sessionId') or '') if isinstance(body, dict) else ''
    workspace = _workspace_for_session(session_id)
    if not workspace:
        return {'ok': False, 'error': 'No workspace for that session'}
    if not _revoke(workspace):
        return {'ok': False, 'error': 'Could not persist workspace revocation'}
    return {'ok': True, 'workspace': workspace}
