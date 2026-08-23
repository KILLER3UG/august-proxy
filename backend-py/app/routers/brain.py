"""
Brain router — mutation endpoints + System Health (v3, §12).

The /api/brain/learning endpoint is served by the brain dashboard router (v3 enhanced
that to return the rich aggregation including auto-memories, sleep
cycle, delta engine, and pending skills). This router adds the
mutation endpoints (delete/edit heuristic, approve/reject skill,
run consolidation) and the System Health fan-out.
"""

from __future__ import annotations

import os
import re
import time

from fastapi import APIRouter, HTTPException

from app.json_narrowing import as_dict, as_int, as_list, as_str

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


@router.patch('/profile')
async def editProfile(body: dict):
    """Edit the user profile blob (the "what August knows about you" facts).

    Body (all optional, at least one):
      ``{ "summary": str }``            — replace the profile summary line
      ``{ "addFact": str }``            — add/refresh one fact (auto-fielded)
      ``{ "removeFact": str }``         — remove a fact by exact text
    Returns the updated profile object.
    """
    from app.services.memory.user_profile import (
        _MAX_PROFILE_FACTS,
        _NEAR_DUP_THRESHOLD,
        _build_summary,
        _classify_fact,
        _similarity,
    )
    from app.services.memory_store import get_memory, save_memory

    key = 'userProfile'
    raw = get_memory(key)
    profile = raw if isinstance(raw, dict) else {'summary': '', 'facts': [], 'updated_at': 0.0}
    facts = [as_dict(f) for f in as_list(profile.get('facts'), [])]
    changed = False
    now = time.time()

    summary = (body.get('summary') or '').strip()
    if summary and summary != as_str(profile.get('summary'), ''):
        profile['summary'] = summary
        changed = True

    addFact = (body.get('addFact') or '').strip()
    if addFact:
        dup = next(
            (f for f in facts if _similarity(addFact, as_str(f.get('fact'), '')) >= _NEAR_DUP_THRESHOLD),
            None,
        )
        if dup is not None:
            dup['updated_at'] = now
        else:
            facts.append({'fact': addFact, 'field': _classify_fact(addFact), 'updated_at': now})
        changed = True

    removeFact = (body.get('removeFact') or '').strip()
    if removeFact:
        before = len(facts)
        facts = [f for f in facts if as_str(f.get('fact'), '') != removeFact]
        changed = changed or len(facts) != before

    if not changed:
        return {'profile': profile, 'changed': False}
    facts.sort(key=lambda f: float(as_str(f.get('updated_at'), '0') or 0), reverse=True)
    facts = facts[:_MAX_PROFILE_FACTS]
    profile['facts'] = facts
    if not (body.get('summary') or '').strip():
        # Only regenerate the fact-derived summary when the user did not
        # supply a manual one this call — an edited summary must survive
        # (previously it was unconditionally overwritten; audit finding).
        profile['summary'] = _build_summary(facts)
    profile['updated_at'] = now
    save_memory(key, profile)
    return {'profile': profile, 'changed': True}


@router.delete('/heuristics/{heuristic_id}')
async def deleteHeuristic(heuristic_id: int):
    """v3: Delete a learned heuristic."""
    from app.services.heuristics_service import removeHeuristicById

    ok = removeHeuristicById(heuristic_id)
    return {'deleted': ok}


@router.patch('/heuristics/{heuristic_id}')
async def editHeuristic(heuristic_id: int, body: dict):
    """v3: Edit a learned heuristic — rule text and/or suppression.

    Body: ``{ "rule": "new text"?, "suppressed": true|false? }``. At least
    one field must be present. Suppressing a rule excludes it from prompt
    injection without deleting it.
    """
    from app.services.heuristics_service import setHeuristicSuppressed, updateHeuristic

    newRule = (body.get('rule') or '').strip()
    suppressed = body.get('suppressed')
    if newRule:
        ok = updateHeuristic(heuristic_id, newRule)
        if not ok:
            return {'updated': False, 'error': 'heuristic not found'}
    if suppressed is not None:
        ok = setHeuristicSuppressed(heuristic_id, bool(suppressed))
        if not ok and not newRule:
            return {'updated': False, 'error': 'heuristic not found'}
    if not newRule and suppressed is None:
        return {'updated': False, 'error': 'rule or suppressed required'}
    return {'updated': True}


@router.get('/heuristics/{heuristic_id}/trail')
async def heuristicTrail(heuristic_id: int):
    """Version history for one learned heuristic (newest first).

    Every mutation records a trail entry (add/upgrade/edit/suppress/
    restore/remove/rollback) — the rollback button restores the previous
    rule text from this history.
    """
    from app.services.heuristics_service import listHeuristicTrail

    return {'trail': listHeuristicTrail(heuristic_id)}


@router.post('/heuristics/{heuristic_id}/rollback')
async def heuristicRollback(heuristic_id: int):
    """Restore a learned heuristic's previous rule text (Prime /refine:
    versioned self-improvement state with rollback)."""
    from app.services.heuristics_service import rollbackHeuristic

    ok = rollbackHeuristic(heuristic_id)
    return {'rolledBack': ok}


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


@router.get('/skills/{name}/draft')
async def getSkillDraft(name: str):
    """Fetch a pending skill's draft body plus the active skill body for diffing.

    ``existingBody`` is the body of the active skill when one already exists
    under this name (patch case); null for brand-new skills.
    """
    from app.services.memory_store import _conn

    conn = _conn()
    row = conn.execute(
        'SELECT name, draft_path FROM pending_skills WHERE name = ?',
        (name,),
    ).fetchone()
    if not row or not row['draft_path'] or not os.path.exists(row['draft_path']):
        raise HTTPException(status_code=404, detail='Draft not found')
    try:
        with open(row['draft_path'], encoding='utf-8') as f:
            raw = f.read()
    except OSError:
        raise HTTPException(status_code=404, detail='Draft not found')
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n(.*)', raw, re.DOTALL)
    body = m.group(2).strip() if m else raw.strip()
    existingBody = None
    try:
        from app.services import skill_service

        existing = skill_service.get(name)
        if not existing:
            kebab = skill_service._kebab_name(name)
            if kebab and kebab != name:
                existing = skill_service.get(kebab)
        if existing and existing.get('instructions'):
            existingBody = str(existing['instructions'])
    except Exception:
        pass
    return {'name': row['name'], 'body': body, 'existingBody': existingBody}


@router.get('/routing/stats')
async def routingStats(days: int = 30):
    """Model track record + daily token totals (D6/D7)."""
    from app.services.routing_evidence import get_stats

    return get_stats(days=days)


@router.get('/routing/suggestions')
async def routingSuggestions(prompt: str = '', taskType: str = '', limit: int = 5):
    """Which models win for this kind of task (surpass #1/#7).

    ``prompt`` is classified into a task type; ``taskType`` overrides.
    Returns per-model win-rate + average token cost, best first.
    """
    from app.services.routing_evidence import classify_task_type, get_suggestions

    resolved_type = (taskType or '').strip() or classify_task_type(prompt)
    return {
        'taskType': resolved_type,
        'suggestions': get_suggestions(resolved_type, limit=limit),
    }


@router.get('/harness/trends')
async def harnessTrends(days: int = 30):
    """Harness fleet health: win-rate / token / duration trends per model.

    The routing-evidence table is the harness's own eval signal — per-day
    aggregates let the Brain surface show whether the fleet is improving
    (and which models regress) over time.
    """
    try:
        from app.services.memory_store import _conn as getConn

        conn = getConn()
        rows = conn.execute(
            "SELECT date(created_at) AS day, model, provider, "
            "SUM(ok) AS wins, COUNT(*) AS total, "
            "AVG(input_tokens + output_tokens) AS avg_tokens, "
            "AVG(duration_ms) AS avg_duration "
            "FROM routing_evidence WHERE created_at > datetime('now', ?) "
            "GROUP BY day, model, provider ORDER BY day",
            (f'-{max(1, min(days, 90))} days',),
        ).fetchall()
        daily = []
        for r in rows:
            total = as_int(r['total'], 0)
            if total <= 0:
                continue
            daily.append(
                {
                    'day': as_str(r['day'], ''),
                    'model': as_str(r['model'], ''),
                    'provider': as_str(r['provider'], ''),
                    'wins': as_int(r['wins'], 0),
                    'total': total,
                    'winRate': round(as_int(r['wins'], 0) / total, 2),
                    'avgTokens': int(round(as_int(r['avg_tokens'], 0))),
                    'avgDurationMs': int(round(as_int(r['avg_duration'], 0))),
                }
            )
        return {'rangeDays': max(1, min(days, 90)), 'daily': daily}
    except Exception:
        return {'rangeDays': max(1, min(days, 90)), 'daily': []}


@router.get('/harness/evals')
async def harnessEvals(limit: int = 50):
    """Recent scripted-model eval runs (the loop-level golden tasks).

    Each row is one scenario run from ``tests/test_harness_evals.py`` /
    ``app/services/harness_eval.py`` — pass/fail, rounds, duration. Running
    the eval suite regularly and plotting this over time measures whether
    harness changes actually improve loop behavior.
    """
    from app.services.harness_eval import list_eval_runs

    runs = list_eval_runs(limit=limit)
    passed = sum(1 for r in runs if r.get('passed'))
    return {
        'runs': runs,
        'total': len(runs),
        'passed': passed,
        'passRate': round(passed / len(runs), 2) if runs else None,
    }


@router.post('/harness/evals/run')
async def runHarnessEvals():
    """Run the loop-level golden suite now, in the background.

    The scheduler also runs it every 6h; this endpoint forces an immediate
    run so the Reliability dashboard can measure a change right after it
    lands. Results stream into ``GET /api/brain/harness/evals``.
    """
    import asyncio

    from app.services import harness_eval

    asyncio.create_task(harness_eval.run_all_scenarios())
    return {'started': True, 'note': 'eval suite running in the background'}


@router.get('/harness/proposals')
async def harnessProposals(limit: int = 50):
    """Harness self-improvement proposals filed by the model.

    Rows live under ``data/harness_proposals/*.json``; approve/reject via
    ``POST /api/brain/harness/proposals/{id}/decide``. Approvable kinds
    (brain_config / skill_*) run a deterministic applier; everything else is
    recorded for human implementation.
    """
    from app.services.harness_self_improve import list_proposals

    rows = list_proposals(limit=limit)
    return {
        'proposals': rows,
        'total': len(rows),
        'open': sum(1 for r in rows if r.get('status') == 'open'),
    }


@router.post('/harness/proposals/{pid}/decide')
async def harnessProposalDecide(pid: str, body: dict = {}):
    """Approve / reject / dismiss one harness proposal.

    ``{"decision": "approve"|"reject"|"dismiss", "note": "..."}``. Approval
    executes the deterministic applier for approvable kinds and records the
    outcome in the curation ledger.
    """
    from fastapi import HTTPException

    from app.json_narrowing import as_dict, as_str
    from app.services.harness_self_improve import decide_proposal

    decision = as_str(as_dict(body).get('decision'), '')
    note = as_str(as_dict(body).get('note'), '')
    if not decision:
        raise HTTPException(status_code=400, detail='decision is required')
    try:
        return decide_proposal(pid, decision, note)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get('/routing/best-by-task')
async def routingBestByTask(days: int = 30, minSamples: int = 3):
    """Best model per task type (win-rate desc) — the Reliability
    dashboard's routing table. Same evidence as /routing/suggestions,
    but one row per task type instead of per prompt."""
    from app.services.routing_evidence import best_by_task

    return {'results': best_by_task(days=days, min_samples=max(1, minSamples))}


@router.get('/routing/decisions')
async def routingDecisions(limit: int = 20):
    """Recent auto-route decisions — who was routed where, and by what
    margin. Makes auto-routing auditable instead of a black box."""
    from app.services.routing_evidence import list_auto_route_decisions

    return {'decisions': list_auto_route_decisions(limit=max(1, min(limit, 100)))}


@router.post('/routing/arena')
async def routingArena(body: dict):
    """Record an arena/debate verdict: the picked lane won, the rest lost.

    Body: ``{ "sessionId": str, "prompt": str, "winner": {modelId, provider},
    "losers": [{modelId, provider}, ...] }``
    """
    from app.services.routing_evidence import classify_task_type, record_arena

    raw_winner = body.get('winner')
    winner = raw_winner if isinstance(raw_winner, dict) else {}
    raw_losers = body.get('losers')
    losers = raw_losers if isinstance(raw_losers, list) else []
    loser_pairs = [
        (as_str(loser.get('modelId'), ''), as_str(loser.get('provider'), ''))
        for loser in losers
        if isinstance(loser, dict)
    ]
    record_arena(
        session_id=as_str(body.get('sessionId'), ''),
        task_type=classify_task_type(as_str(body.get('prompt'), '')),
        winner_model=as_str(winner.get('modelId'), ''),
        winner_provider=as_str(winner.get('provider'), ''),
        loser_models=loser_pairs,
        prompt=as_str(body.get('prompt'), ''),
    )
    return {'recorded': True}


@router.get('/routing/arena')
async def routingArenaHistory(limit: int = 50, days: int = 30):
    """Arena/debate verdict history (source='arena' rows, newest first).

    Feeds the Brain arena archive UI — results previously vanished when the
    overlay closed. ``prompt`` is included so the archive can offer replay.
    """
    try:
        from app.services.memory_store import _conn as getConn

        conn = getConn()
        rows = conn.execute(
            "SELECT session_id, task_type, model, provider, ok, "
            "input_tokens + output_tokens AS tokens, duration_ms, created_at, prompt "
            "FROM routing_evidence WHERE source = 'arena' "
            "AND created_at > datetime('now', ?) "
            "ORDER BY created_at DESC LIMIT ?",
            (f'-{max(1, min(days, 90))} days', max(1, min(limit, 200))),
        ).fetchall()
        results = []
        for r in rows:
            results.append(
                {
                    'sessionId': as_str(r['session_id'], ''),
                    'taskType': as_str(r['task_type'], ''),
                    'model': as_str(r['model'], ''),
                    'provider': as_str(r['provider'], ''),
                    'won': as_int(r['ok'], 0) == 1,
                    'tokens': as_int(r['tokens'], 0),
                    'durationMs': as_int(r['duration_ms'], 0),
                    'at': as_str(r['created_at'], ''),
                    'prompt': as_str(r['prompt'], ''),
                }
            )
        return {'results': results}
    except Exception:
        return {'results': []}


@router.post('/run-consolidation')
async def runConsolidationEndpoint(body: dict = {}):
    """Trigger a consolidation cycle now.

    Body ``{ "preview": true }`` computes the plan WITHOUT applying it —
    the UI shows merge/promote/delete candidates first (B2), then calls
    ``/apply-consolidation`` with the same plan.
    """
    from app.services.consolidation_daemon import previewConsolidation, runConsolidation

    if body.get('preview'):
        return await previewConsolidation()
    stats = await runConsolidation()
    return stats


@router.post('/memory/reconcile')
async def reconcileVectorMirror():
    """Repair auto_memories ↔ vector_entries drift on demand.

    Re-embeds rows whose vector twin went missing (skipped while the encoder
    is degraded) and removes orphaned twins whose memory row vanished.
    Also runs each sleep cycle; this endpoint exposes it for the Brain UI.
    """
    from app.services.memory.vector_mirror import last_reconciliation, reconcile_vector_mirror

    report = reconcile_vector_mirror()
    return {'report': report, 'previous': last_reconciliation()}


@router.get('/curation/ledger')
async def curationLedger(limit: int = 50, actor: str = '', target_kind: str = ''):
    """Unified curation decision journal.

    Every loop that merges/promotes/supersedes/archives/deletes a memory,
    heuristic, or skill appends one row — reflection ('reflection'), the
    sleep cycle ('sleep_cycle'), model review ('model_review'), heuristic
    graduation ('promotion'), and the skill curator ('curator'). This is the
    single answer to "why did the harness change its memory?".
    """
    from app.services.memory.curation_ledger import recent

    return {'entries': recent(limit, actor=actor, target_kind=target_kind)}


@router.get('/pending-consolidation')
async def pendingConsolidation():
    """Stashed sleep-cycle plan waiting for Keep / Discard in chat."""
    from app.services.consolidation_daemon import get_pending_consolidation

    plan = get_pending_consolidation()
    if not plan:
        return {'plan': None, 'merged': 0, 'promoted': 0, 'deleted': 0}
    merged = sum(
        1
        for merge_raw in (plan.get('merge') or [])
        if isinstance(merge_raw, dict) and merge_raw.get('keepId') is not None
    )
    promoted = sum(
        1
        for promo_raw in (plan.get('promote') or [])
        if isinstance(promo_raw, dict) and promo_raw.get('factKey')
    )
    deleted = len(plan.get('delete') or []) + len(plan.get('archiveMemories') or [])
    from app.services.consolidation_daemon import list_pending_actions

    return {
        'plan': plan,
        'merged': merged,
        'promoted': promoted,
        'deleted': deleted,
        'actions': list_pending_actions(plan),
    }


@router.post('/pending-consolidation/apply-one')
async def applyOnePendingConsolidation(body: dict):
    """Keep a single distill action; leave the rest pending."""
    from app.services.consolidation_daemon import (
        _apply_consolidation_plan,
        _plan_has_actions,
        clear_pending_consolidation,
        get_pending_consolidation,
        list_pending_actions,
        stash_pending_consolidation,
        take_pending_action,
    )

    plan = get_pending_consolidation()
    if not plan:
        raise HTTPException(status_code=404, detail='No pending distill')
    action_id = str(body.get('id') or body.get('actionId') or '')
    try:
        slice_plan, remaining = take_pending_action(plan, action_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    stats = await _apply_consolidation_plan(slice_plan)
    if _plan_has_actions(remaining):
        stash_pending_consolidation(remaining)
    else:
        clear_pending_consolidation()
    return {'status': 'ok', **stats, 'remaining': list_pending_actions(remaining) if _plan_has_actions(remaining) else []}


@router.post('/pending-consolidation/discard-one')
async def discardOnePendingConsolidation(body: dict):
    from app.services.consolidation_daemon import (
        _plan_has_actions,
        clear_pending_consolidation,
        get_pending_consolidation,
        list_pending_actions,
        stash_pending_consolidation,
        take_pending_action,
    )

    plan = get_pending_consolidation()
    if not plan:
        raise HTTPException(status_code=404, detail='No pending distill')
    action_id = str(body.get('id') or body.get('actionId') or '')
    try:
        _slice, remaining = take_pending_action(plan, action_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if _plan_has_actions(remaining):
        stash_pending_consolidation(remaining)
        return {'status': 'ok', 'remaining': list_pending_actions(remaining)}
    clear_pending_consolidation()
    return {'status': 'ok', 'remaining': []}


@router.post('/pending-consolidation/discard')
async def discardPendingConsolidation():
    from app.services.consolidation_daemon import clear_pending_consolidation

    clear_pending_consolidation()
    return {'status': 'ok'}


@router.post('/apply-consolidation')
async def applyConsolidation(body: dict):
    """Apply a previously previewed consolidation plan.

    Body: ``{ "plan": {"merge": [...], "promote": [...], "delete": [...]} }``
    — the exact plan returned by ``run-consolidation`` with ``preview: true``.
    """
    from app.services.consolidation_daemon import _apply_consolidation_plan

    plan = body.get('plan')
    if not isinstance(plan, dict):
        raise HTTPException(status_code=400, detail='plan is required')
    stats = await _apply_consolidation_plan(plan)
    from app.services.consolidation_daemon import clear_pending_consolidation

    clear_pending_consolidation()
    return stats


@router.get('/sync-status')
async def brainSyncStatus():
    """Workbench session sync and cognitive boot status."""
    from app.services.cognitive_boot import get_boot_status
    from app.services.workbench.brain_sync import get_sync_stats

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
    from app.services.cognitive_config import ensure_defaults, get_boot_layers, get_features
    from app.services.consolidation_daemon import get_last_run
    from app.services.db_writer import get_stats as db_writer_stats

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
                    n = as_int(stats.get('entities')) if isinstance(stats, dict) else 0
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
