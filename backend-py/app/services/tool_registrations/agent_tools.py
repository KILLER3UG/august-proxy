"""Daemon, blackboard, and subagent tool handlers + registration."""

from __future__ import annotations
from app.json_narrowing import as_bool, as_dict, as_str
from app.services import tool_registry


async def _spawnDaemon(name: str, prompt: str, watchCondition: str = '', tools: str = '') -> str:
    """Spawn a background daemon (subconscious agent).

    Daemons run headless on the Cerebellum model (fast, cheap) with a
    restricted read-only tool set. They are best for polling, monitoring,
    and watching. The model gets results in <subconscious_updates> on
    subsequent turns.

    For complex background tasks that need full tool access, use
    ``spawn_subagent`` instead.
    """
    from app.services.daemon_manager import DaemonSpec, getManager

    try:
        toolsList: list[str] | None = None
        if tools == 'none':
            toolsList = []
        elif tools:
            toolsList = [t.strip() for t in tools.split(',') if t.strip()]
        spec = DaemonSpec(name=name, prompt=prompt, watchCondition=watchCondition or None, tools=toolsList)
        from app.services.workbench.workbench import get_session

        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        manager = getManager()
        result = await manager.spawn(spec, sessionId)
        return result
    except Exception as exc:
        return f'Error spawning daemon: {exc}'


async def _listDaemons(sessionId: str = '') -> str:
    """List active daemons and their status."""
    from app.services.daemon_manager import getManager

    try:
        manager = getManager()
        daemons = manager.list_daemons(sessionId or None)
        if not daemons:
            return 'No active daemons.'
        lines = ['Active daemons:']
        for d in daemons:
            status = d['status']
            dd = as_dict(d)
            triggered = ' [TRIGGERED]' if as_bool(dd.get('triggered')) else ''
            err = as_str(dd.get('error'))
            error = f' error={err}' if err else ''
            lines.append(f'  [{d["name"]}] {status}{triggered}{error}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error listing daemons: {exc}'


async def _killDaemon(daemonId: str) -> str:
    """Kill a running daemon by its id."""
    from app.services.daemon_manager import getManager

    try:
        manager = getManager()
        if await manager.kill(daemonId):
            return f"Daemon '{daemonId}' killed."
        return f"Daemon '{daemonId}' not found."
    except Exception as exc:
        return f'Error killing daemon: {exc}'


async def _writeBlackboard(key: str, value: str, priority: int = 0) -> str:
    """Write a note to the shared blackboard.

    Blackboard notes are visible to all agents in the session (main loop
    and daemons). They expire after a TTL or when acknowledged.
    """
    from app.services.workbench.workbench import get_session
    from app.services.blackboard_service import writeNote

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        agent = getattr(session, '_current_agent', 'main')
        writeNote(sessionId, agent, key, value, priority)
        return f'Blackboard note written: {key}'
    except Exception as exc:
        return f'Error writing blackboard: {exc}'


async def _readBlackboard(agent: str = '', key: str = '') -> str:
    """Read notes from the shared blackboard."""
    from app.services.workbench.workbench import get_session
    from app.services.blackboard_service import readNotes

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        notes = readNotes(sessionId, agent, key)
        if not notes:
            return 'No blackboard notes found.'
        lines = ['Blackboard notes:']
        for n in notes[:20]:
            lines.append(f'  [{n["agent"]}] {n["key"]}: {str(n["value"])[:200]}')
        return '\n'.join(lines)
    except Exception as exc:
        return f'Error reading blackboard: {exc}'


async def _clearBlackboard(agent: str = '') -> str:
    """Clear blackboard notes."""
    from app.services.workbench.workbench import get_session
    from app.services.blackboard_service import clearNotes

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        count = clearNotes(sessionId, agent)
        return f'Cleared {count} blackboard note(s).'
    except Exception as exc:
        return f'Error clearing blackboard: {exc}'


async def _updateState(
    phase: str = '', step: int = 1, completed: str = '', blockers: str = '', verificationCommand: str = ''
) -> str:
    """Track execution state across a multi-step task.

    Gives the model phase awareness so it doesn't loop or repeat steps.
    State is stored in the session and injected as <execution_state> in
    Tier 3 on every turn. Call this when you start, progress through, or
    complete a phase of work.
    """
    from app.services.workbench.workbench import get_session, updateSessionState

    try:
        session = get_session()
        if not session:
            return 'Error: no active workbench session.'
        completedList = [c.strip() for c in completed.split('\n') if c.strip()] if completed else []
        blockersList = [b.strip() for b in blockers.split('\n') if b.strip()] if blockers else []
        state: dict[str, object] = {
            'phase': phase or getattr(session, '_execution_phase', 'research'),
            'step': step,
            'completed': completedList,
            'blockers': blockersList,
        }
        if verificationCommand:
            state['verification_command'] = verificationCommand
        await updateSessionState(session, executionState=state)
        return f'State updated: phase={state["phase"]}, step={state["step"]}, completed={len(completedList)}, blockers={len(blockersList)}'
    except Exception as exc:
        return f'Error updating state: {exc}'


async def _spawnSubagent(goal: str, agentId: str = '', context: str = '', toolsets: list[str] | None = None) -> str:
    """Dispatch a sub-agent for a focused task and return its final answer.

    Resolves the active workbench session via the contextvar, then runs the
    sub-agent to completion. Sub-agent lifecycle/text/tool events are emitted
    to the parent session's SSE stream through the event log.
    """
    from app.services import event_log
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.subagent import executeSubAgent

    sessionId = currentSessionId.get()
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        return 'Error: no active workbench session for sub-agent dispatch.'

    def _emit(ev: dict) -> None:
        try:
            event_log.event_log.append(sessionId, as_str(ev.get('type'), 'subagent_event'), ev)
        except Exception:
            pass

    result = await executeSubAgent(session, agentId or 'general', goal, context or '', emit=_emit)
    status = as_str(result.get('status'), 'completed')
    text = as_str(result.get('result')) or as_str(result.get('error')) or ''
    return f"Sub-agent '{as_str(result.get('agentId'), 'general')}' {status}.\n\n{text}"


def register() -> None:
    """Register daemon, blackboard, and subagent tools."""
    tool_registry.register(
        'spawn_daemon',
        'Spawn a background daemon (subconscious agent). Daemons run on the Cerebellum model (fast, cheap) with a restricted read-only tool set. Use for polling, monitoring, and watching CI. Results appear in <subconscious_updates> on subsequent turns. Max 3 daemons per session.',
        _spawnDaemon,
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Unique name for the daemon.'},
                'prompt': {'type': 'string', 'description': 'Instructions for the daemon.'},
                'watchCondition': {
                    'type': 'string',
                    'description': 'Trigger: on_completion | on_match:KEYWORD | on_change | (empty for none)',
                },
                'tools': {
                    'type': 'string',
                    'description': "Comma-separated tool allowlist, or 'none' for no tools, or empty for defaults.",
                },
            },
            'required': ['name', 'prompt'],
        },
    )
    tool_registry.register(
        'list_daemons',
        'List active daemons and their status (running, triggered, completed, errored). Limited to 3 per session. Omits session_id to use the current session.',
        _listDaemons,
        {
            'type': 'object',
            'properties': {
                'sessionId': {'type': 'string', 'description': 'Session ID (optional; defaults to current).'}
            },
            'required': [],
        },
    )
    tool_registry.register(
        'kill_daemon',
        'Kill a daemon by its id. Use list_daemons to find active daemon IDs.',
        _killDaemon,
        {
            'type': 'object',
            'properties': {'daemonId': {'type': 'string', 'description': 'Daemon ID to kill.'}},
            'required': ['daemonId'],
        },
    )
    tool_registry.register(
        'write_blackboard',
        'Write a note to the shared blackboard. Notes are visible to all agents (main loop and daemons) in the session. Use for inter-agent coordination (e.g. daemon posting test results for the main model).',
        _writeBlackboard,
        {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Note key (e.g. test_result, file_change).'},
                'value': {'type': 'string', 'description': 'Note content (plain text or JSON).'},
                'priority': {'type': 'integer', 'description': 'Priority (0-10, higher = more urgent). Default 0.'},
            },
            'required': ['key', 'value'],
        },
    )
    tool_registry.register(
        'read_blackboard',
        'Read notes from the shared blackboard, filtered by agent and/or key. Returns all notes if no filters provided.',
        _readBlackboard,
        {
            'type': 'object',
            'properties': {
                'agent': {'type': 'string', 'description': 'Filter by agent name (optional).'},
                'key': {'type': 'string', 'description': 'Filter by key (optional).'},
            },
            'required': [],
        },
    )
    tool_registry.register(
        'clear_blackboard',
        'Clear notes from the shared blackboard, optionally scoped to a specific agent.',
        _clearBlackboard,
        {
            'type': 'object',
            'properties': {'agent': {'type': 'string', 'description': 'Only clear notes from this agent (optional).'}},
            'required': [],
        },
    )
    tool_registry.register(
        'spawn_subagent',
        'Dispatch a sub-agent for a focused task. Give it a clear goal and context; optionally specify an agentId (from create_agent) to use a specialized agent, otherwise a general-purpose agent runs.',
        _spawnSubagent,
        {
            'type': 'object',
            'properties': {
                'goal': {'type': 'string', 'description': 'The task goal for the sub-agent.'},
                'agentId': {
                    'type': 'string',
                    'description': 'Agent id to run (from create_agent). Defaults to a general agent.',
                },
                'context': {'type': 'string', 'description': 'Background context for the sub-agent.'},
                'toolsets': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Tool sets to grant the sub-agent (optional).',
                },
            },
            'required': ['goal'],
        },
    )
