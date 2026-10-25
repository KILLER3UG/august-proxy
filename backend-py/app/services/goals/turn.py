"""The turn lifecycle — what one turn does to the work record.

Called from ``turn_close.turnTelemetry``, the one place every turn already reports its round count
and its outcome. That choice is the whole design: the loop does not learn about goals, and a second
round counter cannot disagree with the one the transcript and ``turn_outcomes`` show.

Two rules:
  * a turn that did no work and has no run creates nothing — a plain conversation must not accrue a
    work record nobody asked for;
  * a run that parked at its ceiling is RESUMED, never replaced, so the ceiling cannot be reset by
    starting the next turn.
"""
from __future__ import annotations

import asyncio

from app.services.goals import records as R
from app.services.goals import store as S


def _settle(session_id: str, rounds: int) -> None:
    envs = S.load_envs()
    if not any(e.id == R.ROOT_ID for e in envs):
        return  # the layer has never been seeded: nothing to settle
    env_id = S.env_of_session(session_id)
    existing = S.session_run(env_id, session_id)
    if rounds <= 0 and existing is None:
        return
    run, _notes = S.open_or_resume_run(env_id, session_id=session_id)
    if rounds > 0:
        S.spend_rounds(run.id, rounds)


async def settle_turn(session_id: str, rounds: int) -> None:
    """Settle this turn's rounds onto the session's run, off the event loop."""
    try:
        await asyncio.to_thread(_settle, session_id, rounds)
    except Exception:  # noqa: BLE001 - a goal record must never fail a turn that already answered
        import logging

        logging.getLogger(__name__).debug('goal turn settlement skipped', exc_info=True)
