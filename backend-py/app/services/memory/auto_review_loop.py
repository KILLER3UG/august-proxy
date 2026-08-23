"""Automatic memory-review + skill-curation loop (0.16.6 follow-up).

The user's rule: everything must be automatic — the user chats, the harness
maintains itself. This loop runs the LLM memory review (the same
``run_memory_review`` the old "Review what I remember" chip triggered) on a
schedule and AUTO-APPLIES the safe subset:

  * improve / merge   → applied via ``apply_review_actions`` (bounded edits,
                        every action journaled in the curation ledger)
  * enhance (pin)     → applied (additive, low risk)
  * remove            → NEVER auto-applied — deletions stay human-approved;
                        they are recorded as open proposals instead.

Skill curation was already automatic (hourly background curator); this module
does not touch it. A KV heartbeat records the last run so the UI can show a
quiet "last self-maintenance" line instead of nagging the user with buttons.
"""

from __future__ import annotations

import logging
import time

from app.json_narrowing import as_dict, as_int, as_list

log = logging.getLogger(__name__)

_KV_KEY = 'auto_memory_review_state'
_DEFAULT_INTERVAL_S = 12 * 3600  # twice a day is plenty for memory hygiene


def _kv() -> object:
    from app.services.memory_store import kv

    return kv


def _read_state() -> dict[str, object]:
    try:
        from app.services.memory_store import get_memory

        raw = get_memory(_KV_KEY)
        if isinstance(raw, dict):
            return raw
    except Exception:
        pass
    return {}


def _write_state(state: dict[str, object]) -> None:
    try:
        from app.services.memory_store import save_memory

        save_memory(_KV_KEY, state)
    except Exception:
        log.debug('auto review: failed to persist state', exc_info=True)


def last_run_summary() -> str:
    """One quiet line for the UI ('' when never run)."""
    st = _read_state()
    at = as_int(st.get('lastRunAt'), 0)
    if not at:
        return ''
    applied = as_int(st.get('applied'), 0)
    skipped = as_int(st.get('skippedRemove'), 0)
    age_h = max(0, int((time.time() - at) / 3600))
    parts = [f'self-maintenance ran {age_h}h ago']
    if applied:
        parts.append(f'{applied} memory improvements applied')
    if skipped:
        parts.append(f'{skipped} removals await your approval')
    return ' · '.join(parts)


async def run_auto_review(*, model: str = '', force: bool = False) -> dict[str, object]:
    """One automatic review pass: review → auto-apply safe actions.

    Returns a small report; failures are logged, never raised (a background
    hygienist must not crash the app).
    """
    st = _read_state()
    now = int(time.time())
    interval = _DEFAULT_INTERVAL_S
    if not force and now - as_int(st.get('lastRunAt'), 0) < interval:
        return {'ran': False, 'reason': 'interval-not-due'}

    applied = 0
    skipped_remove = 0
    reviewed_model = model
    try:
        from app.services.memory.memory_review import apply_review_actions, run_memory_review

        result = await run_memory_review(model or '', origin='', folder_id='', session_id='')
        reviewed_model = str(as_dict(result).get('model') or model or '')
        actions: list[dict[str, object]] = []
        for kind, key in (('improve', 'improve'), ('enhance', 'enhance'), ('merge', 'merge')):
            for row in as_list(result.get(key), []):
                entry = as_dict(row)
                entry['kind'] = kind
                actions.append(entry)
                applied += 1
        for row in as_list(result.get('remove'), []):
            # Deletions are never automatic — park them as proposals.
            entry = as_dict(row)
            skipped_remove += 1
            try:
                from app.services.harness_self_improve import save_proposal

                save_proposal(
                    problem=f"Auto-review suggests removing a memory (id {as_int(entry.get('id'), 0)})",
                    evidence=str(entry.get('why') or '')[:500],
                    proposal='Delete this auto-memory after human confirmation.',
                    rollback='Re-create the memory row from the ledger detail.',
                    kind='observation',
                    payload={'removeMemoryId': as_int(entry.get('id'), 0)},
                )
            except Exception:
                pass
        if actions:
            apply_review_actions(actions)
    except Exception as exc:
        log.warning('auto review failed: %s', exc)
        _write_state({**st, 'lastError': str(exc)[:300], 'lastAttemptAt': now})
        return {'ran': True, 'ok': False, 'error': str(exc)[:200]}

    report = {
        'ran': True,
        'ok': True,
        'applied': applied,
        'skippedRemove': skipped_remove,
        'model': reviewed_model,
        'at': now,
    }
    _write_state({
        'lastRunAt': now,
        'applied': applied,
        'skippedRemove': skipped_remove,
        'model': reviewed_model,
    })
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='self_improvement',
            layer='auto_maintenance.review',
            summary=(
                f'Memory self-maintenance: {applied} improvements applied'
                + (f', {skipped_remove} removals queued for approval' if skipped_remove else '')
            ),
            meta={'type': 'autoReview', **{k: v for k, v in report.items() if k != 'ran'}},
        )
    except Exception:
        pass
    return report


def make_auto_review_task() -> 'object':
    """Create the background asyncio task (started from app lifespan)."""

    import asyncio

    async def _loop() -> None:
        # First run after boot: wait a calm-down period so startup isn't
        # competing with an immediate LLM call.
        await asyncio.sleep(180)
        while True:
            try:
                await run_auto_review()
            except Exception:
                log.debug('auto review loop iteration failed', exc_info=True)
            await asyncio.sleep(1800)  # check twice/hour; run gates by interval

    return asyncio.create_task(_loop())
