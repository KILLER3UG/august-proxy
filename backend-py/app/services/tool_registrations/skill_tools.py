"""Skill load/list/manage tool handlers + registration."""

from __future__ import annotations

import json

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


async def _skillManage(
    action: str,
    name: str,
    body: str = '',
    description: str = '',
    trigger: str = '',
    category: str = 'uncategorized',
    filePath: str = '',
    content: str = '',
) -> str:
    """Author/maintain skills: create, patch, write_file, remove_file, delete.

    Lessons captured by the background-review reflection loop land here as
    agent-authored skills the model loads via load_skill.
    """
    from app.services import skill_service
    from app.services.skill_service import SkillValidationError

    try:
        if action == 'create':
            result = skill_service.createSkill(name, description, body, trigger=trigger, category=category)
            return f"Created skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'patch':
            result = skill_service.patchSkill(
                name,
                body=body or None,
                description=description or None,
                trigger=trigger or None,
                category=category or None,
            )
            return f"Patched skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'write_file':
            result = skill_service.writeSkillFile(name, filePath, content)
            return f"Wrote '{filePath}' into skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'remove_file':
            result = skill_service.removeSkillFile(name, filePath)
            return f"Removed '{filePath}' from skill '{name}'.\n" + json.dumps(result, default=str)
        if action == 'delete':
            result = skill_service.deleteSkill(name)
            return f"Deleted skill '{name}'.\n" + json.dumps(result, default=str)
        return f"Error: unknown skill_manage action '{action}'. Use one of: create, patch, write_file, remove_file, delete."
    except SkillValidationError as exc:
        return f'Error: {exc}'
    except Exception as exc:
        return f'Error in skill_manage({action}): {exc}'


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
    tool_registry.register(
        'skill_manage',
        'Author and maintain skills: create a new skill, patch an existing one, write/remove support files (scripts/, references/, templates/), or delete. Captured lessons live as skills the model loads via load_skill.',
        _skillManage,
        {
            'type': 'object',
            'properties': {
                'action': {
                    'type': 'string',
                    'enum': ['create', 'patch', 'write_file', 'remove_file', 'delete'],
                    'description': 'What to do.',
                },
                'name': {'type': 'string', 'description': 'Skill name (lowercase, dotted/hyphenated).'},
                'body': {'type': 'string', 'description': 'SKILL.md body markdown (create/patch).'},
                'description': {'type': 'string', 'description': 'One-sentence description ≤ 60 chars (create/patch).'},
                'trigger': {'type': 'string', 'description': 'Optional trigger phrase (create/patch).'},
                'category': {'type': 'string', 'description': 'Skill category (create/patch).'},
                'filePath': {
                    'type': 'string',
                    'description': 'Relative path within the skill dir (write_file/remove_file).',
                },
                'content': {'type': 'string', 'description': 'File contents (write_file).'},
            },
            'required': ['action', 'name'],
        },
    )
