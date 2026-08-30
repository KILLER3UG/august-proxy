"""Skill load/list tool handlers + registration."""

from __future__ import annotations

from app.json_narrowing import as_str
from app.services import tool_registry


def _currentWorkspacePath() -> str:
    """The current workbench session's workspacePath ('' when none/home).

    Part 17 Phase B: skill tools resolve through the session's workspace
    so project skills (``<ws>/.aug/skills/``) load/list with shadowing.
    """
    try:
        from app.services.workbench import workbench as _wb
        from app.services.workbench.context import currentSessionId

        sid = str(currentSessionId.get() or '')
        if not sid:
            return ''
        session = _wb.get_workbench_session(sid)
        if session is None:
            return ''
        return as_str(getattr(session, 'workspacePath', '') or '')
    except Exception:
        return ''


async def _loadSkill(name: str) -> str:
    """Load a skill's full instructions."""
    from app.services import skill_service

    try:
        skill = skill_service.get(name, _currentWorkspacePath() or None)
        if not skill:
            return f"Error: Skill '{name}' not found."
        if not skill.get('enabled'):
            return (
                f"Skill '{name}' is disabled. It cannot be loaded — "
                'enable it in Settings → Skills first.'
            )
        # Part 16 Phase E: trigger-hit telemetry (per-skill usage sidecar).
        skill_service.record_skill_use(as_str(skill.get('path'), ''))
        return f'# {skill["name"]}\n\n{as_str(skill.get("description"), "")}\n\n{as_str(skill.get("instructions"), "")}'
    except Exception as exc:
        return f"Error loading skill '{name}': {exc}"


async def _listSkills(query: str = '') -> str:
    """List available skills with optional search."""
    from app.services import skill_service

    try:
        ws = _currentWorkspacePath() or None
        if query:
            # search() defaults to enabledOnly=True.
            skills = skill_service.search(query, workspace=ws)
        else:
            skills = [s for s in skill_service.list_all(ws) if s.get('enabled')]
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
