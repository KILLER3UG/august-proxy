"""System/environment, heuristics, state, and scratchpad tools."""

from __future__ import annotations

import re

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

    parts = ['Proxy version: 0.1.0', f'Data directory: {settings.dataDir}', 'Platform: win32']
    try:
        import subprocess

        cwd = str(settings.dataDir.parent)
        branch = subprocess.run(
            ['git', 'branch', '--show-current'], cwd=cwd, capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if branch:
            parts.append(f'Git branch: {branch}')
    except Exception:
        pass
    try:
        from app.services.tool_registry import listTools

        tools = listTools()
        parts.append(f'Registered tools: {len(tools)}')
    except Exception:
        pass
    return '\n'.join(parts)


async def _updateHeuristics(action: str, rule: str = '') -> str:
    """Manage learned behavioral heuristics.

    Actions:
      add    — Persist a new rule: "Project uses Yarn, not NPM"
      remove — Remove a rule by id or exact text
      clear  — Clear all rules
      list   — Return current rules
    """
    from app.services.heuristics_service import addHeuristic, clearHeuristics, listHeuristics, removeByRule

    try:
        if action == 'add':
            if not rule:
                return "Error: 'rule' is required for add action."
            result = addHeuristic(rule)
            if result is not None:
                return f'Heuristic added (id={result}).'
            return 'Heuristic already exists (duplicate).'
        elif action == 'remove':
            if not rule:
                return "Error: 'rule' is required for remove action."
            if removeByRule(rule):
                return f'Heuristic removed: {rule}'
            return f'Heuristic not found: {rule}'
        elif action == 'clear':
            count = clearHeuristics()
            return f'Cleared {count} heuristic(s).'
        elif action == 'list':
            heuristics = listHeuristics()
            if not heuristics:
                return 'No learned heuristics.'
            lines = ['Learned heuristics:']
            for h in heuristics:
                lines.append(f'  [{h["id"]}] {h["rule"]} (source: {h["source"]}, category: {h["category"]})')
            return '\n'.join(lines)
        else:
            return f'Unknown action: {action}. Use add, remove, clear, or list.'
    except Exception as exc:
        return f'Error managing heuristics: {exc}'


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
        await updateSessionState(
            session,
            executionState={
                'phase': as_str(getattr(session, '_execution_state', {}).get('phase'), 'research'),
                'step': as_int(getattr(session, '_execution_state', {}).get('step'), 1),
                'completed': as_list(getattr(session, '_execution_state', {}).get('completed'), []),
                'blockers': as_list(getattr(session, '_execution_state', {}).get('blockers'), []),
            },
        )
        setattr(session, '_working_memory', text)
        return 'Scratchpad updated.'
    except Exception as exc:
        return f'Error writing scratchpad: {exc}'


_EXIT_CODE_RE = re.compile(r'exit code:\s*(-?\d+)', re.IGNORECASE)
# Order matters: explicit clean-run signals first, then failure markers, then
# weak pass markers — so "2 failed, 10 passed" fails and "0 failed" passes.
_STRONG_PASS_MARKERS = ('0 failed', 'no failures', 'all checks passed', 'build succeeded')
_FAIL_MARKERS = ('failed', 'failure', 'traceback', 'error:', 'assertionerror')
_WEAK_PASS_MARKERS = ('passed', '✓')


def _verificationVerdict(receipts: list[object]) -> tuple[str, str]:
    """Judge this turn's command receipts for the verifier gate.

    Returns (verdict, detail): 'pass' | 'fail' | 'unclear' | 'none'.
    Most recent receipt wins on exit codes; unclear output falls through to
    older receipts, and pure-unclear history is given the benefit of the
    doubt (the gate must not strand tasks whose verification output is
    unconventional).
    """
    if not receipts:
        return ('none', '')
    for receipt in reversed(receipts):
        text = as_str(as_dict(receipt).get('content'), '').lower() if isinstance(receipt, dict) else ''
        if not text:
            continue
        name = as_str(as_dict(receipt).get('name'), 'command') if isinstance(receipt, dict) else 'command'
        m = _EXIT_CODE_RE.search(text)
        if m:
            code = int(m.group(1))
            if code == 0:
                return ('pass', f'{name} exited 0')
            return ('fail', f'{name} exited {code}')
        if any(marker in text for marker in _STRONG_PASS_MARKERS):
            return ('pass', f'clean-run markers in {name} output')
        if any(marker in text for marker in _FAIL_MARKERS):
            return ('fail', f'failure markers in {name} output')
        if any(marker in text for marker in _WEAK_PASS_MARKERS):
            return ('pass', f'pass markers in {name} output')
    return ('unclear', '')


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
        prevState = getattr(session, '_execution_state', None)
        currentPhase = as_str(as_dict(prevState).get('phase'), 'research') if prevState else 'research'
        targetPhase = (phase or currentPhase).strip().lower()
        # Verifier gate (enforced, not honor-system): entering review/complete
        # requires a command run THIS turn whose output looks like a pass.
        # Receipts are recorded by the workbench tool loop for command tools
        # and cleared at turn start.
        if targetPhase in ('review', 'complete') and currentPhase not in ('review', 'complete'):
            verdict, detail = _verificationVerdict(
                as_list(getattr(session, '_verification_receipts', None), [])
            )
            if verdict == 'none':
                return (
                    'Verifier gate: no command was run this turn. Run the relevant test / lint / '
                    'build command first (via run_command), confirm it passes, then call '
                    'update_state again.'
                )
            if verdict == 'fail':
                return (
                    f'Verifier gate: the verification run did not pass ({detail}). Fix the '
                    'failures, re-run the command, then call update_state again.'
                )
        completedList = [c.strip() for c in completed.split('\n') if c.strip()] if completed else []
        blockersList = [b.strip() for b in blockers.split('\n') if b.strip()] if blockers else []
        state: dict[str, object] = {
            'phase': targetPhase,
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
        'update_heuristics',
        "Manage learned behavioral heuristics. Add a rule when you notice a recurring user preference (e.g. 'Project uses Yarn, not NPM'). Rules persist across sessions. Actions: add, remove, clear, list.",
        _updateHeuristics,
        {
            'type': 'object',
            'properties': {
                'action': {
                    'type': 'string',
                    'description': 'Action to perform: add | remove | clear | list',
                    'enum': ['add', 'remove', 'clear', 'list'],
                },
                'rule': {'type': 'string', 'description': 'The heuristic rule text (required for add/remove).'},
            },
            'required': ['action'],
        },
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
                'completed': {
                    'type': 'string',
                    'description': 'Newline-separated list of completed items for this step.',
                },
                'blockers': {'type': 'string', 'description': 'Newline-separated list of blockers.'},
                'verificationCommand': {
                    'type': 'string',
                    'description': 'Command to verify this step is complete (optional, for Verifier Reflex).',
                },
            },
            'required': [],
        },
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
