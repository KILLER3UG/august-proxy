"""
Brain dashboard API — /api/brain/* endpoints.

The frontend Memory & Knowledge section (frontend/.../sections/memory/Memory.tsx)
polls 9 read-only endpoints that aggregate the brain's memory store, vector DB,
facts, and prompt builder into the shapes the dashboard renders. Originally
these lived under the Node.js backend's /ui/memory/* and /ui/brain/* routes —
a legacy "UI-consumed" prefix that is misleading in a clean backend API.

This router unifies them under a single /api/brain/* namespace with
resource-oriented sub-paths, dropping the redundant "memory/" segment entirely
(no "memory" nesting inside "brain"). It is non-colliding with the core
memory CRUD router (/api/memory/kv, /facts, /search, /stats), which stays
unchanged.

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
from app.services import memoryStore
from app.services.memory import contextBuilder
from app.services.memory import vectorDb
router = APIRouter(prefix='/api/brain')

@router.get('/status')
async def brainStatus() -> dict[str, object]:
    """Return brain store health — { count, driver, path, available }.

    Maps memory_store.get_stats() + the brain SQLite path into the StoreStatus
    shape the dashboard reads.
    """
    try:
        from app.lib.paths import dataPath
        stats = memoryStore.getStats() or {}
        dbPath = dataPath('august_brain.sqlite')
        count = int(stats.get('memoryStore', 0) or 0)
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
        rows = memoryStore.listMemory('%') or []
    except Exception:
        rows = []
    items: list[dict[str, object]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        key = r.get('key', '')
        value = r.get('value')
        if isinstance(value, str):
            try:
                import json
                value = json.loads(value)
            except Exception:
                pass
        summary = ''
        if isinstance(value, dict):
            summary = str(value.get('summary') or value.get('text') or value.get('content') or value)[:300]
        items.append({'id': str(r.get('id') or key), 'type': 'memory', 'key': key, 'title': key, 'summary': summary or str(value)[:300] if value is not None else '', 'status': 'active', 'pinned': False, 'confidence': 1.0, 'source': 'memoryStore', 'updatedAt': r.get('updatedAt') or ''})
    return {'items': items}

@router.get('/vectors')
async def brainVectors() -> dict[str, object]:
    """Return vector DB entries — { entries: VectorEntry[] }.

    Projects each vector entry into { id, topic, summary, timestamp, tags }.
    """
    try:
        db = vectorDb._read() or {}
        entries = db.get('entries', []) or db.get('vectors', []) or []
    except Exception:
        entries = []
    out: list[dict[str, object]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        meta = e.get('metadata') or {}
        out.append({'id': str(e.get('id') or meta.get('id') or ''), 'topic': str(meta.get('topic') or meta.get('namespace') or 'default'), 'summary': str(e.get('text') or meta.get('summary') or meta.get('text') or '')[:300], 'timestamp': e.get('timestamp') or meta.get('timestamp') or '', 'tags': meta.get('tags') or []})
    return {'entries': out}

@router.get('/learning')
async def brainLearning() -> dict[str, object]:
    """v3: Return the rich Brain dashboard learning aggregation.

    Includes heuristics, core facts, user profile, auto-memories,
    sleep cycle stats, delta engine stats, and pending skills.
    The legacy `{status, lastStartedAt, lastTopic}` shape is preserved
    as a top-level `backgroundReview` field for backward compatibility.
"""
    from app.services.heuristicsService import listHeuristics
    from app.services import consolidationDaemon as _cd
    from app.services import deltaEngine as _de
    heuristics = listHeuristics()
    coreFacts = memoryStore.getMemory('core_memory')
    userProfile = memoryStore.getMemory('user_profile')
    try:
        deltaQueueSize = len(getattr(_de, '_diff_queue', []) or [])
    except Exception:
        deltaQueueSize = 0
    lastFlushAt = getattr(_de, '_last_flush', None)
    autoMemories: list[dict[str, object]] = []
    try:
        rows = memoryStore._conn().execute('SELECT id, key, content, importance, createdAt FROM autoMemories ORDER BY importance DESC, id DESC LIMIT 20').fetchall()
        autoMemories = [dict(r) for r in rows]
    except Exception:
        pass
    sleepCycle: dict[str, object] = {'lastRunAt': None, 'lastMerged': 0, 'lastPromoted': 0, 'lastDeleted': 0}
    last = getattr(_cd, '_last_run', None)
    if last:
        sleepCycle.update({'lastRunAt': last.get('at'), 'lastMerged': last.get('merged', 0), 'lastPromoted': last.get('promoted', 0), 'lastDeleted': last.get('deletedStale', 0)})
    pendingSkills: list[dict[str, object]] = []
    try:
        rows = memoryStore._conn().execute("SELECT id, name, description, triggerText, draftPath, sourceSessionId, createdAt, status, useCount FROM pendingSkills WHERE status = 'pending' ORDER BY createdAt DESC").fetchall()
        pendingSkills = [dict(r) for r in rows]
    except Exception:
        pass
    try:
        topics = memoryStore.listTopics(limit=1) or []
    except Exception:
        topics = []
    lastTopic = topics[0].get('topic') if topics else None
    lastAt = topics[0].get('classified_at') if topics else None
    backgroundReview = {'status': 'idle', 'lastStartedAt': lastAt, 'lastTopic': lastTopic}
    return {'status': 'idle', 'heuristics': heuristics, 'heuristicCount': len(heuristics), 'coreFacts': coreFacts, 'userProfile': userProfile, 'autoMemories': autoMemories, 'sleepCycle': sleepCycle, 'deltaEngine': {'consentGranted': False, 'queueSize': deltaQueueSize, 'lastFlushAt': lastFlushAt}, 'pendingSkills': pendingSkills, 'backgroundReview': backgroundReview}

@router.get('/prompt')
async def brainPrompt() -> dict[str, object]:
    """Return the built system prompt — { prompt, length }."""
    prompt = contextBuilder.buildSystemPrompt()
    return {'prompt': prompt, 'length': len(prompt)}

@router.get('/search')
async def brainSearch(q: str=Query(default='')) -> dict[str, object]:
    """Search the brain across store + facts + vectors — { results: SearchResult[] }.

    Merges memory_store.search_memory, search_facts, and vector_db.search into
    the SearchResult shape ({ provider, type, title, text, score, ... }).
    """
    results: list[dict[str, object]] = []
    query = (q or '').strip()
    if not query:
        return {'results': []}
    try:
        for r in memoryStore.searchMemory(query) or []:
            if not isinstance(r, dict):
                continue
            results.append({'provider': 'memory_store', 'type': 'memory', 'title': str(r.get('key', '')), 'text': str(r.get('value', ''))[:500], 'score': float(r.get('score', 1.0) or 1.0), 'key': str(r.get('key', ''))})
    except Exception:
        pass
    try:
        for f in memoryStore.searchFacts(query) or []:
            if not isinstance(f, dict):
                continue
            results.append({'provider': 'facts', 'type': 'fact', 'title': str(f.get('key', f.get('fact_key', ''))), 'text': str(f.get('value') or f.get('fact_value', ''))[:500], 'score': float(f.get('confidence', 1.0) or 1.0), 'key': str(f.get('key', f.get('fact_key', ''))), 'quality': {'score': float(f.get('confidence', 1.0) or 1.0), 'confidence': float(f.get('confidence', 1.0) or 1.0), 'label': 'high' if float(f.get('confidence', 1.0) or 1.0) >= 0.8 else 'medium'}})
    except Exception:
        pass
    try:
        for v in vectorDb.search(query, top_k=5) or []:
            if not isinstance(v, dict):
                continue
            meta = v.get('metadata') or {}
            results.append({'provider': 'vector_db', 'type': 'vector', 'title': str(meta.get('topic') or 'vector'), 'text': str(v.get('text') or meta.get('text') or '')[:500], 'score': float(v.get('score', 0.0) or 0.0), 'key': str(v.get('id') or '')})
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
        facts = memoryStore.listFacts('guideline') or []
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
            text = str(value.get('text') or value.get('content') or value.get('summary') or '')
        elif value is not None:
            text = str(value)
        out.append({'id': str(f.get('key') or f.get('factKey') or ''), 'text': text, 'source': str(f.get('source') or 'memoryStore'), 'confidence': float(f.get('confidence', 1.0) or 1.0), 'status': 'active', 'count': 1, 'createdAt': f.get('createdAt') or '', 'lastSeenAt': f.get('updatedAt') or '', 'lastUsedAt': None})
    return {'guidelines': out}

@router.get('/graph')
async def brainGraph() -> dict[str, object]:
    """Return knowledge graph stats — GraphStats.

    Aggregates counts from memory items, facts, and vector entries into
    { stats: { counts, entityTypes, updatedAt } }.
    """
    counts = {'entities': 0, 'relations': 0, 'observations': 0}
    entityTypes: dict[str, int] = {}
    try:
        stats = memoryStore.getStats() or {}
        counts['entities'] = int(stats.get('memoryStore', 0) or 0)
        counts['observations'] = int(stats.get('facts', 0) or 0)
        entityTypes['memory'] = counts['entities']
        entityTypes['fact'] = counts['observations']
    except Exception:
        pass
    try:
        vcount = vectorDb.count()
        counts['relations'] = int(vcount or 0)
        if vcount:
            entityTypes['vector'] = int(vcount)
    except Exception:
        pass
    return {'stats': {'counts': counts, 'entityTypes': entityTypes, 'updatedAt': str(int(time.time()))}}

@router.get('/diagnostics')
async def brainDiagnostics() -> dict[str, object]:
    """Return brain diagnostics — BrainDiagnostics.

    Shape: { error?, injectedChars, maxChars, compacted, guidelines,
    semanticFacts, vectorEntries }.
    """
    try:
        stats = memoryStore.getStats() or {}
        try:
            vcount = int(vectorDb.count() or 0)
        except Exception:
            vcount = 0
        try:
            guidelines = len(memoryStore.listFacts('guideline') or [])
        except Exception:
            guidelines = 0
        try:
            facts = int(stats.get('facts', 0) or 0)
        except Exception:
            facts = 0
        prompt = contextBuilder.buildSystemPrompt()
        return {'injectedChars': len(prompt), 'maxChars': 32768, 'compacted': False, 'guidelines': guidelines, 'semanticFacts': facts, 'vectorEntries': vcount}
    except Exception as exc:
        return {'error': str(exc), 'injectedChars': 0, 'maxChars': 0, 'compacted': False, 'guidelines': 0, 'semanticFacts': 0, 'vectorEntries': 0}