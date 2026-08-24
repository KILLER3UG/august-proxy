"""Skill load/list tool handlers + registration."""

from __future__ import annotations

from app.json_narrowing import as_str
from app.services import tool_registry


async def _loadSkill(name: str) -> str:
    """Load a skill's full instructions."""
    from app.services import skill_service

    try:
        skill = skill_service.get(name)
        if not skill:
            return f"Error: Skill '{name}' not found."
        return f'# {skill["name"]}\n\n{as_str(skill.get("description"), "")}\n\n{as_str(skill.get("instructions"), "")}'
    except Exception as exc:
        return f"Error loading skill '{name}': {exc}"


async def _listSkills(query: str = '') -> str:
    """List available skills with optional search."""
    from app.services import skill_service

    try:
        if query:
            skills = skill_service.search(query)
        else:
            skills = skill_service.list_all()
        if not skills:
            return 'No skills found.' if not query else f"No skills matching '{query}'."
        lines = [f'Available skills ({len(skills)}):\n']
        for s in skills:
            lines.append(f'  - {s["name"]:30s} {as_str(s.get("description"), "")[:60]}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error listing skills: {exc}'


def register() -> None:
    """Register skill tools."""
    tool_registry.register(
        'load_skill',
        "Load a skill's full instructions by name. Use list_skills first to discover available skill names.",
        _loadSkill,
        {
            'type': 'object',
            'properties': {'name': {'type': 'string', 'description': 'The skill name to load.'}},
            'required': ['name'],
        },
    )
    tool_registry.register(
        'list_skills',
        "List available skills with optional search query. Use load_skill to load a skill's full instructions.",
        _listSkills,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Optional search query.'}},
            'required': [],
        },
    )
