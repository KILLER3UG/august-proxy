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


def _currentBotAgentId() -> str:
    """The current session's Bot agent id when it is bot-scoped, else '' — so
    load_skill/list_skills resolve through the Bot's private skill root too
    (2.15, Part 25: the per-turn <relevant_skills> block advertises bot skills,
    so the load door must see the same root or it returns 'not found')."""
    try:
        from app.services import session_scope

        return session_scope.bot_agent_id(session_scope.resolve_scope())
    except Exception:
        return ''


async def _loadSkill(name: str) -> str:
    """Load a skill's full instructions."""
    from app.services import skill_service

    try:
        skill = skill_service.get(name, _currentWorkspacePath() or None, _currentBotAgentId())
        if not skill:
            return f"Error: Skill '{name}' not found."
        if not skill.get('enabled'):
            return (
                f"Skill '{name}' is disabled. It cannot be loaded — "
                'enable it in Settings → Skills first.'
            )
        trigger_path = as_str(skill.get('path'), '')
        # Trigger-hit telemetry (per-skill usage sidecar).
        skill_service.record_skill_use(trigger_path)
        body = (
            f'# {skill["name"]}\n\n'
            f'{as_str(skill.get("description"), "")}\n\n'
            f'{as_str(skill.get("instructions"), "")}'
        )
        # A skill may ship sidecar documents next to SKILL.md. Naming them is
        # what makes them usable: the body stays the entry point and the model
        # opens only the one file it needs, instead of the whole directory
        # being invisible because nothing told it the files exist.
        listing = _siblingFiles(trigger_path)
        return f'{body}\n{listing}' if listing else body
    except Exception as exc:
        return f"Error loading skill '{name}': {exc}"


_MAX_SKILL_FILES = 25


def _siblingFiles(skill_path: str) -> str:
    """List the other files in a skill's directory, with sizes."""
    from pathlib import Path

    if not skill_path:
        return ''
    try:
        directory = Path(skill_path).parent
        if not directory.is_dir():
            return ''
        entries = sorted(
            (p for p in directory.rglob('*') if p.is_file() and p.name != 'SKILL.md'),
            key=lambda p: str(p.relative_to(directory)).replace('\\', '/'),
        )
    except OSError:
        return ''
    lines: list[str] = []
    for entry in entries[:_MAX_SKILL_FILES]:
        try:
            rel = str(entry.relative_to(directory)).replace('\\', '/')
            size = entry.stat().st_size
        except (OSError, ValueError):
            continue
        if rel.split('/')[0].startswith('.'):
            continue
        lines.append(f'- {rel} ({size} bytes)')
    if not lines:
        return ''
    note = ''
    if len(entries) > _MAX_SKILL_FILES:
        note = f'\n(_{len(entries) - _MAX_SKILL_FILES} more not listed — list the directory for the full set_)'
    return (
        '\n\n## Files in this skill\n'
        'Read one with read_file, relative to the skill directory:\n'
        + '\n'.join(lines)
        + note
    )


async def _listSkills(query: str = '') -> str:
    """List available skills with optional search."""
    from app.services import skill_service

    try:
        ws = _currentWorkspacePath() or None
        agent_id = _currentBotAgentId()
        if query:
            # search() defaults to enabledOnly=True.
            skills = skill_service.search(query, workspace=ws, agent_id=agent_id)
        else:
            skills = [s for s in skill_service.list_all(ws, agent_id) if s.get('enabled')]
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
