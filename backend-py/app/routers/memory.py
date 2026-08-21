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


class AutoMemoryCreate(CamelModel):
    """Auto-memory create body. Internals are snake_case; JSON stays camelCase."""

    key: str
    content: object
    category: str = 'auto'
    importance: float = 0.5
    source: str = 'auto'


class AutoMemoryUpdate(CamelModel):
    """Auto-memory update body — all fields optional (partial update)."""

    content: object | None = None
    category: str | None = None
    importance: float | None = None
    source: str | None = None
    pinned: bool | None = None


class MemoryReviewRequest(CamelModel):
    """Ask the selected chat model to review memories."""

    model: str = ''
    origin: str = 'all'
    folder_id: str = ''
    session_id: str = ''


class MemoryReviewApply(CamelModel):
    """Apply accepted review actions."""

    actions: list[dict[str, object]]
    session_id: str = ''


class ProposalCreate(CamelModel):
    """Proposal create body. Internals are snake_case; JSON stays camelCase."""

    session_id: str
    proposal_type: str
    content: object


class ProposalDecide(CamelModel):
    """Proposal decide body. Internals are snake_case; JSON stays camelCase."""

    status: str
    decided_by: str = ''


@router.post('/review')
async def reviewMemoriesRoute(body: MemoryReviewRequest):
    """Use the selected model to suggest improve / remove / enhance. Does not apply.

    Pass origin/folder_id to scope the review to Recalled vs By Project.
    When session_id is given, records the review marker so the per-turn
    <review_required> nag clears until the next interval.
    """
    from app.services.memory.memory_review import run_memory_review

    result = await run_memory_review(body.model, origin=body.origin, folder_id=body.folder_id, session_id=body.session_id)
    if body.session_id:
        try:
            from app.services.workbench.sessions import mark_memory_reviewed

            mark_memory_reviewed(body.session_id)
        except Exception:
            pass
    return result


@router.get('/auto/review-candidates')
async def listReviewCandidatesRoute(
    origin: str = 'recalled',
    folder_id: str = '',
    session_id: str = '',
    limit: int = 30,
):
    """Low-value candidates for bulk keep/remove review (stale, low confidence, expiring).

    Powers the model-checked curation bar: model can keep what is important and
    remove what is not. Works for recalled and by-project scopes.
    """
    from app.services.memory.auto_memory import list_review_candidates

    items = list_review_candidates(origin=origin, folder_id=folder_id, session_id=session_id, limit=limit)
    return {'items': items, 'origin': origin, 'folderId': folder_id, 'count': len(items)}


class BulkMemoryAction(CamelModel):
    ids: list[int]
    action: str
    rewrite: str = ''


@router.post('/auto/bulk')
async def bulkMemoryActionRoute(body: BulkMemoryAction):
    """Bulk keep / remove / pin / enhance for reviewed batches."""
    from app.services.memory.auto_memory import delete_auto_memory, get_auto_memory, update_auto_memory

    action = (body.action or '').strip().lower()
    if action not in ('keep', 'remove', 'pin', 'unpin', 'delete'):
        raise HTTPException(status_code=400, detail='Unknown action: use keep | remove | pin | unpin')
    ids = [int(x) for x in (body.ids or []) if int(x) > 0][:50]
    if not ids:
        raise HTTPException(status_code=400, detail='ids is required')
    applied = 0
    for mid in ids:
        if action in ('remove', 'delete'):
            if delete_auto_memory(mid):
                applied += 1
        elif action == 'keep':
            mem = get_auto_memory(mid)
            if mem:
                imp = float(mem.get('importance') or 0.5)
                update_auto_memory(mid, importance=min(1.0, max(imp, 0.85)))
                applied += 1
        elif action == 'pin':
            if update_auto_memory(mid, pinned=True):
                applied += 1
        elif action == 'unpin':
            # Unpin requires clearing pin; route through direct SQL via update path
            from app.services.memory_store import _conn

            c = _conn()
            c.execute('UPDATE auto_memories SET pinned = 0, updated_at = datetime("now") WHERE id = ?', (mid,))
            c.commit()
            applied += 1
    return {'status': 'ok', 'action': action, 'applied': applied, 'total': len(ids)}


@router.post('/review/apply')
async def applyMemoryReviewRoute(body: MemoryReviewApply):
    """Apply user-accepted memory review actions."""
    from app.services.memory.memory_review import apply_review_actions

    stats = apply_review_actions(list(body.actions or []))
    if body.session_id:
        try:
            from app.services.workbench.sessions import mark_memory_reviewed

            mark_memory_reviewed(body.session_id)
        except Exception:
            pass
    return {'status': 'ok', **stats}


@router.get('/export')
async def exportMemoryRoute(folder_id: str = "", origin: str = "all"):
    """Derived markdown view of memory (global or per-project). SQLite is SoT."""
    from app.services.memory.markdown_export import export_memory_markdown
    path = export_memory_markdown(folder_id=folder_id, origin=origin)
    if not path or not path.exists():
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse("# Memory export\n\n_(no data yet)_\n", media_type="text/markdown")
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(path.read_text(encoding="utf-8"), media_type="text/markdown")


@router.get('/prompt/export')
async def exportPromptRoute(sessionId: str = ""):
    """Derived markdown view of the assembled system prompt for a session."""
    import os
    from pathlib import Path

    from fastapi.responses import PlainTextResponse

    from app.lib.paths import dataPath
    # Path-traversal guard: session ids are generated slugs ("wb_..."). Reject
    # anything with separators/dot-segments before it touches the filesystem.
    if sessionId and (
        "/" in sessionId
        or "\\" in sessionId
        or ".." in sessionId
        or os.path.basename(sessionId) != sessionId
    ):
        sessionId = ""
    if sessionId:
        candidates = [Path(str(dataPath())) / ".aug" / "system-prompt" / f"{sessionId}.md", Path(str(dataPath())) / "system-prompt.md"]
        for cand in candidates:
            if cand.exists():
                return PlainTextResponse(cand.read_text(encoding="utf-8"), media_type="text/markdown")
    global_path = Path(str(dataPath())) / "system-prompt.md"
    if global_path.exists():
        return PlainTextResponse(global_path.read_text(encoding="utf-8"), media_type="text/markdown")
    return PlainTextResponse("# System Prompt\n\n_(no snapshot yet \u2014 send a message to generate)_\n", media_type="text/markdown")


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


@router.get('/auto')
async def listAutoMemoriesRoute(
    category: str = '',
    origin: str = 'all',
    include_telemetry: bool | None = None,
    folder_id: str = '',
    session_id: str = '',
):
    """List auto-memories, grouped by category.

    ``origin``: ``all`` | ``recalled`` | ``added``.
    Settings UIs pass ``recalled`` / ``added``; tools use default ``all``.
    Telemetry keys (``tool_failure_*``) are hidden for ``origin=recalled`` unless
    ``include_telemetry=true``.
    ``folder_id`` filters to memories from sessions in that folder (project
    memories); ``session_id`` filters to one session.
    """
    from app.services.memory.auto_memory import list_all_auto_memories

    if include_telemetry is None:
        tele = origin != 'recalled'
    else:
        tele = include_telemetry
    items = list_all_auto_memories(
        category, origin=origin, include_telemetry=tele, folder_id=folder_id, session_id=session_id
    )
    grouped: dict[str, list[object]] = {}
    for item in items:
        cat = str(item.get('category') or 'auto')
        grouped.setdefault(cat, []).append(item)
    return {'items': items, 'grouped': grouped, 'origin': origin}


@router.post('/auto')
async def createAutoMemoryRoute(body: AutoMemoryCreate):
    """Create (or upsert-by-key) an auto-memory entry."""
    from app.services.memory.auto_memory import create_auto_memory

    src = (body.source or 'auto').strip().lower()
    if src not in ('user', 'auto', 'agent'):
        src = 'auto'
    importance = body.importance
    if src == 'user' and importance < 0.8:
        importance = 0.85
    memoryId = create_auto_memory(
        body.key,
        cast(JsonValue, body.content),
        body.category,
        importance,
        source=src,
    )
    if src == 'user' and memoryId:
        from app.services.memory.auto_memory import update_auto_memory

        update_auto_memory(int(memoryId), pinned=True)
    return {'id': memoryId, 'status': 'ok', 'source': src, 'pinned': src == 'user'}


@router.get('/auto/{memoryId}')
async def getAutoMemoryRoute(memoryId: int):
    """Get a single auto-memory entry by id."""
    from app.services.memory.auto_memory import get_auto_memory

    item = get_auto_memory(memoryId)
    if not item:
        raise HTTPException(status_code=404, detail='Memory not found')
    return item


@router.put('/auto/{memoryId}')
async def updateAutoMemoryRoute(memoryId: int, body: AutoMemoryUpdate):
    """Update an auto-memory entry's content/category/importance/source."""
    from app.services.memory.auto_memory import update_auto_memory

    ok = update_auto_memory(
        memoryId,
        content=cast(JsonValue, body.content) if body.content is not None else None,
        category=body.category,
        importance=body.importance,
        source=body.source,
        pinned=body.pinned,
    )
    if not ok:
        raise HTTPException(status_code=404, detail='Memory not found')
    return {'status': 'ok'}


@router.delete('/auto/{memoryId}')
async def deleteAutoMemoryRoute(memoryId: int):
    """Delete an auto-memory entry by id."""
    from app.services.memory.auto_memory import delete_auto_memory

    if not delete_auto_memory(memoryId):
        raise HTTPException(status_code=404, detail='Memory not found')
    return {'status': 'ok'}


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


@router.get('/proposals')
async def listProposalsRoute(sessionId: str = '', status: str = '', limit: int = 50):
    """List proposals (optionally by session and/or status)."""
    proposals = memory_store.list_proposals(sessionId, status)
    return {'results': proposals[-max(1, min(limit, 200)) :]}


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
