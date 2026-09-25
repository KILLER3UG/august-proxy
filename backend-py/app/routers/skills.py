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
    # A non-home workspace routes the create to the
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


def _usage_fields(skill_name: str) -> dict[str, object]:
    """``usageCount``/``lastUsed`` for a response row, read through the one
    sidecar resolver. A skill nobody has triggered reads as 0/'' rather than
    being omitted, so the UI never has to guess which of "unused" and "the
    server forgot to look" it is rendering.
    """
    usage = skill_service.read_skill_usage(skill_name)
    count = usage.get('count')
    last = usage.get('lastUsed')
    return {
        'usageCount': count if isinstance(count, int) else 0,
        'lastUsed': last if isinstance(last, str) else '',
    }


def _lineage_fields(skill: dict[str, object]) -> dict[str, object]:
    """Provenance an approved learning proposal writes into SKILL.md.

    ``origin`` / ``learned_from`` / ``version`` / ``status`` / ``supersedes``
    are not parsed fields — they arrive in the parse's unrecognized-key bag,
    which is why they need naming here. Both the list and the detail row must
    spread this one helper: each endpoint rebuilds its payload field by field,
    so a key added to one and not the other silently vanishes on that read."""
    raw = skill.get('meta')
    meta = raw if isinstance(raw, dict) else {}
    # SKILL.md values are always strings, and ``as_int`` rejects a string on
    # purpose — running it through here read every learned skill as version 1.
    digits = str(meta.get('version') or '').strip()
    return {
        'supersedes': str(meta.get('supersedes') or '').strip(),
        'origin': str(meta.get('origin') or '').strip(),
        'status': str(meta.get('status') or '').strip(),
        'version': int(digits) if digits.isdigit() else 1,
    }


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
                **_lineage_fields(s),
                **_usage_fields(str(s.get('name') or '')),
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
    return {
        **skill,
        # The raw parse is snake_case while every other skill response is
        # camelCase, so the detail pane's `selected.createdBy` read undefined
        # and labelled an agent-authored skill "bundled".
        'createdBy': str(skill.get('created_by') or ''),
        **_lineage_fields(skill),
        **_usage_fields(str(skill.get('name') or name)),
    }


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
