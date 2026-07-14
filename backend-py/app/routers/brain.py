"""
Brain router — mutation endpoints + System Health (v3, §12).

The /api/brain/learning endpoint is served by the brain dashboard router (v3 enhanced
that to return the rich aggregation including auto-memories, sleep
cycle, delta engine, and pending skills). This router adds the
mutation endpoints (delete/edit heuristic, approve/reject skill,
run consolidation) and the System Health fan-out.
"""

from __future__ import annotations
from fastapi import APIRouter
from app.json_narrowing import as_int

router = APIRouter(prefix='/api/brain')


@router.get('/delta-consent')
async def getDeltaConsent():
    """Delta engine consent (durable SoT in memory_store)."""
    from app.services import delta_engine as de

    return {'consentGranted': bool(de.isConsentGranted())}


@router.put('/delta-consent')
async def putDeltaConsent(body: dict):
    """Set delta engine consent. Body: ``{ "granted": true|false }``."""
    from app.services import delta_engine as de

    granted = bool(body.get('granted'))
    if granted:
        de.grantConsent()
    else:
        de.revokeConsent()
    return {'consentGranted': bool(de.isConsentGranted())}


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


@router.get('/sync-status')
async def brainSyncStatus():
    """Workbench session sync and cognitive boot status."""
    from app.services.workbench.brain_sync import get_sync_stats
    from app.services.cognitive_boot import get_boot_status

    return {
        'brainSync': get_sync_stats(),
        'cognitiveBoot': get_boot_status(),
    }


@router.post('/backfill-workbench')
async def backfillWorkbench():
    """Re-run workbench-sessions.json → brain SQLite backfill."""
    from app.services.workbench.brain_sync import backfill_workbench_json_to_brain

    return backfill_workbench_json_to_brain()


@router.get('/health')
async def getHealth():
    """Per-phase status from the single cognitive config tree + real probes.

    Flags come from ``auxiliary.cognitive.features`` (and boot services),
    not a separate dead schema. Boot service rows are included so operators
    see what is actually running.
    """
    import time

    from app.services.cognitive_boot import get_boot_status
    from app.services.cognitive_config import ensure_defaults, get_features, get_boot_layers
    from app.services.db_writer import get_stats as db_writer_stats
    from app.services.consolidation_daemon import get_last_run

    ensure_defaults()
    features = get_features()
    boot = get_boot_layers()
    boot_status = get_boot_status()
    phases = [
        ('heuristics', 'Learned Heuristics'),
        ('execution_state', 'Execution State'),
        ('scratchpad', 'Working Memory'),
        ('tool_guardrails', 'Loop Guardrails'),
        ('progressive_disclosure', 'BM25 Tool Catalog'),
        ('prompt_caching', 'Prompt Caching'),
        ('cognitive_budget', 'Cognitive Budgeting'),
        ('daemons', 'Subconscious Daemons'),
        ('blackboard', 'Blackboard'),
        ('env_watcher', 'Env Watcher'),
        ('verifier_reflex', 'Verifier Reflex'),
        ('skill_genesis', 'Skill Genesis'),
        ('vector_memory', 'Vector Memory'),
        ('graph_memory', 'Graph Memory'),
    ]
    nowIso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    results = []
    for flagKey, label in phases:
        # env_watcher feature tracks boot.environment_watcher when set
        if flagKey == 'env_watcher':
            flagVal = bool(features.get('env_watcher', False) or boot.get('environment_watcher', False))
        else:
            flagVal = bool(features.get(flagKey, False))
        if not flagVal:
            results.append(
                {
                    'layer': label,
                    'flag': flagKey,
                    'flagValue': False,
                    'flag_value': False,
                    'status': 'off',
                    'detail': 'feature flag disabled',
                    'lastCheckAt': nowIso,
                    'last_check_at': nowIso,
                }
            )
            continue
        check = _runSelfcheck(flagKey)
        results.append(
            {
                'layer': label,
                'flag': flagKey,
                'flagValue': True,
                'flag_value': True,
                'status': check['status'],
                'detail': check['detail'],
                'lastCheckAt': nowIso,
                'last_check_at': nowIso,
            }
        )
    # Boot services honesty row
    services = boot_status.get('services') if isinstance(boot_status, dict) else {}
    results.append(
        {
            'layer': 'Cognitive Boot',
            'flag': 'cognitive_boot',
            'flagValue': bool(boot_status.get('started')),
            'flag_value': bool(boot_status.get('started')),
            'status': 'on & healthy' if boot_status.get('started') else 'off',
            'detail': f"services={list(services.keys()) if isinstance(services, dict) else []}",
            'lastCheckAt': nowIso,
            'last_check_at': nowIso,
        }
    )
    last_run = get_last_run()
    results.append(
        {
            'layer': 'Consolidation',
            'flag': 'consolidation',
            'flagValue': bool(boot.get('consolidation')),
            'flag_value': bool(boot.get('consolidation')),
            'status': 'on & healthy' if boot.get('consolidation') else 'off',
            'detail': f'last_run={last_run}' if last_run else 'no consolidation runs yet',
            'lastCheckAt': nowIso,
            'last_check_at': nowIso,
        }
    )
    try:
        dw = db_writer_stats()
    except Exception:
        dw = {}
    results.append(
        {
            'layer': 'DB Writer',
            'flag': 'db_writer',
            'flagValue': bool(boot.get('db_writer')),
            'flag_value': bool(boot.get('db_writer')),
            'status': 'on & healthy' if boot.get('db_writer') else 'off',
            'detail': f"depth={dw.get('queue_depth')} dropped_low={dw.get('dropped_low')} executed={dw.get('executed')}",
            'lastCheckAt': nowIso,
            'last_check_at': nowIso,
        }
    )
    try:
        from app.adapters.proxy_tools import get_proxy_silent_stats

        silent = get_proxy_silent_stats()
    except Exception:
        silent = {}
    results.append(
        {
            'layer': 'Proxy silent swallows',
            'flag': 'proxy_silent_metrics',
            'flagValue': True,
            'flag_value': True,
            'status': 'on & healthy',
            'detail': f'swallowed={sum(int(v) for v in silent.values()) if silent else 0} by_key={silent}',
            'lastCheckAt': nowIso,
            'last_check_at': nowIso,
        }
    )
    return {
        'phases': results,
        'cognitiveBoot': boot_status,
        'features': features,
        'boot': boot,
        'consolidationLastRun': last_run,
        'dbWriter': dw,
        'proxySilent': silent,
    }


def _runSelfcheck(flagKey: str) -> dict:
    """Run a lightweight self-check for a cognitive layer.

    Returns {"status": str, "detail": str}. Never raises — failures
    become "on & failing" with the exception message as detail.
    """
    try:
        if flagKey == 'heuristics':
            from app.services.heuristics_service import countHeuristics

            count = countHeuristics()
            return {'status': 'on & healthy', 'detail': f'{count} active heuristic{("s" if count != 1 else "")}'}
        elif flagKey == 'execution_state':
            from app.services.memory_store import _conn

            row = (
                _conn()
                .execute("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_state'")
                .fetchone()
            )
            return {
                'status': 'on & healthy' if row else 'on & failing',
                'detail': 'execution_state table reachable' if row else 'execution_state table missing',
            }
        elif flagKey == 'scratchpad':
            from app.services.memory_store import _conn

            row = _conn().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='scratchpad'").fetchone()
            return {
                'status': 'on & healthy' if row else 'on & failing',
                'detail': 'scratchpad table reachable' if row else 'scratchpad table missing',
            }
        elif flagKey == 'tool_guardrails':
            from app.services.memory_store import _conn

            try:
                row = _conn().execute('SELECT COUNT(*) FROM tool_guardrail_log').fetchone()
                hits = int(row[0]) if row else 0
            except Exception:
                hits = 0
            return {'status': 'on & healthy', 'detail': f'{hits} guardrail event{("s" if hits != 1 else "")} logged'}
        elif flagKey == 'progressive_disclosure':
            from app.services.tools.model_tools import AUGUST_CORE_TOOLS

            count = len(AUGUST_CORE_TOOLS)
            return {
                'status': 'on & healthy' if count > 5 else 'on & failing',
                'detail': f'{count} tools in BM25 catalog',
            }
        elif flagKey == 'prompt_caching':
            from app.services.workbench.prompt_cache import getCache

            try:
                stats = getCache().stats()
                hits = as_int(stats.get('hits', 0)) if isinstance(stats, dict) else 0
            except Exception:
                hits = 0
            return {'status': 'on & healthy', 'detail': f'{hits} cache hit{("s" if hits != 1 else "")} recorded'}
        elif flagKey == 'cognitive_budget':
            from app.services.workbench.token_budget import estimateTokens

            t = estimateTokens('selfcheck probe text')
            return {'status': 'on & healthy' if t > 0 else 'on & failing', 'detail': f'token estimator returns {t}'}
        elif flagKey == 'daemons':
            from app.services.daemon_manager import getManager

            mgr = getManager()
            d = mgr.list_daemons() or []
            running = sum((1 for x in d if x.get('status') in ('running', 'idle')))
            return {
                'status': 'on & healthy' if d is not None else 'on & failing',
                'detail': f'{len(d)} daemon{("s" if len(d) != 1 else "")} registered, {running} active',
            }
        elif flagKey == 'blackboard':
            from app.services.memory_store import _conn

            row = _conn().execute('SELECT COUNT(*) FROM blackboard').fetchone()
            n = int(row[0]) if row else 0
            return {'status': 'on & healthy', 'detail': f'{n} note{("s" if n != 1 else "")} on blackboard'}
        elif flagKey == 'env_watcher':
            from app.services.cognitive_boot import get_boot_status
            from app.services.environment_watcher import getRecentChanges

            boot = get_boot_status()
            sessions = boot.get('session_watchers') if isinstance(boot, dict) else []
            n = len(sessions) if isinstance(sessions, list) else 0
            recent = 0
            if isinstance(sessions, list):
                for sid in sessions:
                    recent += len(getRecentChanges(str(sid), maxAgeSeconds=3600))
            return {
                'status': 'on & healthy',
                'detail': f'{n} session watcher(s), {recent} recent event(s)',
            }
        elif flagKey == 'verifier_reflex':
            from app.services.memory_store import _conn

            try:
                row = _conn().execute('SELECT COUNT(*) FROM verifier_gate_log').fetchone()
                gates = int(row[0]) if row else 0
            except Exception:
                gates = 0
            return {'status': 'on & healthy', 'detail': f'{gates} verifier gate{("s" if gates != 1 else "")} injected'}
        elif flagKey == 'skill_genesis':
            from app.services.memory_store import _conn

            row = _conn().execute("SELECT COUNT(*) FROM pending_skills WHERE status = 'pending'").fetchone()
            n = int(row[0]) if row else 0
            return {'status': 'on & healthy', 'detail': f'{n} pending skill{("s" if n != 1 else "")}'}
        elif flagKey == 'vector_memory':
            from app.services.memory import vector_db

            n = int(vector_db.count() or 0)
            return {'status': 'on & healthy', 'detail': f'{n} vector entr{"y" if n == 1 else "ies"}'}
        elif flagKey == 'graph_memory':
            from app.services.memory import graph_memory

            try:
                if hasattr(graph_memory, 'graphStats'):
                    stats = graph_memory.graphStats()
                    n = int(stats.get('entities') or 0) if isinstance(stats, dict) else 0
                else:
                    g = graph_memory._read() if hasattr(graph_memory, '_read') else {}
                    entities = g.get('entities') if isinstance(g, dict) else []
                    n = len(entities) if isinstance(entities, list) else 0
            except Exception:
                n = 0
            return {'status': 'on & healthy', 'detail': f'{n} graph entit{"y" if n == 1 else "ies"}'}
        else:
            return {'status': 'on & healthy', 'detail': 'no probe defined'}
    except Exception as exc:
        return {'status': 'on & failing', 'detail': f'{type(exc).__name__}: {exc}'}
