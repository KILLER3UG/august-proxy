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


class SkillPatch(CamelModel):
    body: str | None = None
    description: str | None = None
    trigger: str | None = None
    category: str | None = None
    disabled: bool | None = None


class SkillFileWrite(CamelModel):
    file_path: str
    content: str


@router.get('')
async def listSkills(
    q: str = Query('', description='Search query (name/description/trigger)'),
    category: str = Query('', description='Filter by category'),
):
    """Search and list available skills."""
    results = skill_service.search(query=q, category=category, enabledOnly=False)
    return {
        'skills': [
            {
                'name': s['name'],
                'description': s.get('description', ''),
                'trigger': s.get('trigger', ''),
                'category': s.get('category', 'uncategorized'),
                'enabled': s['enabled'],
                'createdBy': s.get('created_by', ''),
            }
            for s in results
        ],
        'total': len(results),
    }


@router.get('/{name}')
async def getSkill(name: str):
    """Get a single skill by name."""
    skill = skill_service.get(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    return skill


@router.post('')
async def createSkill(body: SkillCreate):
    """Create a new agent-authored skill."""
    try:
        return skill_service.createSkill(
            body.name, body.description, body.body, trigger=body.trigger, category=body.category
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch('/{name}')
async def patchSkill(name: str, body: SkillPatch):
    """Patch an existing skill (copy-on-write for bundled skills).

    M6 item 4: one file write per request — the disabled flip and any
    content fields are applied in a single ``patchSkill`` call.
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
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete('/{name}')
async def deleteSkill(name: str):
    """Delete an agent-authored skill. Refuses bundled skills."""
    try:
        return skill_service.deleteSkill(name)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
