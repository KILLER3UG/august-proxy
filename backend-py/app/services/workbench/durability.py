"""T18 fail-closed session durability barriers (plan §9.4).

The durable session log is flushed at exactly three barriers:

1. ``model-dispatch`` — before a model request is dispatched;
2. ``tool-side-effect`` — before a top-level tool body can side-effect
   (nested calls — subagents, code runner — flush their OWN sessions and
   reuse the outer checkpoint, so a tool never triggers a second flush of
   the parent session);
3. ``step-boundary`` — after each completed tool round.

A failed flush aborts the protected operation: losing trajectory state is
worse than stopping. Crash recovery never truncates — a session persisted
mid-turn (``turnOpen``) is closed with a synthetic interrupted marker when
loaded, so replay stays balanced (see WorkbenchSession.fromDict).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger(__name__)

BARRIER_MODEL_DISPATCH = 'model-dispatch'
BARRIER_TOOL_SIDE_EFFECT = 'tool-side-effect'
BARRIER_STEP_BOUNDARY = 'step-boundary'

# Part 26 6.3: the per-turn tail blocks (<memory>, <relevant_skills>,
# <session_state>, <memory_nudge>) are patched onto the last user message for
# THIS request only — they must not ride in persisted history (bloat, stale
# state the model may later trust, phantom mining episodes: the miner's
# injection filter is prefix-only and <memory_nudge> contains correction
# vocabulary). Marked at patch time; stripped before every persist.
_TAIL_PATCH_FLAG = '_tailPatched'
_TAIL_MARKERS = (
    '\n\n<memory',
    '\n\n<relevant_skills',
    '\n\n<session_state',
    '\n\n<memory_nudge',
)


def strip_tail_patches(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Return the list with tail-patched messages reverted to their base text."""
    changed = False
    out: list[dict[str, object]] = []
    for msg in messages:
        if isinstance(msg, dict) and msg.get(_TAIL_PATCH_FLAG):
            changed = True
            clean = {k: v for k, v in msg.items() if k != _TAIL_PATCH_FLAG}
            content = clean.get('content')
            if isinstance(content, str):
                cuts = [content.find(m) for m in _TAIL_MARKERS]
                cuts = [c for c in cuts if c > 0]
                if cuts:
                    clean = {**clean, 'content': content[: min(cuts)].rstrip()}
            msg = clean
        out.append(msg)
    return out if changed else messages


def flush_session_barrier(
    session: 'WorkbenchSession',
    barrier: str,
    messages: list[dict[str, object]] | None = None,
) -> tuple[bool, str]:
    """Durable flush of one session; returns ``(ok, errorText)``.

    When ``messages`` is given the session's transcript is synced from the
    turn's working copy first, so the snapshot includes mid-turn progress
    (session.messages otherwise only syncs at turn end). Exceptions are
    caught and reported — the CALLER decides how to abort (fail-closed).
    """
    try:
        if messages is not None:
            session.messages = strip_tail_patches(list(messages))
            session.messageCount = len(session.messages)
        session.turnOpen = True
        from app.services import memory_store
        from app.services.memory_store import save_workbench_session_sot

        memory_store.init()
        save_workbench_session_sot(session.toDict())
        return True, ''
    except Exception as exc:
        logger.error(
            'T18 durability barrier %s failed session=%s: %s',
            barrier,
            getattr(session, 'id', '?'),
            exc,
        )
        return False, str(exc)
