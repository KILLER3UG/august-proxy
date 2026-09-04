"""
Brain Orchestrator settings-tab HTTP API.

Mounts four routes under ``/api/brain``:

  GET  /api/brain/config                — { source, config, defaults, sessionId?, session? }
  PUT  /api/brain/config                — { ok, config, defaults }           (400 on bad patch)
  POST /api/brain/config/reset          — { ok, config, defaults }
  GET  /api/brain/config/from-session   — { source, config, defaults, sessionId, session }
  GET  /api/brain/stores                — per-store counts for the Memory settings page
  GET  /api/brain/stores/{name}         — paginated rows of one store (read-only browse)
  DELETE /api/brain/stores/{name}/{id}  — delete one row (per-entry Delete in the UI)
  PATCH  /api/brain/stores/{name}/{id}  — update whitelisted fields of one row
  GET  /api/brain/consolidation/log     — M4 consolidation + M5 lesson-promotion log
  POST /api/brain/consolidation/run     — trigger one consolidation pass now
  GET  /api/brain/turn-outcomes         — M5 per-model error-rate telemetry
  GET  /api/brain/state-lookup          — §5.5 raw internal_state/memory_store row by key

The shared service is :mod:`app.services.brain_config_service`. Mutation
endpoints record an audit row via ``memory_store.record_config_audit``.

Handler functions use camelCase to match the project-wide convention. URL
paths and JSON wire-format keys remain snake_case (FastAPI path params,
HTTP method semantics, and the ``auxiliary.cognitive.orchestrator`` SoT
must stay backward-compatible).

Port of the deleted Node.js ``backend/index.js`` brain-config block
(commit 6d61910, 2026-06-21).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.models.camel_base import CamelModel
from app.services import brain_config_service

router = APIRouter(prefix='/api/brain', tags=['brain-config'])


@router.get('/config')
async def getBrainConfig():
    """Return the effective brain config + defaults + source tag + session
    info. The React ``BrainSettings`` page calls this on mount."""
    return brain_config_service.getBrainConfigForSettings()


@router.put('/config')
async def putBrainConfig(body: dict[str, object]):
    """Apply a partial patch to ``auxiliary.cognitive.orchestrator``.

    Body must be a JSON object whose keys are a subset of the 11 known
    fields (9 booleans + 2 numeric limits). Unknown keys, wrong types, or
    out-of-range numbers → HTTP 400 with ``{code, message}``.
    """
    ok, err, merged = brain_config_service.saveBrainConfig(body or {})
    if not ok:
        raise HTTPException(
            status_code=400, detail={'code': 'EBRAIN_UNKNOWN_KEY' if 'unknown' in err else 'validation', 'message': err}
        )
    return {'ok': True, 'config': merged, 'defaults': brain_config_service.getDefaults()}


@router.post('/config/reset')
async def postBrainConfigReset():
    """Clear ``auxiliary.cognitive.orchestrator`` and return the factory defaults."""
    ok, defaults = brain_config_service.resetBrainConfig()
    return {'ok': ok, 'config': defaults, 'defaults': defaults}


@router.get('/config/from-session')
async def getBrainConfigFromSession(sessionId: str = Query(..., min_length=1)):
    """Return the brain config tagged ``source='session'`` for a specific
    workbench session. ``sessionId`` is required (400 if missing)."""
    if not sessionId:
        raise HTTPException(
            status_code=400, detail={'code': 'validation', 'message': 'sessionId query param is required'}
        )
    return brain_config_service.getBrainConfigFromSession(sessionId)


@router.get('/stores')
async def getBrainStores():
    """Per-store row counts — the Memory settings page header chips."""
    from app.services.memory_store.brain import brain_store_summary

    return {'stores': brain_store_summary()}


@router.get('/stores/{name}')
async def getBrainStore(
    name: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    query: str = Query('', max_length=200),
    sort: str = Query('', description='newest|oldest|updated|confidence (Part 17 C-4)'),
    category: str = Query('', max_length=64, description='Server-side category filter (C-3)'),
    source: str = Query('', max_length=64, description='Server-side source filter (C-3)'),
    confidence: str = Query('', max_length=16, description='Server-side confidence filter (C-3)'),
):
    """Read-only paginated browse of one brain store (Memory settings page).

    Part 17 Phase C: ``sort``/``category``/``source``/``confidence`` move
    filtering and ordering server-side so they hold past the fetch cap.
    """
    from app.services.memory_store.brain import brain_browse

    result = brain_browse(
        name,
        limit=limit,
        offset=offset,
        query=query,
        sort=sort,
        category=category,
        source=source,
        confidence=confidence,
    )
    if result.get('error') and not result.get('total') and 'not available' in str(result.get('error')):
        raise HTTPException(status_code=404, detail=result['error'])
    return result


@router.delete('/stores/{name}/{row_id:path}')
async def deleteBrainStoreRow(name: str, row_id: str):
    """Delete one row from a brain store (per-entry Delete in the Memory UI).

    ``row_id`` is the store's identifier column (``id`` for most stores, the
    ``key`` for the KV memory store). Read-only/legacy stores return 403.
    """
    from app.services.memory_store.brain import brain_delete_row

    result = brain_delete_row(name, row_id)
    if result.get('status') == 403:
        raise HTTPException(status_code=403, detail=result.get('error'))
    if not result.get('ok'):
        err = str(result.get('error') or 'delete failed')
        raise HTTPException(status_code=404 if 'not found' in err else 400, detail=err)
    return result


@router.patch('/stores/{name}/{row_id:path}')
async def updateBrainStoreRow(name: str, row_id: str, body: dict[str, object]):
    """Update whitelisted fields of one brain-store row (Memory UI inline edit).

    Only the store's whitelisted columns are applied; unknown fields are
    ignored. Read-only/legacy stores return 403.
    """
    from app.services.memory_store.brain import brain_update_row

    result = brain_update_row(name, row_id, body or {})
    if result.get('status') == 403:
        raise HTTPException(status_code=403, detail=result.get('error'))
    if not result.get('ok'):
        err = str(result.get('error') or 'update failed')
        raise HTTPException(status_code=404 if 'not found' in err else 400, detail=err)
    return result


@router.get('/consolidation/log')
async def getConsolidationLog(limit: int = Query(50, ge=1, le=200)):
    """M4 consolidation log (plan §3.5): one lifecycle row per pass plus the
    M5 lesson-promotion decisions. This is the analysis surface that replaced
    the deleted diagnostics endpoints."""
    import json as _json

    from app.services.memory_conn import conn as _mem_conn

    rows = _mem_conn().execute(
        "SELECT created_at, event_type, detail FROM lifecycle "
        "WHERE event_type IN ('consolidation', 'lesson_promoted', 'lesson_promotion_skipped') "
        'ORDER BY created_at DESC LIMIT ?',
        (limit,),
    ).fetchall()
    entries: list[dict[str, object]] = []
    for r in rows:
        detail: object = {}
        try:
            detail = _json.loads(r['detail']) if r['detail'] else {}
        except (ValueError, TypeError):
            detail = {'raw': r['detail']}
        entries.append({'createdAt': r['created_at'], 'eventType': r['event_type'], 'detail': detail})
    return {'entries': entries}


@router.post('/consolidation/run')
async def postConsolidationRun():
    """Trigger one consolidation pass now (Settings → Memory → "Run now")."""
    import asyncio

    from app.services.memory_store.consolidation import run_consolidation

    summary = await asyncio.to_thread(run_consolidation)
    return {'ok': not summary.get('error'), 'summary': summary}


@router.get('/turn-outcomes')
async def getTurnOutcomes(days: int = Query(7, ge=1, le=30)):
    """M5 telemetry (plan §3.6): per-model/provider error rates for the
    Observability hub. Diagnostics only — never injected into prompts and
    never shown in the Memory UI."""
    from app.services.turn_outcomes import error_rate_by_model

    return {'days': days, 'models': error_rate_by_model(days=days)}


@router.get('/memory/metrics')
async def getMemoryMetrics(days: int = Query(7, ge=1, le=30)):
    """Phase D item 4 (Part 17): recall + latency instrument.

    Two sections, both read-only diagnostics:
      * ``recall`` — per-turn counts from internal_state (global facts
        recalled, project entries recalled, block sizes): the before/after
        instrument for this plan and every later retrieval change.
      * ``latency`` — the Phase L section: TTFT / duration / prompt-cache
        hit split aggregated over ``days`` from turn_outcomes.
    """
    import json as _json

    from app.services.memory_conn import conn as _mem_conn
    from app.services.memory_store.kv import get_internal_state

    def _readTotals() -> dict[str, int]:
        try:
            raw = get_internal_state('memory:recall:totals')
            val = _json.loads(str(raw)) if isinstance(raw, str) else raw
            if isinstance(val, dict):
                return {str(k): int(str(v)) for k, v in val.items()}
            return {}
        except Exception:
            return {}

    totals = _readTotals()
    recall = {
        'turns': int(totals.get('turns') or 0),
        'globalFactsRecalled': int(totals.get('globalFactsRecalled') or 0),
        'projectEntriesRecalled': int(totals.get('projectEntriesRecalled') or 0),
    }
    latency: dict[str, object] = {'turns': 0}
    try:
        rows = _mem_conn().execute(
            """
            SELECT COUNT(*) AS turns,
                   AVG(ttft_ms) AS avg_ttft_ms,
                   MAX(ttft_ms) AS max_ttft_ms,
                   AVG(duration_ms) AS avg_duration_ms,
                   SUM(cache_hit_tokens) AS cache_hit_tokens,
                   SUM(cache_miss_tokens) AS cache_miss_tokens
            FROM turn_outcomes
            WHERE ts >= datetime('now', ?)
            """,
            (f'-{int(days)} days',),
        ).fetchall()
        for r in rows:
            turns = int(r['turns'] or 0)
            hitT = int(r['cache_hit_tokens'] or 0)
            missT = int(r['cache_miss_tokens'] or 0)
            latency = {
                'turns': turns,
                'avgTtftMs': round(float(r['avg_ttft_ms'] or 0), 1) if turns else 0.0,
                'maxTtftMs': int(r['max_ttft_ms'] or 0) if turns else 0,
                'avgDurationMs': round(float(r['avg_duration_ms'] or 0), 1) if turns else 0.0,
                'cacheHitTokens': hitT,
                'cacheMissTokens': missT,
                'cacheHitRate': round(hitT / (hitT + missT), 3) if (hitT + missT) else 0.0,
            }
    except Exception:
        latency = {'turns': 0, 'error': 'turn_outcomes unavailable'}
    return {'days': days, 'recall': recall, 'latency': latency}


@router.get('/state-lookup')
async def getStateLookup(key: str = Query(..., min_length=1)):
    """Raw state lookup (plan §5.5): type a key, get the raw
    ``internal_state`` or ``memory_store`` row verbatim. This is the only
    surface where ``cognitive:*``-style machine state is ever visible —
    never quarantined into Memory, never rendered by default. Read-only;
    ``internal_state`` is checked first (machine state wins)."""
    import json as _json

    from app.services.memory_conn import conn as _mem_conn

    k = key.strip()
    if not k:
        raise HTTPException(
            status_code=400, detail={'code': 'validation', 'message': 'key query param is required'}
        )
    conn = _mem_conn()
    for table in ('internal_state', 'memory_store'):
        row = conn.execute(
            f'SELECT value, updated_at FROM {table} WHERE key = ?', (k,)
        ).fetchone()
        if row:
            value: object
            try:
                value = _json.loads(row['value'])
            except (ValueError, TypeError):
                value = row['value']
            return {
                'key': k,
                'found': True,
                'source': table,
                'value': value,
                'updatedAt': row['updated_at'],
            }
    return {'key': k, 'found': False, 'source': None, 'value': None, 'updatedAt': None}


# ── Routing evidence: Arena / Debate verdicts (Part 25 Phase 4) ──────────────
# The Arena + Debate UIs are live and POST a winner/losers verdict to
# /api/brain/routing/arena and read history back; the endpoints never existed,
# so every recorded verdict toasted "Could not record verdict". These thin
# routes persist verdicts into the existing routing_evidence table (source
# 'arena') and serve the archive + a win-rate suggestion list.


class _ArenaModel(CamelModel):
    model_id: str = ''
    provider: str = ''


class _ArenaVerdict(CamelModel):
    session_id: str = ''
    prompt: str = ''
    task_type: str = 'arena'
    winner: _ArenaModel | None = None
    losers: list[_ArenaModel] = []


@router.post('/routing/arena')
async def recordArenaVerdict(body: _ArenaVerdict):
    """Record one arena/debate verdict: a winner row (ok=1) + one loser row
    (ok=0) per competing model, all tagged source='arena'."""
    from app.services.memory_conn import conn

    winner = body.winner
    if winner is None or not winner.model_id:
        raise HTTPException(status_code=400, detail='winner.modelId is required')
    c = conn()
    recorded = 0
    c.execute(
        "INSERT INTO routing_evidence (session_id, task_type, model, provider, ok, source, prompt) "
        "VALUES (?, ?, ?, ?, 1, 'arena', ?)",
        (body.session_id, body.task_type or 'arena', winner.model_id, winner.provider, body.prompt),
    )
    recorded += 1
    for loser in body.losers:
        if not loser.model_id:
            continue
        c.execute(
            "INSERT INTO routing_evidence (session_id, task_type, model, provider, ok, source, prompt) "
            "VALUES (?, ?, ?, ?, 0, 'arena', ?)",
            (body.session_id, body.task_type or 'arena', loser.model_id, loser.provider, body.prompt),
        )
        recorded += 1
    c.commit()
    return {'ok': True, 'recorded': recorded}


@router.get('/routing/arena')
async def getArenaHistory(limit: int = Query(100, ge=1, le=500)):
    """Recent arena verdicts (the durable archive the UI groups per session)."""
    from app.services.memory_conn import conn

    rows = conn().execute(
        "SELECT session_id, task_type, model, provider, ok, input_tokens, output_tokens, "
        "duration_ms, created_at, prompt FROM routing_evidence WHERE source = 'arena' "
        'ORDER BY id DESC LIMIT ?',
        (limit,),
    ).fetchall()
    return {
        'results': [
            {
                'sessionId': str(r['session_id'] or ''),
                'taskType': str(r['task_type'] or 'arena'),
                'model': str(r['model'] or ''),
                'provider': str(r['provider'] or ''),
                'won': bool(r['ok']),
                'tokens': int(r['input_tokens'] or 0) + int(r['output_tokens'] or 0),
                'durationMs': int(r['duration_ms'] or 0),
                'at': str(r['created_at'] or ''),
                'prompt': str(r['prompt'] or ''),
            }
            for r in rows
        ]
    }


@router.get('/routing/suggestions')
async def getRoutingSuggestions(prompt: str = Query('', max_length=2000), limit: int = Query(5, ge=1, le=25)):
    """Per-model win-rate suggestions from arena evidence (surpass #1 loop):
    models ranked by win rate over ≥1 recorded verdict, for the composer's
    'which model wins this kind of prompt' affordance."""
    from app.services.memory_conn import conn

    rows = conn().execute(
        "SELECT model, provider, SUM(ok) AS wins, COUNT(*) AS total, "
        "AVG(input_tokens + output_tokens) AS avg_tokens FROM routing_evidence "
        "WHERE source = 'arena' AND model != '' GROUP BY model, provider "
        'ORDER BY wins * 1.0 / total DESC, total DESC LIMIT ?',
        (limit,),
    ).fetchall()
    suggestions = [
        {
            'modelId': str(r['model'] or ''),
            'provider': str(r['provider'] or ''),
            'wins': int(r['wins'] or 0),
            'total': int(r['total'] or 0),
            'winRate': round(int(r['wins'] or 0) / max(1, int(r['total'] or 0)), 3),
            'avgTokens': int(r['avg_tokens'] or 0),
        }
        for r in rows
    ]
    return {'prompt': prompt, 'suggestions': suggestions}
