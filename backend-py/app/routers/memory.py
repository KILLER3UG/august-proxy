"""Memory system API routes.

Port of the memory-related Express routes from the JS backend.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import memory_store

router = APIRouter(prefix="/api/memory")


class MemorySave(BaseModel):
    key: str
    value: Any
    category: str = "general"
    source: str = ""


class FactSave(BaseModel):
    fact_key: str
    fact_value: Any
    category: str = "general"
    source: str = ""
    confidence: float = 1.0


class FactSearch(BaseModel):
    query: str = ""
    category: str = ""


class ProposalCreate(BaseModel):
    session_id: str
    proposal_type: str
    content: Any


class ProposalDecide(BaseModel):
    status: str
    decided_by: str = ""


# ── Memory KV ────────────────────────────────────────────────────────


@router.get("/kv")
async def list_memory_kv():
    """List all memory entries."""
    return {"entries": memory_store.list_memory()}


@router.post("/kv")
async def save_memory_kv(body: MemorySave):
    """Save a key-value pair to memory."""
    memory_store.save_memory(body.key, body.value)
    return {"status": "ok"}


@router.get("/kv/{key}")
async def get_memory_kv(key: str):
    """Get a value from memory."""
    value = memory_store.get_memory(key)
    if value is None:
        raise HTTPException(status_code=404, detail="Key not found")
    return {"key": key, "value": value}


@router.delete("/kv/{key}")
async def delete_memory_kv(key: str):
    """Delete a memory key."""
    if not memory_store.delete_memory(key):
        raise HTTPException(status_code=404, detail="Key not found")
    return {"status": "ok"}


@router.get("/search")
async def search_memory_route(query: str = ""):
    """Full-text search across memory."""
    if not query:
        return {"results": []}
    results = memory_store.search_memory(query)
    return {"results": results, "query": query, "count": len(results)}


# ── Facts ────────────────────────────────────────────────────────────


@router.get("/facts")
async def list_facts(category: str = ""):
    """List facts, optionally filtered by category."""
    facts = memory_store.list_facts(category)
    return {"facts": facts}


@router.post("/facts")
async def save_fact_route(body: FactSave):
    """Save a structured fact."""
    memory_store.save_fact(body.fact_key, body.fact_value, body.category, body.source, body.confidence)
    return {"status": "ok"}


@router.post("/facts/search")
async def search_facts_route(body: FactSearch):
    """Search facts by key or value."""
    results = memory_store.search_facts(body.query, body.category)
    return {"results": results, "count": len(results)}


@router.get("/facts/{key}")
async def get_fact_route(key: str):
    """Get a fact by key."""
    fact = memory_store.get_fact(key)
    if not fact:
        raise HTTPException(status_code=404, detail="Fact not found")
    return fact


@router.delete("/facts/{key}")
async def delete_fact_route(key: str):
    """Delete a fact."""
    if not memory_store.delete_fact(key):
        raise HTTPException(status_code=404, detail="Fact not found")
    return {"status": "ok"}


# ── Proposals ────────────────────────────────────────────────────────


@router.post("/proposals")
async def create_proposal(body: ProposalCreate):
    """Create a proposal (plan, mutation)."""
    pid = memory_store.save_proposal(body.session_id, body.proposal_type, body.content)
    return {"id": pid, "status": "pending"}


@router.get("/proposals/{proposal_id}")
async def get_proposal_route(proposal_id: int):
    """Get a proposal by ID."""
    proposal = memory_store.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return proposal


@router.post("/proposals/{proposal_id}/decide")
async def decide_proposal_route(proposal_id: int, body: ProposalDecide):
    """Decide (approve/reject) a proposal."""
    if not memory_store.decide_proposal(proposal_id, body.status, body.decided_by):
        raise HTTPException(status_code=404, detail="Proposal not found")
    return {"status": body.status}


# ── Lifecycle ────────────────────────────────────────────────────────


@router.post("/lifecycle")
async def record_lifecycle_route(session_id: str, event_type: str, detail: Any = None):
    """Record a lifecycle event."""
    lid = memory_store.record_lifecycle(session_id, event_type, detail)
    return {"id": lid}


@router.get("/lifecycle/{session_id}")
async def list_lifecycle_route(session_id: str, event_type: str = ""):
    """List lifecycle events for a session."""
    events = memory_store.list_lifecycle(session_id, event_type)
    return {"events": events}


# ── Stats ────────────────────────────────────────────────────────────


@router.get("/stats")
async def memory_stats():
    """Get database statistics."""
    return memory_store.get_stats()
