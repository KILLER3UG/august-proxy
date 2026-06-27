"""Skill system API routes — list, read, author, and maintain skills."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services import skill_service
from app.services.skill_service import SkillValidationError

router = APIRouter(prefix="/api/skills")


# ── Request models ────────────────────────────────────────────────────


class SkillCreate(BaseModel):
    name: str = Field(..., description="Lowercase, dotted/hyphenated skill name.")
    description: str = Field(..., description="One-sentence description, ≤ 60 chars.")
    body: str = Field(..., description="SKILL.md body markdown.")
    trigger: str = ""
    category: str = "uncategorized"


class SkillPatch(BaseModel):
    body: str | None = None
    description: str | None = None
    trigger: str | None = None
    category: str | None = None


class SkillFileWrite(BaseModel):
    file_path: str
    content: str


# ── Read ──────────────────────────────────────────────────────────────


@router.get("")
async def list_skills(
    q: str = Query("", description="Search query (name/description/trigger)"),
    category: str = Query("", description="Filter by category"),
):
    """Search and list available skills."""
    results = skill_service.search(query=q, category=category, enabled_only=False)
    return {
        "skills": [
            {
                "name": s["name"],
                "description": s.get("description", ""),
                "trigger": s.get("trigger", ""),
                "category": s.get("category", "uncategorized"),
                "enabled": s["enabled"],
                "created_by": s.get("created_by", ""),
            }
            for s in results
        ],
        "total": len(results),
    }


@router.get("/{name}")
async def get_skill(name: str):
    """Get a single skill by name."""
    skill = skill_service.get(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    return skill


# ── Author ────────────────────────────────────────────────────────────


@router.post("")
async def create_skill(body: SkillCreate):
    """Create a new agent-authored skill."""
    try:
        return skill_service.create_skill(
            body.name, body.description, body.body,
            trigger=body.trigger, category=body.category,
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/{name}")
async def patch_skill(name: str, body: SkillPatch):
    """Patch an existing skill (copy-on-write for bundled skills)."""
    try:
        return skill_service.patch_skill(
            name,
            body=body.body,
            description=body.description,
            trigger=body.trigger,
            category=body.category,
        )
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{name}")
async def delete_skill(name: str):
    """Delete an agent-authored skill. Refuses bundled skills."""
    try:
        return skill_service.delete_skill(name)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{name}/files")
async def write_skill_file(name: str, body: SkillFileWrite):
    """Write a support file (scripts/, references/, templates/) into a skill."""
    try:
        return skill_service.write_skill_file(name, body.file_path, body.content)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{name}/files")
async def delete_skill_file(name: str, file_path: str = Query(..., description="Relative path within the skill dir")):
    """Remove a support file from a skill dir."""
    try:
        return skill_service.remove_skill_file(name, file_path)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
