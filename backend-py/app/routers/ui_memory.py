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
from typing import Any

from fastapi import APIRouter, Query

from app.services import memory_store
from app.services.memory import context_builder
from app.services.memory import vector_db

router = APIRouter(prefix="/api/brain")


# ── Status ─────────────────────────────────────────────────────────────


@router.get("/status")
async def brain_status() -> dict[str, Any]:
    """Return brain store health — { count, driver, path, available }.

    Maps memory_store.get_stats() + the brain SQLite path into the StoreStatus
    shape the dashboard reads.
    """
    try:
        stats = memory_store.get_stats() or {}
        db_path = memory_store._db_path()
        count = int(stats.get("memory_store", 0) or 0)
        return {
            "count": count,
            "driver": "sqlite",
            "path": str(db_path),
            "available": True,
        }
    except Exception as exc:
        return {"count": 0, "driver": "sqlite", "path": "", "available": False, "error": str(exc)}


# ── Items ─────────────────────────────────────────────────────────────


@router.get("/items")
async def brain_items() -> dict[str, Any]:
    """Return stored memory items — { items: MemoryItem[] }.

    Maps memory_store.list_memory() rows (key, value) into the MemoryItem
    shape the dashboard renders (id, type, key, title, summary, ...).
    """
    try:
        rows = memory_store.list_memory("%") or []
    except Exception:
        rows = []
    items: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        key = r.get("key", "")
        value = r.get("value")
        if isinstance(value, str):
            try:
                import json
                value = json.loads(value)
            except Exception:
                pass
        summary = ""
        if isinstance(value, dict):
            summary = str(value.get("summary") or value.get("text") or value.get("content") or value)[:300]
        items.append({
            "id": str(r.get("id") or key),
            "type": "memory",
            "key": key,
            "title": key,
            "summary": summary or str(value)[:300] if value is not None else "",
            "status": "active",
            "pinned": False,
            "confidence": 1.0,
            "source": "memory_store",
            "updatedAt": r.get("updated_at") or r.get("updatedAt") or "",
        })
    return {"items": items}


# ── Vectors ───────────────────────────────────────────────────────────


@router.get("/vectors")
async def brain_vectors() -> dict[str, Any]:
    """Return vector DB entries — { entries: VectorEntry[] }.

    Projects each vector entry into { id, topic, summary, timestamp, tags }.
    """
    try:
        db = vector_db._read() or {}
        entries = db.get("entries", []) or db.get("vectors", []) or []
    except Exception:
        entries = []
    out: list[dict[str, Any]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        meta = e.get("metadata") or {}
        out.append({
            "id": str(e.get("id") or meta.get("id") or ""),
            "topic": str(meta.get("topic") or meta.get("namespace") or "default"),
            "summary": str(e.get("text") or meta.get("summary") or meta.get("text") or "")[:300],
            "timestamp": e.get("timestamp") or meta.get("timestamp") or "",
            "tags": meta.get("tags") or [],
        })
    return {"entries": out}


# ── Learning status ───────────────────────────────────────────────────


@router.get("/learning")
async def brain_learning() -> dict[str, Any]:
    """v3: Return the rich Brain dashboard learning aggregation.

    Includes heuristics, core facts, user profile, auto-memories,
    sleep cycle stats, delta engine stats, and pending skills.
    The legacy `{status, lastStartedAt, lastTopic}` shape is preserved
    as a top-level `background_review` field for backward compatibility.
    """
    from app.services.heuristics_service import list_heuristics
    from app.services import consolidation_daemon as _cd
    from app.services import delta_engine as _de

    # Heuristics
    heuristics = list_heuristics()

    # Core facts & user profile
    core_facts = memory_store.get_memory("core_memory")
    user_profile = memory_store.get_memory("user_profile")

    # Delta engine queue size
    try:
        delta_queue_size = len(getattr(_de, "_diff_queue", []) or [])
    except Exception:
        delta_queue_size = 0
    last_flush_at = getattr(_de, "_last_flush", None)

    # Auto-memories (top 20 by importance)
    auto_memories: list[dict[str, Any]] = []
    try:
        rows = memory_store._conn().execute(
            "SELECT id, key, content, importance, created_at "
            "FROM auto_memories ORDER BY importance DESC, id DESC LIMIT 20"
        ).fetchall()
        auto_memories = [dict(r) for r in rows]
    except Exception:
        pass

    # Sleep cycle stats
    sleep_cycle: dict[str, Any] = {
        "last_run_at": None,
        "last_merged": 0,
        "last_promoted": 0,
        "last_deleted": 0,
    }
    last = getattr(_cd, "_last_run", None)
    if last:
        sleep_cycle.update({
            "last_run_at": last.get("at"),
            "last_merged": last.get("merged", 0),
            "last_promoted": last.get("promoted", 0),
            "last_deleted": last.get("deleted_stale", 0),
        })

    # Pending skills
    pending_skills: list[dict[str, Any]] = []
    try:
        rows = memory_store._conn().execute(
            "SELECT id, name, description, trigger_text, draft_path, "
            "source_session_id, created_at, status, use_count "
            "FROM pending_skills WHERE status = 'pending' "
            "ORDER BY created_at DESC"
        ).fetchall()
        pending_skills = [dict(r) for r in rows]
    except Exception:
        pass

    # Legacy background_review status (for backward compat)
    try:
        topics = memory_store.list_topics(limit=1) or []
    except Exception:
        topics = []
    last_topic = topics[0].get("topic") if topics else None
    last_at = topics[0].get("classified_at") if topics else None
    background_review = {
        "status": "idle",
        "lastStartedAt": last_at,
        "lastTopic": last_topic,
    }

    return {
        "status": "idle",  # Legacy top-level field for the existing dashboard
        "heuristics": heuristics,
        "heuristic_count": len(heuristics),
        "core_facts": core_facts,
        "user_profile": user_profile,
        "auto_memories": auto_memories,
        "sleep_cycle": sleep_cycle,
        "delta_engine": {
            "consent_granted": False,
            "queue_size": delta_queue_size,
            "last_flush_at": last_flush_at,
        },
        "pending_skills": pending_skills,
        # Legacy field for the existing dashboard
        "background_review": background_review,
    }


# ── System prompt preview ─────────────────────────────────────────────


@router.get("/prompt")
async def brain_prompt() -> dict[str, Any]:
    """Return the built system prompt — { prompt, length }."""
    prompt = context_builder.build_system_prompt()
    return {"prompt": prompt, "length": len(prompt)}


# ── Search ───────────────────────────────────────────────────────────


@router.get("/search")
async def brain_search(q: str = Query(default="")) -> dict[str, Any]:
    """Search the brain across store + facts + vectors — { results: SearchResult[] }.

    Merges memory_store.search_memory, search_facts, and vector_db.search into
    the SearchResult shape ({ provider, type, title, text, score, ... }).
    """
    results: list[dict[str, Any]] = []
    query = (q or "").strip()
    if not query:
        return {"results": []}

    # KV memory
    try:
        for r in memory_store.search_memory(query) or []:
            if not isinstance(r, dict):
                continue
            results.append({
                "provider": "memory_store",
                "type": "memory",
                "title": str(r.get("key", "")),
                "text": str(r.get("value", ""))[:500],
                "score": float(r.get("score", 1.0) or 1.0),
                "key": str(r.get("key", "")),
            })
    except Exception:
        pass

    # Facts
    try:
        for f in memory_store.search_facts(query) or []:
            if not isinstance(f, dict):
                continue
            results.append({
                "provider": "facts",
                "type": "fact",
                "title": str(f.get("key", f.get("fact_key", ""))),
                "text": str(f.get("value") or f.get("fact_value", ""))[:500],
                "score": float(f.get("confidence", 1.0) or 1.0),
                "key": str(f.get("key", f.get("fact_key", ""))),
                "quality": {
                    "score": float(f.get("confidence", 1.0) or 1.0),
                    "confidence": float(f.get("confidence", 1.0) or 1.0),
                    "label": "high" if float(f.get("confidence", 1.0) or 1.0) >= 0.8 else "medium",
                },
            })
    except Exception:
        pass

    # Vectors
    try:
        for v in vector_db.search(query, top_k=5) or []:
            if not isinstance(v, dict):
                continue
            meta = v.get("metadata") or {}
            results.append({
                "provider": "vector_db",
                "type": "vector",
                "title": str(meta.get("topic") or "vector"),
                "text": str(v.get("text") or meta.get("text") or "")[:500],
                "score": float(v.get("score", 0.0) or 0.0),
                "key": str(v.get("id") or ""),
            })
    except Exception:
        pass

    return {"results": results}


# ── Guidelines ────────────────────────────────────────────────────────


@router.get("/guidelines")
async def brain_guidelines() -> dict[str, Any]:
    """Return guidelines — { guidelines: Guideline[] }.

    Guidelines are stored as facts in the 'guideline' category; each is mapped
    into the Guideline shape ({ id, text, source, confidence, status, ... }).
    """
    try:
        facts = memory_store.list_facts("guideline") or []
    except Exception:
        facts = []
    out: list[dict[str, Any]] = []
    for f in facts:
        if not isinstance(f, dict):
            continue
        value = f.get("value")
        if isinstance(value, str):
            try:
                import json
                value = json.loads(value)
            except Exception:
                pass
        text = ""
        if isinstance(value, dict):
            text = str(value.get("text") or value.get("content") or value.get("summary") or "")
        elif value is not None:
            text = str(value)
        out.append({
            "id": str(f.get("key", f.get("fact_key", ""))),
            "text": text,
            "source": str(f.get("source") or "memory_store"),
            "confidence": float(f.get("confidence", 1.0) or 1.0),
            "status": "active",
            "count": 1,
            "createdAt": f.get("created_at") or f.get("createdAt") or "",
            "lastSeenAt": f.get("updated_at") or f.get("updatedAt") or "",
            "lastUsedAt": None,
        })
    return {"guidelines": out}


# ── Graph ─────────────────────────────────────────────────────────────


@router.get("/graph")
async def brain_graph() -> dict[str, Any]:
    """Return knowledge graph stats — GraphStats.

    Aggregates counts from memory items, facts, and vector entries into
    { stats: { counts, entityTypes, updatedAt } }.
    """
    counts = {"entities": 0, "relations": 0, "observations": 0}
    entity_types: dict[str, int] = {}
    try:
        stats = memory_store.get_stats() or {}
        counts["entities"] = int(stats.get("memory_store", 0) or 0)
        counts["observations"] = int(stats.get("facts", 0) or 0)
        entity_types["memory"] = counts["entities"]
        entity_types["fact"] = counts["observations"]
    except Exception:
        pass
    try:
        vcount = vector_db.count()
        counts["relations"] = int(vcount or 0)
        if vcount:
            entity_types["vector"] = int(vcount)
    except Exception:
        pass
    return {"stats": {"counts": counts, "entityTypes": entity_types, "updatedAt": str(int(time.time()))}}


# ── Diagnostics ───────────────────────────────────────────────────────


@router.get("/diagnostics")
async def brain_diagnostics() -> dict[str, Any]:
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
            guidelines = len(memory_store.list_facts("guideline") or [])
        except Exception:
            guidelines = 0
        try:
            facts = int(stats.get("facts", 0) or 0)
        except Exception:
            facts = 0
        prompt = context_builder.build_system_prompt()
        return {
            "injectedChars": len(prompt),
            "maxChars": 32768,
            "compacted": False,
            "guidelines": guidelines,
            "semanticFacts": facts,
            "vectorEntries": vcount,
        }
    except Exception as exc:
        return {"error": str(exc), "injectedChars": 0, "maxChars": 0, "compacted": False,
                "guidelines": 0, "semanticFacts": 0, "vectorEntries": 0}
