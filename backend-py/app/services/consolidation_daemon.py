"""
Sleep Cycle — consolidation daemon.

Background daemon triggered during idle or every 24 hours. Uses the
Hippocampus model to review recent auto_memories and learned_heuristics,
then merges duplicates, promotes recurring patterns to facts, and deletes
stale entries. Skill creation is handled by background_review.py (unified
reflection); this module only maintains legacy pending-skill approval.
"""

from __future__ import annotations

import json
import logging
import os
import time

from app.json_narrowing import as_dict, as_list
from app.type_aliases import ConsolidationSummaryDict

logger = logging.getLogger(__name__)
_CONSOLIDATIONInterval = 86400
_RECENTProtectionCount = 20
_lastRun: dict[str, object] | None = None
_last_run = None  # kept in sync by _persist_last_run for tests
_LAST_RUN_KEY = 'cognitive:consolidation:last_run'


def get_last_run() -> dict[str, object] | None:
    """Return last consolidation summary (memory first, then process cache)."""
    global _lastRun
    if _lastRun is not None:
        return dict(_lastRun)
    try:
        from app.services.memory_store import get_memory

        stored = get_memory(_LAST_RUN_KEY)
        if isinstance(stored, dict):
            _lastRun = dict(stored)
            return dict(stored)
    except Exception:
        pass
    return None


def _persist_last_run(stats: ConsolidationSummaryDict) -> None:
    global _lastRun, _last_run
    payload: dict[str, object] = {
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'merged': stats.get('merged', 0),
        'promoted': stats.get('promoted', 0),
        'deleted_stale': stats.get('deleted_stale', 0),
        'errors': list(stats.get('errors') or []),
    }
    _lastRun = payload
    _last_run = payload
    try:
        from app.services.brain_write_facade import save_kv

        save_kv(_LAST_RUN_KEY, payload)
    except Exception:
        logger.debug('persist consolidation last_run failed', exc_info=True)


def _sanitizeSkillName(name: str) -> str:
    """Normalize any name to kebab-case matching skill_service validation.

    Examples:
      "Debug Python Script" -> "debug-python-script"
      "user_preferences"    -> "user-preferences"
      "JWT-Auth-Flow"       -> "jwt-auth-flow"
      "debugPythonScript"   -> "debug-python-script"
    """
    if not name:
        return ''
    from app.services.skill_service import _kebab_name

    return _kebab_name(name)[:50]


def _record_audit(action: str, target_key: str = '', reason: str = '', detail: str = '') -> None:
    """Append one row to the consolidation audit trail (fire-and-forget).

    Written from the db_writer worker thread alongside the mutation it
    describes, so the trail stays in lock-step with what actually changed.
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        conn.execute(
            'INSERT INTO consolidation_audit (action, target_key, reason, detail) VALUES (?, ?, ?, ?)',
            (action, (target_key or '')[:120], (reason or '')[:200], (detail or '')[:300]),
        )
        conn.commit()
    except Exception:
        logger.debug('consolidation audit record failed (non-fatal)', exc_info=True)


async def _call_hippocampus(prompt: str) -> str:
    """Snake-case alias for tests and newer callers."""
    return await _callHippocampus(prompt)


async def _callHippocampus(prompt: str) -> str:
    """v2: Call the Hippocampus model. Returns raw text response.

    Uses the provider client if available; falls back to a heuristic
    no-op for environments without a configured LLM.
    """
    try:
        from app.providers import resolver as providerResolver
        from app.providers.clients import getClient
        from app.services.workbench import model_fleet

        model = model_fleet.getModelForRole('hippocampus')
        if not model:
            return ''
        provider = providerResolver.resolve(model)
        if not provider:
            available = [p for p in providerResolver.list_available() if p.get('api_key')]
            provider = available[0] if available else None
        if not provider:
            return ''
        client = getClient(provider)
        if client and hasattr(client, 'generate'):
            response = await client.generate(prompt)
            return response or ''
    except Exception:
        pass
    return ''


async def _build_consolidation_plan() -> dict | None:
    """Steps 1–2: collect memories/heuristics and ask Hippocampus for a plan.

    Returns the validated plan dict (``{merge, promote, delete}``) or None
    when there is nothing to consolidate or the model call fails.
    """
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        autoMemories = [
            dict(r) for r in conn.execute('SELECT * FROM auto_memories ORDER BY id DESC LIMIT 100').fetchall()
        ]
        heuristics = [dict(r) for r in conn.execute('SELECT * FROM learned_heuristics ORDER BY id DESC').fetchall()]
        if not (heuristics or autoMemories):
            return None
        prompt = f"""Review these auto_memories and learned_heuristics. Return a JSON plan:\n{{'merge': [{{'keepId': int, 'removeIds': [int, ...], 'mergedRule': str}}],\n 'promote': [{{'pattern': str, 'factKey': str, 'factValue': str}}],\n 'delete': [int, ...]}}\nAuto memories ({len(autoMemories)}):\n{json.dumps(autoMemories, default=str)[:2000]}\n\nHeuristics ({len(heuristics)}):\n{json.dumps(heuristics, default=str)[:2000]}\n\nPreserve the most recent 20 rules (do not delete them).\nIf there's nothing to do, return {{"merge": [], "promote": [], "delete": []}}.\n"""
        raw = await _callHippocampus(prompt)
        if not raw:
            return None
        try:
            plan = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return plan if isinstance(plan, dict) else None
    except Exception as exc:
        logger.error('Consolidation plan error: %s', exc)
        return None


async def _apply_consolidation_plan(plan: dict) -> ConsolidationSummaryDict:
    """Steps 4–5: apply a validated plan (merges/promotes/deletes + audit).

    Writes go through db_writer (single-write-queue); every mutation is
    mirrored to the audit trail. Most-recent 20 rules are protected.
    """
    stats: ConsolidationSummaryDict = {'merged': 0, 'promoted': 0, 'deleted_stale': 0, 'errors': []}
    try:
        from app.services.db_writer import enqueue_write
        from app.services.memory_store import _conn

        conn = _conn()
        recentIds = {
            r['id']
            for r in conn.execute(
                'SELECT id FROM learned_heuristics ORDER BY id DESC LIMIT ?', (_RECENTProtectionCount,)
            ).fetchall()
        }
        for mergeRaw in as_list(plan.get('merge'), []):
            merge = as_dict(mergeRaw)
            keepId = merge.get('keepId')
            removeIds = as_list(merge.get('removeIds'), [])
            mergedRule = merge.get('mergedRule')
            if keepId is None or not removeIds:
                continue
            for rid in removeIds:
                if rid == keepId:
                    continue

                def _deleteMerged(i: object = rid) -> object:
                    conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (i,))
                    conn.commit()
                    _record_audit('merge', target_key=str(i), reason='merged duplicate', detail=str(mergedRule)[:300])
                    return None

                await enqueue_write(_deleteMerged, must_succeed=True)
            if mergedRule:

                def _updateMerged(k: object = keepId, m: object = mergedRule) -> object:
                    conn.execute(
                        "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') WHERE id = ?", (m, k)
                    )
                    conn.commit()
                    _record_audit('merge', target_key=str(k), reason='merged rule replaced', detail=str(m)[:300])
                    return None

                await enqueue_write(_updateMerged, must_succeed=True)
            stats['merged'] += 1
        for promoRaw in as_list(plan.get('promote'), []):
            promo = as_dict(promoRaw)
            factKey = promo.get('factKey')
            factValue = promo.get('factValue')
            if not factKey or not factValue:
                continue

            def _insertFact(k: object = factKey, v: object = factValue) -> object:
                conn.execute(
                    'INSERT INTO facts (fact_key, fact_value, category, source, confidence) VALUES (?, ?, ?, ?, ?)',
                    (k, v, 'auto-promoted', 'consolidation', 0.8),
                )
                conn.commit()
                _record_audit('promote', target_key=str(k), reason='promoted pattern', detail=str(v)[:300])
                return None

            await enqueue_write(_insertFact, must_succeed=True)
            stats['promoted'] += 1
        for did in as_list(plan.get('delete'), []):
            if did in recentIds:
                continue

            def _deleteStale(i: object = did) -> object:
                conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (i,))
                conn.commit()
                _record_audit('delete', target_key=str(i), reason='stale rule')
                return None

            await enqueue_write(_deleteStale, must_succeed=True)
            stats['deleted_stale'] += 1
    except Exception as exc:
        stats['errors'].append(str(exc))
        logger.error('Consolidation error: %s', exc)
    _persist_last_run(stats)
    from app.services.brain_event_bus import emitBrainEvent

    summaryParts = []
    if stats['merged']:
        summaryParts.append(f'merged {stats["merged"]} duplicate{("s" if stats["merged"] != 1 else "")}')
    if stats['promoted']:
        summaryParts.append(f'promoted {stats["promoted"]} pattern{("s" if stats["promoted"] != 1 else "")} to facts')
    if stats['deleted_stale']:
        summaryParts.append(
            f'deleted {stats["deleted_stale"]} stale rule{("s" if stats["deleted_stale"] != 1 else "")}'
        )
    if not summaryParts:
        summaryParts.append('no changes — sleep cycle healthy')
    emitBrainEvent(
        category='consolidation',
        layer='consolidation_daemon',
        summary=f'Sleep cycle done: {", ".join(summaryParts)}',
        meta={
            'merged': stats['merged'],
            'promoted': stats['promoted'],
            'deleted_stale': stats['deleted_stale'],
        },
    )
    return stats


async def runConsolidation() -> ConsolidationSummaryDict:
    """Run one Hippocampus-driven consolidation cycle (plan + apply).

    1. Collect recent auto_memories and all learned_heuristics
    2. Call Hippocampus with a structured prompt
    3. Validate the JSON response
    4. Apply merges, promotions, deletes (most-recent 20 protected)
    5. Write through db_writer (Phase 0 single-write-queue)

    Returns stats about what was done.
    """
    from app.services.brain_event_bus import emitBrainEvent

    emitBrainEvent(
        category='consolidation',
        layer='consolidation_daemon',
        summary='Sleep cycle started (will update on completion)',
    )
    plan = await _build_consolidation_plan()
    if plan is None:
        stats: ConsolidationSummaryDict = {'merged': 0, 'promoted': 0, 'deleted_stale': 0, 'errors': []}
        _persist_last_run(stats)
        return stats
    return await _apply_consolidation_plan(plan)


async def previewConsolidation() -> dict[str, object]:
    """Compute the sleep-cycle plan WITHOUT applying anything (B2 preview).

    Returns the raw plan plus per-action counts so the UI can show the user
    exactly what would merge/promote/delete before they commit.
    """
    plan = await _build_consolidation_plan()
    if plan is None:
        return {'plan': None, 'merged': 0, 'promoted': 0, 'deleted': 0, 'errors': []}
    merged = 0
    for mergeRaw in as_list(plan.get('merge'), []):
        m = as_dict(mergeRaw)
        if m.get('keepId') is not None and as_list(m.get('removeIds'), []):
            merged += 1
    promoted = 0
    for promoRaw in as_list(plan.get('promote'), []):
        p = as_dict(promoRaw)
        if p.get('factKey') and p.get('factValue'):
            promoted += 1
    deleted = len(as_list(plan.get('delete'), []))
    return {'plan': plan, 'merged': merged, 'promoted': promoted, 'deleted': deleted, 'errors': []}


def approvePendingSkill(name: str) -> bool:
    """Approve a pending skill — promote into agent skills via skill_service."""
    try:
        from app.services.brain_event_bus import emitBrainEvent
    except Exception:
        emitBrainEvent = None  # type: ignore[assignment]
    try:
        from app.services import skill_service
        from app.services.memory_store import _conn

        conn = _conn()
        row = conn.execute(
            'SELECT name, description, trigger_text, draft_path FROM pending_skills WHERE name = ?',
            (name,),
        ).fetchone()
        if not row:
            return False
        draftPath = row['draft_path']
        if not draftPath or not os.path.exists(draftPath):
            return False
        with open(draftPath, encoding='utf-8') as f:
            raw = f.read()
        # Parse frontmatter + body from draft
        import re

        m = re.match(r'^---\s*\n(.*?)\n---\s*\n(.*)', raw, re.DOTALL)
        description = row['description'] or ''
        trigger = row['trigger_text'] or ''
        body = raw
        if m:
            fm: dict[str, str] = {}
            for line in m.group(1).split('\n'):
                if ':' in line:
                    k, __, v = line.partition(':')
                    fm[k.strip()] = v.strip()
            description = fm.get('description', description) or 'Evolving skill'
            trigger = fm.get('trigger', trigger) or ''
            body = m.group(2).strip()
        safe_name = _sanitizeSkillName(name)
        if not safe_name:
            from app.services.skill_service import _kebab_name

            safe_name = _kebab_name(name) or 'evolving-skill'
        # Truncate description to skill_service limit
        if len(description) > 60:
            description = description[:57] + '...'
        try:
            skill_service.createSkill(
                safe_name,
                description or 'Evolving skill from chat',
                body or f'# {safe_name}\n\nEvolving skill.',
                trigger=trigger,
                category='evolving',
                createdBy='agent',
            )
        except skill_service.SkillValidationError as exc:
            # Already exists — patch body instead
            if 'already exists' in str(exc).lower():
                skill_service.patchSkill(safe_name, body=body, description=description, trigger=trigger)
            else:
                logger.error('Skill approval validation error: %s', exc)
                return False
        try:
            os.remove(draftPath)
        except Exception:
            pass
        conn.execute("UPDATE pending_skills SET status = 'approved' WHERE name = ?", (name,))
        conn.commit()
        if emitBrainEvent is not None:
            emitBrainEvent(
                category='skill_genesis',
                layer='consolidation_daemon.approved_pending_skill',
                summary=f'Approved skill: {safe_name[:80]}',
            )
        return True
    except Exception as exc:
        logger.error('Skill approval error: %s', exc)
        return False


def rejectPendingSkill(name: str) -> bool:
    """v2: Reject a pending skill — delete the staging file."""
    emitBrainEvent = None
    try:
        from app.services.brain_event_bus import emitBrainEvent as _emit

        emitBrainEvent = _emit
    except Exception:
        pass
    try:
        from app.services.memory_store import _conn

        conn = _conn()
        row = conn.execute('SELECT draft_path FROM pending_skills WHERE name = ?', (name,)).fetchone()
        if not row:
            return False
        draftPath = row['draft_path']
        if os.path.exists(draftPath):
            os.remove(draftPath)
        conn.execute("UPDATE pending_skills SET status = 'rejected' WHERE name = ?", (name,))
        conn.commit()
        if emitBrainEvent is not None:
            emitBrainEvent(
                category='skill_genesis',
                layer='consolidation_daemon.rejected_pending_skill',
                summary=f'Rejected skill: {name[:80]}',
            )
        return True
    except Exception as exc:
        logger.error('Skill rejection error: %s', exc)
        return False
