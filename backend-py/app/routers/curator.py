"""Curator API routes — un-404s CuratorSuggestionBar.

``POST /api/curator/run``   — one skill-learning pass (mine → score → flag
  → judge). ``dryRun=true`` reports what WOULD run without model calls or
  filings. Gated on ``skillLearning`` (off → 409).
``GET  /api/curator/report`` — the ``skillLearningReport`` counters blob for
  the Learning section header.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.camel_base import CamelModel

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

    # Mining + judging are multi-second synchronous work — run
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
        # _parseSkill nests unrecognized frontmatter (incl. the
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
        # The tier-1 rubric lives in tier1_result; judge_verdict
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

    # P2.1: a skills-index budget overflow is a persisted issue —
    # surfaced here so the Learning header can show it (None when never).
    overflow = get_internal_state('skillsIndexOverflow')
    # D-3: the metric blob is multi-file IO (proposals dir) + a DB
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
    """Offloaded: runs the resolution check + metric build together
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


# ── Versioned refine store (T15 wiring) ───────────────────────────────────
# The store had a reader in the prompt path and no reachable write/manage
# surface since its router was deleted. These routes complete the loop: the
# Learning panel shows what the auto-refine pass wrote, a human can roll back
# any entry (append-only undo, the journal keeps the story), and the config
# gate (autoRefine, producer/reviewer model pins) is user-reachable.

@router.get('/refine')
async def refineEntries(includeDeleted: bool = False, kind: str = ''):
    """Active refine-store entries (prompt_note/memory/skill/subagent)."""
    from app.services import refine_store

    return {
        'entries': refine_store.list_entries(kind=kind, include_deleted=includeDeleted),
        'config': refine_store.get_refine_config(),
        'ledger': refine_store.read_ledger(limit=20),
    }


class RefineConfigPatch(CamelModel):
    autoRefine: bool | None = None
    producerModel: str | None = None
    reviewModel: str | None = None


@router.post('/refine/config')
async def setRefineConfig(body: RefineConfigPatch):
    """Update the refine gate/config. Producer and reviewer must be
    different models — auto_refine's batch review discards same-model
    pairs, so saving an equal pair is refused here rather than silently
    dooming every batch."""
    from app.services import refine_store

    current = refine_store.get_refine_config()
    merged = {
        'autoRefine': current['autoRefine'] if body.autoRefine is None else body.autoRefine,
        'producerModel': current['producerModel'] if body.producerModel is None else body.producerModel,
        'reviewModel': current['reviewModel'] if body.reviewModel is None else body.reviewModel,
    }
    if (
        merged['autoRefine']
        and merged['producerModel']
        and merged['producerModel'] == merged['reviewModel']
    ):
        raise HTTPException(
            status_code=400,
            detail='producer and reviewer must be different models (same-model judging is inert)',
        )
    out = refine_store.set_refine_config(merged)
    if not out.get('ok'):
        raise HTTPException(status_code=500, detail=str(out.get('error')))
    return out


@router.post('/refine/run')
async def runRefineNow():
    """One gated refine pass on demand (evidence from the learning stores).
    The independent reviewer + discard-default still gate it; enabling here
    does not bypass autoRefine's config gate unless it is on."""
    import asyncio

    from app.services import refine_store

    return await asyncio.to_thread(refine_store.run_scheduled_refine)


@router.post('/refine/{entry_id}/rollback')
async def rollbackRefine(entry_id: str):
    """Undo the newest version of one entry (append-only; the undo is itself
    a version so the journal never loses anything)."""
    from app.services import refine_store

    try:
        entry = refine_store.rollback_entry(entry_id, actor='user')
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {'ok': True, 'id': entry.get('id'), 'version': len(entry.get('versions') or [])}


@router.delete('/refine/{entry_id}')
async def deleteRefine(entry_id: str, rationale: str = 'deleted from Learning panel'):
    """Soft-delete an entry (a versioned delete; rollback can revive it)."""
    from app.services import refine_store

    try:
        refine_store.delete_entry(
            entry_id,
            rationale=rationale,
            expected_outcome='the entry no longer injects into prompts',
            actor='user',
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {'ok': True}


# ── P2 unified learning scheduler ─────────────────────────────────────────


@router.get('/scheduler')
async def schedulerStatus():
    """Per-job cadence + last-run ledger for the Learning panel: the single
    place to answer 'when did the learning brain last run, and what did it
    do?' (replaces the per-poller logging the old loops each kept)."""
    from app.services.learning_scheduler import scheduler_status

    return scheduler_status()


@router.post('/scheduler/run/{job}')
async def runScheduledJob(job: str):
    """Run one scheduler job now (same ledger rows as the cadence)."""
    from app.services.learning_scheduler import JOBS, run_job_async

    if job not in JOBS:
        raise HTTPException(status_code=404, detail=f'unknown job {job!r}')
    return await run_job_async(job)


@router.get('/outcomes')
async def outcomeReport(limit: int = 30):
    """P5 outcome ledger: what the harness changed and whether it helped
    (improved / flat / regressed / insufficient), newest first."""
    import asyncio

    from app.services.harness_outcome import outcome_report

    return await asyncio.to_thread(outcome_report, max(1, min(200, int(limit))))
