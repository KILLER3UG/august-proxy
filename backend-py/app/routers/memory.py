"""Memory system API routes.

Port of the memory-related Express routes from the JS backend.
"""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import memoryStore
router = APIRouter(prefix='/api/memory')

class MemorySave(BaseModel):
    key: str
    value: Any
    category: str = 'general'
    source: str = ''

class FactSave(BaseModel):
    factKey: str
    factValue: Any
    category: str = 'general'
    source: str = ''
    confidence: float = 1.0

class FactSearch(BaseModel):
    query: str = ''
    category: str = ''

class ProposalCreate(BaseModel):
    sessionId: str
    proposalType: str
    content: Any

class ProposalDecide(BaseModel):
    status: str
    decidedBy: str = ''

@router.get('/kv')
async def listMemoryKv():
    """List all memory entries."""
    return {'entries': memoryStore.list_memory()}

@router.post('/kv')
async def saveMemoryKv(body: MemorySave):
    """Save a key-value pair to memory."""
    memoryStore.save_memory(body.key, body.value)
    return {'status': 'ok'}

@router.get('/kv/{key}')
async def getMemoryKv(key: str):
    """Get a value from memory."""
    value = memoryStore.get_memory(key)
    if value is None:
        raise HTTPException(status_code=404, detail='Key not found')
    return {'key': key, 'value': value}

@router.delete('/kv/{key}')
async def deleteMemoryKv(key: str):
    """Delete a memory key."""
    if not memoryStore.delete_memory(key):
        raise HTTPException(status_code=404, detail='Key not found')
    return {'status': 'ok'}

@router.get('/search')
async def searchMemoryRoute(query: str=''):
    """Full-text search across memory."""
    if not query:
        return {'results': []}
    results = memoryStore.search_memory(query)
    return {'results': results, 'query': query, 'count': len(results)}

@router.get('/facts')
async def listFacts(category: str=''):
    """List facts, optionally filtered by category."""
    facts = memoryStore.list_facts(category)
    return {'facts': facts}

@router.post('/facts')
async def saveFactRoute(body: FactSave):
    """Save a structured fact."""
    memoryStore.save_fact(body.fact_key, body.fact_value, body.category, body.source, body.confidence)
    return {'status': 'ok'}

@router.post('/facts/search')
async def searchFactsRoute(body: FactSearch):
    """Search facts by key or value."""
    results = memoryStore.search_facts(body.query, body.category)
    return {'results': results, 'count': len(results)}

@router.get('/facts/{key}')
async def getFactRoute(key: str):
    """Get a fact by key."""
    fact = memoryStore.get_fact(key)
    if not fact:
        raise HTTPException(status_code=404, detail='Fact not found')
    return fact

@router.delete('/facts/{key}')
async def deleteFactRoute(key: str):
    """Delete a fact."""
    if not memoryStore.delete_fact(key):
        raise HTTPException(status_code=404, detail='Fact not found')
    return {'status': 'ok'}

@router.post('/proposals')
async def createProposal(body: ProposalCreate):
    """Create a proposal (plan, mutation)."""
    pid = memoryStore.save_proposal(body.session_id, body.proposal_type, body.content)
    return {'id': pid, 'status': 'pending'}

@router.get('/proposals/{proposal_id}')
async def getProposalRoute(proposalId: int):
    """Get a proposal by ID."""
    proposal = memoryStore.get_proposal(proposalId)
    if not proposal:
        raise HTTPException(status_code=404, detail='Proposal not found')
    return proposal

@router.post('/proposals/{proposal_id}/decide')
async def decideProposalRoute(proposalId: int, body: ProposalDecide):
    """Decide (approve/reject) a proposal."""
    if not memoryStore.decide_proposal(proposalId, body.status, body.decided_by):
        raise HTTPException(status_code=404, detail='Proposal not found')
    return {'status': body.status}

@router.post('/lifecycle')
async def recordLifecycleRoute(sessionId: str, eventType: str, detail: Any=None):
    """Record a lifecycle event."""
    lid = memoryStore.record_lifecycle(sessionId, eventType, detail)
    return {'id': lid}

@router.get('/lifecycle/{session_id}')
async def listLifecycleRoute(sessionId: str, eventType: str=''):
    """List lifecycle events for a session."""
    events = memoryStore.list_lifecycle(sessionId, eventType)
    return {'events': events}

@router.get('/stats')
async def memoryStats():
    """Get database statistics."""
    return memoryStore.get_stats()