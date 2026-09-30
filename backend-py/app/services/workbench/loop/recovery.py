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


def _overflowProbeText(response: object, _depth: int = 0) -> str:
    """Flatten a provider error envelope into one lowercase haystack.

    The marker table is rich (ten shapes of the same message) but it was being
    matched against a single flat field, ``as_str(response.get('error'))``. Any
    gateway that nests the message — which is most of them — stringified to
    something that contained no marker, so :func:`_isContextOverflowError`
    returned False and the reactive rescue silently never ran. The turn then
    failed on a context overflow with no compaction attempted, and no event to
    show that anything had been skipped.

    Real shapes this has to survive:

    * ``{'error': 'context length exceeded'}``            — flat
    * ``{'error': {'message': 'prompt is too long'}}``    — nested (most common)
    * ``{'code': 'context_length_exceeded'}``             — no message at all
    * ``{'error': {'type': ..., 'message': ...}}``
    * ``{'error': {'error': {'message': ...}}}``          — double-wrapped proxies
    * ``{'message': ..., 'type': 'invalid_request_error'}``
    * ``{'error': [{'message': ...}, ...]}``              — batch/aggregator shapes

    Bounded depth and breadth: an envelope is a handful of levels, and a
    pathological payload must not turn a predicate into a traversal.
    """
    if _depth > 4:
        return ''
    if isinstance(response, str):
        return response.lower()
    if isinstance(response, (int, float, bool)):
        return str(response).lower()
    if isinstance(response, dict):
        parts = [
            _overflowProbeText(v, _depth + 1)
            for _k, v in list(response.items())[:24]
        ]
        return ' '.join(p for p in parts if p)
    if isinstance(response, list):
        parts = [_overflowProbeText(v, _depth + 1) for v in response[:12]]
        return ' '.join(p for p in parts if p)
    return ''


def _isContextOverflowError(response: object) -> bool:
    """True when the failure is a context-window overflow (promotable).

    Matches the marker table against every string reachable in the error
    envelope, not just a top-level flat ``error`` field. See
    :func:`_overflowProbeText` for the shapes this had to survive.
    """
    hay = _overflowProbeText(response)
    if not hay:
        return False
    return any((marker in hay for marker in _CONTEXT_OVERFLOW_MARKERS))


# A rescue that frees a handful of tokens is not a rescue: the retry that
# follows will overflow again, so the turn pays a whole extra request to learn
# nothing. Both paths used to accept ANY reduction (`after < before`), which
# meant a 1-token shave passed the gate and the caller retried into the same
# overflow. Scaled off `before` so a small turn is not held to an absolute
# floor it can never meet, with a hard minimum so the "1 token" case can never
# pass.
_MIN_USEFUL_REDUCTION_TOKENS = 256


def _reductionIsWorthwhile(before: int, after: int) -> bool:
    """Did the compaction free enough headroom to be worth retrying for?

    ``compressMessages`` is a TRIGGER, not a target: any ``threshold`` below the
    current size makes it attempt a reduction. So the only thing standing
    between "the surface got smaller" and "the turn can continue" is this gate,
    and it used to be ``after < before``.
    """
    floor = max(_MIN_USEFUL_REDUCTION_TOKENS, int(before) // 32)
    return int(after) <= int(before) - floor


def _compactionThreshold(before: int, contextWindow: int) -> int:
    """The one trigger threshold both compaction paths use.

    With a known window it is the share of the window the surface may occupy
    (55%). Without one there is no budget to reason about, so the trigger is
    simply "more than the floor" — the old reactive ``before - 1`` was a
    near-tautology that only ever meant "yes, compress", leaving the real
    decision to the gate in :func:`_reductionIsWorthwhile`.
    """
    if contextWindow:
        return max(4096, int(contextWindow * 0.55))
    return 4096


async def _compactionCall(
    messages: list[dict[str, object]],
    *,
    contextWindow: int,
    goalHint: str,
    summarizer: object | None,
) -> list[dict[str, object]]:
    """THE compaction policy — one site, shared by every path that compacts.

    Pre-turn auto-compact, the budget ladder's middle rung and the reactive
    overflow rescue all reduce context for the same session, so they must agree
    on HOW or a rescue is a second context policy wearing the same name. Three
    things used to differ, and the differences were not deliberate:

    * the reactive path passed NO ``replayUserBytes``, so the newest whole user
      messages from the summarized middle were dropped — on the one path that
      runs *after* the model has already overflowed, where the original ask is
      most likely to be sitting in that middle;
    * it hardcoded ``schema=True`` where the budget path computed
      ``schema=summarizer is None``;
    * it hardcoded ``schema=True`` and passed no summarizer, so a provider with
      the LLM compactor enabled still got the heuristic on the overflow path.

    The trigger is the ONLY intended difference now, and it is not even a
    parameter: all three call this with the same policy and differ only in what
    they do with the result.
    """
    from app.services.workbench.context_compressor import (
        REPLAY_USER_BUDGET_BYTES,
        compressMessages,
        pruneToolOutputs,
    )

    pruned = pruneToolOutputs(list(messages))
    return await compressMessages(
        pruned,
        threshold=_compactionThreshold(_tokens(pruned), contextWindow),
        head_count=4,
        tail_count=6,
        summarizer=summarizer,  # type: ignore[arg-type]
        pin_predicates=[_is_update_state_transition, _is_failing_receipt],
        contextWindow=contextWindow or None,
        goalHint=goalHint,
        schema=summarizer is None,
        replayUserBytes=REPLAY_USER_BUDGET_BYTES,
    )


def _tokens(messages: list[dict[str, object]]) -> int:
    from app.providers.clients.base import estimateTokens

    return estimateTokens(messages)


async def _reactiveContextReduction(
    messages: list[dict[str, object]], contextWindow: int, session: WorkbenchSession
) -> list[dict[str, object]] | None:
    """Reactive prune-then-compact for a context-overflow error.

    Runs the same policy as every other compaction path (see
    :func:`_compactionCall`) and returns the reduced list only when the surface
    actually advanced by enough to be worth a retry. ``None`` means the caller
    should fall through to context promotion / the fallback chain — which is
    the right outcome when shaving a few tokens would just overflow again.
    The reduced transcript gets the plan-state block re-injected (T7
    mid-turn policy) so orientation survives the rewrite.
    """
    before = _tokens(messages)
    try:
        reduced = await _compactionCall(
            messages,
            contextWindow=contextWindow,
            goalHint=as_str(getattr(session, 'goal', '') or ''),
            summarizer=None,
        )
        reduced = _injectPlanState(reduced, session)
    except Exception:
        logger.debug('reactive context reduction failed', exc_info=True)
        return None
    after = _tokens(reduced)
    if not _reductionIsWorthwhile(before, after):
        logger.info(
            'workbench reactive context reduction bought nothing useful: %d→%d tokens',
            before,
            after,
        )
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

    Deliberately the SAME policy as every other compaction path — it calls
    :func:`_compactionCall`, so a budget rescue cannot become a second, subtly
    different context policy for the same session. Returns the reduced list only
    when the surface shrank by enough to be worth having; ``None`` means the
    caller keeps what it had.
    """
    from app.services.workbench.context_compressor import (
        acquireCompactionLock,
        releaseCompactionLock,
    )

    if not acquireCompactionLock(session):
        logger.info('workbench budget-compact skipped — lock held session=%s', sessionId)
        return None
    try:
        from app.services.workbench.context_compressor import pruneToolOutputs

        originalTokens = _tokens(pruneToolOutputs(list(messages)))
        summarizer = None
        try:
            from app.services.cognitive_config import get_features
            from app.services.workbench.providers import make_compactor_llm_client

            if get_features().get('llm_compactor', False):
                summarizer = make_compactor_llm_client(resolvedProvider, resolvedModel)
        except Exception:
            summarizer = None
        compressed = await _compactionCall(
            messages,
            contextWindow=contextWindow,
            goalHint=as_str(getattr(session, 'goal', '') or ''),
            summarizer=summarizer,
        )
        compressedTokens = _tokens(compressed)
        if not _reductionIsWorthwhile(originalTokens, compressedTokens):
            return None
        session.messages = list(compressed)  # type: ignore[attr-defined]
        session.messageCount = len(compressed)  # type: ignore[attr-defined]
        session._last_compaction_turn = currentTurn  # type: ignore[attr-defined]
        # The event lives HERE, not in the ladder's caller: emitting it from
        # both meant a budget compaction published two `compaction` frames,
        # which is a regression introduced when the trigger tag was added.
        # `trigger='budget'` is what makes the three paths distinguishable in
        # the stream; without it this frame is anonymous.
        if emit:
            emit(
                {
                    'type': 'compaction',
                    'trigger': 'budget',
                    'originalTokens': originalTokens,
                    'compressedTokens': compressedTokens,
                    'compressedCount': len(compressed),
                    'headCount': 4,
                    'tailCount': 6,
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
