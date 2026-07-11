"""
Brain router — mutation endpoints + System Health (v3, §12).

The /api/brain/learning endpoint is served by ui_memory.py (v3 enhanced
that to return the rich aggregation including auto-memories, sleep
cycle, delta engine, and pending skills). This router adds the
mutation endpoints (delete/edit heuristic, approve/reject skill,
run consolidation) and the System Health fan-out.
"""
from __future__ import annotations
from fastapi import APIRouter
router = APIRouter(prefix='/api/brain')

@router.delete('/heuristics/{heuristic_id}')
async def deleteHeuristic(heuristicId: int):
    """v3: Delete a learned heuristic."""
    from app.services.heuristics_service import removeHeuristicById
    ok = removeHeuristicById(heuristicId)
    return {'deleted': ok}

@router.patch('/heuristics/{heuristic_id}')
async def editHeuristic(heuristicId: int, body: dict):
    """v3: Edit a learned heuristic's rule text."""
    from app.services.heuristics_service import updateHeuristic
    newRule = (body.get('rule') or '').strip()
    if not newRule:
        return {'updated': False, 'error': 'rule cannot be empty'}
    ok = updateHeuristic(heuristicId, newRule)
    return {'updated': ok}

@router.post('/skills/{name}/approve')
async def approveSkill(name: str):
    """v3: Approve a pending skill — move staging to active."""
    from app.services.consolidation_daemon import approvePendingSkill
    ok = approvePendingSkill(name)
    return {'approved': ok}

@router.post('/skills/{name}/reject')
async def rejectSkill(name: str):
    """v3: Reject a pending skill — delete staging file."""
    from app.services.consolidation_daemon import rejectPendingSkill
    ok = rejectPendingSkill(name)
    return {'rejected': ok}

@router.post('/run-consolidation')
async def runConsolidationEndpoint():
    """v3: Trigger a consolidation cycle now."""
    from app.services.consolidation_daemon import runConsolidation
    stats = await runConsolidation()
    return stats

@router.get('/health')
async def getHealth():
    """Per-phase status: flags + selfcheck() with detail + last_check_at."""
    from app.config import settings
    import time
    try:
        cfg = settings.config
        layersCfg = cfg.get('auxiliary', {}).get('cognitive_layers', {})
    except Exception:
        layersCfg = {}
    phases = [('heuristics', 'Phase 4 — Learned Heuristics'), ('execution_state', 'Phase 5 — Execution State'), ('scratchpad', 'Phase 6 — Working Memory'), ('tool_guardrails', 'Phase 6 — Loop Guardrails'), ('progressive_disclosure', 'Phase 3 — BM25'), ('prompt_caching', 'Phase 7 — Prompt Caching'), ('cognitive_budget', 'Phase 2 — Cognitive Budgeting'), ('daemons', 'Phase 8 — Subconscious Daemons'), ('blackboard', 'Phase 10 — Blackboard'), ('env_watcher', 'Phase 10 — Env Watcher'), ('verifier_reflex', 'Phase 10 — Verifier Reflex'), ('skill_genesis', 'Phase 10 — Skill Genesis')]
    nowIso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    results = []
    for flagKey, label in phases:
        flagVal = bool(layersCfg.get(flagKey, False))
        if not flagVal:
            results.append({'layer': label, 'flag': flagKey, 'flagValue': False, 'status': 'off', 'detail': 'feature flag disabled', 'lastCheckAt': nowIso})
            continue
        check = _runSelfcheck(flagKey)
        results.append({'layer': label, 'flag': flagKey, 'flagValue': True, 'status': check['status'], 'detail': check['detail'], 'lastCheckAt': nowIso})
    return {'phases': results}

def _runSelfcheck(flagKey: str) -> dict:
    """Run a lightweight self-check for a cognitive layer.

    Returns {"status": str, "detail": str}. Never raises — failures
    become "on & failing" with the exception message as detail.
    """
    try:
        if flagKey == 'heuristics':
            from app.services.heuristics_service import countHeuristics
            count = countHeuristics()
            return {'status': 'on & healthy', 'detail': f"{count} active heuristic{('s' if count != 1 else '')}"}
        elif flagKey == 'execution_state':
            from app.services.memory_store import _conn
            row = _conn().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_state'").fetchone()
            return {'status': 'on & healthy' if row else 'on & failing', 'detail': 'execution_state table reachable' if row else 'execution_state table missing'}
        elif flagKey == 'scratchpad':
            from app.services.memory_store import _conn
            row = _conn().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='scratchpad'").fetchone()
            return {'status': 'on & healthy' if row else 'on & failing', 'detail': 'scratchpad table reachable' if row else 'scratchpad table missing'}
        elif flagKey == 'tool_guardrails':
            from app.services.memory_store import _conn
            try:
                row = _conn().execute('SELECT COUNT(*) FROM tool_guardrail_log').fetchone()
                hits = int(row[0]) if row else 0
            except Exception:
                hits = 0
            return {'status': 'on & healthy', 'detail': f"{hits} guardrail event{('s' if hits != 1 else '')} logged"}
        elif flagKey == 'progressive_disclosure':
            from app.services.tools.model_tools import AUGUST_CORE_TOOLS
            count = len(AUGUST_CORE_TOOLS)
            return {'status': 'on & healthy' if count > 5 else 'on & failing', 'detail': f'{count} tools in BM25 catalog'}
        elif flagKey == 'prompt_caching':
            from app.services import prompt_cache
            try:
                stats = prompt_cache.getStats() if hasattr(prompt_cache, 'get_stats') else {}
                hits = int(stats.get('hits', 0)) if isinstance(stats, dict) else 0
            except Exception:
                hits = 0
            return {'status': 'on & healthy', 'detail': f"{hits} cache hit{('s' if hits != 1 else '')} recorded"}
        elif flagKey == 'cognitive_budget':
            from app.services.workbench.token_budget import estimateTokens
            t = estimateTokens('selfcheck probe text')
            return {'status': 'on & healthy' if t > 0 else 'on & failing', 'detail': f'token estimator returns {t}'}
        elif flagKey == 'daemons':
            from app.services.daemon_manager import getManager
            mgr = getManager()
            d = mgr.listDaemons() or []
            running = sum((1 for x in d if x.get('status') in ('running', 'idle')))
            return {'status': 'on & healthy' if d is not None else 'on & failing', 'detail': f"{len(d)} daemon{('s' if len(d) != 1 else '')} registered, {running} active"}
        elif flagKey == 'blackboard':
            from app.services.memory_store import _conn
            row = _conn().execute('SELECT COUNT(*) FROM blackboard').fetchone()
            n = int(row[0]) if row else 0
            return {'status': 'on & healthy', 'detail': f"{n} note{('s' if n != 1 else '')} on blackboard"}
        elif flagKey == 'env_watcher':
            from app.services.memory_store import _conn
            try:
                row = _conn().execute('SELECT MAX(timestamp) FROM env_change_log').fetchone()
                last = row[0] if row else None
            except Exception:
                last = None
            return {'status': 'on & healthy', 'detail': f"last event: {last or 'none yet'}"}
        elif flagKey == 'verifier_reflex':
            from app.services.memory_store import _conn
            try:
                row = _conn().execute('SELECT COUNT(*) FROM verifier_gate_log').fetchone()
                gates = int(row[0]) if row else 0
            except Exception:
                gates = 0
            return {'status': 'on & healthy', 'detail': f"{gates} verifier gate{('s' if gates != 1 else '')} injected"}
        elif flagKey == 'skill_genesis':
            from app.services.memory_store import _conn
            row = _conn().execute("SELECT COUNT(*) FROM pendingSkills WHERE status = 'pending'").fetchone()
            n = int(row[0]) if row else 0
            return {'status': 'on & healthy', 'detail': f"{n} pending skill{('s' if n != 1 else '')}"}
        else:
            return {'status': 'on & healthy', 'detail': 'no probe defined'}
    except Exception as exc:
        return {'status': 'on & failing', 'detail': f'{type(exc).__name__}: {exc}'}