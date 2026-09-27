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
