"""Context-overflow, stuck-request + budget recovery for the managed tool loop (P1#11 split).

Moved from workbench.py: the context-window overflow detection, the reactive
prune-then-compact rescue, the turn budget ladder (soft USD / token /
wall-clock arms), and the compaction the ladder's middle rung buys. The
transcript landmark pins the two compaction paths share live here too, so
loop/ never has to reach back into workbench.py for them. The stuck-request
ladder (a history the provider refuses on shape) joins them because it is the
same problem with the same three parts — detect, reduce the surface, retry.

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


def _compactionThreshold(before: int, context_window: int) -> int:
    """The one trigger threshold both compaction paths use.

    With a known window it is the share of the window the surface may occupy
    (55%). Without one there is no budget to reason about, so the trigger is
    simply "more than the floor" — the old reactive ``before - 1`` was a
    near-tautology that only ever meant "yes, compress", leaving the real
    decision to the gate in :func:`_reductionIsWorthwhile`.
    """
    if context_window:
        return max(4096, int(context_window * 0.55))
    return 4096


def _contextRotateArmed() -> bool:
    """Is the second context-relief route armed? An absent key means today's
    single route, so shipping the alternative changes nothing by default.

    Read per compaction rather than memoized: arming it from Settings should take
    effect on the next long turn without a restart, and a compaction is rare
    enough that one config read per event is not a hot path.
    """
    try:
        from app.services import brain_config_service as _bc

        return bool(_bc.getRuntimeConfig().get('contextReliefRotate', False))
    except Exception:
        return False


async def _compactionCall(
    messages: list[dict[str, object]],
    *,
    context_window: int,
    goalHint: str,
    summarizer: object | None,
    thresholdOverride: int | None = None,
) -> tuple[list[dict[str, object]], str, dict[str, int]]:
    """THE compaction policy — one site, shared by every path that compacts.

    Five paths reduce context: the pre-turn auto-compact, the budget ladder's
    middle rung, the reactive overflow rescue, the manual "Free up memory"
    endpoint (which forces its own threshold), and a subagent compacting
    mid-run. They must agree on HOW or a rescue is a second context policy
    wearing the same name. Three things used to differ, and the differences were
    not deliberate:

    * the reactive path passed NO ``replayUserBytes``, so the newest whole user
      messages from the summarized middle were dropped — on the one path that
      runs *after* the model has already overflowed, where the original ask is
      most likely to be sitting in that middle;
    * it hardcoded ``schema=True`` where the budget path computed
      ``schema=summarizer is None``;
    * it hardcoded ``schema=True`` and passed no summarizer, so a provider with
      the LLM compactor enabled still got the heuristic on the overflow path.

    The trigger is the ONLY intended difference now, and it is not even a
    parameter: all five call this with the same policy and differ only in what
    they do with the result. They did not always — the pre-turn path, the manual
    endpoint and the subagent each passed the arguments inline, so the two
    recovery paths could be (and were) reconciled against EACH OTHER while three
    more policies stayed divergent. A subagent compacting mid-run used to get the
    heuristic summarizer, a count-budgeted tail, no tool-output prune, no landmark
    pins and no verbatim replay of the user's own words; the manual button shared
    most of that. `tests/test_compaction_policy_parity.py` now gates the census.

    Returns ``(messages, relief)`` — the route is returned rather than left for
    each caller to recompute, because a path that emitted a frame about a route it
    did not take is the same class of bug this function exists to prevent.
    """
    from app.services.workbench.context_compressor import (
        RELIEF_ROTATE,
        REPLAY_USER_BUDGET_BYTES,
        compressMessages,
        pruneToolOutputs,
        reliefHeadCount,
        reliefStrategy,
    )

    pruned = pruneToolOutputs(list(messages))
    relief = reliefStrategy(pruned, armed=_contextRotateArmed())
    stats: dict[str, int] = {}
    compressed = await compressMessages(
        pruned,
        threshold=(
            int(thresholdOverride)
            if thresholdOverride is not None
            else _compactionThreshold(_tokens(pruned), context_window)
        ),
        head_count=reliefHeadCount(relief),
        tail_count=6,
        summarizer=summarizer,  # type: ignore[arg-type]
        pin_predicates=[_is_update_state_transition, _is_failing_receipt],
        contextWindow=context_window or None,
        goalHint=goalHint,
        schema=summarizer is None,
        replayUserBytes=REPLAY_USER_BUDGET_BYTES,
        rotate=relief == RELIEF_ROTATE,
        reliefStats=stats,
    )
    return compressed, relief, stats


def _tokens(messages: list[dict[str, object]]) -> int:
    from app.providers.clients.base import estimateTokens

    return estimateTokens(messages)


async def _reactiveContextReduction(
    messages: list[dict[str, object]],
    contextWindow: int,
    session: WorkbenchSession,
    statsOut: dict[str, object] | None = None,
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
        reduced, _relief, _stats = await _compactionCall(
            messages,
            context_window=contextWindow,
            goalHint=as_str(getattr(session, 'goal', '') or ''),
            summarizer=None,
        )
        if statsOut is not None:
            statsOut['relief'] = _relief
            statsOut.update(_stats)
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


# A provider that objects to a request's SHAPE — a 400 / invalid_request that
# is not a full window and not transient — has rejected the history, not the
# turn. The loop already refuses to REPLAY those (`_DETERMINISTIC_400_MARKERS`
# keeps them out of the retry policy, correctly: an identical request fails
# identically), but nothing repaired them, and `session.messages` is what the
# NEXT turn sends. A session that trips this twice in a row therefore can never
# send again, and only deleting the chat could fix it. DeepSeek-Bot's `parts.js`
# names the rule — "a provider may turn down one request for reasons of its own;
# a history that breaks every request fails the next turn as well" — and answers
# it with a fresh part carrying the recent lines, then a bare part that leaves
# even those out. Two rungs here, same order of severity: flatten the tool
# pairing the gateway objected to (keeps the whole conversation), then the bare
# newest ask. The strikes are counted out of `turn_outcomes`, the ledger
# `turn_close` already writes per turn: the signal has to outlive the process (a
# poisoned session stays poisoned) and a previous turn's error class is already a
# column, so this needs no new state and no migration.
_STUCK_REQUEST_CLASS = 'bad_request'
# T16(d): deterministic 400s — the request itself is malformed (an orphaned
# tool-use id, a broken message structure). Retrying re-sends the identical
# request forever (a documented field incident); these are
# fatal-or-repair, never transient. Checked before the marker scan so a message
# that happens to contain "timeout" still fails fast.
#
# This table lives HERE rather than in workbench.py because two doors consult it:
# the retry policy (`_isRetryableModelError`, re-exported under the same name)
# and the shape-repair predicate below. A second copy would let the two disagree
# about what "the request's shape is the problem" means — which is the one thing
# this ladder must not guess at.
_DETERMINISTIC_400_MARKERS = (
    'tool_use_id',
    'tool use id',
    'tool_call_id',
    'orphan',
    'no tool call',
    'messages must alternate',
    'unexpected role',
    'invalid role',
    'unrecognized role',
    # These are request-shape rejections — the identical retry
    # fails identically, so classifying them as deterministic stops the
    # useless retry storm (each one verified against real upstream text).
    'budget_tokens',
    'thinking',
    'schema',
    'model not found',
)
# Rows walked back through the session's recorded outcomes. Generous because the
# window is ROWS, not turns: sub-agent fan-out rows share the table and the
# session id and are skipped, so an orchestrator chat with a page of fan-out
# rows newer than the two refused turns would otherwise read streak 0 and never
# repair. Counting stops at 3 (see `_stuckRequestEscape`).
_STUCK_SCAN_ROWS = 60

# Both notes are merged into the last user message (never added beside one) by
# `_stripToolsFromHistory`, because a trailing second user message is itself a
# shape objection on a strict gateway.
_STUCK_FLATTEN_NOTE = (
    '[Proxy Self-Heal] The provider refused the previous request over its message '
    'structure, so this retry repeats the same conversation with every tool call '
    'and result rendered as plain text instead of tool blocks. Nothing was '
    'dropped or deleted. Tools ARE still available — re-run anything you need to '
    'act on rather than trusting a receipt quoted as text.'
)
_STUCK_BARE_NOTE = (
    '[Proxy Self-Heal] The provider refused this conversation twice over its '
    'message structure, so this request carries only the newest user message and '
    'no history. The earlier turns are archived, not deleted. Tell the user the '
    'previous message could not be sent and ask again for whatever you need.'
)


def _requestStuckStreak(session_id: str) -> int:
    """Consecutive recent turns on this session the provider refused on shape.

    Sub-agent fan-out rows share the table and the session id but never carry an
    ``error_class`` (the writer passes none), so they are skipped rather than
    counted. Any other outcome — a clean turn, a rate limit, an overflow —
    breaks the run: the request's shape was not what the provider objected to,
    so dropping history would fix nothing.

    Returns 0 when nothing is recorded, including on a database without the
    table. Absent means "not stuck", never "assume stuck".
    """
    if not session_id:
        return 0
    try:
        from app.services.memory_conn import conn as _brainConn

        rows = _brainConn().execute(
            'SELECT ok, error_class, task_type FROM turn_outcomes '
            'WHERE session_id = ? ORDER BY id DESC LIMIT ?',
            (session_id, _STUCK_SCAN_ROWS),
        ).fetchall()
    except Exception:
        logger.debug('stuck-request streak read failed', exc_info=True)
        return 0
    streak = 0
    for row in rows:
        if as_str(row['task_type'], '') == 'subagent_fanout':
            continue
        if int(row['ok'] or 0) == 1 or as_str(row['error_class'], '') != _STUCK_REQUEST_CLASS:
            break
        streak += 1
        if streak > 2:
            # Past the bare rung the ladder does nothing, so the exact length of
            # a long run is never consulted — stop counting rather than scan the
            # window for a number that cannot change the answer.
            break
    return streak


def _isShapeRefusal(response: object) -> bool:
    """True when the provider objected to this request's message STRUCTURE.

    Two conditions, because the cost of a false positive is rewriting the user's
    transcript. `classify_error`'s bare `400` arm makes *any* two consecutive
    400s look alike — a bad model name, an oversized image, a moderation refusal
    and a broken tool pairing all classify as `bad_request`, but only the last
    is fixed by reshaping the history. So the class decides which ladder this is
    (``context_overflow`` is matched first, so a too-long prompt stays on the
    token-shaped rescue) and the marker table decides whether there is a shape to
    repair. Both read the flattened envelope (`_overflowProbeText`): a gateway
    that nests its message stringified to something with no marker, which is the
    exact bug that made the overflow rescue silently never run.
    """
    from app.services.turn_outcomes import classify_error

    try:
        hay = _overflowProbeText(response)
        if classify_error(hay) != _STUCK_REQUEST_CLASS:
            return False
        return any(m in hay for m in _DETERMINISTIC_400_MARKERS)
    except Exception:
        logger.debug('shape-refusal classify failed', exc_info=True)
        return False


def _hasToolStructure(messages: list[dict[str, object]]) -> bool:
    """True when a request surface carries tool pairing at all.

    The flattening rung only exists to remove pairing, so a history with none is
    the case where it would buy nothing — that goes to the bare rung instead.
    Checked on the shapes both wire formats use: a ``tool`` role row (OpenAI),
    a ``tool_calls`` field (OpenAI), and ``tool_use`` / ``tool_result`` content
    blocks (Anthropic).
    """
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if as_str(msg.get('role'), '') == 'tool' or msg.get('tool_calls') or msg.get('tool_use_id'):
            return True
        content = msg.get('content')
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and as_str(b.get('type'), '') in ('tool_use', 'tool_result'):
                    return True
    return False


def _flattenedRequestSurface(messages: list[dict[str, object]]) -> list[dict[str, object]] | None:
    """Strike one: the same conversation, with its tool pairing rendered as text.

    Keeps every message the model already exchanged — the objection is that a
    ``tool_use_id`` no longer resolves, a result arrived without its call, or a
    role the gateway will not accept rode in from an older turn. Flattening the
    pairing removes all three without discarding the substance, which is why
    this rung comes before dropping anything.
    """
    from app.services.workbench.loop.prompt import _stripToolsFromHistory

    if not _hasToolStructure(messages):
        return None
    return _stripToolsFromHistory(list(messages), note=_STUCK_FLATTEN_NOTE)


def _bareRequestSurface(messages: list[dict[str, object]]) -> list[dict[str, object]] | None:
    """Strike two: the newest user ask and nothing else.

    The bare rung of the reference ladder — "the latest messages carried into a
    rescued part may be what breaks the request". The newest USER message is
    chosen over the newest message of any role because the user's ask is the one
    thing the turn cannot proceed without, and the harness note tells the model
    to say the previous message could not be sent rather than silently answering
    from nothing. If no user message exists, there is nothing to rescue.
    """
    from app.services.workbench.loop.prompt import _stripToolsFromHistory

    latest = next(
        (
            m
            for m in reversed(messages)
            if isinstance(m, dict) and as_str(m.get('role'), '') == 'user'
        ),
        None,
    )
    if latest is None:
        return None
    surface = _stripToolsFromHistory([latest], note=_STUCK_BARE_NOTE)
    return surface or None


def _stuckRequestEscape(
    session: WorkbenchSession, messages: list[dict[str, object]]
) -> tuple[int, str, list[dict[str, object]]] | None:
    """Repair a history the provider refuses, or say there is nothing to do.

    Returns ``(streak, strike, surface)`` where ``strike`` is ``'flattened'``
    (same conversation, tool pairing rendered as text) or ``'bare'`` (newest ask
    only). ``None`` means do not try: this is only the FIRST refused turn (one
    bad 400 may be the provider's own bad day, not the history), the ladder is
    already spent, or no rung can make this surface smaller.

    Each rung drops strictly more structure than the one before it, and the
    streak only advances on a turn that still ends refused, so the ladder
    escalates carried → bare → honest failure. It cannot ping-pong and it cannot
    eat the transcript across turns, because at streak 3 nothing fires at all.
    """
    streak = _requestStuckStreak(as_str(getattr(session, 'id', ''), ''))
    if streak < 1 or streak > 2:
        return None
    if streak == 1:
        flat = _flattenedRequestSurface(messages)
        if flat is not None:
            return (streak, 'flattened', flat)
    bare = _bareRequestSurface(messages)
    if bare is None or len(bare) >= len(messages):
        return None
    return (streak, 'bare', bare)


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
        compressed, relief, stats = await _compactionCall(
            messages,
            context_window=contextWindow,
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
            from app.services.workbench.context_compressor import reliefHeadCount

            emit(
                {
                    'type': 'compaction',
                    'trigger': 'budget',
                    'originalTokens': originalTokens,
                    'compressedTokens': compressedTokens,
                    # Messages REMOVED, not messages remaining: the card renders
                    # this as "summarized N messages", so reporting the result
                    # length told the user the compaction had kept what it kept.
                    'compressedCount': max(0, len(messages) - len(compressed)),
                    # The split the compressor actually used. `headCount`/`tailCount`
                    # were the defaults (4/6), so the card reported "kept the first 4
                    # and last 6" about a compaction that had kept 120 verbatim.
                    'headCount': stats.get('head', reliefHeadCount(relief)),
                    'pinnedCount': stats.get('pinned', 0),
                    'replayedCount': stats.get('replayed', 0),
                    'relief': relief,
                    'tailCount': stats.get('tail', 6),
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

# The tool-round ceiling gets the same one-round treatment as the budget ladder's
# last rung: the work a turn did is worth more delivered than truncated. It is a
# separate string because it has to name the ceiling the model hit — "budget"
# would read as a cost limit, and a model told it ran out of money stops trying to
# finish the task and starts apologising.
_ROUND_CAP_FINAL_DIRECTIVE = (
    '\n\n<round_ceiling>\nThis turn has used its {cap} tool rounds. Tool calls are no longer '
    'available for this round. Answer NOW in plain text: what you completed, what is still '
    'outstanding, and the exact next step. Do not start new work and do not apologise for '
    'the limit — a summary of real progress is the deliverable.\n</round_ceiling>'
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
