"""Context-overflow + budget recovery for the managed tool loop (P1#11 split).

Moved from workbench.py: the context-window overflow detection, the reactive
prune-then-compact rescue, the turn budget ladder (soft USD / token /
wall-clock arms), and the compaction the ladder's middle rung buys. The
transcript landmark pins the two compaction paths share live here too, so
loop/ never has to reach back into workbench.py for them.

workbench.py re-exports every name here under its original name, so the loop
body, subagent.py and the tests keep resolving them on the workbench module.

One-way import rule: nothing under loop/ imports workbench.py.
"""

from __future__ import annotations

import logging
import re
from typing import Callable

from app.json_narrowing import as_dict, as_float, as_int, as_list, as_str
from app.services.workbench.sessions import WorkbenchSession
from app.services.workbench.state_blocks import _injectPlanState

logger = logging.getLogger('workbench')

_CONTEXT_OVERFLOW_MARKERS = (
    'context length',
    'context window',
    'maximum context',
    'context_length',
    'context_window',
    'too many tokens',
    'token limit',
    'max_tokens',
    'prompt is too long',
    'input is too long',
)


def _isContextOverflowError(response: dict[str, object]) -> bool:
    """True when the failure is a context-window overflow (promotable)."""
    msg = as_str(response.get('error')).lower()
    return any((marker in msg for marker in _CONTEXT_OVERFLOW_MARKERS))


async def _reactiveContextReduction(
    messages: list[dict[str, object]], contextWindow: int, session: WorkbenchSession
) -> list[dict[str, object]] | None:
    """Reactive prune-then-compact for a context-overflow error.

    Runs the same reduction as pre-turn (projection prune, then summarize
    with the token-budgeted verbatim tail) and returns the reduced list only
    when the surface actually advanced (token count dropped). None means the
    caller should fall through to context promotion / the fallback chain.
    The reduced transcript gets the plan-state block re-injected (T7
    mid-turn policy) so orientation survives the rewrite.
    """
    from app.providers.clients.base import estimateTokens
    from app.services.workbench.context_compressor import compressMessages, pruneToolOutputs

    before = estimateTokens(messages)
    try:
        reduced = pruneToolOutputs(messages)
        threshold = max(4096, int(contextWindow * 0.55)) if contextWindow else before - 1
        reduced = await compressMessages(
            reduced,
            threshold=threshold,
            head_count=4,
            tail_count=6,
            contextWindow=contextWindow or None,
            goalHint=as_str(getattr(session, 'goal', '') or ''),
            schema=True,
            pin_predicates=[_is_update_state_transition, _is_failing_receipt],
        )
        reduced = _injectPlanState(reduced, session)
    except Exception:
        logger.debug('reactive context reduction failed', exc_info=True)
        return None
    after = estimateTokens(reduced)
    if after >= before:
        return None
    logger.info('workbench reactive context reduction: %d→%d tokens', before, after)
    return reduced


# Turn budget ladder (audit P1#12). A turn that outgrows its soft budget is
# DEGRADED in steps rather than cut off: bare tool surface, then compaction,
# then one tool-free answer — and the turn ends as turn_end{reason: 'budget'}.
# The rungs are ordered cheapest-to-act on first, so a budget that is only
# slightly over buys a cheaper round instead of a truncation.
_BUDGET_LADDER = ('surface', 'compaction', 'final')


def _turnBudget() -> tuple[float, int, int]:
    """(soft USD, soft tokens, wall-clock seconds) armed for this turn.

    Mirrors ``_managedToolLoopCap``: brain-config overrides, an absent key (or
    0) leaves that arm off, and all-off means the ladder never runs. These are
    SOFT ceilings — a breach degrades the turn, it does not abort it.
    """
    try:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = getRuntimeConfig()
        return (
            max(0.0, as_float(cfg.get('budgetSoftUsd'), 0.0)),
            max(0, as_int(cfg.get('budgetSoftTokens'), 0)),
            max(0, as_int(cfg.get('budgetWallClockSec'), 0)),
        )
    except Exception:
        logger.debug('turn budget read failed; ladder stays off', exc_info=True)
        return (0.0, 0, 0)


def _budgetBreached(
    arms: tuple[float, int, int],
    *,
    spend_usd: float = 0.0,
    tokens: int = 0,
    elapsed_sec: float = 0.0,
) -> bool:
    """True when any ARMED soft budget has been met.

    A 0 arm is switched off, not met — with every arm off this is always False,
    so an unconfigured install never walks the ladder.
    """
    soft_usd, soft_tokens, wall_sec = arms
    if soft_usd > 0 and spend_usd >= soft_usd:
        return True
    if soft_tokens > 0 and tokens >= soft_tokens:
        return True
    return wall_sec > 0 and elapsed_sec >= wall_sec


def _nextBudgetStep(current: int) -> int:
    """The rung a fresh breach escalates to, clamped at the last one.

    A turn that stays over budget after the final rung does not keep
    escalating — it ends, which is the whole point of the last rung.
    """
    return min(int(current) + 1, len(_BUDGET_LADDER))


def _turnSpendUsd(model_id: str, cache_hit: int, cache_miss: int, out_tokens: int) -> float:
    """This turn's spend so far, in USD.

    Routed through cost_estimator — the single pricing source — so the budget
    arm and the composer chip / Usage page can never disagree. The cache split
    is already resolved by the loop, and when it is known ``total_in`` is
    ignored upstream, so the same cache-aware arithmetic applies.
    """
    try:
        from app.services.cost_estimator import session_cost_usd

        return session_cost_usd(
            model_id=model_id,
            total_in=cache_miss,
            total_out=out_tokens,
            cache_hit=cache_hit,
            cache_miss=cache_miss,
        )
    except Exception:
        # A budget that cannot be priced must not fail the turn it is
        # measuring; the other arms still work.
        logger.debug('turn spend estimate failed; cost arm reads 0', exc_info=True)
        return 0.0


async def _budgetTriggeredCompaction(
    session: object,
    sessionId: str,
    messages: list[dict[str, object]],
    *,
    contextWindow: int,
    emit: Callable[[dict[str, object]], None] | None,
    resolvedProvider: dict[str, object] | None,
    resolvedModel: str,
    currentTurn: int,
) -> list[dict[str, object]] | None:
    """Mid-turn compaction forced by the budget ladder.

    Deliberately the SAME compaction the pre-turn auto-compact runs (same
    prune → summarize → persist, same landmark pins) — a budget rescue that
    summarized differently would be a second, subtly different context policy
    for the same session. Returns the reduced list only when the surface
    actually shrank; None means the caller keeps what it had.
    """
    from app.providers.clients.base import estimateTokens
    from app.services.workbench.context_compressor import (
        REPLAY_USER_BUDGET_BYTES,
        acquireCompactionLock,
        compressMessages,
        pruneToolOutputs,
        releaseCompactionLock,
    )

    if not acquireCompactionLock(session):
        logger.info('workbench budget-compact skipped — lock held session=%s', sessionId)
        return None
    try:
        pruned = pruneToolOutputs(list(messages))
        originalTokens = estimateTokens(pruned)
        threshold = max(4096, int((contextWindow or 0) * 0.55)) if contextWindow else 4096
        summarizer = None
        try:
            from app.services.cognitive_config import get_features
            from app.services.workbench.providers import make_compactor_llm_client

            if get_features().get('llm_compactor', False):
                summarizer = make_compactor_llm_client(resolvedProvider, resolvedModel)
        except Exception:
            summarizer = None
        compressed = await compressMessages(
            pruned,
            threshold=threshold,
            head_count=4,
            tail_count=6,
            summarizer=summarizer,
            pin_predicates=[_is_update_state_transition, _is_failing_receipt],
            contextWindow=contextWindow or None,
            goalHint=as_str(getattr(session, 'goal', '') or ''),
            schema=summarizer is None,
            replayUserBytes=REPLAY_USER_BUDGET_BYTES,
        )
        compressedTokens = estimateTokens(compressed)
        if compressedTokens >= originalTokens:
            return None
        session.messages = list(compressed)  # type: ignore[attr-defined]
        session.messageCount = len(compressed)  # type: ignore[attr-defined]
        session._last_compaction_turn = currentTurn  # type: ignore[attr-defined]
        if emit:
            emit(
                {
                    'type': 'compaction',
                    'originalTokens': originalTokens,
                    'compressedTokens': compressedTokens,
                    'compressedCount': len(pruned) - len(compressed),
                    'headCount': 4,
                    'tailCount': 6,
                    'threshold': threshold,
                    'contextWindow': contextWindow,
                    'underThreshold': False,
                }
            )
        return compressed
    except Exception:
        # A failed rescue must not take the turn with it — the caller keeps
        # the surface it had and the ladder moves on.
        logger.warning('workbench budget-compact failed session=%s', sessionId, exc_info=True)
        return None
    finally:
        releaseCompactionLock(session)


_BUDGET_FINAL_DIRECTIVE = (
    '\n\n<turn_budget>\nThis turn has reached its configured budget. Tool calls are no longer '
    'available for this round. Answer NOW in plain text: state what you completed, what you '
    'did not, and what the user should do next. Do not start new work.\n</turn_budget>'
)


# Transcript landmark pins (P4), shared by the pre-turn auto-compact, the
# reactive overflow rescue and the budget compaction. They live here because
# every one of those three paths needs them, and loop/ may not import
# workbench.py. workbench.py re-exports all three names.
def _msgTextLower(msg: dict[str, object]) -> str:
    """Lowercased text of a workbench message (string or text blocks)."""
    content = msg.get('content', '')
    if isinstance(content, str):
        return content.lower()
    if isinstance(content, list):
        parts: list[str] = []
        for b in content:
            if isinstance(b, dict) and b.get('type') in ('text', 'output_text'):
                parts.append(str(b.get('text', '')))
        return '\n'.join(parts).lower()
    return ''


def _is_update_state_transition(msg: dict[str, object]) -> bool:
    """Landmark (P4): an update_state tool call or its 'State updated' receipt.

    The phase/step the model last recorded is key state — a middle-summary
    must not drop it.
    """
    role = msg.get('role', '')
    if role == 'tool':
        lower = _msgTextLower(msg)
        return 'state updated' in lower and 'phase=' in lower
    if role == 'assistant':
        content = msg.get('content', '')
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') == 'update_state':
                    return True
        for tc in as_list(msg.get('tool_calls'), []):
            if isinstance(tc, dict):
                fn = as_dict(tc.get('function'), {})
                if as_str(fn.get('name'), '') == 'update_state':
                    return True
    return False


def _is_failing_receipt(msg: dict[str, object]) -> bool:
    """Landmark (P4): a tool result showing a failing run (test/lint/build).

    The latest failure output is exactly what the model needs to fix the
    task — a 120-char summary line can drop the actual error string.
    """
    if msg.get('role') != 'tool':
        return False
    lower = _msgTextLower(msg)
    if 'failed' in lower or 'error:' in lower:
        return True
    return bool(re.search(r'exit code:\s*[1-9]\d*', lower))
