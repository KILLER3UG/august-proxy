"""Harness API router — readiness, guidance, health, friction, trends endpoints.

Exposes the Phase 4-5 service modules. All responses use the standard
API envelope ({ok, formatVersion, data}) per Sprint B.2.
"""

from fastapi import APIRouter, Query

from app.json_narrowing import as_str
from app.lib.api_envelope import error, success

router = APIRouter(prefix='/api/harness', tags=['harness'])


@router.get('/readiness')
async def get_readiness(workspace: str = Query(..., description='Absolute path to workspace')):
    """Score a project's readiness for AI agent work (5 capabilities × L1-L5)."""
    from app.services.project_readiness import score_project_readiness

    result = score_project_readiness(workspace)
    if 'error' in result:
        return error('INVALID_WORKSPACE', result['error'])
    return success(result)


@router.get('/guidance')
async def get_guidance_next(workspace: str | None = Query(None, description='Optional workspace path')):
    """Get stage-appropriate next steps (Bootstrap/Operationalize/Optimize)."""
    from app.services.guidance import get_guidance

    return success(get_guidance(workspace))


@router.get('/health/providers')
async def get_provider_health():
    """Get health status for all monitored providers."""
    from app.services.health_monitor import health_monitor

    return success({'providers': health_monitor.get_all_health()})


@router.get('/friction')
async def get_friction(since_days: int = Query(7, ge=1, le=90)):
    """Get friction attribution stats over a time window."""
    from app.services.memory.friction import get_friction_stats

    return success(get_friction_stats(since_days=since_days))


@router.get('/trends')
async def get_trends(weeks: int = Query(12, ge=1, le=52)):
    """Get longitudinal harness trends (weekly aggregation)."""
    from app.services.memory.trends import get_trends as _get_trends

    return success({'trends': _get_trends(weeks=weeks)})


@router.get('/memory-lifecycle')
async def get_memory_lifecycle():
    """Get memory lifecycle stats (created/retrieved/applied/stale)."""
    from app.services.memory.lifecycle import get_memory_lifecycle_stats

    return success({'memories': get_memory_lifecycle_stats()})


@router.get('/workflow-candidates')
async def get_workflow_candidates():
    """Get detected repeated workflow candidates."""
    from app.services.memory.workflow_detection import get_workflow_candidates as _get

    return success({'candidates': _get()})


@router.get('/coverage-gaps')
async def get_coverage_gaps():
    """Get asset demand reconciliation (coverage gaps)."""
    from app.services.memory.reconciliation import reconcile_demand_coverage

    return success({'gaps': reconcile_demand_coverage()})


@router.get('/features')
async def get_features():
    """Get feature flag states."""
    from app.lib.features import get_all

    return success({'features': get_all()})


@router.get('/ownership-suggestions')
async def get_ownership_suggestions():
    """Get ownership routing suggestions for uncovered demand (Sprint D.4)."""
    from app.services.ownership_router import get_suggestions

    return success({'suggestions': get_suggestions()})


@router.get('/traces')
async def get_traces(
    session_id: str | None = Query(None, description='Filter by workbench session id'),
    limit: int = Query(100, ge=1, le=500, description='Max rows'),
):
    """Per-turn execution traces (prompt hash, tools, rounds, self-heal
    events, graded outcome) for replay / regression diffs."""
    from app.services.trace_store import list_session_traces, recent_traces

    if session_id:
        return success({'traces': list_session_traces(session_id, limit)})
    return success({'traces': recent_traces(limit)})


@router.get('/drift')
async def get_drift(
    recent_days: int = Query(7, ge=1, le=30),
    baseline_days: int = Query(28, ge=7, le=90),
    min_samples: int = Query(10, ge=1, le=200),
    drop: float = Query(0.15, ge=0.0, le=1.0),
):
    """Models whose win rate regressed (recent window vs the baseline before
    it) — the same check the scheduled drift alert runs."""
    from app.services.routing_evidence import drift_report

    return success(
        {
            'drift': drift_report(
                recent_days=recent_days,
                baseline_days=baseline_days,
                min_recent_samples=min_samples,
                drop=drop,
            )
        }
    )


@router.get('/model-profiles')
async def get_model_profiles(model: str = '', min_turns: int = Query(10, ge=1, le=200)):
    """Per-model capability fingerprints + suggested profiles (toolSurface
    auto-detect). Pass a model id for one model, or omit for all models with
    traces."""
    from app.services.trace_store import capability_fingerprint

    if model:
        return success(capability_fingerprint(model, min_turns=min_turns))
    try:
        from app.services.trace_store import _conn as _trace_conn

        rows = _trace_conn().execute(
            'SELECT model, MAX(provider) AS provider FROM session_traces '
            'GROUP BY model ORDER BY MAX(id) DESC LIMIT 25'
        ).fetchall()
        return success(
            {
                'profiles': [
                    capability_fingerprint(as_str(r['model'], ''), as_str(r['provider'], ''), min_turns=min_turns)
                    for r in rows
                ]
            }
        )
    except Exception as exc:
        return success({'profiles': [], 'error': str(exc)})


@router.get('/prompt-cache')
async def get_prompt_cache_stats():
    """Tier1/2 prompt cache hit rate (observability for prompt-caching work)."""
    from app.services.workbench.prompt_cache import getCache

    return success(getCache().stats())
