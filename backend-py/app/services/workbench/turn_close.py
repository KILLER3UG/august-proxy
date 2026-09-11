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
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from app.json_narrowing import as_int, as_str
from app.services.workbench.sessions import _now

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger('workbench')

Emit = Callable[[dict[str, object]], None]


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
) -> None:
    """M3 usage feedback + M5 turn telemetry (moved verbatim from
    _sendWorkbenchMessageStreamImpl)."""
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
        if turnError is not None:
            # Rare promoted-lesson path (Q2): repeated failures of one
            # signature may yield ONE reviewed, deduplicated lesson fact.
            # Fire-and-forget — the review call must not delay the done event.
            asyncio.create_task(
                turn_outcomes.maybe_promote_failure_lesson(
                    model=resolvedModel or '',
                    provider=_telemetryProvider,
                    error_class=turn_outcomes.classify_error(turnError),
                    sample_error=turnError,
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
