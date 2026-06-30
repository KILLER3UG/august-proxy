"""
/api/august routes — alias management action endpoint + config audit log.

These endpoints match the shapes the existing frontend already calls
(``manageAugustAliases`` → ``POST /api/august/aliases/manage`` and the
audit viewer → ``GET /api/august/audit``), so the UI stops 404'ing against
the Python backend.
"""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import aliasService
from app.services.memoryStore import listConfigAudit
router = APIRouter(prefix='/api/august')

class AliasManageItem(BaseModel):
    alias: str
    targetModel: str = ''
    targetProvider: str = ''
    displayAlias: str = ''

class AliasManageRequest(BaseModel):
    action: str
    alias: str | None = None
    targetModel: str | None = None
    targetProvider: str | None = None
    displayAlias: str | None = None
    items: list[AliasManageItem] | None = None

@router.post('/aliases/manage')
async def manageAliases(body: AliasManageRequest):
    """Unified alias action endpoint used by the frontend's AliasesTab."""
    action = (body.action or '').lower()
    if action == 'list':
        return {'aliases': aliasService.list_aliases()}
    if action == 'upsert':
        alias = (body.alias or '').strip()
        if not alias:
            raise HTTPException(400, detail={'code': 'bad_request', 'message': 'alias is required'})
        try:
            entry = aliasService.create_alias(alias=alias, target_model=body.target_model or '', target_provider=body.target_provider or '', display_alias=body.display_alias or '', actor='ui')
        except ValueError as exc:
            raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})
        return {'alias': entry}
    if action == 'delete':
        if not body.alias:
            raise HTTPException(400, detail={'code': 'bad_request', 'message': 'alias is required'})
        removed = aliasService.delete_alias(body.alias, actor='ui')
        return {'deleted': removed, 'alias': body.alias}
    raise HTTPException(400, detail={'code': 'bad_request', 'message': f"Unknown action '{action}'"})

@router.get('/audit')
async def auditLog(category: str='', limit: int=200) -> dict[str, Any]:
    """Return config-change audit entries shaped for the frontend AuditEntry view."""
    limit = max(1, min(limit, 1000))
    rows = listConfigAudit(category=category, limit=limit)
    entries = []
    for r in rows:
        entries.append({'id': r.get('id'), 'category': r.get('category'), 'action': r.get('action'), 'actor': r.get('actor', ''), 'before': r.get('before'), 'after': r.get('after'), 'createdAt': r.get('createdAt')})
    return {'entries': entries, 'count': len(entries)}

@router.get('/rollback')
async def rollbackList() -> dict[str, Any]:
    """Rollback is out of scope for this pass — return an empty list."""
    return {'entries': [], 'count': 0}