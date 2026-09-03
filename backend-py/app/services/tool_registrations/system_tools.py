"""System/environment, heuristics, state, and scratchpad tools."""

from __future__ import annotations

import sys

from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.services import tool_registry


async def _diagnoseProxy() -> str:
    """Diagnose the proxy runtime environment.

    Returns paths, providers, mode, permissions — let the model
    understand its own runtime.
    """
    from app.config import settings

    parts = [
        f'Data directory: {settings.dataDir}',
        f'Web dist: {settings.webDist}',
        f'Port: {settings.port}',
        'Mode: python',
        f'Environment: {getattr(settings, "env", "production")}',
    ]
    try:
        providers = as_dict(settings.config.get('providers'), {})
        if isinstance(providers, dict):
            for name, info in list(providers.items())[:10]:
                if isinstance(info, dict):
                    parts.append(f"Provider '{name}': model={as_str(info.get('model'), 'unknown')}")
    except Exception:
        pass
    try:
        from app.services.workbench import workbench as _wb

        _getCurrentSessionMode = getattr(_wb, 'getCurrentSessionMode', None)
        if callable(_getCurrentSessionMode):
            parts.append(f'Session mode: {_getCurrentSessionMode()}')
    except Exception:
        pass
    return '\n'.join(parts)


async def _describeEnvironment() -> str:
    """Describe the workspace environment: paths, VCS, available tools."""
    from app.config import settings

    parts = [
        'Proxy version: 0.1.0',
        f'Data directory: {settings.dataDir}',
        f'Platform: {sys.platform}',
    ]

    def _run(cmd: list[str], cwd: str | None = None) -> str:
        try:
            import subprocess

            return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ''

    cwd = str(settings.dataDir.parent)
    # Versions
    for prog, args in [('python', ['python', '--version']), ('node', ['node', '--version']), ('go', ['go', 'version']), ('uv', ['uv', '--version']), ('pnpm', ['pnpm', '--version']), ('rg', ['rg', '--version']), ('fd', ['fd', '--version']), ('jq', ['jq', '--version'])]:
        out = _run(args)
        if out:
            parts.append(f'{prog}: {out.splitlines()[0][:120]}')
    # Git
    branch = _run(['git', 'branch', '--show-current'], cwd=cwd)
    if branch:
        parts.append(f'Git branch: {branch}')
    status = _run(['git', 'status', '--porcelain'], cwd=cwd)
    if status:
        parts.append(f'Git status:\n{status[:2000]}')
    else:
        parts.append('Git status: clean')
    head = _run(['git', 'rev-parse', '--short', 'HEAD'], cwd=cwd)
    if head:
        parts.append(f'Git HEAD: {head}')
    # Disk
    try:
        import shutil

        du = shutil.disk_usage(cwd)
        parts.append(f'Disk free: {du.free // (1024*1024)} MB / total {du.total // (1024*1024)} MB')
    except Exception:
        pass
    # Env (filtered)
    try:
        import os

        for k in ('PATH', 'PYTHONPATH', 'NODE_ENV', 'VIRTUAL_ENV', 'CONDA_PREFIX'):
            v = os.environ.get(k, '')
            if v:
                parts.append(f'Env {k}: {v[:300]}')
    except Exception:
        pass
    # Workspace path
    try:
        from app.services.workbench.workbench import get_session

        sess = get_session()
        ws_path = str(getattr(sess, 'workspacePath', '') or '') if sess else ''
        if ws_path:
            parts.append(f'Workspace: {ws_path}')
    except Exception:
        pass
    try:
        from app.services.tool_registry import listTools

        tools = listTools()
        parts.append(f'Registered tools: {len(tools)}')
    except Exception:
        pass
    return '\n'.join(parts)


async def _writeScratchpad(text: str) -> str:
    """Write a scratchpad note to working memory.

    Proxy keeps only the MOST RECENT scratchpad content. Old content is
    DISCARDED — not accumulated. Use this to keep your current analysis,
    code diff, or reasoning step in front of you across turns.
    """
    from app.services.workbench.workbench import get_session, updateSessionState

    try:
        session = get_session()
        if not session:
            return 'Error: no active workbench session.'
        # Merge with the current execution state — rewriting from scratch
        # silently drops keys the model set on a previous update_state call.
        prevState = as_dict(getattr(session, '_execution_state', None), {})
        state: dict[str, object] = {
            'phase': as_str(prevState.get('phase'), 'research'),
            'step': as_int(prevState.get('step'), 1),
            'completed': as_list(prevState.get('completed'), []),
            'blockers': as_list(prevState.get('blockers'), []),
        }
        if prevState.get('verification_command'):
            state['verification_command'] = prevState['verification_command']
        ok = await updateSessionState(session, executionState=state)
        if not ok:
            return 'Error: scratchpad update timed out under concurrent writes — retry the call.'
        setattr(session, '_working_memory', text)
        return 'Scratchpad updated.'
    except Exception as exc:
        return f'Error writing scratchpad: {exc}'


async def _summarizeSession(include_scratchpad: bool = True) -> str:
    """Summarize the current session's state for handoff/compaction."""
    from app.services.workbench.workbench import get_session

    try:
        session = get_session()
        if not session:
            return 'Error: no active session.'
        from app.services.workbench.sessions import summarize_session

        base = summarize_session(session)
        scratch = ''
        if include_scratchpad:
            scratch = as_str(getattr(session, '_working_memory', ''), '').strip()
        # Recent dialogue summary (local fallback).
        recent = ''
        try:
            from app.services.workbench.context_compressor import localSummarize

            msgs = getattr(session, 'messages', []) or []
            if msgs:
                recent = localSummarize(msgs[-20:])
        except Exception:
            pass
        import json as _json

        out: dict[str, object] = {**base}
        if scratch:
            out['scratchpad'] = scratch[:4000]
        if recent:
            out['recentSummary'] = recent[:4000]
        return _json.dumps(out, indent=2, ensure_ascii=False)
    except Exception as exc:
        return f'Error summarizing session: {exc}'


async def _setAgentMode(mode: str = '') -> str:
    """Switch the session's agent mode.

    Modes:
      chat — answer in text; tool calls are blocked.
      agent — native tool calling (default).
      code — write a fenced ```python block instead; the harness executes it
             with a workspace-bound tool API (read_file / write_file /
             run_command / list_files).
      orchestrator / planner — dispatch workstreams only; no shell/edit.
    """
    from app.services.workbench.workbench import get_session

    mode = (mode or '').strip().lower()
    if mode == 'planner':
        mode = 'orchestrator'
    if mode not in ('chat', 'agent', 'code', 'orchestrator'):
        return "Error: mode must be one of: chat, agent, code, orchestrator."
    session = get_session()
    if not session:
        return 'Error: no active workbench session.'
    setattr(session, 'agent_mode', mode)
    return f'Agent mode set to {mode}.'


async def _updateState(
    phase: str = '', step: int = 1, completed: str = '', blockers: str = '', **_extra: object
) -> str:
    """Track execution state across a multi-step task.

    Gives the model phase awareness so it doesn't loop or repeat steps.
    State is stored in the session and injected as <execution_state> in
    Tier 3 on every turn. Call this when you start, progress through, or
    complete a phase of work.

    ``**_extra`` absorbs legacy/decorative args (``note``,
    ``verificationCommand``) so a stale caller payload never TypeErrors
    the dispatch.
    """
    from app.services.workbench.workbench import get_session, updateSessionState

    try:
        session = get_session()
        if not session:
            return 'Error: no active workbench session.'
        prevState = getattr(session, '_execution_state', None)
        currentPhase = as_str(as_dict(prevState).get('phase'), 'research') if prevState else 'research'
        targetPhase = (phase or currentPhase).strip().lower()
        # Validate against the known phase set — a typo'd phase would
        # otherwise silently corrupt the state the next turn reads.
        _VALID_PHASES = ('research', 'plan', 'implement', 'review', 'complete')
        if targetPhase not in _VALID_PHASES:
            return (
                f'Error: unknown phase "{targetPhase}". Valid phases: {", ".join(_VALID_PHASES)}. '
                'Use update_state to move research → plan → implement → review → complete.'
            )
        completedList = [c.strip() for c in completed.split('\n') if c.strip()] if completed else []
        blockersList = [b.strip() for b in blockers.split('\n') if b.strip()] if blockers else []
        state: dict[str, object] = {
            'phase': targetPhase,
            'step': step,
            'completed': completedList,
            'blockers': blockersList,
        }
        ok = await updateSessionState(session, executionState=state)
        if not ok:
            return 'Error: state update timed out under concurrent writes — retry the call.'
        return f'State updated: phase={state["phase"]}, step={state["step"]}, completed={len(completedList)}, blockers={len(blockersList)}'
    except Exception as exc:
        return f'Error updating state: {exc}'


async def _enterPlanModeFallback() -> str:
    """Defensive fallback — the workbench turn loop intercepts enter_plan_mode
    before dispatch and performs the actual mode switch."""
    return 'enter_plan_mode is handled by the workbench turn loop; this fallback should never run.'


async def _submitPlanFallback(planPath: str = '') -> str:
    """Defensive fallback — the workbench turn loop intercepts submit_plan
    before dispatch and loads the plan markdown file."""
    return 'submit_plan is handled by the workbench turn loop; this fallback should never run.'


_TODOS_SCHEMA: dict[str, object] = {
    'type': 'object',
    'properties': {
        'todos': {
            'type': 'array',
            'description': 'The todo items.',
            'items': {
                'type': 'object',
                'properties': {
                    'content': {'type': 'string', 'description': 'What the step involves.'},
                    'status': {
                        'type': 'string',
                        'enum': ['pending', 'in_progress', 'completed'],
                        'description': 'Step status. Exactly one step should be in_progress.',
                    },
                },
                'required': ['content', 'status'],
            },
        },
        'title': {'type': 'string', 'description': 'Optional short list title.'},
    },
    'required': ['todos'],
}


async def _submitTodosFallback(todos: list | None = None, title: str = '') -> str:
    """Fallback for dispatch paths outside the workbench turn loop (proxy
    adapter, text-tool protocol): route through routeTodos so a worker-side
    call lands on its own handle, not the parent session."""
    from app.services.workbench.workbench import routeTodos

    if not isinstance(todos, list) or not todos:
        return 'Error: todos must be a non-empty array of {content, status}.'
    return routeTodos(todos, title=title or '')


async def _updateTodosFallback(todos: list | None = None, title: str = '') -> str:
    """Fallback twin of submit_todos — replaces the caller's todo list."""
    return await _submitTodosFallback(todos, title)


def register() -> None:
    """Register system and workbench-state tools."""
    tool_registry.register(
        'diagnose_proxy',
        "Diagnose the proxy runtime environment: paths, providers, mode, permissions. Use this to understand what the proxy can do and how it's configured.",
        _diagnoseProxy,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'describe_environment',
        'Describe the workspace environment: data paths, VCS status, registered tools. Use diagnose_proxy to understand the proxy runtime itself.',
        _describeEnvironment,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'update_state',
        "Track execution state across a multi-step task. Call this when you start, progress through, or complete a phase. The state is injected into the next turn's system prompt so you know where you left off.",
        _updateState,
        {
            'type': 'object',
            'properties': {
                'phase': {
                    'type': 'string',
                    'description': 'Current phase: research | plan | implement | review | complete',
                    'enum': ['research', 'plan', 'implement', 'review', 'complete'],
                },
                'step': {'type': 'integer', 'description': 'Step number within the current phase.'},
                'note': {'type': 'string', 'description': 'Short free-form note about progress.'},
            },
            'required': ['phase'],
        },
    )
    # Todo-list doors. The workbench turn loop intercepts these names before
    # dispatch (T7 re-injection); the registrations below exist so the tools
    # are VISIBLE to native tool-calling models and covered by the validator,
    # policy buckets, and the fallbacks above (previously the loop handled
    # names no schema ever advertised — only text-protocol models could find
    # them, and the drawer's todo list was effectively main-agent-only by
    # accident).
    tool_registry.register(
        'submit_todos',
        'Create or replace the todo checklist for the current task. Use for multi-step work: '
        'one item per step, exactly one in_progress. The list renders in the Tasks panel and '
        'survives compaction. Update it with update_todos as steps finish.',
        _submitTodosFallback,
        _TODOS_SCHEMA,
    )
    tool_registry.register(
        'update_todos',
        'Update the todo checklist statuses as work progresses (same shape as submit_todos; '
        'replaces the list). Mark a step completed the moment it is verified done, never in advance.',
        _updateTodosFallback,
        _TODOS_SCHEMA,
    )
    tool_registry.register(
        'write_scratchpad',
        'Write a scratchpad note to working memory. Only the most recent note is kept — old content is discarded. Use this to hold your current analysis, code diff, or reasoning step across turns.',
        _writeScratchpad,
        {
            'type': 'object',
            'properties': {
                'text': {
                    'type': 'string',
                    'description': 'The scratchpad content. This REPLACES any previous scratchpad content.',
                }
            },
            'required': ['text'],
        },
    )
    tool_registry.register(
        'summarize_session',
        'Summarize the current session (tokens, costs, scratchpad, recent dialogue) for handoff or compaction. Preserves key state without manual work. At high/critical cognitive budget, use this plus write_scratchpad before compact.',
        _summarizeSession,
        {
            'type': 'object',
            'properties': {
                'include_scratchpad': {
                    'type': 'boolean',
                    'description': 'Include the current scratchpad content. Default true.',
                }
            },
            'required': [],
        },
    )
    tool_registry.register(
        'enter_plan_mode',
        'Enter Plan mode before a non-trivial multi-step change (multiple files, architecture, risky or '
        'destructive ops). Investigate read-only, write the plan to the session plan file this tool '
        'returns (.aug/plans/), then present it via submit_plan. Skip for simple, clearly-scoped requests.',
        _enterPlanModeFallback,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'submit_plan',
        'Submit your plan for user approval. First write it as clean markdown to this session\'s plan file '
        '(.aug/plans/<sessionId>.md — the exact path comes from enter_plan_mode; it is the only file '
        'writable in Plan mode), then call this tool; the file is shown to the user exactly as written.',
        _submitPlanFallback,
        {
            'type': 'object',
            'properties': {
                'planPath': {
                    'type': 'string',
                    'description': (
                        'Optional path to the plan markdown file. Only this session\'s own '
                        'plan file (.aug/plans/<sessionId>.md) is accepted; other paths are ignored.'
                    ),
                },
            },
            'required': [],
        },
    )
    tool_registry.register(
        'set_agent_mode',
        "Switch this session's agent mode: 'chat' (text only), 'agent' (native tools), "
        "'code' (fenced python workspace API), or 'orchestrator' (dispatch workstreams; "
        "no shell/edit — alias: planner).",
        _setAgentMode,
        {
            'type': 'object',
            'properties': {
                'mode': {
                    'type': 'string',
                    'enum': ['chat', 'agent', 'code', 'orchestrator', 'planner'],
                    'description': 'The agent mode to switch to.',
                }
            },
            'required': ['mode'],
        },
    )
