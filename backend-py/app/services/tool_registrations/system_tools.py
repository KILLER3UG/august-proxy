"""System/environment, heuristics, state, and scratchpad tools."""

from __future__ import annotations

import re
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
        # Merge with the current execution state — rewriting from scratch
        # silently drops keys like verification_command, breaking the
        # verifier auto-run on the next turn.
        prevState = as_dict(getattr(session, '_execution_state', None), {})
        state: dict[str, object] = {
            'phase': as_str(prevState.get('phase'), 'research'),
            'step': as_int(prevState.get('step'), 1),
            'completed': as_list(prevState.get('completed'), []),
            'blockers': as_list(prevState.get('blockers'), []),
        }
        if prevState.get('verification_command'):
            state['verification_command'] = prevState['verification_command']
        await updateSessionState(session, executionState=state)
        setattr(session, '_working_memory', text)
        return 'Scratchpad updated.'
    except Exception as exc:
        return f'Error writing scratchpad: {exc}'


_EXIT_CODE_RE = re.compile(r'exit code:\s*(-?\d+)', re.IGNORECASE)
# Order matters: explicit clean-run signals first, then failure markers, then
# weak pass markers — so "2 failed, 10 passed" fails and "0 failed" passes.
_STRONG_PASS_MARKERS = ('0 failed', '0 failures', 'no failures', 'all checks passed', 'build succeeded')
_FAIL_MARKERS = ('failed', 'failure', 'traceback', 'error:', 'assertionerror')
_WEAK_PASS_MARKERS = ('passed', '✓')


def _normalizeCommand(cmd: str) -> str:
    """Normalize a command for matching (whitespace + case insensitive)."""
    return ' '.join((cmd or '').strip().lower().split())


def _verificationVerdict(receipts: list[object], expected_command: str = '') -> tuple[str, str]:
    """Judge this turn's command receipts for the verifier gate.

    Returns (verdict, detail): 'pass' | 'fail' | 'unclear' | 'none'.
    Most recent receipt wins on exit codes; unclear output falls through to
    older receipts, and pure-unclear history is given the benefit of the
    doubt (the gate must not strand tasks whose verification output is
    unconventional).

    When ``expected_command`` is set (the declared ``verification_command``),
    receipts from OTHER commands are skipped — ``echo ok`` must not satisfy
    the gate.
    """
    if not receipts:
        return ('none', '')
    matched_declared = False
    saw_content = False
    for receipt in reversed(receipts):
        text = as_str(as_dict(receipt).get('content'), '').lower() if isinstance(receipt, dict) else ''
        if not text:
            continue
        saw_content = True
        if expected_command:
            cmd = as_str(as_dict(receipt).get('command'), '') if isinstance(receipt, dict) else ''
            if _normalizeCommand(cmd) != _normalizeCommand(expected_command):
                continue
            matched_declared = True
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
    if expected_command and not matched_declared:
        # A verification command was DECLARED but no receipt came from it —
        # the gate must not give the benefit of the doubt to other commands.
        return ('none', 'no receipt from the declared verification command')
    if not saw_content:
        # Every receipt is empty — a command that produced nothing must not
        # clear the gate (previously fell through to 'unclear' → pass).
        return ('none', 'no usable command output recorded this turn')
    return ('unclear', '')


def _messageText(msg: dict[str, object], cap: int = 4000) -> str:
    """Extract plain text from a session message (str or block list)."""
    content = msg.get('content', '')
    if isinstance(content, str):
        return content[:cap]
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and as_str(block.get('type'), '') == 'text':
                parts.append(as_str(block.get('text'), ''))
        return '\n'.join(parts)[:cap]
    return ''


async def _reviewerCritique(session: object) -> tuple[bool, str]:
    """One-shot independent reviewer critique of the final answer.

    Opt-in (``AUGUST_VERIFIER_REVIEWER=1``): after the deterministic gate
    passes, a cheap review model may veto the completion if the answer does
    not satisfy the goal. Any failure to run falls back to allowing — the
    deterministic gate already passed. Memoized per turn so repeated
    ``update_state(phase='complete')`` calls do not re-pay the call.
    """
    try:
        if getattr(session, '_reviewer_checked', False):
            return (True, '')
        import os

        if os.environ.get('AUGUST_VERIFIER_REVIEWER') != '1':
            return (True, '')
        from app.providers import resolver as providerResolver
        from app.services.workbench.providers import make_review_llm_client

        provider = providerResolver.resolve(as_str(getattr(session, 'provider', '') or ''))
        reviewer = make_review_llm_client(provider, '')
        if reviewer is None:
            setattr(session, '_reviewer_checked', True)
            return (True, '')
        msgs = as_list(getattr(session, 'messages', None), [])
        goal = ''
        answer = ''
        for m in reversed(msgs):
            if not isinstance(m, dict):
                continue
            role = as_str(m.get('role'), '')
            if role == 'assistant' and not answer:
                answer = _messageText(m)
            elif role == 'user' and not goal:
                goal = _messageText(m, 2000)
            if answer and goal:
                break
        if not answer:
            setattr(session, '_reviewer_checked', True)
            return (True, '')
        reviewText = (
            await reviewer(
                [
                    {
                        'role': 'system',
                        'content': (
                            'You are a strict correctness reviewer for an AI coding agent. '
                            'The agent must satisfy the user goal and its verification '
                            '(tests/lint/build) must genuinely pass. Reply with exactly '
                            'PASS or FAIL, then one short line explaining why.'
                        ),
                    },
                    {
                        'role': 'user',
                        'content': (
                            f'GOAL:\n{goal}\n\nFINAL ANSWER:\n{answer}\n\n'
                            'Does this answer satisfy the goal? Reply PASS or FAIL.'
                        ),
                    },
                ]
            )
            or ''
        ).strip()[:300]
        setattr(session, '_reviewer_checked', True)
        if reviewText.upper().startswith('FAIL'):
            return (False, reviewText)
        return (True, reviewText)
    except Exception:
        return (True, '')


async def _setAgentMode(mode: str = '') -> str:
    """Switch the session's agent mode.

    Modes:
      chat — answer in text; tool calls are blocked.
      agent — native tool calling (default).
      code — write a fenced ```python block instead; the harness executes it
             with a workspace-bound tool API (read_file / write_file /
             run_command / list_files).
    """
    from app.services.workbench.workbench import get_session

    mode = (mode or '').strip().lower()
    if mode not in ('chat', 'agent', 'code'):
        return "Error: mode must be one of: chat, agent, code."
    session = get_session()
    if not session:
        return 'Error: no active workbench session.'
    setattr(session, 'agent_mode', mode)
    return f'Agent mode set to {mode}.'


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
        # Validate against the known phase set — a typo'd phase (e.g.
        # `completed`) would otherwise skip the verifier gate below while
        # leaving `phase != 'complete'`, stranding the final answer.
        _VALID_PHASES = ('research', 'plan', 'implement', 'review', 'complete')
        if targetPhase not in _VALID_PHASES:
            return (
                f'Error: unknown phase "{targetPhase}". Valid phases: {", ".join(_VALID_PHASES)}. '
                'Use update_state to move research → plan → implement → review → complete.'
            )
        # Verifier gate (enforced, not honor-system): entering review/complete
        # requires a command run THIS turn whose output looks like a pass.
        # Receipts are recorded by the workbench tool loop for command tools
        # and cleared at turn start.
        #
        # Gate triggers:
        #   • entering `review` from an earlier phase (research/plan/implement)
        #   • entering `complete` from anything other than `complete` itself —
        #     this closes the same-turn bypass where `review → complete` in one
        #     turn skipped re-verification (the model could claim completion
        #     without a fresh passing run).
        # No-op updates within the same gated phase (e.g. `review → review` to
        # bump step/blockers) are NOT re-gated.
        entering_review = targetPhase == 'review' and currentPhase not in ('review', 'complete')
        entering_complete = targetPhase == 'complete' and currentPhase != 'complete'
        if entering_review or entering_complete:
            # When a verification command was DECLARED, only receipts from that
            # exact command satisfy the gate (`echo ok` cannot stand in for the
            # declared test command).
            declaredCmd = as_str(as_dict(prevState).get('verification_command'), '') if prevState else ''
            verdict, detail = _verificationVerdict(
                as_list(getattr(session, '_verification_receipts', None), []),
                expected_command=declaredCmd,
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
            if targetPhase == 'complete' and verdict in ('pass', 'unclear'):
                # Reviewer critique (opt-in, one-shot): an independent model may
                # veto a completion whose answer does not satisfy the goal.
                allow, reviewDetail = await _reviewerCritique(session)
                if not allow:
                    return (
                        'Verifier gate: the reviewer model found problems with the answer '
                        f'({reviewDetail}). Fix them, re-run verification, then call '
                        "update_state(phase='complete') again."
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


async def _enterPlanModeFallback() -> str:
    """Defensive fallback — the workbench turn loop intercepts enter_plan_mode
    before dispatch and performs the actual mode switch."""
    return 'enter_plan_mode is handled by the workbench turn loop; this fallback should never run.'


async def _submitPlanFallback(planPath: str = '') -> str:
    """Defensive fallback — the workbench turn loop intercepts submit_plan
    before dispatch and loads the plan markdown file."""
    return 'submit_plan is handled by the workbench turn loop; this fallback should never run.'


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
    tool_registry.register(
        'enter_plan_mode',
        'Switch this session into Plan mode before a non-trivial multi-step change '
        '(multiple files, architectural decisions, risky or destructive operations). '
        'In Plan mode you investigate with read-only tools and write your plan as '
        'markdown to this session\'s plan file under .aug/plans/ (the exact path is '
        'returned by this tool) — the only file you may write — then present it with '
        'submit_plan for user approval. Do NOT call this for simple, clearly-scoped '
        'requests; just do the work. No effect if already in Plan mode.',
        _enterPlanModeFallback,
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'submit_plan',
        'Submit your plan for user approval. First write the plan as clean markdown '
        'to this session\'s plan file (.aug/plans/<sessionId>.md — the exact path is '
        'returned by enter_plan_mode; it is the only file writable in Plan mode and '
        'is private to this session), then call this tool; the file is shown to the '
        'user exactly as written.',
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
        "Switch this session's agent mode: 'chat' (answer in text only; tool calls are "
        "blocked), 'agent' (native tool calling, default), or 'code' (write a fenced "
        '```python block; the harness executes it with a workspace-bound tool API: '
        'read_file(path), write_file(path, content), run_command(cmd), list_files(path)).',
        _setAgentMode,
        {
            'type': 'object',
            'properties': {
                'mode': {
                    'type': 'string',
                    'enum': ['chat', 'agent', 'code'],
                    'description': 'The agent mode to switch to.',
                }
            },
            'required': ['mode'],
        },
    )
