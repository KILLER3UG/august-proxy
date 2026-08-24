"""Harness self-improvement API routes — list/read/decide proposals."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.models.camel_base import CamelModel
from app.services import harness_self_improve

router = APIRouter(prefix='/api/harness/proposals')


class ProposalDecision(CamelModel):
    decision: str = Field(..., description='approve | reject | dismiss')
    note: str = ''


@router.get('')
async def listProposals(status: str = ''):
    """List harness proposals, newest first (optionally filtered by status)."""
    return {
        'proposals': harness_self_improve.list_proposals(status=status),
        'openCount': len(harness_self_improve.list_proposals(status='open')),
    }


@router.get('/{pid}')
async def getProposal(pid: str):
    row = harness_self_improve.get_proposal(pid)
    if not row:
        raise HTTPException(status_code=404, detail=f'Proposal {pid!r} not found')
    return row


@router.post('/{pid}/decide')
async def decideProposal(pid: str, body: ProposalDecision):
    """Approve/reject/dismiss. Approval runs the deterministic applier."""
    try:
        return harness_self_improve.decide_proposal(pid, body.decision, body.note)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
