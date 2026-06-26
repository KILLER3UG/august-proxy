"""
Skill system API routes.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.services import skill_service

router = APIRouter(prefix="/api/skills")


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
            }
            for s in results
        ],
        "total": len(results),
    }
