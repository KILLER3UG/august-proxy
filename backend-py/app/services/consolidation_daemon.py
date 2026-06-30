"""
Sleep Cycle — consolidation daemon (Phase 9a + 10.4).

v2: Background daemon triggered during idle or every 24 hours. Uses the
Hippocampus model to review recent auto_memories and learned_heuristics,
then merges duplicates, promotes recurring patterns to facts, and deletes
stale entries. Also drafts new SKILL.md files from successful complex
sessions (Phase 10.4) using the Prefrontal model.
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import time
from typing import Any
logger = logging.getLogger(__name__)
_CONSOLIDATIONInterval = 86400
_RECENTProtectionCount = 20
_SKILLDraftRateLimit = 1
_stagingDir = os.path.join('data', 'skills', 'staging')
_activeSkillsDir = os.path.join('skills')
_lastRun: dict | None = None

def _sanitizeSkillName(name: str) -> str:
    """v2 hardening: Convert any name to a valid camelCase identifier.

    LLMs may produce names with spaces, hyphens, underscores, or starting
    with uppercase. This function normalizes the name to camelCase so it's
    a valid filename-safe identifier. Examples:
      "Debug Python Script" -> "debugPythonScript"
      "user_preferences"    -> "userPreferences"
      "JWT-Auth-Flow"       -> "jwtAuthFlow"
      "  Hello World  "      -> "helloWorld"
    """
    if not name:
        return ''
    import re
    s = name.strip()
    parts = re.split('[^A-Za-z0-9]+', s)
    parts = [p for p in parts if p]
    if not parts:
        return ''
    result = parts[0].lower()
    for p in parts[1:]:
        result += p[0].upper() + p[1:].lower() if len(p) > 0 else ''
    return result[:50]

async def _callHippocampus(prompt: str) -> str:
    """v2: Call the Hippocampus model. Returns raw text response.

    Uses the provider client if available; falls back to a heuristic
    no-op for environments without a configured LLM.
    """
    try:
        from app.services.workbench import modelFleet
        from app.providers.clients import getClient
        model = modelFleet.get_model_for_role('hippocampus')
        client = getClient({'model': model})
        if client and hasattr(client, 'generate'):
            response = await client.generate(prompt)
            return response or ''
    except Exception:
        pass
    return ''

async def _callPrefrontal(prompt: str) -> str:
    """v2: Call the Prefrontal model. Returns raw text response."""
    try:
        from app.services.workbench import modelFleet
        from app.providers.clients import getClient
        model = modelFleet.get_model_for_role('prefrontal')
        client = getClient({'model': model})
        if client and hasattr(client, 'generate'):
            response = await client.generate(prompt)
            return response or ''
    except Exception:
        pass
    return ''

def _getSessionSummary(sessionId: str) -> str:
    """v2: Get a brief summary of a session's activity. Default impl returns empty."""
    return ''

async def runConsolidation() -> dict[str, Any]:
    """Run one Hippocampus-driven consolidation cycle.

    1. Collect recent auto_memories and all learned_heuristics
    2. Call Hippocampus with a structured prompt
    3. Validate the JSON response
    4. Apply merges, promotions, deletes (most-recent 20 protected)
    5. Write through db_writer (Phase 0 single-write-queue)

    Returns stats about what was done.
    """
    stats: dict[str, Any] = {'merged': 0, 'promoted': 0, 'deleted_stale': 0, 'errors': []}
    from app.services.brain_event_bus import emitBrainEvent
    emitBrainEvent(category='consolidation', layer='consolidation_daemon', summary=f'Sleep cycle started over {0} heuristics (will update on completion)')
    try:
        from app.services.memory_store import _conn
        from app.services.db_writer import enqueueWrite
        conn = _conn()
        autoMemories = [dict(r) for r in conn.execute('SELECT * FROM auto_memories ORDER BY id DESC LIMIT 100').fetchall()]
        heuristics = [dict(r) for r in conn.execute('SELECT * FROM learned_heuristics ORDER BY id DESC').fetchall()]
        if not heuristics:
            return stats
        prompt = f"""Review these auto_memories and learned_heuristics. Return a JSON plan:\n{{'merge': [{{'keep_id': int, 'remove_ids': [int, ...], 'merged_rule': str}}],\n 'promote': [{{'pattern': str, 'fact_key': str, 'fact_value': str}}],\n 'delete': [int, ...]}}\nAuto memories ({len(autoMemories)}):\n{json.dumps(autoMemories, default=str)[:2000]}\n\nHeuristics ({len(heuristics)}):\n{json.dumps(heuristics, default=str)[:2000]}\n\nPreserve the most recent 20 rules (do not delete them).\nIf there's nothing to do, return {{"merge": [], "promote": [], "delete": []}}.\n"""
        raw = await _callHippocampus(prompt)
        if not raw:
            return stats
        try:
            plan = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return stats
        if not isinstance(plan, dict):
            return stats
        recentIds = {r['id'] for r in conn.execute('SELECT id FROM learned_heuristics ORDER BY id DESC LIMIT ?', (_RECENTProtectionCount,)).fetchall()}
        for merge in plan.get('merge', []):
            keepId = merge.get('keep_id')
            removeIds = merge.get('remove_ids', [])
            mergedRule = merge.get('merged_rule')
            if keepId is None or not removeIds:
                continue
            for rid in removeIds:
                if rid == keepId:
                    continue
                await enqueueWrite(lambda i=rid: conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (i,)))
            if mergedRule:
                await enqueueWrite(lambda k=keepId, m=mergedRule: conn.execute("UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') WHERE id = ?", (m, k)))
            stats['merged'] += 1
        for promo in plan.get('promote', []):
            factKey = promo.get('fact_key')
            factValue = promo.get('fact_value')
            if not factKey or not factValue:
                continue
            await enqueueWrite(lambda k=factKey, v=factValue: conn.execute('INSERT INTO facts (fact_key, fact_value, category, source, confidence) VALUES (?, ?, ?, ?, ?)', (k, v, 'auto-promoted', 'consolidation', 0.8)))
            stats['promoted'] += 1
        for did in plan.get('delete', []):
            if did in recentIds:
                continue
            await enqueueWrite(lambda i=did: conn.execute('DELETE FROM learned_heuristics WHERE id = ?', (i,)))
            stats['deleted_stale'] += 1
    except Exception as exc:
        stats['errors'].append(str(exc))
        logger.error('Consolidation error: %s', exc)
    global _last_run
    _lastRun = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'merged': stats['merged'], 'promoted': stats['promoted'], 'deleted_stale': stats['deleted_stale']}
    from app.services.brain_event_bus import emitBrainEvent
    summaryParts = []
    if stats['merged']:
        summaryParts.append(f"merged {stats['merged']} duplicate{('s' if stats['merged'] != 1 else '')}")
    if stats['promoted']:
        summaryParts.append(f"promoted {stats['promoted']} pattern{('s' if stats['promoted'] != 1 else '')} to facts")
    if stats['deleted_stale']:
        summaryParts.append(f"deleted {stats['deleted_stale']} stale rule{('s' if stats['deleted_stale'] != 1 else '')}")
    if not summaryParts:
        summaryParts.append('no changes — sleep cycle healthy')
    emitBrainEvent(category='consolidation', layer='consolidation_daemon', summary=f"Sleep cycle done: {', '.join(summaryParts)}", meta={'merged': stats['merged'], 'promoted': stats['promoted'], 'deleted_stale': stats['deleted_stale']})
    return stats

async def draftSkillForSession(sessionId: str) -> str | None:
    """v2: Draft a SKILL.md from a successful session.

    Returns the skill name or None if skipped.
    Quality guard: skip if we already drafted a skill today.
    """
    try:
        from app.services.memory_store import _conn
        conn = _conn()
        today = time.strftime('%Y-%m-%d')
        recent = conn.execute("SELECT COUNT(*) as c FROM pending_skills WHERE created_at >= ? AND created_by = 'auto-gen'", (today,)).fetchone()
        if recent['c'] >= _SKILLDraftRateLimit:
            return None
        summary = _getSessionSummary(sessionId)
        if not summary:
            return None
        prompt = f"This session completed a complex multi-step workflow. Is this workflow generic enough to be turned into a reusable skill? If yes, draft a SKILL.md. Constraints: the 'name' MUST be a valid camelCase identifier (e.g., 'debugPythonScript', 'userPreferences', 'jwtAuthFlow') — lowercase first word, capitalized subsequent words, no separators, no spaces, no special chars, <= 50 chars. Return JSON: {{'name': str, 'description': str, 'trigger': str, 'body': str}} or {{'skip': true, 'reason': str}}.\n\nSession summary:\n{summary}\n"
        raw = await _callPrefrontal(prompt)
        try:
            plan = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        if plan.get('skip'):
            return None
        name = _sanitizeSkillName(plan.get('name', ''))
        description = plan.get('description', '')
        trigger = plan.get('trigger', '')
        body = plan.get('body', '')
        if not name or not body:
            return None
        os.makedirs(_stagingDir, exist_ok=True)
        draftPath = os.path.join(_stagingDir, f'{name}.md')
        content = f'---\nname: {name}\ndescription: {description}\ntrigger: {trigger}\ncreated_by: auto-gen\n---\n\n{body}\n'
        with open(draftPath, 'w', encoding='utf-8') as f:
            f.write(content)
        conn.execute('INSERT INTO pending_skills (name, description, trigger_text, draft_path, source_session_id, source_workflow) VALUES (?, ?, ?, ?, ?, ?)', (name, description, trigger, draftPath, sessionId, summary[:500]))
        conn.commit()
        return name
    except Exception as exc:
        logger.error('Skill drafting error: %s', exc)
        return None

def approvePendingSkill(name: str) -> bool:
    """v2: Approve a pending skill — move from staging to active."""
    try:
        from app.services.brain_event_bus import emitBrainEvent
    except Exception:
        pass
    try:
        from app.services.memory_store import _conn
        conn = _conn()
        row = conn.execute('SELECT draft_path FROM pending_skills WHERE name = ?', (name,)).fetchone()
        if not row:
            return False
        draftPath = row['draft_path']
        if not os.path.exists(draftPath):
            return False
        os.makedirs(_activeSkillsDir, exist_ok=True)
        import shutil
        shutil.move(draftPath, os.path.join(_activeSkillsDir, f'{name}.md'))
        conn.execute("UPDATE pending_skills SET status = 'approved' WHERE name = ?", (name,))
        conn.commit()
        emitBrainEvent(category='skill_genesis', layer='consolidation_daemon.approved_pending_skill', summary=f'Approved skill: {name[:80]}')
        return True
    except Exception as exc:
        logger.error('Skill approval error: %s', exc)
        return False

def rejectPendingSkill(name: str) -> bool:
    """v2: Reject a pending skill — delete the staging file."""
    try:
        from app.services.brain_event_bus import emitBrainEvent
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
        emitBrainEvent(category='skill_genesis', layer='consolidation_daemon.rejected_pending_skill', summary=f'Rejected skill: {name[:80]}')
        return True
    except Exception as exc:
        logger.error('Skill rejection error: %s', exc)
        return False