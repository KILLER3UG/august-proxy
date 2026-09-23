"""Post-loop turn close — split out of workbench.py (P3 loop split, slice 1).

The bookkeeping that runs after the managed tool loop exits on every
completed turn (error turns included): the STOP lifecycle hook, M3 usage
feedback + M5 turn telemetry (fact use-count bumps, the turn_outcomes row,
the turnTelemetry SSE event, failure-lesson promotion), the persist/close
block (strip tail patches, turnOpen=False, per-turn usage attach, status,
turnCount, saveSessions(immediate), timeline + session-summary writes,
record_usage) — and the after-first-exchange auto-title schedule. The
`finally:` that resets the cancel ContextVar and emits the `done` event
STAYS in workbench.py: it is syntactically bound to the loop's try, so the
terminal-event protocol is untouched by the move.

Names tests monkeypatch on workbench (saveSessions, _emitSessionStatus,
_toolDefName, queue_memory_habit_nudge) resolve LAZILY through the module
object — patching wb.saveSessions still intercepts the persist path
(test_workbench_tool_loop's boom test depends on exactly that). Code moved
verbatim; the only rewrites are the six loop counters bundled into
``TurnTotals`` and ``_trace``/``_turnStartMs`` becoming parameters.

046: ``turnTelemetry`` also persists the turn verdict — the loop's
``turnEndReason`` / ``parseFailures`` / ``surfaceDowngraded`` become the
``end_reason`` / ``malformed_tool_args`` / ``surface_downgraded`` columns (the
same words the ``turn_end`` SSE event carries), and the two failure sources
the loop never reported through telemetry — the edit-verification gate
(read back off the session's own verify state) and this session's guardrail
blocks (read back off ``tool_guardrail_log``, which has no model column) —
become ``edit_verify_fails`` / ``guardrail_classes`` and feed the widened
failure-lesson path. Missing values are written NULL, never 0: the loop stays
the single authority on WHY it stopped, and turn_close does not guess.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable

from app.json_narrowing import as_int, as_str
from app.services.workbench.sessions import _now

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger('workbench')

Emit = Callable[[dict[str, object]], None]

# The edit-verification failure receipt marker (edit_verification
# ._failure_receipt). Read only to QUOTE a repeated gate miss in a candidate
# lesson — it never decides anything.
_VERIFY_FAIL_MARKER = '[verification FAILED'
_VERIFY_SCAN_MESSAGES = 12


@dataclass
class TurnTotals:
    """The turn's accumulated token/duration counters, handed to close.

    One bundle instead of six params: the same numbers feed the persisted
    per-message usage chip, record_usage and the turnTelemetry event.
    """

    inputTokens: int = 0
    outputTokens: int = 0
    contextTokens: int = 0
    generationMs: float = 0.0
    cacheHitTokens: int = 0
    cacheMissTokens: int = 0
    toolArgsReadyMs: int = 0


def _wb():
    """The workbench module (lazy, so monkeypatches on wb.* apply here)."""
    import app.services.workbench.workbench as workbench

    return workbench


def _alias(extra: dict[str, object], names: tuple[str, ...]) -> object:
    """First non-None value among the ``**extra`` aliases (see turnTelemetry)."""
    for name in names:
        value = extra.get(name)
        if value is not None:
            return value
    return None


def _counterValue(value: object) -> int | None:
    """Normalise a handed-in loop counter; None stays None (not recorded).

    ``as_int`` deliberately rejects ``bool``, and ``surfaceDowngraded`` IS a
    bool in the loop, so the narrow here has to accept it as 1/0 instead of
    turning a real downgrade into a measured zero.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _utcStamp(epochMs: int) -> str:
    """Epoch ms → the ``datetime('now')`` text space tool_guardrail_log uses."""
    try:
        return datetime.fromtimestamp(epochMs / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    except (OverflowError, OSError, ValueError, TypeError):
        return ''


def _edit_verify_streak(session: WorkbenchSession) -> int | None:
    """The turn's trailing edit-verification fail streak, NULL when unmeasured.

    Reads the state edit_verification already owns for this session. A session
    with no state never ran the gate, which must NOT be recorded as 0 — the
    panel distinguishes "the last gate passed" (0) from "there was no gate"
    (NULL).
    """
    state = getattr(session, '_verify_state', None)
    if not isinstance(state, dict):
        return None
    return as_int(state.get('failStreak'), 0)


def _edit_verify_sample(currentMessages: list[dict[str, Any]]) -> str:
    """Quote the newest verification receipt in the turn tail, if there is one."""
    for m in reversed(currentMessages[-_VERIFY_SCAN_MESSAGES:]):
        if not isinstance(m, dict):
            continue
        content = m.get('content')
        parts: list[str] = []
        if isinstance(content, str):
            parts = [content]
        elif isinstance(content, list):
            parts = [
                as_str(b.get('text') or b.get('content'), '') for b in content if isinstance(b, dict)
            ]
        for part in parts:
            idx = part.find(_VERIFY_FAIL_MARKER)
            if idx >= 0:
                return ' '.join(part[idx : idx + 300].split())
    return ''


def lastUserMessageText(session: WorkbenchSession) -> str:
    """Extract text content from the last user message in a session."""
    for msg in reversed(session.messages):
        if msg.get('role') == 'user':
            content = msg.get('content', '')
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                texts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
                return ' '.join(texts)
    return ''

async def emitStopHook(sessionId: str, toolRound: int, turnError: str | None) -> None:
    """STOP lifecycle hook — best-effort, never breaks the close path."""
    try:
        from app.services.hooks.lifecycle import emit_lifecycle
        from app.services.hooks.types import HookEvent as _StopEvent

        await emit_lifecycle(
            _StopEvent.STOP,
            sessionId,
            extra={'rounds': toolRound, 'error': turnError or ''},
        )
    except Exception:
        logger.debug('STOP hook failed (non-fatal)', exc_info=True)


async def turnTelemetry(
    *,
    session: WorkbenchSession,
    sessionId: str,
    currentMessages: list[dict[str, Any]],
    tools: list[dict[str, object]] | None,
    openaiTools: list[dict[str, object]],
    resolvedModel: str,
    resolvedProvider: dict[str, object] | None,
    totals: TurnTotals,
    turnStartMs: int,
    trace: Any,
    turnError: str | None,
    emit: Emit | None,
    toolRound: int,
    turnEndReason: str | None = None,
    parseFailures: int | None = None,
    surfaceDowngraded: bool | int | None = None,
    **extra: object,
) -> None:
    """M3 usage feedback + M5 turn telemetry (moved verbatim from
    _sendWorkbenchMessageStreamImpl).

    046 adds the durable turn verdict. ``turnEndReason`` / ``parseFailures`` /
    ``surfaceDowngraded`` are the loop's own words for WHY it stopped and how
    much it had to self-correct on the way; they are named exactly like the
    loop's locals so the call site passes them straight through. The in-turn
    counters stay authoritative for in-turn behaviour — this only records the
    outcome. Anything not handed in is written NULL ("not recorded") and the
    panel labels it; guessing a reason from ``turnError`` text would put words
    in the loop's mouth, so it is deliberately not done here. ``**extra``
    swallows snake_case aliases (and any further kwargs) rather than raising:
    a TypeError on this await would break every turn over a telemetry field.
    """
    try:
        from app.services import turn_outcomes
        from app.services.memory_store import touch_fact_usage

        # Usage feedback: an injected fact the assistant echoed back (title or
        # key quoted in the reply) earns a use_count bump — the retrieval
        # boost signal. Only facts injected THIS turn are eligible.
        injectedFacts = getattr(session, '_injected_facts', None) or []
        if injectedFacts:
            session._injected_facts = []
            lastAssistantText = ''
            for m in reversed(currentMessages):
                if isinstance(m, dict) and m.get('role') == 'assistant':
                    contentVal = m.get('content', '')
                    if isinstance(contentVal, str):
                        lastAssistantText = contentVal
                    elif isinstance(contentVal, list):
                        lastAssistantText = ' '.join(
                            str(b.get('text', ''))
                            for b in contentVal
                            if isinstance(b, dict) and b.get('type') == 'text'
                        )
                    break
            replyLower = lastAssistantText.lower()
            if replyLower:
                usedKeys = [
                    key
                    for key, title in injectedFacts
                    if key and (key.lower() in replyLower or (len(title) >= 8 and title.lower() in replyLower))
                ]
                if usedKeys:
                    touch_fact_usage(usedKeys)
        # Memory-habit nudge (2026-08-29): a substantial turn that saved no
        # memory queues a one-shot <memory_nudge> tail hint for the NEXT turn
        # — the model's chance to consolidate durable knowledge. Best-effort,
        # never blocks the turn, never touches the system prompt.
        try:
            from app.services import brain_config_service as _nudgeBc

            _nudgeWritesOn = bool(_nudgeBc.getRuntimeConfig().get('modelMemoryWrites', True))
        except Exception:
            _nudgeWritesOn = True
        try:
            _wb().queue_memory_habit_nudge(
                session,
                rounds=toolRound,
                # On the OpenAI/Responses wire `tools` stays []
                # (only `openaiTools` is built), so the remember-offered check
                # was always False and the nudge never fired there.
                rememberOffered=any(
                    _wb()._toolDefName(t) == 'remember' for t in (tools or openaiTools or [])
                ),
                memWritesOn=_nudgeWritesOn,
            )
        except Exception:
            logger.debug('memory habit nudge queue failed', exc_info=True)
        # Telemetry: one structured row per turn, no model calls, never
        # injected into prompts (diagnostics for Observability only).
        _telemetryProvider = (
            as_str(resolvedProvider.get('name') or resolvedProvider.get('id'), '')
            if isinstance(resolvedProvider, dict)
            else ''
        )
        # ── the persisted turn verdict, 046 ─────────────────────────────
        # The loop's own words, handed in as kwargs. Nothing is inferred from
        # turnError text here: a reason turn_close guessed would be a second
        # authority over why the turn ended, and a wrong one.
        _reason = as_str(
            turnEndReason if turnEndReason is not None else _alias(
                extra, ('turn_reason', 'turnReason', 'end_reason', 'endReason', 'reason')
            ),
            '',
        ).strip()
        _malformed = parseFailures if parseFailures is not None else _alias(
            extra, ('parse_failures', 'malformedToolArgs', 'malformed_tool_args')
        )
        _downgraded = surfaceDowngraded if surfaceDowngraded is not None else _alias(
            extra, ('surface_downgraded', 'surfaceDowngraded')
        )
        # Guardrail blocks are read back out of tool_guardrail_log: that table
        # stays the authority for the per-block detail, but it records no
        # model/provider, so nothing could tie a repeated block to the model
        # that keeps causing it until this roll-up landed on the turn's row.
        _guardrailDigest, _guardrailSamples = turn_outcomes.guardrail_class_digest(
            sessionId, _utcStamp(turnStartMs)
        )
        _editVerifyFails = _edit_verify_streak(session)
        turn_outcomes.record_turn_outcome(
            model=resolvedModel or '',
            provider=_telemetryProvider,
            task_type=as_str(getattr(session, 'agent_mode', '') or 'agent'),
            ok=turnError is None,
            error_class=turn_outcomes.classify_error(turnError or ''),
            duration_ms=max(0, int(time.time() * 1000) - turnStartMs),
            session_id=sessionId,
            ttft_ms=int(trace.ttft_ms or 0),
            cache_hit_tokens=int(totals.cacheHitTokens or 0),
            cache_miss_tokens=int(totals.cacheMissTokens or 0),
            tool_args_ready_to_stream_end_ms=totals.toolArgsReadyMs,
            # None on every one of these → SQL NULL → "not recorded". A
            # zero-measured turn and an unmeasured one stay distinguishable.
            end_reason=_reason or None,
            rounds=None if toolRound is None else int(toolRound),
            malformed_tool_args=_counterValue(_malformed),
            surface_downgraded=_counterValue(_downgraded),
            edit_verify_fails=_editVerifyFails,
            guardrail_classes=_guardrailDigest,
        )
        # Surface the per-turn latency/cache numbers as one SSE event
        # (Observability; the transcript can show a cache-hit chip) — turns
        # the "feels slow" regression into visible numbers.
        if emit:
            emit(
                {
                    'type': 'turnTelemetry',
                    'ttftMs': int(trace.ttft_ms or 0),
                    'durationMs': max(0, int(time.time() * 1000) - turnStartMs),
                    'cacheHitTokens': int(totals.cacheHitTokens or 0),
                    'cacheMissTokens': int(totals.cacheMissTokens or 0),
                    'inputTokens': int(totals.inputTokens or 0),
                    'outputTokens': int(totals.outputTokens or 0),
                    # P3.1: the early-dispatch measurement rides the same
                    # telemetry event (0 = no tool call this turn).
                    'toolArgsReadyToStreamEndMs': totals.toolArgsReadyMs,
                }
            )
        # Rare promoted-lesson path (Q2): repeated failures of ONE signature
        # may yield ONE reviewed, deduplicated lesson fact. 046 widens the
        # inputs beyond the upstream error text — a turn whose edit-verification
        # gate kept rejecting the fix, or whose tool calls kept hitting a
        # guardrail, now carries those classes too, each in its own signature
        # space (an `edit_file` guardrail block and an `edit_file` error class
        # are two different lessons). The threshold, the review gate and the
        # `lesson` fact kind are unchanged; nothing here can withhold an
        # answer. Fire-and-forget — the review call must not delay the done
        # event.
        _lessonClasses: list[turn_outcomes.FailureClass] = []
        if _editVerifyFails:
            _lessonClasses.append(
                turn_outcomes.FailureClass(
                    turn_outcomes.KIND_EDIT_VERIFY,
                    '',
                    _edit_verify_sample(currentMessages)
                    or 'the edit-verification gate rejected the last fix attempts',
                )
            )
        for _tool, _sample in _guardrailSamples.items():
            _lessonClasses.append(
                turn_outcomes.FailureClass(
                    turn_outcomes.KIND_GUARDRAIL, _tool, _sample or 'identical-call / loop guardrail'
                )
            )
        if turnError is not None or _lessonClasses:
            asyncio.create_task(
                turn_outcomes.maybe_promote_failure_lesson(
                    model=resolvedModel or '',
                    provider=_telemetryProvider,
                    error_class=turn_outcomes.classify_error(turnError or ''),
                    sample_error=turnError or '',
                    failure_classes=_lessonClasses,
                )
            )
    except Exception:
        logger.debug('turn telemetry failed (non-fatal)', exc_info=True)


def persistAndClose(
    *,
    session: WorkbenchSession,
    sessionId: str,
    currentMessages: list[dict[str, Any]],
    resolvedModel: str,
    totals: TurnTotals,
    trace: Any,
    emit: Emit | None,
) -> None:
    """Close + persist the turn. saveSessions / _emitSessionStatus go
    through _wb() so test monkeypatches keep intercepting."""
    from app.services.workbench.durability import strip_tail_patches as _stripTails

    # The tail-patched last-user message is request-scoped —
    # persist the clean text (the barrier flushes already strip).
    session.messages = _stripTails(list(currentMessages))
    # Close the turn — the persist below records turnOpen=False so a
    # later load does not mistake this session for an orphaned open turn.
    session.turnOpen = False
    # Persist per-turn usage on the last assistant message: the SSE done
    # event is volatile, so without this the usage chip vanished after a
    # restart (fresh load from the session blob) — audit fix.
    try:
        if totals.inputTokens > 0 or totals.outputTokens > 0:
            for m in reversed(session.messages):
                if isinstance(m, dict) and m.get('role') == 'assistant':
                    m['usage'] = {
                        'inputTokens': totals.inputTokens,
                        'outputTokens': totals.outputTokens,
                        'contextTokens': totals.contextTokens,
                        'durationMs': int(totals.generationMs),
                        'cacheHitTokens': totals.cacheHitTokens,
                        'cacheMissTokens': totals.cacheMissTokens,
                    }
                    break
    except Exception:
        logger.debug('per-turn usage attach failed', exc_info=True)
    # Keep awaiting_approval if ask-mode left a pending mutation (ApprovalBanner).
    if session.pendingMutations:
        session.status = 'awaiting_approval'
    else:
        session.status = 'idle'
    session.updatedAt = _now()
    # Monotonic turn counter — drives the auto-compaction cooldown
    # (messageCount shrinks on compaction and cannot serve this role).
    session.turnCount = getattr(session, 'turnCount', 0) + 1
    with trace.span('persist'):
        # Persist session to SQLite (primary); JSON export is best-effort.
        # immediate=True: turnOpen=False was JUST set, and the debounced
        # path leaves a ~150 ms window where a crash loses the final
        # assistant message and recovery paints a phantom [interrupted]
        # marker (audit batch 2026-09-09). The barrier saves are already
        # synchronous; the turn-end close must be too.
        try:
            _wb().saveSessions(immediate=True, dirty=session.id)
        except Exception as exc:
            logger.exception('workbench session persist failed; still emitting done')
            if emit:
                emit(
                    {
                        'type': 'error',
                        'message': f'Session persist failed: {exc}',
                        'code': 'session_persist_failed',
                    }
                )
        # Journey timeline: one entry per completed turn (last user ask).
        try:
            from app.services.memory_store.rest import write_timeline_event

            lastAsk = lastUserMessageText(session)[:240]
            if lastAsk:
                from app.services.session_scope import resolve_scope

                write_timeline_event(
                    session.id, lastAsk, category='workbench',
                    scope=resolve_scope(session=session),
                )
        except Exception:
            logger.debug('workbench timeline write failed', exc_info=True)
        # Session summary (D5): once per session, distill a free local
        # summary into the metadata and the Journey timeline.
        try:
            if (
                session.messageCount >= 4
                and not (session.metadata or {}).get('summary')
                and getattr(session, 'metadata', None) is not None
            ):
                from app.services.workbench.context_compressor import localSummarize

                summary = localSummarize(list(session.messages), maxSummaryChars=800)
                if summary.strip():
                    session.metadata['summary'] = summary.strip()
                    write_timeline_event(
                        session.id,
                        f'Session summary: {summary.strip()[:300]}',
                        category='summary',
                    )
        except Exception:
            logger.debug('session summary failed', exc_info=True)
        _wb()._emitSessionStatus(sessionId)
        if totals.inputTokens > 0 or totals.outputTokens > 0:
            try:
                from app.services.memory_store import record_usage

                record_usage(
                    sessionId=session.id,
                    model=resolvedModel,
                    inputTokens=totals.inputTokens,
                    outputTokens=totals.outputTokens,
                    contextTokens=totals.contextTokens,
                    cacheHitTokens=totals.cacheHitTokens,
                    cacheMissTokens=totals.cacheMissTokens,
                )
                session.totalInputTokens += totals.inputTokens
                session.totalOutputTokens += totals.outputTokens
                session.cacheHitTokens = as_int(
                    getattr(session, 'cacheHitTokens', 0), 0
                ) + totals.cacheHitTokens
                session.cacheMissTokens = as_int(
                    getattr(session, 'cacheMissTokens', 0), 0
                ) + totals.cacheMissTokens
                # The session has carried `totalCost` since the dataclass was
                # written, and the Runs table has rendered it ever since — but
                # nothing assigned it, so every run showed $0.0000 whatever it
                # spent. Accumulated here, the one place the token totals land.
                from app.services.cost_estimator import session_cost_usd

                session.totalCost += session_cost_usd(
                    model_id=resolvedModel,
                    total_in=totals.inputTokens,
                    total_out=totals.outputTokens,
                    cache_hit=totals.cacheHitTokens,
                    cache_miss=totals.cacheMissTokens,
                )
            except Exception:
                logger.exception('workbench record_usage failed')


def scheduleAutoTitle(
    *,
    sessionId: str,
    currentMessages: list[dict[str, Any]],
    resolvedProvider: dict[str, object] | None,
    resolvedModel: str,
) -> None:
    # LLM sidebar title after the first exchange (placeholder titles only).
    # Runs even for headless sessions — automation runs still deserve a
    # readable sidebar title.
    try:
        from app.services.workbench.title_generator import schedule_auto_title_after_turn

        schedule_auto_title_after_turn(
            sessionId,
            list(currentMessages),
            provider=resolvedProvider,
            model=resolvedModel or '',
        )
    except Exception:
        logger.debug('schedule auto-title failed for %s', sessionId, exc_info=True)
