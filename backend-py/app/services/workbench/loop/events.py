"""Recovery/telemetry event frames for the managed tool loop (P1#11 split).

Moved from workbench.py: the one unified ``recovery`` frame every
self-correction rescue emits (audit P0#6 / D9). workbench.py re-exports
it under its original name, so the loop body, the sub-agent layer and any
external reader keep resolving it on the workbench module.

One-way import rule: nothing under loop/ imports workbench.py.
"""

from __future__ import annotations

from typing import Callable


def _emitRecovery(
    emit: Callable[[dict[str, object]], None] | None,
    kind: str,
    attempt: int,
    outcome: str,
    degraded: bool,
) -> None:
    """One unified frame per self-correction rescue (audit P0#6 / D9).

    Every path that rescues a turn mid-flight — length continuation, reactive
    context reduction, auto-compact, the budget ladder — emits
    ``recovery {kind, attempt, outcome, degraded}`` so the event log shows
    what was rescued and whether the answer shipped degraded. ``degraded=True``
    is the trust signal: the turn looks complete but was truncated or rescued
    into a reduced surface.
    """
    if not emit:
        return
    emit(
        {
            'type': 'recovery',
            'kind': kind,
            'attempt': int(attempt),
            'outcome': outcome,
            'degraded': bool(degraded),
        }
    )


def _emitCompactionEvent(
    emit: Callable[[dict[str, object]], None] | None,
    *,
    trigger: str,
    originalTokens: int,
    originalMessages: int,
    currentMessages: list[dict[str, object]],
    contextWindow: int,
) -> None:
    """One ``compaction`` frame per compaction, tagged with what caused it.

    There are three compaction paths — the pre-turn auto-compact, the budget
    ladder's middle rung, and the reactive overflow rescue — and only the first
    emitted a ``compaction`` event. The other two emitted a ``recovery`` frame
    instead, so a stream reader could not tell a budget compaction from a
    reactive one, nor either from the ladder's non-compaction rungs.

    ``trigger`` is the discriminator: ``pre_turn`` | ``budget`` |
    ``reactive_overflow``. Equal before/after counts mean the compaction RAN AND
    ACHIEVED NOTHING, which is a genuinely different fact from never having run
    — and the reactive path's own before/after comparison is internal, so
    without this frame the two were indistinguishable to anything outside the
    loop.
    """
    if not emit:
        return
    from app.providers.clients.base import estimateTokens as _estTok

    compressedTokens = _estTok(currentMessages)
    emit(
        {
            'type': 'compaction',
            'trigger': trigger,
            'originalTokens': int(originalTokens),
            'compressedTokens': compressedTokens,
            'compressedCount': max(0, int(originalMessages) - len(currentMessages)),
            'contextWindow': int(contextWindow),
        }
    )
