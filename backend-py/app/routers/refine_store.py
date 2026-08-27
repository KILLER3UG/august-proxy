"""T15 versioned refine store API — entries, rollback, refine passes, config."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.models.camel_base import CamelModel
from app.services import refine_store

router = APIRouter(prefix='/api/harness/refine')


class EntryCreate(CamelModel):
    kind: str = Field(..., description='prompt_note | memory | skill | subagent')
    scope: str = Field('global', description='global | local')
    session_id: str = ''
    content: dict = Field(..., description='kind-specific content object')
    rationale: str
    expected_outcome: str


class EntryUpdate(CamelModel):
    content: dict
    rationale: str
    expected_outcome: str


class EntryDelete(CamelModel):
    rationale: str
    expected_outcome: str


class RollbackBody(CamelModel):
    rationale: str = ''


class RefinePassBody(CamelModel):
    session_id: str = ''
    evidence: str = Field(..., description='harness evidence the pass refines against')


class RefineConfigBody(CamelModel):
    auto_refine: bool = False
    producer_model: str = ''
    review_model: str = ''


@router.get('/entries')
async def listEntries(
    scope: str = '', sessionId: str = '', kind: str = '', includeDeleted: bool = False
):
    """Active refine-store entries (optionally incl. deleted), local first."""
    return {
        'entries': refine_store.list_entries(
            scope=scope,
            session_id=sessionId,
            kind=kind,
            include_deleted=includeDeleted,
        )
    }


@router.get('/ledger')
async def getLedger(limit: int = 20):
    """The append-only refine journal."""
    return {'ledger': refine_store.read_ledger(limit=max(1, min(limit, 200)))}


@router.get('/config')
async def getConfig():
    return {'refineConfig': refine_store.get_refine_config()}


@router.put('/config')
async def putConfig(body: RefineConfigBody):
    result = refine_store.set_refine_config(body.model_dump(by_alias=True))
    if not result.get('ok'):
        raise HTTPException(status_code=500, detail=str(result.get('error') or 'Save failed'))
    return result


@router.post('/entries')
async def createEntry(body: EntryCreate):
    """User path: create one entry directly (rationale + outcome required)."""
    try:
        entry = refine_store.create_entry(
            kind=body.kind,
            scope=body.scope,
            content=body.content,
            rationale=body.rationale,
            expected_outcome=body.expected_outcome,
            session_id=body.session_id,
            actor='user',
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {'entry': entry}


@router.get('/entries/{entry_id}')
async def getEntry(entry_id: str):
    """Full entry including its version history."""
    entry = refine_store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f'Entry {entry_id!r} not found')
    return {'entry': entry, 'active': refine_store.is_active(entry)}


@router.put('/entries/{entry_id}')
async def updateEntry(entry_id: str, body: EntryUpdate):
    try:
        entry = refine_store.update_entry(
            entry_id, body.content, body.rationale, body.expected_outcome, actor='user'
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {'entry': entry}


@router.delete('/entries/{entry_id}')
async def deleteEntry(entry_id: str, body: EntryDelete):
    try:
        entry = refine_store.delete_entry(
            entry_id, body.rationale, body.expected_outcome, actor='user'
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {'entry': entry}


@router.post('/entries/{entry_id}/rollback')
async def rollbackEntry(entry_id: str, body: RollbackBody):
    """Undo the newest version of one entry (append-only — nothing is lost)."""
    try:
        entry = refine_store.rollback_entry(entry_id, actor='user', rationale=body.rationale)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {'entry': entry, 'active': refine_store.is_active(entry)}


@router.post('/pass')
async def runPass(body: RefinePassBody):
    """Manual refine pass: one model call → JSON edits over the store."""
    if not body.evidence.strip():
        raise HTTPException(status_code=400, detail='evidence is required')
    result = await refine_store.run_refine_pass(
        session_id=body.session_id, evidence=body.evidence
    )
    if result.get('error'):
        raise HTTPException(status_code=502, detail=str(result['error']))
    return result


@router.post('/auto')
async def runAuto(body: RefinePassBody):
    """Auto-refine: pass + independent cheap reviewer gate (discard-default)."""
    return await refine_store.auto_refine(session_id=body.session_id, evidence=body.evidence)
