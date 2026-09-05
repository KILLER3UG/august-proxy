"""Daemon, blackboard, and subagent tool handlers + registration."""

from __future__ import annotations

from app.json_narrowing import as_bool, as_dict, as_str
from app.services import tool_registry


async def _spawnDaemon(
    name: str,
    prompt: str,
    watchCondition: str = '',
    tools: str = '',
    persistWorkspace: bool = False,
) -> str:
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
        spec = DaemonSpec(name=name, prompt=prompt, watchCondition=watchCondition or None, tools=toolsList, persistWorkspace=bool(persistWorkspace))
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


async def _writeBlackboard(key: str, value: str, priority: int = 0, persistWorkspace: bool = False) -> str:
    """Write a note to the shared blackboard.

    Blackboard notes are visible to all agents in the session (main loop
    and daemons). They expire after a TTL or when acknowledged. With
    persistWorkspace, they survive to the next session in the same workspace.
    """
    from app.services.blackboard_service import writeNote
    from app.services.workbench.workbench import get_session

    try:
        session = get_session()
        sessionId = getattr(session, 'id', '') if session else ''
        agent = getattr(session, '_current_agent', 'main')
        writeNote(sessionId, agent, key, value, priority, persist='workspace' if persistWorkspace else 'session')
        return f'Blackboard note written: {key}' + (' (workspace-persisted)' if persistWorkspace else '')
    except Exception as exc:
        return f'Error writing blackboard: {exc}'


async def _readBlackboard(agent: str = '', key: str = '') -> str:
    """Read notes from the shared blackboard."""
    from app.services.blackboard_service import readNotes
    from app.services.workbench.workbench import get_session

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
    from app.services.blackboard_service import clearNotes
    from app.services.workbench.workbench import get_session

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
        ok = await updateSessionState(session, executionState=state)
        if not ok:
            return 'Error: state update timed out under concurrent writes — retry the call.'
        return f'State updated: phase={state["phase"]}, step={state["step"]}, completed={len(completedList)}, blockers={len(blockersList)}'
    except Exception as exc:
        return f'Error updating state: {exc}'


async def _spawnSubagents(
    workItems: list | None = None,
    mode: str = 'auto',
    background: bool = True,
) -> str:
    """Spawn multiple sub-agents in parallel. See spawn_subagents tool schema."""
    import json

    from app.services import event_log
    from app.services.runtime_services import get_orchestrator
    from app.services.tools.spawn_subagents_tool import executeSpawnSubagents
    from app.services.workbench import workbench as wb
    from app.services.workbench.context import currentSessionId

    sessionId = currentSessionId.get()
    session = wb.getWorkbenchSession(sessionId)
    if not session:
        return 'Error: no active workbench session for sub-agent dispatch.'
    items = workItems if isinstance(workItems, list) else []
    if not items:
        return 'Error: workItems must be a non-empty array of {goal, agentId?, context?}.'

    def _emit(ev: dict) -> None:
        try:
            event_log.event_log.append(sessionId, as_str(ev.get('type'), 'subagent_event'), ev)
        except Exception:
            pass

    result = await executeSpawnSubagents(
        get_orchestrator(),
        session,
        [as_dict(i) if isinstance(i, dict) else {'goal': str(i)} for i in items],
        mode=mode or 'auto',
        emit=_emit,
        background=bool(background),
    )
    return json.dumps(result, default=str)


async def _listWorkstreams() -> str:
    import json

    from app.services.workbench.context import currentSessionId
    from app.services.workstreams import list_workstreams

    sid = currentSessionId.get()
    if not sid:
        return 'Error: no active session.'
    return json.dumps(list_workstreams(sid), default=str)


async def _sendSubagentMessage(taskId: str = '', workstream: str = '', message: str = '') -> str:
    """Steer a running worker, or enqueue a continuation on a named workstream."""
    from app.services.runtime_services import get_orchestrator
    from app.services.workbench.context import currentSessionId

    text = (message or '').strip()
    if not text:
        return 'Error: message is required.'
    orch = get_orchestrator()
    tid = (taskId or '').strip()
    if tid and orch.enqueueMailbox(tid, text):
        return f'Steering queued for {tid}. It is injected on the worker\'s next round (does not interrupt the current model call).'
    if workstream:
        from app.services.tools.spawn_subagents_tool import executeSpawnSubagents
        from app.services.workbench import workbench as wb
        from app.services.workstreams import format_episode_context

        sid = currentSessionId.get()
        session = wb.getWorkbenchSession(sid)
        if not session:
            return 'Error: no active workbench session.'
        prior = format_episode_context(sid, workstream)
        result = await executeSpawnSubagents(
            orch,
            session,
            [{'goal': text, 'workstream': workstream, 'context': prior, 'agentId': 'general'}],
            mode='auto',
            background=True,
        )
        import json

        return json.dumps(result, default=str)
    return 'Error: unknown taskId and no workstream to continue.'


async def _interruptSubagent(taskId: str = '') -> str:
    from app.services.runtime_services import get_orchestrator

    tid = (taskId or '').strip()
    if not tid:
        return 'Error: taskId is required.'
    ok = await get_orchestrator().terminate(tid)
    return f'Interrupted {tid}.' if ok else f'Task {tid} not found or already finished.'


def register() -> None:
    """Register daemon, blackboard, and subagent tools."""
    tool_registry.register(
        'spawn_daemon',
        'Spawn a background daemon (subconscious agent) on the Cerebellum model with a read-only tool set. '
        'Use for polling, monitoring, watching CI. Results appear in <subconscious_updates> on later turns. '
        'Max 10 per session (20 per workspace). persistWorkspace makes watchers survive the session.',
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
                'persistWorkspace': {
                    'type': 'boolean',
                    'description': 'When true, the daemon persists beyond this session and can hand off via workspace blackboard (use for watchers). Default false.',
                },
            },
            'required': ['name', 'prompt'],
        },
    )
    tool_registry.register(
        'list_daemons',
        'List active daemons and their status (running, triggered, completed, errored). Limited to 10 per session. Omits session_id to use the current session.',
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
        'Write a note to the shared blackboard. Notes are visible to all agents (main loop and daemons) in the session. Add persistWorkspace for cross-session handoff (daemon → next session). Use for inter-agent coordination (e.g. daemon posting test results for the main model).',
        _writeBlackboard,
        {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Note key (e.g. test_result, file_change).'},
                'value': {'type': 'string', 'description': 'Note content (plain text or JSON).'},
                'priority': {'type': 'integer', 'description': 'Priority (0-10, higher = more urgent). Default 0.'},
                'persistWorkspace': {
                    'type': 'boolean',
                    'description': 'When true, persist to workspace so the next session in this workspace sees it (daemon handoff). Default false.',
                },
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
        'spawn_subagents',
        (
            'Spawn one or more sub-agents in parallel for independent work items (single or batch in one '
            'call). Default background=true delivers completions as they finish; background=false blocks. '
            'Each item may set effort (low/medium/high/max), a model override, and yieldSchema for a JSON result.'
        ),
        _spawnSubagents,
        {
            'type': 'object',
            'properties': {
                'workItems': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'goal': {'type': 'string'},
                            'agentId': {'type': 'string', 'default': 'general'},
                            'context': {'type': 'string'},
                            'restrictedTools': {'type': 'array', 'items': {'type': 'string'}},
                            'effort': {
                                'type': 'string',
                                'enum': ['low', 'medium', 'high', 'max'],
                                'default': 'medium',
                                'description': 'Reasoning effort for this sub-agent.',
                            },
                            'model': {
                                'type': 'string',
                                'description': 'Model override (default: agent alias / smol role routing).',
                            },
                            'yieldSchema': {
                                'type': 'object',
                                'description': 'Optional JSON Schema — the sub-agent returns a single JSON object matching it, validated before delivery.',
                            },
                            'name': {'type': 'string', 'description': 'Workstream/DAG node name.'},
                            'workstream': {'type': 'string', 'description': 'Persistent thread; resumes from prior episodes.'},
                            'dependsOn': {'type': 'array', 'items': {'type': 'string'}},
                            'sourceWorkstreams': {'type': 'array', 'items': {'type': 'string'}},
                            'acceptanceCriteria': {'type': 'string'},
                            'stopCondition': {'type': 'string'},
                            'maxIterations': {'type': 'integer'},
                            'skills': {
                                'type': 'array',
                                'items': {'type': 'string'},
                                'description': 'Skill names to preload into the worker (full SKILL.md).',
                            },
                            'capability': {
                                'type': 'string',
                                'enum': ['read_only', 'standard', 'full'],
                                'default': 'standard',
                                'description': 'Tool surface for the worker: read_only (Cerebellum read-only), standard (inherit parent), full (all tools).',
                            },
                        },
                        'required': ['goal'],
                    },
                    'minItems': 1,
                    'maxItems': 10,
                },
                'mode': {
                    'type': 'string',
                    'enum': ['auto', 'proposed', 'negotiated'],
                    'default': 'auto',
                },
                'background': {
                    'type': 'boolean',
                    'default': True,
                    'description': 'Return after dispatch; deliver each completion individually (default true). Set false to block until all work items finish.',
                },
            },
            'required': ['workItems'],
        },
    )
    tool_registry.register(
        'list_workstreams',
        'List named workstreams (persistent threads) and their latest episodes for this session.',
        _listWorkstreams,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'send_subagent_message',
        'Steer a running sub-agent (queued for its next round) or continue a named workstream with a new worker that sees prior episodes.',
        _sendSubagentMessage,
        {
            'type': 'object',
            'properties': {
                'taskId': {'type': 'string', 'description': 'Running sub-agent task id.'},
                'workstream': {'type': 'string', 'description': 'Named thread to continue if taskId is not running.'},
                'message': {'type': 'string', 'description': 'Steering instruction or next action.'},
            },
            'required': ['message'],
        },
    )
    tool_registry.register(
        'interrupt_subagent',
        'Cancel a running sub-agent by taskId. Does not roll back filesystem changes already made.',
        _interruptSubagent,
        {
            'type': 'object',
            'properties': {'taskId': {'type': 'string'}},
            'required': ['taskId'],
        },
    )
