"""Memory system API routes.

Port of the memory-related Express routes from the JS backend.
"""

from __future__ import annotations
from typing import cast
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import memory_store
from app.typeAliases import JsonValue

router = APIRouter(prefix='/api/memory')


class MemorySave(BaseModel):
    key: str
    value: object
    category: str = 'general'
    source: str = ''


class FactSave(BaseModel):
    factKey: str
    factValue: object
    category: str = 'general'
    source: str = ''
    confidence: float = 1.0


class FactSearch(BaseModel):
    query: str = ''
    category: str = ''


class ProposalCreate(BaseModel):
    sessionId: str
    proposalType: str
    content: object


class ProposalDecide(BaseModel):
    status: str
    decidedBy: str = ''


@router.get('/kv')
async def listMemoryKv():
    """List all memory entries."""
    return {'entries': memory_store.listMemory()}


@router.post('/kv')
async def saveMemoryKv(body: MemorySave):
    """Save a key-value pair to memory."""
    memory_store.saveMemory(body.key, cast(JsonValue, body.value))
    return {'status': 'ok'}


@router.get('/kv/{key}')
async def getMemoryKv(key: str):
    """Get a value from memory."""
    value = memory_store.getMemory(key)
    if value is None:
        raise HTTPException(status_code=404, detail='Key not found')
    return {'key': key, 'value': value}


@router.delete('/kv/{key}')
async def deleteMemoryKv(key: str):
    """Delete a memory key."""
    if not memory_store.deleteMemory(key):
        raise HTTPException(status_code=404, detail='Key not found')
    return {'status': 'ok'}


@router.get('/search')
async def searchMemoryRoute(query: str = ''):
    """Full-text search across memory."""
    if not query:
        return {'results': []}
    results = memory_store.searchMemory(query)
    return {'results': results, 'query': query, 'count': len(results)}


@router.get('/facts')
async def listFacts(category: str = ''):
    """List facts, optionally filtered by category."""
    facts = memory_store.listFacts(category)
    return {'facts': facts}


@router.post('/facts')
async def saveFactRoute(body: FactSave):
    """Save a structured fact."""
    memory_store.saveFact(body.factKey, cast(JsonValue, body.factValue), body.category, body.source, body.confidence)
    return {'status': 'ok'}


@router.post('/facts/search')
async def searchFactsRoute(body: FactSearch):
    """Search facts by key or value."""
    results = memory_store.searchFacts(body.query, body.category)
    return {'results': results, 'count': len(results)}


@router.get('/facts/{key}')
async def getFactRoute(key: str):
    """Get a fact by key."""
    fact = memory_store.getFact(key)
    if not fact:
        raise HTTPException(status_code=404, detail='Fact not found')
    return fact


@router.delete('/facts/{key}')
async def deleteFactRoute(key: str):
    """Delete a fact."""
    if not memory_store.deleteFact(key):
        raise HTTPException(status_code=404, detail='Fact not found')
    return {'status': 'ok'}


@router.post('/proposals')
async def createProposal(body: ProposalCreate):
    """Create a proposal (plan, mutation)."""
    pid = memory_store.saveProposal(body.sessionId, body.proposalType, cast(JsonValue, body.content))
    return {'id': pid, 'status': 'pending'}


@router.get('/proposals/{proposalId}')
async def getProposalRoute(proposalId: int):
    """Get a proposal by ID."""
    proposal = memory_store.getProposal(proposalId)
    if not proposal:
        raise HTTPException(status_code=404, detail='Proposal not found')
    return proposal


@router.post('/proposals/{proposalId}/decide')
async def decideProposalRoute(proposalId: int, body: ProposalDecide):
    """Decide (approve/reject) a proposal."""
    if not memory_store.decideProposal(proposalId, body.status, body.decidedBy):
        raise HTTPException(status_code=404, detail='Proposal not found')
    return {'status': body.status}


@router.post('/lifecycle')
async def recordLifecycleRoute(sessionId: str, eventType: str, detail: object = None):
    """Record a lifecycle event."""
    lid = memory_store.recordLifecycle(sessionId, eventType, cast(JsonValue, detail))
    return {'id': lid}


@router.get('/lifecycle/{sessionId}')
async def listLifecycleRoute(sessionId: str, eventType: str = ''):
    """List lifecycle events for a session."""
    events = memory_store.listLifecycle(sessionId, eventType)
    return {'events': events}


@router.get('/stats')
async def memoryStats():
    """Get database statistics."""
    return memory_store.getStats()
