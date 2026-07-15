"""
Brain dashboard API — /api/brain/* endpoints.

The frontend Memory & Knowledge section polls these read-only endpoints that
aggregate the brain's memory store, vector DB, facts, and prompt builder.

Resource-oriented sub-paths under /api/brain/*; non-colliding with core
memory CRUD (/api/memory/kv, /facts, /search, /stats).

Endpoints (all GET):
  /api/brain/status       → { count, driver, path, available }
  /api/brain/items        → { items: MemoryItem[] }
  /api/brain/vectors      → { entries: VectorEntry[] }
  /api/brain/learning     → { status, lastStartedAt?, lastTopic? }
  /api/brain/prompt       → { prompt, length }
  /api/brain/search?q=    → { results: SearchResult[] }
  /api/brain/guidelines   → { guidelines: Guideline[] }
  /api/brain/graph        → GraphStats
  /api/brain/diagnostics  → BrainDiagnostics
"""

from __future__ import annotations
import time
from fastapi import APIRouter, Query
from app.services import memory_store
from app.services.memory import context_builder
from app.services.memory import vector_db
from app.json_narrowing import as_dict, as_float, as_int, as_list, as_str

router = APIRouter(prefix='/api/brain')


@router.get('/status')
async def brainStatus() -> dict[str, object]:
    """Return brain store health — { count, driver, path, available }.

    Maps memory_store.get_stats() + the brain SQLite path into the StoreStatus
    shape the dashboard reads.
    """
    try:
        from app.lib.paths import dataPath

        stats = memory_store.get_stats() or {}
        dbPath = dataPath('august_brain.sqlite')
        count = as_int(stats.get('memoryStore') or stats.get('memory_store'), 0)
        return {'count': count, 'driver': 'sqlite', 'path': str(dbPath), 'available': True}
    except Exception as exc:
        return {'count': 0, 'driver': 'sqlite', 'path': '', 'available': False, 'error': str(exc)}


@router.get('/items')
async def brainItems() -> dict[str, object]:
    """Return stored memory items — { items: MemoryItem[] }.

    Maps memory_store.list_memory() rows (key, value) into the MemoryItem
    shape the dashboard renders (id, type, key, title, summary, ...).
    """
    try:
        rows = memory_store.list_memory('%') or []
    except Exception:
        rows = []
    items: list[dict[str, object]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        key = as_str(r.get('key'), '')
        value = r.get('value')
        if isinstance(value, str):
            try:
                import json

                value = json.loads(value)
            except Exception:
                pass
        summary = ''
        if isinstance(value, dict):
            summary = str(
                as_str(value.get('summary')) or as_str(value.get('text')) or as_str(value.get('content')) or value
            )[:300]
        items.append(
            {
                'id': as_str(r.get('id')) or key,
                'type': 'memory',
                'key': key,
                'title': key,
                'summary': summary or str(value)[:300] if value is not None else '',
                'status': 'active',
                'pinned': False,
                'confidence': 1.0,
                'source': 'memory_store',
                'updatedAt': as_str(r.get('updatedAt')) or '',
            }
        )
    return {'items': items}


@router.get('/vectors')
async def brainVectors() -> dict[str, object]:
    """Return vector DB entries — { entries: VectorEntry[] }.

    Projects each vector entry into { id, topic, summary, timestamp, tags }.
    """
    try:
        db = vector_db._read() or {}
        entries = as_list(db.get('entries'), []) or as_list(db.get('vectors'), []) or []
    except Exception:
        entries = []
    out: list[dict[str, object]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        meta = as_dict(e.get('metadata'), {})
        out.append(
            {
                'id': as_str(e.get('id')) or as_str(meta.get('id')) or '',
                'topic': as_str(meta.get('topic')) or as_str(meta.get('namespace')) or 'default',
                'summary': (as_str(e.get('text')) or as_str(meta.get('summary')) or as_str(meta.get('text')) or '')[
                    :300
                ],
                'timestamp': as_str(e.get('timestamp')) or as_str(meta.get('timestamp')) or '',
                'tags': as_list(meta.get('tags'), []),
            }
        )
    return {'entries': out}


@router.get('/learning')
async def brainLearning() -> dict[str, object]:
    """v3: Return the rich Brain dashboard learning aggregation.

    Includes heuristics, core facts, user profile, auto-memories,
    sleep cycle stats, delta engine stats, and pending skills.
    The legacy `{status, lastStartedAt, lastTopic}` shape is preserved
    as a top-level `backgroundReview` field for backward compatibility.
    """
    from app.services.heuristics_service import listHeuristics
    from app.services import consolidation_daemon as _cd
    from app.services import delta_engine as _de

    heuristics = listHeuristics()
    coreFacts = memory_store.get_memory('coreMemory')
    userProfile = memory_store.get_memory('userProfile')
    try:
        deltaQueueSize = len(getattr(_de, '_diff_queue', []) or [])
    except Exception:
        deltaQueueSize = 0
    lastFlushAt = getattr(_de, '_last_flush', None)
    autoMemories: list[dict[str, object]] = []
    try:
        rows = (
            memory_store._conn()
            .execute(
                'SELECT id, key, content, importance, created_at FROM auto_memories ORDER BY importance DESC, id DESC LIMIT 20'
            )
            .fetchall()
        )
        autoMemories = [memory_store._row_as_wire(r) for r in rows]
    except Exception:
        pass
    sleepCycle: dict[str, object] = {'lastRunAt': None, 'lastMerged': 0, 'lastPromoted': 0, 'lastDeleted': 0}
    last = None
    try:
        last = _cd.get_last_run() if hasattr(_cd, 'get_last_run') else None
    except Exception:
        last = None
    if not last:
        last = getattr(_cd, '_lastRun', None) or getattr(_cd, '_last_run', None)
    if last:
        sleepCycle.update(
            {
                'lastRunAt': as_str(last.get('at')),
                'lastMerged': as_int(last.get('merged'), 0),
                'lastPromoted': as_int(last.get('promoted'), 0),
                'lastDeleted': as_int(last.get('deleted_stale') if last.get('deleted_stale') is not None else last.get('deletedStale'), 0),
            }
        )
    pendingSkills: list[dict[str, object]] = []
    try:
        rows = (
            memory_store._conn()
            .execute(
                "SELECT id, name, description, trigger_text, draft_path, source_session_id, created_at, status, use_count FROM pending_skills WHERE status = 'pending' ORDER BY created_at DESC"
            )
            .fetchall()
        )
        pendingSkills = [memory_store._row_as_wire(r) for r in rows]
    except Exception:
        pass
    try:
        topics = memory_store.list_topics(limit=1) or []
    except Exception:
        topics = []
    lastTopic = topics[0].get('topic') if topics else None
    lastAt = (topics[0].get('classifiedAt') or topics[0].get('classified_at')) if topics else None
    backgroundReview = {'status': 'idle', 'lastStartedAt': lastAt, 'lastTopic': lastTopic}
    return {
        'status': 'idle',
        'heuristics': heuristics,
        'heuristicCount': len(heuristics),
        'coreFacts': coreFacts,
        'userProfile': userProfile,
        'autoMemories': autoMemories,
        'sleepCycle': sleepCycle,
        'delta_engine': {
            'consentGranted': bool(_de.isConsentGranted()) if hasattr(_de, 'isConsentGranted') else False,
            'queueSize': deltaQueueSize,
            'lastFlushAt': lastFlushAt,
        },
        'pendingSkills': pendingSkills,
        'backgroundReview': backgroundReview,
    }


@router.get('/prompt')
async def brainPrompt() -> dict[str, object]:
    """Return the built system prompt — { prompt, length }."""
    prompt = context_builder.buildSystemPrompt()
    return {'prompt': prompt, 'length': len(prompt)}


@router.get('/search')
async def brainSearch(q: str = Query(default='')) -> dict[str, object]:
    """Search the brain across store + facts + vectors — { results: SearchResult[] }.

    Merges memory_store.search_memory, search_facts, and vector_db.search into
    the SearchResult shape ({ provider, type, title, text, score, ... }).
    """
    results: list[dict[str, object]] = []
    query = (q or '').strip()
    if not query:
        return {'results': []}
    try:
        for r in memory_store.search_memory(query) or []:
            if not isinstance(r, dict):
                continue
            results.append(
                {
                    'provider': 'memory_store',
                    'type': 'memory',
                    'title': as_str(r.get('key'), ''),
                    'text': as_str(r.get('value'), '')[:500],
                    'score': as_float(r.get('score'), 1.0),
                    'key': as_str(r.get('key'), ''),
                }
            )
    except Exception:
        pass
    try:
        for f in memory_store.search_facts(query) or []:
            if not isinstance(f, dict):
                continue
            results.append(
                {
                    'provider': 'facts',
                    'type': 'fact',
                    'title': as_str(f.get('key')) or as_str(f.get('fact_key')) or '',
                    'text': as_str(f.get('value')) or as_str(f.get('fact_value')) or ''[:500],
                    'score': as_float(f.get('confidence'), 1.0),
                    'key': as_str(f.get('key')) or as_str(f.get('fact_key')) or '',
                    'quality': {
                        'score': as_float(f.get('confidence'), 1.0),
                        'confidence': as_float(f.get('confidence'), 1.0),
                        'label': 'high' if as_float(f.get('confidence'), 1.0) >= 0.8 else 'medium',
                    },
                }
            )
    except Exception:
        pass
    try:
        for v in vector_db.search(query, top_k=5) or []:
            if not isinstance(v, dict):
                continue
            meta = as_dict(v.get('metadata'), {})
            results.append(
                {
                    'provider': 'vector_db',
                    'type': 'vector',
                    'title': as_str(meta.get('topic')) or 'vector',
                    'text': (as_str(v.get('text')) or as_str(meta.get('text')) or '')[:500],
                    'score': as_float(v.get('score'), 0.0),
                    'key': as_str(v.get('id')) or '',
                }
            )
    except Exception:
        pass
    return {'results': results}


@router.get('/guidelines')
async def brainGuidelines() -> dict[str, object]:
    """Return guidelines — { guidelines: Guideline[] }.

    Guidelines are stored as facts in the 'guideline' category; each is mapped
    into the Guideline shape ({ id, text, source, confidence, status, ... }).
    """
    try:
        facts = memory_store.list_facts('guideline') or []
    except Exception:
        facts = []
    out: list[dict[str, object]] = []
    for f in facts:
        if not isinstance(f, dict):
            continue
        value = f.get('value')
        if isinstance(value, str):
            try:
                import json

                value = json.loads(value)
            except Exception:
                pass
        text = ''
        if isinstance(value, dict):
            text = str(as_str(value.get('text')) or as_str(value.get('content')) or as_str(value.get('summary')) or '')
        elif value is not None:
            text = str(value)
        out.append(
            {
                'id': as_str(f.get('key')) or as_str(f.get('factKey')) or '',
                'text': text,
                'source': as_str(f.get('source')) or 'memory_store',
                'confidence': as_float(f.get('confidence'), 1.0),
                'status': 'active',
                'count': 1,
                'createdAt': as_str(f.get('createdAt')) or '',
                'lastSeenAt': as_str(f.get('updatedAt')) or '',
                'lastUsedAt': None,
            }
        )
    return {'guidelines': out}


@router.get('/graph')
async def brainGraph(
    q: str = Query('', description='Optional entity search; empty = default neighborhood'),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, object]:
    """Return knowledge graph stats + searchable subgraph for the UI.

    Shape::
        {
          stats: { counts, entityTypes, updatedAt },
          search: { entities: [...], relations: [...] }
        }

    Entities/relations come from graph_memory (SQLite SoT). When ``q`` is
    empty, returns the most recently updated neighborhood so the Graph tab
    can render without a search gate.
    """
    from app.services.memory import graph_memory

    counts = {'entities': 0, 'relations': 0, 'observations': 0}
    entityTypes: dict[str, int] = {}
    entities_out: list[dict[str, object]] = []
    relations_out: list[dict[str, object]] = []

    try:
        stats = graph_memory.graphStats()
        counts = {
            'entities': as_int(stats.get('entities'), 0),
            'relations': as_int(stats.get('relations'), 0),
            'observations': as_int(stats.get('observations'), 0),
        }
        entityTypes = graph_memory.entityTypeCounts()
    except Exception:
        pass

    try:
        query = (q or '').strip()
        if query:
            raw_entities = graph_memory.searchEntities(query)[:limit]
        else:
            raw_entities = graph_memory.listEntities(limit)

        # Stable ids from name keys; map for relation endpoints
        name_to_id: dict[str, str] = {}
        keys: list[str] = []
        for e in raw_entities:
            name = as_str(e.get('name'), '')
            if not name:
                continue
            eid = graph_memory.entityKey(name)
            name_to_id[name] = eid
            keys.append(eid)
            entities_out.append(
                {
                    'id': eid,
                    'type': as_str(e.get('type'), 'general') or 'general',
                    'name': name,
                    'score': 1.0,
                }
            )

        if keys:
            raw_rels = graph_memory.listRelationsForKeys(keys, limit=min(200, limit * 4))
            # Also include endpoint entities missing from the primary set
            extra_names: set[str] = set()
            for r in raw_rels:
                for side in (as_str(r.get('source')), as_str(r.get('target'))):
                    if side and side not in name_to_id:
                        extra_names.add(side)
            for name in extra_names:
                ent = graph_memory.getEntity(name)
                if not ent:
                    continue
                eid = graph_memory.entityKey(name)
                name_to_id[name] = eid
                entities_out.append(
                    {
                        'id': eid,
                        'type': as_str(ent.get('type'), 'general') or 'general',
                        'name': name,
                        'score': 0.5,
                    }
                )

            for r in raw_rels:
                src = as_str(r.get('source'))
                tgt = as_str(r.get('target'))
                if not src or not tgt:
                    continue
                relations_out.append(
                    {
                        'id': as_str(r.get('id')) or f'{src}->{tgt}',
                        'from': name_to_id.get(src) or graph_memory.entityKey(src),
                        'to': name_to_id.get(tgt) or graph_memory.entityKey(tgt),
                        'type': as_str(r.get('type'), 'related') or 'related',
                        'fromName': src,
                        'toName': tgt,
                    }
                )
    except Exception:
        pass

    return {
        'stats': {
            'counts': counts,
            'entityTypes': entityTypes,
            'updatedAt': str(int(time.time())),
        },
        'search': {
            'entities': entities_out,
            'relations': relations_out,
        },
    }


@router.get('/diagnostics')
async def brainDiagnostics() -> dict[str, object]:
    """Return brain diagnostics — BrainDiagnostics.

    Shape: { error?, injectedChars, maxChars, compacted, guidelines,
    semanticFacts, vectorEntries }.
    """
    try:
        stats = memory_store.get_stats() or {}
        try:
            vcount = int(vector_db.count() or 0)
        except Exception:
            vcount = 0
        try:
            guidelines = len(memory_store.list_facts('guideline') or [])
        except Exception:
            guidelines = 0
        try:
            facts = as_int(stats.get('facts'), 0)
        except Exception:
            facts = 0
        prompt = context_builder.buildSystemPrompt()
        return {
            'injectedChars': len(prompt),
            'maxChars': 32768,
            'compacted': False,
            'guidelines': guidelines,
            'semanticFacts': facts,
            'vectorEntries': vcount,
        }
    except Exception as exc:
        return {
            'error': str(exc),
            'injectedChars': 0,
            'maxChars': 0,
            'compacted': False,
            'guidelines': 0,
            'semanticFacts': 0,
            'vectorEntries': 0,
        }
