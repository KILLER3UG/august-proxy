"""Per-turn volatile state blocks — the tail of the last user message.

Split out of workbench.py (Part 22, prompt/loop separation). These render
the state that must NOT live in the cached system prompt — plan/goal/todos
(<plan_state>), date/title/scratchpad/failure/ambient lines
(<session_state>) — and the mid-turn transcript re-injection used after
compaction. The workbench loop calls them at the same seams as before;
workbench.py re-exports every name for back-compat, so ``wb._planStateBlock``
(tests, receipts) keeps resolving to the same function objects.

Why a separate module: the same reason the per-turn tail lives outside the
prefix cache — state rendering churns while the loop machinery is stable.
Every test for this behavior lives in tests/test_plan_state_t7.py against
the workbench re-exports.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from app.json_narrowing import as_dict, as_int, as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession


def _planStateBlock(session: WorkbenchSession) -> str:
    """Compact plan/todo state block for re-injection.

    Plan/todo state lives on the session, outside the transcript, so it
    survives compaction by construction. Pre-turn it is carried by the
    per-turn <session_state> tail block on the last user message (Phase L —
    the system prompt's <session> block is byte-stable and holds no state);
    mid-turn the tail was built at turn start and goes stale the moment
    update_state / submit_todos / submit_plan run — so their receipts
    re-inject this block, and a post-compaction transcript gets it back
    via ``_injectPlanState``.
    """
    lines: list[str] = []
    goal = as_str(getattr(session, 'goal', '') or '').strip()
    if goal:
        lines.append(f'goal: {" ".join(goal.split())[:300]}')
    plan = getattr(session, 'plan', None)
    if isinstance(plan, dict) and plan:
        status = 'approved' if getattr(session, 'planApproved', False) else 'pending'
        md = as_str(plan.get('markdown') or '').strip()
        if md:
            first = next((ln.strip() for ln in md.splitlines() if ln.strip()), '')
            first = first.lstrip('#').strip()
            path = as_str(plan.get('planPath') or '')
            line = f'plan: {status}'
            if first:
                line += f' — {first[:120]}'
            if path:
                line += f' ({path})'
            lines.append(line)
        else:
            steps = plan.get('steps') or plan.get('plan') or []
            if isinstance(steps, list) and steps:
                doneCount = 0
                current = ''
                for st in steps:
                    if isinstance(st, dict):
                        text = as_str(st.get('text') or st.get('title') or st.get('content') or '')
                        isDone = bool(st.get('done')) or as_str(st.get('status') or '').lower() in (
                            'done',
                            'completed',
                            'complete',
                        )
                    else:
                        text, isDone = str(st), False
                    if isDone:
                        doneCount += 1
                    elif not current:
                        current = text
                line = f'plan: {status} — {doneCount}/{len(steps)} steps done'
                if current:
                    line += f', current: {" ".join(current.split())[:120]}'
                lines.append(line)
    execState = getattr(session, '_execution_state', None)
    if isinstance(execState, dict) and execState:
        phase = as_str(execState.get('phase') or '')
        if phase:
            seg = f'execution: phase={phase}'
            step = execState.get('step')
            if step:
                seg += f' step={step}'
            completed = execState.get('completed') or []
            blockers = execState.get('blockers') or []
            if isinstance(completed, list) and completed:
                seg += f' completed={len(completed)}'
            if isinstance(blockers, list) and blockers:
                seg += f' blockers={len(blockers)}'
            lines.append(seg)
    todos = getattr(session, 'todos', None)
    if isinstance(todos, list) and todos:
        doneCount = 0
        nextText = ''
        for t in todos:
            if isinstance(t, dict):
                isDone = bool(t.get('done')) or as_str(t.get('status') or '').lower() in (
                    'done',
                    'completed',
                    'complete',
                )
                text = as_str(t.get('content') or t.get('text') or t.get('title') or '')
            else:
                isDone, text = False, str(t)
            if isDone:
                doneCount += 1
            elif not nextText:
                nextText = text
        seg = f'todos: {doneCount}/{len(todos)} done'
        if nextText:
            seg += f' — next: {" ".join(nextText.split())[:120]}'
        lines.append(seg)
    if not lines:
        return ''
    return '<plan_state>\n' + '\n'.join(lines) + '\n</plan_state>'


def _compactionNotice(session: WorkbenchSession) -> str:
    """Tail notice when the transcript nears the auto-compact threshold.

    The model could only discover compaction AFTER the transcript shrank —
    by then the scratchpad was the only survival. This line gives it one
    turn of warning to call summarize_session / write the scratchpad first.
    Cheap heuristic estimate (chars/4, no SDK tokenizer) — the precise
    budget is computed once per turn elsewhere and emitted to the UI only.
    """
    try:
        from app.services.workbench.token_budget import estimateTokens

        # The window resolver stays in workbench.py (its other three call
        # sites are loop-side); the lazy function-level import keeps one
        # implementation and honors workbench-level monkeypatching.
        from app.services.workbench.workbench import _resolveModelContextWindow

        text = '\n'.join(
            str(m.get('content', '')) if isinstance(m.get('content'), str) else ''
            for m in session.messages[-80:]
        )
        window = _resolveModelContextWindow(
            as_str(getattr(session, 'model', ''), ''), None
        )
        pct = estimateTokens(text, '', '', '') / max(1, window) * 100
        if pct >= 70:
            return (
                'compaction: transcript is near the auto-compact threshold — '
                'call summarize_session and update your scratchpad THIS turn, '
                'or uncommitted reasoning will be lost.'
            )
    except Exception:
        pass
    return ''


def _daemonCountLine(session: WorkbenchSession) -> str:
    """Ambient daemon visibility — leaks otherwise need list_daemons to notice."""
    try:
        from app.services.daemon_manager import getManager

        manager = getManager()
        total = sum(
            1
            for d in manager._daemons.values()
            if as_dict(d.get('result'), {}).get('status') == 'running'
        )
        mine = sum(
            1
            for d in manager._daemons.values()
            if as_str(d.get('session_id'), '') == session.id
            and as_dict(d.get('result'), {}).get('status') == 'running'
        )
        if total > 0:
            return f'daemons running: {total} total, {mine} in this session — kill finished ones.'
    except Exception:
        pass
    return ''


def _sessionStateBlock(session: WorkbenchSession) -> str:
    """Per-turn <session_state> block.

    Carries everything that must NOT live in the cached system prompt:
    the current date (changes at midnight/DST), per-session id/title
    (unique / mutable), goal, plan status, execution phase, scratchpad,
    last tool failure, todos, and the compact plan/todo state. Injected
    into the LAST USER MESSAGE each turn — the same tail-injection point
    as <memory>/<relevant_skills>, outside the provider prefix cache — so
    state changes never bust the cached system block while staying fresh
    in the model's view every turn.
    """
    lines: list[str] = []
    # The date rides the volatile tail: rendering it in the system prompt
    # would invalidate the provider's cached prefix at every midnight/DST
    # boundary. Always present so the model knows "today" on every turn.
    from datetime import datetime as _dt

    lines.append(f'date: {_dt.now().astimezone().strftime("%Y-%m-%d (%Z)")}')
    title = as_str(getattr(session, 'title', '') or '').strip()
    # Placeholder titles carry no information — skip so a fresh chat gets
    # no junk block (the titler replaces the placeholder and it appears here
    # from the next turn).
    if title and title not in ('New Session', 'New chat'):
        lines.append(f'title: {" ".join(title.split())[:160]}')
    # Compact plan/goal/todos/exec state — same renderer the receipts use.
    planPart = _planStateBlock(session)
    if planPart:
        lines.append(planPart)
    working = getattr(session, '_working_memory', None)
    if working:
        lines.append(
            f'scratchpad: {working if isinstance(working, str) else json.dumps(working, default=str, sort_keys=True)}'
        )
    failure = getattr(session, '_failure_feedback', None)
    if failure:
        lines.append(
            f'last_tool_failure: {failure if isinstance(failure, str) else json.dumps(failure, default=str, sort_keys=True)}'
        )
    # Ambient awareness lines: compaction proximity (the model could only
    # discover compaction after the transcript shrank) and live daemons
    # (leaks otherwise need list_daemons to notice).
    compaction = _compactionNotice(session)
    if compaction:
        lines.append(compaction)
    daemonLine = _daemonCountLine(session)
    if daemonLine:
        lines.append(daemonLine)
    if not lines:
        return ''
    return '<session_state>\n' + '\n'.join(lines) + '\n</session_state>'


def _injectPlanState(
    messages: list[dict[str, object]], session: WorkbenchSession
) -> list[dict[str, object]]:
    """Re-inject the plan-state block into a compacted transcript.

    Mid-turn re-injection policy (Q15: always inject): the block is inserted
    right after the compressed-summary message — i.e. above the preserved
    tail and the last user message — so the model re-orientates before the
    recent rounds. Without a summary (no compaction marker found) it goes
    above the last user message. User role: a mid-transcript ``system``
    message breaks the Anthropic wire format. Pre-turn needs no transcript
    copy — the per-turn <session_state> tail block re-renders every build
    (Phase L; the system prompt's <session> block stays byte-stable).
    """
    from app.services.workbench.context_compressor import _isSummaryMessage

    block = _planStateBlock(session)
    if not block:
        return messages
    out = list(messages)
    insertAt = -1
    for i, m in enumerate(out):
        if _isSummaryMessage(m):
            insertAt = i + 1
            break
    if insertAt < 0:
        for i in range(len(out) - 1, -1, -1):
            if out[i].get('role') == 'user':
                insertAt = i
                break
    if insertAt < 0:
        insertAt = len(out)
    out.insert(insertAt, {'role': 'user', 'content': block})
    return out


def _session_cost_usd(session: object) -> float:
    """Estimate a session's cumulative spend (USD) from its token totals.

    Delegates to the shared cost_estimator (per-model pricing table + env
    overrides, cache-aware) — the same source the usage endpoint uses, so
    the composer chip, the spend ceiling, and the Usage page agree.
    """
    from app.services.cost_estimator import session_cost_usd

    return session_cost_usd(
        model_id=as_str(getattr(session, 'model', ''), ''),
        total_in=as_int(getattr(session, 'totalInputTokens', 0), 0),
        total_out=as_int(getattr(session, 'totalOutputTokens', 0), 0),
        cache_hit=as_int(getattr(session, 'cacheHitTokens', 0), 0),
        cache_miss=as_int(getattr(session, 'cacheMissTokens', 0), 0),
    )
