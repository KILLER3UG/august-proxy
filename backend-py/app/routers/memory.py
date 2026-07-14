"""Memory system API routes.

Port of the memory-related Express routes from the JS backend.

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase.
"""

from __future__ import annotations
from typing import cast
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services import memory_store
from app.type_aliases import JsonValue

router = APIRouter(prefix='/api/memory')


class MemorySave(CamelModel):
    """KV save body. Internals are snake_case; JSON stays camelCase."""

    key: str
    value: object
    category: str = 'general'
    source: str = ''


class FactSave(CamelModel):
    """Fact save body. Internals are snake_case; JSON stays camelCase."""

    fact_key: str
    fact_value: object
    category: str = 'general'
    source: str = ''
    confidence: float = 1.0


class FactSearch(CamelModel):
    """Fact search body. Internals are snake_case; JSON stays camelCase."""

    query: str = ''
    category: str = ''


class ProposalCreate(CamelModel):
    """Proposal create body. Internals are snake_case; JSON stays camelCase."""

    session_id: str
    proposal_type: str
    content: object


class ProposalDecide(CamelModel):
    """Proposal decide body. Internals are snake_case; JSON stays camelCase."""

    status: str
    decided_by: str = ''


@router.get('/kv')
async def listMemoryKv():
    """List all memory entries."""
    return {'entries': memory_store.list_memory()}


@router.post('/kv')
async def saveMemoryKv(body: MemorySave):
    """Save a key-value pair to memory."""
    memory_store.save_memory(body.key, cast(JsonValue, body.value))
    return {'status': 'ok'}


@router.get('/kv/{key}')
async def getMemoryKv(key: str):
    """Get a value from memory."""
    value = memory_store.get_memory(key)
    if value is None:
        raise HTTPException(status_code=404, detail='Key not found')
    return {'key': key, 'value': value}


@router.delete('/kv/{key}')
async def deleteMemoryKv(key: str):
    """Delete a memory key."""
    if not memory_store.delete_memory(key):
        raise HTTPException(status_code=404, detail='Key not found')
    return {'status': 'ok'}


@router.get('/search')
async def searchMemoryRoute(query: str = ''):
    """Full-text search across memory."""
    if not query:
        return {'results': []}
    results = memory_store.search_memory(query)
    return {'results': results, 'query': query, 'count': len(results)}


@router.get('/facts')
async def list_facts(category: str = ''):
    """List facts, optionally filtered by category."""
    facts = memory_store.list_facts(category)
    return {'facts': facts}


@router.post('/facts')
async def saveFactRoute(body: FactSave):
    """Save a structured fact."""
    memory_store.save_fact(
        body.fact_key,
        cast(JsonValue, body.fact_value),
        body.category,
        body.source,
        body.confidence,
    )
    return {'status': 'ok'}


@router.post('/facts/search')
async def searchFactsRoute(body: FactSearch):
    """Search facts by key or value."""
    results = memory_store.search_facts(body.query, body.category)
    return {'results': results, 'count': len(results)}


@router.get('/facts/{key}')
async def getFactRoute(key: str):
    """Get a fact by key."""
    fact = memory_store.get_fact(key)
    if not fact:
        raise HTTPException(status_code=404, detail='Fact not found')
    return fact


@router.delete('/facts/{key}')
async def deleteFactRoute(key: str):
    """Delete a fact."""
    if not memory_store.delete_fact(key):
        raise HTTPException(status_code=404, detail='Fact not found')
    return {'status': 'ok'}


@router.post('/proposals')
async def createProposal(body: ProposalCreate):
    """Create a proposal (plan, mutation)."""
    pid = memory_store.save_proposal(
        body.session_id,
        body.proposal_type,
        cast(JsonValue, body.content),
    )
    return {'id': pid, 'status': 'pending'}


@router.get('/proposals/{proposalId}')
async def getProposalRoute(proposalId: int):
    """Get a proposal by ID."""
    proposal = memory_store.get_proposal(proposalId)
    if not proposal:
        raise HTTPException(status_code=404, detail='Proposal not found')
    return proposal


@router.post('/proposals/{proposalId}/decide')
async def decideProposalRoute(proposalId: int, body: ProposalDecide):
    """Decide (approve/reject) a proposal."""
    if not memory_store.decide_proposal(proposalId, body.status, body.decided_by):
        raise HTTPException(status_code=404, detail='Proposal not found')
    return {'status': body.status}


@router.post('/lifecycle')
async def recordLifecycleRoute(sessionId: str, eventType: str, detail: object = None):
    """Record a lifecycle event."""
    lid = memory_store.record_lifecycle(sessionId, eventType, cast(JsonValue, detail))
    return {'id': lid}


@router.get('/lifecycle/{sessionId}')
async def listLifecycleRoute(sessionId: str, eventType: str = ''):
    """List lifecycle events for a session."""
    events = memory_store.list_lifecycle(sessionId, eventType)
    return {'events': events}


@router.get('/stats')
async def memoryStats():
    """Get database statistics."""
    return memory_store.get_stats()
