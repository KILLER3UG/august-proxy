"""Harness self-improvement API routes — list/read/decide proposals."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.models.camel_base import CamelModel
from app.services import harness_self_improve

router = APIRouter(prefix='/api/harness/proposals')


class ProposalDecision(CamelModel):
    decision: str = Field(..., description='approve | reject | dismiss | reopen')
    note: str = ''


@router.get('')
async def listProposals(status: str = '', origin: str = ''):
    """List harness proposals, newest first (optionally filtered by status).

    Part 16 Phase D step 3: ``origin`` groups self-improvement drafts
    (payload.origin: human | distilled | amended) so reviewable drafts are
    recognizable at a glance."""
    proposals = harness_self_improve.list_proposals(status=status)
    if origin:
        proposals = [
            p
            for p in proposals
            if isinstance(p.get('payload'), dict)
            and str(p['payload'].get('origin', '')) == origin
        ]
    return {
        'proposals': proposals,
        'openCount': len(harness_self_improve.list_proposals(status='open')),
    }


@router.get('/inbox/count')
async def inboxCount():
    """Open review counts across every review queue — the settings-rail
    badge. Deliberately cheap: counts only (file-name scan + one SQL count),
    no payloads, safe to poll on an interval.

    The badge exists because the queues were invisible: a proposal filed
    Sep 4 sat unreviewed for a week while its only surfacing sat behind
    Settings (tier 'hidden')."""
    from app.services import memory_store

    harness = len(harness_self_improve.list_proposals(status='open'))
    memory = 0
    try:
        memory = len(memory_store.list_proposals('consolidation', status='pending'))
    except Exception:
        pass
    return {'harness': harness, 'memory': memory, 'total': harness + memory}


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


@router.post('/promotion/run')
async def runPromotionPass(force: bool = False):
    """Run the cross-project promotion judge now.

    Files ``promote`` proposals into this same review queue (≥2-project
    recurrence bar, sensitive denylist, never mutates project files). Runs
    under Part 16's ``skillLearning`` config — ``off`` skips unless
    ``force``.
    """
    from app.services.harness_promote import run_promotion_pass

    summary = run_promotion_pass(force=force)
    if not summary.get('ran'):
        raise HTTPException(status_code=409, detail=summary.get('reason') or 'pass skipped')
    return summary


@router.post('/promotion/demote-scan')
async def runDemoteScan():
    """Part 17 Phase E measurement: demote suggestions for promoted items
    that never triggered outside their origin project — observation-kind
    proposals in this same queue, never deletions."""
    from app.services.harness_promote import suggest_demotions

    return {'suggestions': suggest_demotions()}
