"""Curator API routes (Part 16 Phase E) — un-404s CuratorSuggestionBar.

``POST /api/curator/run``   — one skill-learning pass (mine → score → flag
  → judge). ``dryRun=true`` reports what WOULD run without model calls or
  filings. Gated on ``skillLearning`` (off → 409).
``GET  /api/curator/report`` — the ``skillLearningReport`` counters blob for
  the Learning section header.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix='/api/curator')


def _mode() -> str:
    try:
        from app.services.brain_config_service import getRuntimeConfig

        return str(getRuntimeConfig().get('skillLearning', 'extract-only') or 'extract-only')
    except Exception:
        return 'extract-only'


@router.post('/run')
async def runCurator(dryRun: bool = False):
    """One skill-learning pass. Never runs inside a live turn."""
    mode = _mode()
    if mode == 'off':
        raise HTTPException(status_code=409, detail='skillLearning is off')

    from app.services.episode_miner import mine_sessions, run_resolution_check
    from app.services.skill_distiller import run_distiller_pass

    mined = mine_sessions()
    distiller = run_distiller_pass(dryRun=dryRun)
    resolution = {} if dryRun else run_resolution_check()
    return {
        'ok': True,
        'mode': mode,
        'dryRun': bool(dryRun),
        'mined': mined,
        'distiller': distiller,
        'resolution': resolution,
        'report': _skillStatusReport(),
    }


def _skillStatusReport() -> dict[str, object]:
    """The shape CuratorSuggestionBar renders: active / staled / archived."""
    try:
        from app.services.skill_service import list_all

        skills = list_all()
    except Exception:
        skills = []
    staled: list[str] = []
    archived: list[str] = []
    active = 0
    for s in skills:
        status = str(s.get('status', '') or '')
        name = str(s.get('name', ''))
        if status == 'stale':
            staled.append(name)
        elif status in ('retired', 'archived'):
            archived.append(name)
        else:
            active += 1
    return {'active': active, 'staled': staled, 'archived': archived, 'errors': []}


@router.get('/episodes')
async def flaggedEpisodes(limit: int = 20):
    """Flagged tier-2 episodes with their tier-1 rubric breakdown — the
    Learning section's flagged list (fingerprint + scores)."""
    import json as _json

    from app.services.episode_miner import flagged_episodes

    out: list[dict[str, object]] = []
    for ep in flagged_episodes(limit=min(50, max(1, limit))):
        verdictRaw = str(ep.get('judge_verdict') or '')
        rubric: dict[str, object] = {}
        judged = None
        try:
            parsed = _json.loads(verdictRaw) if verdictRaw else {}
            if isinstance(parsed.get('tier1'), dict):
                rubric = parsed['tier1'].get('subscores', {})
                rubric = {'score': parsed['tier1'].get('score'), **rubric}
            elif parsed:
                judged = parsed
        except Exception:
            pass
        out.append(
            {
                'id': ep.get('id'),
                'sessionId': ep.get('session_id'),
                'kind': ep.get('kind'),
                'outcome': ep.get('outcome'),
                'fingerprint': ep.get('fingerprint_id'),
                'rubric': rubric,
                'judged': judged,
                'createdAt': ep.get('created_at'),
            }
        )
    return {'episodes': out}


@router.get('/report')
async def curatorReport():
    from app.services.episode_miner import learning_report
    from app.services.skill_distiller import precision_state

    return {
        'mode': _mode(),
        'learning': learning_report(),
        'precision': precision_state(),
    }
