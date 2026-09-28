"""Security, rollback, observations, observability, and system routes."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from app.json_narrowing import as_dict, as_list, as_str
from app.lib.paths import dataPath
from app.models.camel_base import CamelModel
from app.services import host_agent
from app.services.config_service import getConfig, saveConfig

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _security() -> dict[str, object]:
    cfg = getConfig()
    sec = as_dict(cfg.get('security')) if cfg.get('security') is not None else {}
    return {
        'allowedRoots': list(as_list(sec.get('allowedRoots'))),
        'filesystemScope': as_str(sec.get('filesystemScope') or 'allowlist') or 'allowlist',
        'postObservationScreenshot': bool(sec.get('postObservationScreenshot', True)),
    }


class SecurityBody(CamelModel):
    allowed_roots: list[str] | None = None
    filesystem_scope: str | None = None
    post_observation_screenshot: bool | None = None


@router.put('/api/security')
async def put_security(body: SecurityBody):
    cfg = getConfig()
    sec = as_dict(cfg.get('security')) if cfg.get('security') is not None else {}
    if body.allowed_roots is not None:
        sec['allowedRoots'] = body.allowed_roots
    if body.filesystem_scope is not None:
        sec['filesystemScope'] = body.filesystem_scope
    if body.post_observation_screenshot is not None:
        sec['postObservationScreenshot'] = body.post_observation_screenshot
    cfg['security'] = sec
    saveConfig(cfg)
    return {'ok': True, 'security': _security()}


@router.get('/api/security')
async def get_security():
    return _security()


def _rollback_store() -> list[dict[str, object]]:
    cfg = getConfig()
    return [as_dict(x) for x in as_list(cfg.get('rollbackLog'))]


@router.get('/api/rollback')
async def list_rollback(
    limit: int = Query(100, ge=1, le=1000),
    status: str = '',
    type: str = '',
    summary: str = '',
):
    items = _rollback_store()
    if status:
        items = [i for i in items if as_str(i.get('status')) == status]
    if type:
        items = [i for i in items if as_str(i.get('type')) == type]
    items = items[:limit]
    if summary in ('1', 'true', 'yes'):
        by_type: dict[str, int] = {}
        counts = {'available': 0, 'undone': 0, 'failed': 0, 'total': len(_rollback_store())}
        for i in _rollback_store():
            st = as_str(i.get('status') or 'available')
            if st in counts:
                counts[st] += 1
            t = as_str(i.get('type') or 'unknown')
            by_type[t] = by_type.get(t, 0) + 1
        return {**counts, 'byType': by_type, 'at': _now()}
    return {'items': items, 'total': len(items), 'at': _now()}


@router.get('/api/observations')
async def list_observations(limit: int = Query(50, ge=1, le=500), since: str = ''):
    obs_dir = dataPath('observations')
    items: list[dict[str, object]] = []
    if obs_dir.is_dir():
        files = sorted(obs_dir.glob('*.png'), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[:limit]:
            items.append(
                {
                    'id': p.stem,
                    'screenshotPath': str(p),
                    'capturedAt': datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
                    'focusedApp': None,
                }
            )
    return {'items': items, 'total': len(items), 'at': _now()}


@router.get('/api/observations/{obs_id}.png')
async def observation_png(obs_id: str):
    from fastapi import HTTPException

    # `{obs_id}` is a `[^/]+` segment, so a forward slash cannot get in — but
    # a percent-encoded `%5C` decodes to a backslash, which IS a separator on
    # Windows and therefore reached this handler as real traversal:
    # `GET /api/observations/..%5C..%5Csecret.png` served a PNG from outside
    # the observations dir (and outside the data dir entirely with one more
    # `..`), because `dataPath` only joins segments — it does not sanitize
    # them. The reach is narrow: only files ending in `.png` are servable,
    # since the suffix is appended here. Reject the separators outright
    # rather than trusting the segment regex, then prove containment the way
    # `bind_path` does for workspace paths — resolve, then `relative_to`.
    if not obs_id or '/' in obs_id or '\\' in obs_id or obs_id in ('.', '..'):
        raise HTTPException(status_code=404, detail='Observation not found')
    obs_dir = dataPath('observations').resolve()
    p = (obs_dir / f'{obs_id}.png').resolve()
    try:
        p.relative_to(obs_dir)
    except ValueError:
        raise HTTPException(status_code=404, detail='Observation not found')
    if not p.is_file():
        raise HTTPException(status_code=404, detail='Observation not found')
    return FileResponse(str(p), media_type='image/png')


@router.get('/api/observability/overview')
async def observability_overview(range: str = Query('30d')):
    host = await host_agent.getHostInfo()
    # Call with plain kwargs (not FastAPI Query defaults) when reusing the handler.
    rb = await list_rollback(limit=100, status='', type='', summary='1')
    cfg = getConfig()
    policies = as_dict(cfg.get('appPolicies')) if cfg.get('appPolicies') is not None else {}
    counts = {'allow': 0, 'ask': 0, 'deny': 0}
    for v in policies.values():
        key = as_str(v)
        if key in counts:
            counts[key] += 1
    from app.services.memory_store import list_config_audit

    audit_rows = list_config_audit(limit=500)
    by_category: dict[str, int] = {}
    by_actor: dict[str, int] = {}
    for row in audit_rows:
        cat = as_str(row.get('category') or 'unknown') or 'unknown'
        actor = as_str(row.get('actor') or 'system') or 'system'
        by_category[cat] = by_category.get(cat, 0) + 1
        by_actor[actor] = by_actor.get(actor, 0) + 1
    audit_count = len(audit_rows)
    return {
        'range': range if range in ('7d', '30d') else '30d',
        'audit': {
            'count': audit_count,
            'byCategory': by_category,
            'byResult': {'ok': audit_count},
            'byActor': by_actor,
            'byCritical': {'true': 0, 'false': 0, 'null': audit_count},
            'at': _now(),
        },
        'rollback': rb,
        'appPolicy': {
            'policies': policies,
            'counts': counts,
            'defaultPolicy': 'ask',
        },
        'hostAgent': host,
        'at': _now(),
    }


@router.post('/api/system/restart')
async def system_restart():
    """Signal a soft restart intent — process managers (or the desktop shell) act on it."""
    flag = dataPath('restart.requested')
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text(_now(), encoding='utf-8')
    return {'ok': True, 'at': _now(), 'message': 'Restart requested'}


@router.get('/api/workspace/files')
async def workspace_files(path: str = Query('.', alias='path')):
    """List files under a workspace path (desktop file tree).

    The directory has to survive `bind_path` first. This route takes a path
    straight from the caller and used to `iterdir()` it with no containment at
    all, so `?path=C:/Users/<u>/.ssh` returned every entry with absolute
    paths — a directory lister for the whole machine, past the workspace
    check, the hardline credential guard, and the user's own "Computer
    access" allowlist, all of which file tools apply to the same paths.

    So it now goes through the same chokepoint: the hardline guard runs first
    (a listing reveals names and sizes, and `.ssh` is exactly the directory
    that must stay unnameable), then workspace/allowlist containment. It keeps
    read semantics — `for_write=False` — because it reads.

    `workspace=None` is deliberate: this route is the file TREE, which is how
    a user browses to pick a project folder in the first place, so it cannot
    be scoped to a session workspace that may not exist yet. Containment
    therefore comes from the hardline guard and the user's allowlist.
    """
    from app.services.sandbox.hardline import is_credential_directory
    from app.services.sandbox.paths import bind_path

    if is_credential_directory(path):
        # The read guard deliberately allows one non-secret member of `.ssh`
        # (authorized_keys), so it cannot catch the directory itself — but
        # enumerating the store is the entire secret set in one response.
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail='Refused: credential store is not listable')

    root, denial = bind_path(path, None, for_write=False)
    if denial or root is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail=denial or 'Path not permitted')
    if not root.exists():
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail=f'Path not found: {root}')
    if not root.is_dir():
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail=f'Not a directory: {root}')
    files: list[dict[str, object]] = []
    try:
        entries = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail=str(exc)) from exc
    for entry in entries:
        # Skip heavy / hidden noise
        if entry.name in ('.git', 'node_modules', '__pycache__', '.venv'):
            continue
        # A directory the credential guard protects is not listed at all, even
        # when the guard would allow the PARENT it sits in. Gating the request
        # path is not enough on its own: a cloned repo can carry a key at its
        # root, and the tree view would hand back its name and size. The guard
        # is asked per entry, so the rule lives in exactly one place.
        from app.services.sandbox.hardline import check_hardline_path, is_credential_directory

        if is_credential_directory(str(entry)) or check_hardline_path(str(entry), for_write=False):
            continue
        try:
            files.append(
                {
                    'name': entry.name,
                    'path': str(entry),
                    'isDir': entry.is_dir(),
                    'sizeBytes': entry.stat().st_size if entry.is_file() else None,
                }
            )
        except OSError:
            continue
    return {'files': files, 'path': str(root)}


@router.get('/api/overview')
async def overview(range: str = Query('day')):
    """Dashboard overview cards (requests / activity / errors / cost)."""
    from app.json_narrowing import as_float, as_int
    from app.services.logger import get_stats, getActivityLog

    period = 'today' if range in ('day', 'today') else 'all'
    try:
        stats = get_stats(period=period) or {}
    except Exception:
        stats = {}
    try:
        activity = getActivityLog() or []
    except Exception:
        activity = []
    if not isinstance(stats, dict):
        stats = {}
    requests = as_int(stats.get('totalRequests') or stats.get('completedRequests'), 0)
    errors = as_int(stats.get('errorRequests') or stats.get('errors'), 0)
    cost_in = as_float(stats.get('estimatedInputCost') or stats.get('inputCost'), 0.0)
    cost_out = as_float(stats.get('estimatedOutputCost') or stats.get('outputCost'), 0.0)
    cost_total = as_float(stats.get('estimatedTotalCost'), cost_in + cost_out)
    return {
        'requests': requests,
        'activity': len(activity) if isinstance(activity, list) else 0,
        'inspector': requests,
        'errors': errors,
        'cost': {'input': cost_in, 'output': cost_out, 'total': cost_total},
        'activeConfig': {
            'injectAugOnProxy': getConfig().get('injectAugOnProxy', False),
            'activeModel': getConfig().get('activeModel'),
            'activeProvider': getConfig().get('activeProvider'),
        },
        'range': range,
        'at': _now(),
    }
