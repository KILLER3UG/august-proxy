"""Skill system API routes — list, read, author, and maintain skills."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field

from app.models.camel_base import CamelModel
from app.services import skill_service
from app.services.skill_service import SkillValidationError

router = APIRouter(prefix='/api/skills')


class SkillCreate(CamelModel):
    name: str = Field(..., description='Lowercase, dotted/hyphenated skill name.')
    description: str = Field(..., description='One-sentence description, ≤ 60 chars.')
    body: str = Field(..., description='SKILL.md body markdown.')
    trigger: str = ''
    category: str = 'uncategorized'
    # Part 17 Phase B: a non-home workspace routes the create to the
    # project root <ws>/.aug/skills/ (project scope by choice).
    workspace: str | None = None


class SkillPatch(CamelModel):
    body: str | None = None
    description: str | None = None
    trigger: str | None = None
    category: str | None = None
    disabled: bool | None = None
    workspace: str | None = None


class SkillFileWrite(CamelModel):
    file_path: str
    content: str


@router.get('')
async def listSkills(
    q: str = Query('', description='Search query (name/description/trigger)'),
    category: str = Query('', description='Filter by category'),
    workspace: str = Query('', description='Project workspace — merges its .aug/skills root'),
):
    """Search and list available skills.

    With a ``workspace`` the project root's skills join the list (merged
    catalogue, shadowing applied) and rows carry ``scope``/``overrides``.
    """
    results = skill_service.search(
        query=q, category=category, enabledOnly=False, workspace=workspace or None
    )
    return {
        'skills': [
            {
                'name': s['name'],
                'description': s.get('description', ''),
                'trigger': s.get('trigger', ''),
                'category': s.get('category', 'uncategorized'),
                'enabled': s['enabled'],
                'createdBy': s.get('created_by', ''),
                'scope': s.get('scope', ''),
                'overrides': s.get('overrides', ''),
            }
            for s in results
        ],
        'total': len(results),
    }


@router.get('/{name}')
async def getSkill(name: str, workspace: str = Query('')):
    """Get a single skill by name (project > agent > bundled precedence)."""
    skill = skill_service.get(name, workspace or None)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    return skill


@router.post('')
async def createSkill(body: SkillCreate):
    """Create a new agent-authored skill (project root when workspace set)."""
    try:
        return skill_service.createSkill(
            body.name, body.description, body.body,
            trigger=body.trigger, category=body.category, workspace=body.workspace,
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch('/{name}')
async def patchSkill(name: str, body: SkillPatch):
    """Patch an existing skill (copy-on-write for bundled skills).

    M6 item 4: one file write per request — the disabled flip and any
    content fields are applied in a single ``patchSkill`` call.

    Part 17 Phase B: with a workspace, a project entry patches in place;
    a global/bundled name copy-on-writes into the project root as an
    override.
    """
    try:
        enabled = None if body.disabled is None else (not body.disabled)
        return skill_service.patchSkill(
            name,
            body=body.body,
            description=body.description,
            trigger=body.trigger,
            category=body.category,
            enabled=enabled,
            workspace=body.workspace,
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete('/{name}')
async def deleteSkill(name: str, workspace: str = Query('')):
    """Delete a skill. Refuses bundled skills.

    Part 17 Phase B: with a workspace, only the project override is
    deleted — the shadowed global skill stays intact.
    """
    try:
        return skill_service.deleteSkill(name, workspace or None)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
