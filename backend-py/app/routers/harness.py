"""Harness API router — readiness, guidance, health, friction, trends endpoints.

Exposes the Phase 4-5 service modules. All responses use the standard
API envelope ({ok, formatVersion, data}) per Sprint B.2.
"""

from fastapi import APIRouter, Query

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
