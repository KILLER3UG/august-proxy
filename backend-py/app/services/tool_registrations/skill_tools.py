"""Skill load/list tool handlers + registration."""

from __future__ import annotations

import re
import urllib.parse
from pathlib import Path

from app.json_narrowing import as_str
from app.services import tool_registry

# L2 is ONE bundled file, contained to the skill's own directory. The generic
# read_file door is machine-wide by design (folderless chats read anywhere);
# this is the skill-scoped door the authoring spec promises.
_MAX_SKILL_FILE_CHARS = 200_000


def _loadSkillFile(skill: dict[str, object], rel: str) -> str:
    """Read one file from a skill directory, refusing every escape."""
    raw = str(rel or '').strip()
    if not raw:
        return ''
    decoded = urllib.parse.unquote(raw)
    if decoded.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:', decoded):
        return 'Error: skill files are read by a path relative to the skill directory.'
    parts = decoded.replace('\\', '/').split('/')
    if any(part == '..' for part in parts):
        return 'Error: traversal is not allowed in a skill file path.'
    skill_dir = Path(as_str(skill.get('path'), '')).resolve().parent
    try:
        candidate = (skill_dir / decoded).resolve()
    except (OSError, ValueError):
        return 'Error: invalid skill file path.'
    if candidate != skill_dir and not candidate.is_relative_to(skill_dir):
        return 'Error: that file is outside the skill directory.'
    if candidate.is_dir() or not candidate.is_file():
        return f'Error: no skill file {decoded!r}.'
    try:
        if candidate.stat().st_size > _MAX_SKILL_FILE_CHARS:
            return (
                f'Error: {decoded!r} exceeds the per-file cap '
                f'({_MAX_SKILL_FILE_CHARS} chars).'
            )
        text = candidate.read_text('utf-8')
    except (OSError, UnicodeDecodeError) as exc:
        return f'Error reading {decoded!r}: {exc}'
    return f'{decoded} ({len(text)} chars):\n\n{text}'


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


async def _loadSkill(name: str, file: str = '') -> str:
    """Load a skill's full instructions, or one bundled file (L2)."""
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
        gate = skill_service.skillGateReason(skill)
        if gate:
            return f"Skill '{name}' is unavailable here: {gate}."
        if file:
            return _loadSkillFile(skill, file)
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
        directory = _skillDirPosix(trigger_path)
        head = f'Skill directory: {directory}\n\n' if directory else ''
        body = _substituteSkillVars(body, directory)
        return f'{head}{body}\n{listing}' if listing else f'{head}{body}'
    except Exception as exc:
        return f"Error loading skill '{name}': {exc}"


_MAX_SKILL_FILES = 25

# The body of a skill is prose a model reads once and then acts on, so a
# placeholder is only useful if it becomes something the NEXT tool call can be
# given. August's own spellings lead; the Hermes ones are accepted because a
# ported SKILL.md arrives with them and `${HERMES_SKILL_DIR}` in a procedure the
# agent cannot resolve is a step that silently fails.
_SKILL_DIR_TOKENS = ('${HARNESS_SKILL_DIR}', '${HERMES_SKILL_DIR}', '${SKILL_DIR}')
_SESSION_ID_TOKENS = ('${HARNESS_SESSION_ID}', '${HERMES_SESSION_ID}', '${SESSION_ID}')


def _skillDirPosix(skill_path: str) -> str:
    """The skill's own directory, forward-slashed.

    Forward slashes because a Windows path with backslashes is the one argument
    form the wire has repeatedly mangled, and `Path` accepts the posix spelling on
    every platform.
    """
    if not skill_path:
        return ''
    return str(Path(skill_path).parent).replace('\\', '/')


def _substituteSkillVars(text: str, skill_dir: str) -> str:
    """Replace the skill-dir and session-id tokens a SKILL.md body may contain."""
    out = text
    for token in _SKILL_DIR_TOKENS:
        out = out.replace(token, skill_dir)
    if any(token in text for token in _SESSION_ID_TOKENS):
        try:
            from app.services.workbench.context import currentSessionId

            sid = str(currentSessionId.get() or '')
        except Exception:
            sid = ''
        for token in _SESSION_ID_TOKENS:
            out = out.replace(token, sid)
    return out


def _siblingFiles(skill_path: str) -> str:
    """List the other files in a skill's directory, with sizes.

    `directory` is the same dir as `_skillDirPosix(skill_path)`, passed in so the
    paths the listing prints and the `Skill directory:` line above it cannot
    disagree.
    """
    from pathlib import Path

    if not skill_path:
        return ''
    try:
        dirPath = Path(skill_path).parent
        if not dirPath.is_dir():
            return ''
        entries = sorted(
            (p for p in dirPath.rglob('*') if p.is_file() and p.name != 'SKILL.md'),
            key=lambda p: str(p.relative_to(dirPath)).replace('\\', '/'),
        )
    except OSError:
        return ''
    # Absolute, not relative to the skill directory. `read_file` resolves a
    # relative path against the SESSION's workspace (sandbox.paths.bind_path), so
    # the old footer told the model to do something that could not work for a
    # skill living under `<dataDir>/skills` or the bundled tree: "read
    # references/x.md relative to the skill directory" opened
    # `<workspace>/references/x.md` and reported it missing.
    prefix = ''
    lines: list[str] = []
    for entry in entries[:_MAX_SKILL_FILES]:
        try:
            rel = str(entry.relative_to(dirPath)).replace('\\', '/')
            size = entry.stat().st_size
        except (OSError, ValueError):
            continue
        if rel.split('/')[0].startswith('.'):
            continue
        lines.append(f'- {prefix}{rel} ({size} bytes)')
    if not lines:
        return ''
    note = ''
    if len(entries) > _MAX_SKILL_FILES:
        note = f'\n(_{len(entries) - _MAX_SKILL_FILES} more not listed — list the directory for the full set_)'
    return (
        '\n\n## Files in this skill\n'
        'Read one with load_skill(name, file="<relative path>") — traversal and absolute paths '
        'are refused:\n'
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
            # The description IS the trigger — it names when to fire and when NOT
            # to. A fixed 60-char cut deleted the second half, so the listing
            # advertised the skill and hid the rule for using it.
            lines.append(f'  - {s["name"]:30s} {as_str(s.get("description"), "")}')
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
            'properties': {
                'name': {'type': 'string', 'description': 'The skill name to load.'},
                'file': {
                    'type': 'string',
                    'description': 'Optional L2: one file inside the skill directory (e.g. '
                    'references/notes.md), relative to it. Traversal and absolute paths are '
                    'refused.',
                },
            },
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
