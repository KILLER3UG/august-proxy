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
    import asyncio

    mode = _mode()
    if mode == 'off':
        raise HTTPException(status_code=409, detail='skillLearning is off')

    from app.services.episode_miner import mine_sessions, run_resolution_check
    from app.services.skill_distiller import run_distiller_pass

    def syncPass() -> tuple[dict, dict, dict]:
        mined = mine_sessions()
        distiller = run_distiller_pass(dryRun=dryRun)
        resolution = {} if dryRun else run_resolution_check()
        return mined, distiller, resolution

    # §12 F-4: mining + judging are multi-second synchronous work — run
    # them off the event loop so the API stays responsive.
    mined, distiller, resolution = await asyncio.to_thread(syncPass)
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
        # §12 F-9: _parseSkill nests unrecognized frontmatter (incl. the
        # status: field) under 'meta' — a top-level read was always ''.
        metaRaw = s.get('meta')
        meta = metaRaw if isinstance(metaRaw, dict) else {}
        status = str(s.get('status') or meta.get('status') or '')
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
        # §12 F-3: the tier-1 rubric lives in tier1_result; judge_verdict
        # holds only the real tier-2 model verdict.
        rubricRaw = str(ep.get('tier1_result') or '')
        verdictRaw = str(ep.get('judge_verdict') or '')
        rubric: dict[str, object] = {}
        judged = None
        try:
            parsed = _json.loads(rubricRaw) if rubricRaw else {}
            if isinstance(parsed.get('tier1'), dict):
                rubric = parsed['tier1'].get('subscores', {})
                rubric = {'score': parsed['tier1'].get('score'), **rubric}
        except Exception:
            pass
        try:
            parsedVerdict = _json.loads(verdictRaw) if verdictRaw else {}
            judged = parsedVerdict or None
        except Exception:
            judged = None
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
    import asyncio

    from app.services.episode_miner import learning_report
    from app.services.memory_store import get_internal_state
    from app.services.skill_distiller import precision_state

    # P2.1 (Part 18): a skills-index budget overflow is a persisted issue —
    # surfaced here so the Learning header can show it (None when never).
    overflow = get_internal_state('skillsIndexOverflow')
    # D-3 (§3.5): the metric blob is multi-file IO (proposals dir) + a DB
    # recurrence query — keep it off the event loop like /run does. The
    # resolution check must run INSIDE the offloaded function, not as a
    # to_thread argument (evaluating it on the loop was the Part 25 offload-gate
    # violation).
    skill_learning = await asyncio.to_thread(_skillLearningBundle)
    return {
        'mode': _mode(),
        'learning': learning_report(),
        'precision': precision_state(),
        'skillLearning': skill_learning,
        'skillsIndexOverflow': overflow if isinstance(overflow, dict) else None,
    }


def _skillLearningBundle() -> dict[str, object]:
    """Offloaded (Part 25): runs the resolution check + metric build together
    on a worker thread so neither touches the event loop."""
    from app.services.episode_miner import run_resolution_check

    return _skillLearningMetrics(run_resolution_check())


def _skillLearningMetrics(resolution: dict[str, object]) -> dict[str, object]:
    """§3.5 skillLearningReport blob: proposal pipeline + resolution counters.

    draft = every distiller-filed proposal (origin 'distilled'); approval
    rate covers DECIDED proposals only (open ones don't dilute it);
    demotions = decided skill_delete filings; recurred = fingerprints that
    re-flagged after resolution (run_resolution_check's counter).
    """
    from app.services.harness_self_improve import list_proposals

    drafts = approved = rejected = demotions = 0
    try:
        for p in list_proposals():
            payloadRaw = p.get('payload')
            payload: dict[str, object] = payloadRaw if isinstance(payloadRaw, dict) else {}
            kind = str(p.get('kind') or '')
            is_demotion = kind == 'skill_delete'
            origin = str(payload.get('origin') or p.get('origin') or '')
            if origin != 'distilled' and not is_demotion:
                continue
            status = str(p.get('status') or 'open')
            drafts += 1
            if status == 'applied':
                approved += 1
            elif status == 'rejected':
                rejected += 1
                if is_demotion:
                    demotions += 1
    except Exception:
        pass
    decided = approved + rejected

    def _resInt(key: str) -> int:
        v = resolution.get(key)
        return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

    return {
        'drafts': drafts,
        'approved': approved,
        'rejected': rejected,
        'approvalRate': round(approved / decided, 3) if decided else None,
        'demotions': demotions,
        'recurred': _resInt('recurred'),
        'resolved': _resInt('resolved'),
        'demotionSuggestions': _resInt('demotionSuggestions'),
    }
