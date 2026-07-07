"""Skill system API routes — list, read, author, and maintain skills."""
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from app.services import skillService
from app.services.skillService import SkillValidationError
router = APIRouter(prefix='/api/skills')

class SkillCreate(BaseModel):
    name: str = Field(..., description='Lowercase, dotted/hyphenated skill name.')
    description: str = Field(..., description='One-sentence description, ≤ 60 chars.')
    body: str = Field(..., description='SKILL.md body markdown.')
    trigger: str = ''
    category: str = 'uncategorized'

class SkillPatch(BaseModel):
    body: str | None = None
    description: str | None = None
    trigger: str | None = None
    category: str | None = None

class SkillFileWrite(BaseModel):
    filePath: str
    content: str

@router.get('')
async def listSkills(q: str=Query('', description='Search query (name/description/trigger)'), category: str=Query('', description='Filter by category')):
    """Search and list available skills."""
    results = skillService.search(query=q, category=category, enabledOnly=False)
    return {'skills': [{'name': s['name'], 'description': s.get('description', ''), 'trigger': s.get('trigger', ''), 'category': s.get('category', 'uncategorized'), 'enabled': s['enabled'], 'createdBy': s.get('created_by', '')} for s in results], 'total': len(results)}

@router.get('/{name}')
async def getSkill(name: str):
    """Get a single skill by name."""
    skill = skillService.get(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    return skill

@router.post('')
async def createSkill(body: SkillCreate):
    """Create a new agent-authored skill."""
    try:
        return skillService.createSkill(body.name, body.description, body.body, trigger=body.trigger, category=body.category)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.patch('/{name}')
async def patchSkill(name: str, body: SkillPatch):
    """Patch an existing skill (copy-on-write for bundled skills)."""
    try:
        return skillService.patchSkill(name, body=body.body, description=body.description, trigger=body.trigger, category=body.category)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.delete('/{name}')
async def deleteSkill(name: str):
    """Delete an agent-authored skill. Refuses bundled skills."""
    try:
        return skillService.deleteSkill(name)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.post('/{name}/files')
async def writeSkillFile(name: str, body: SkillFileWrite):
    """Write a support file (scripts/, references/, templates/) into a skill."""
    try:
        return skillService.write_skill_file(name, body.file_path, body.content)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.delete('/{name}/files')
async def deleteSkillFile(name: str, filePath: str=Query(..., description='Relative path within the skill dir')):
    """Remove a support file from a skill dir."""
    try:
        return skillService.remove_skill_file(name, filePath)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))