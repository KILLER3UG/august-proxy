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
_DEFAULT_INTERVAL_S = 12 * 3600  # idle cadence — boot ALWAYS runs a full pass

# Boot-maintenance state (separate KV so the UI can show "updating…" live).
_BOOT_KEY = 'boot_maintenance_state'

# Process-wide flag: set while a boot pass is running. The status endpoint
# reads this to report `running: true` without touching the loop task.
_bootRunning = False


def boot_running() -> bool:
    return _bootRunning


def read_boot_state() -> dict[str, object]:
    try:
        from app.services.memory_store import get_memory

        raw = get_memory(_BOOT_KEY)
        if isinstance(raw, dict):
            return raw
    except Exception:
        pass
    return {}


def _write_boot_state(state: dict[str, object]) -> None:
    try:
        from app.services.memory_store import save_memory

        save_memory(_BOOT_KEY, state)
    except Exception:
        log.debug('boot maintenance: failed to persist state', exc_info=True)


async def run_boot_maintenance(*, force_review: bool = True) -> dict[str, object]:
    """Full refresh pass on FRESH APP OPEN (user rule: boot ⇒ update everything).

    Runs the fast deterministic sweeps synchronously, then the LLM memory
    review with ``force=True`` (bypasses the 12h idle gate — a fresh open is
    exactly when the user expects everything up to date). Persists progress
    so GET /api/brain/auto-maintenance can show a live 'updating…' state.
    """
    global _bootRunning
    if _bootRunning:
        return {'ran': False, 'reason': 'already-running'}
    import asyncio as _asyncio
    from datetime import datetime as _dt
    from datetime import timezone as _tz

    _bootRunning = True
    started = time.time()
    try:
        _write_boot_state({'running': True, 'startedAt': _dt.now(_tz.utc).isoformat()})
        try:
            from app.services.brain_event_bus import emitBrainEvent

            emitBrainEvent(
                category='self_improvement',
                layer='auto_maintenance.boot',
                summary='Fresh start: updating memories and skills…',
                meta={'type': 'bootMaintenance', 'phase': 'start'},
            )
        except Exception:
            pass

        report: dict[str, object] = {'ran': True}
        # 1) Deterministic sweeps (fast, no LLM): expired-memory TTL prune,
        #    vector-mirror reconciliation, skill stale/archive transitions.
        try:
            from app.services.memory.auto_memory import prune_expired_memories

            report['prunedExpired'] = prune_expired_memories(limit=200)
        except Exception as exc:
            report['prunedExpiredError'] = str(exc)[:150]
        try:
            from app.services.memory.vector_mirror import reconcile_vector_mirror

            mirror = await _asyncio.to_thread(reconcile_vector_mirror)
            report['mirrorRepaired'] = as_int(as_dict(mirror).get('repaired'), 0)
        except Exception as exc:
            report['mirrorError'] = str(exc)[:150]
        try:
            from app.services.skills.curator import shared_curator

            cur = shared_curator().run_curation()
            report['staled'] = len(as_list(as_dict(cur).get('staled'), []))
            report['archivedSkills'] = len(as_list(as_dict(cur).get('archived'), []))
        except Exception as exc:
            report['curatorError'] = str(exc)[:150]

        # 2) LLM memory review — forced on boot.
        review = await run_auto_review(force=force_review)
        report['review'] = {k: v for k, v in as_dict(review).items()}

        report['durationMs'] = int((time.time() - started) * 1000)
    finally:
        # ALWAYS clear the live flag — even when the pass throws mid-way, or
        # the UI would spin "Updating memory & skills…" forever.
        _bootRunning = False
    _write_boot_state({
        'running': False,
        'lastCompletedAt': int(started),
        'applied': as_int(as_dict(report.get('review')).get('applied'), 0),
        'skippedRemove': as_int(as_dict(report.get('review')).get('skippedRemove'), 0),
        'summary': last_run_summary(),
    })
    try:
        from app.services.brain_event_bus import emitBrainEvent

        applied = as_int(as_dict(report.get('review')).get('applied'), 0)
        emitBrainEvent(
            category='self_improvement',
            layer='auto_maintenance.boot',
            summary=(
                f'Fresh-start maintenance done in {report.get("durationMs", 0)}ms'
                + (f' · {applied} improvements applied' if applied else '')
                + (' · (with errors)' if any(k.endswith('Error') for k in report) else '')
            ),
            meta={'type': 'bootMaintenance', 'phase': 'done', **{k: v for k, v in report.items() if k != 'review'}},
        )
    except Exception:
        pass
    return report


async def make_boot_maintenance_task() -> 'object':
    """Fire-and-forget boot pass spawned from lifespan AFTER the server starts."""
    import asyncio

    async def _run() -> None:
        # Small delay so the UI connects first and sees the running state.
        await asyncio.sleep(2.5)
        try:
            await run_boot_maintenance()
        except Exception:
            log.exception('boot maintenance failed')

    return asyncio.create_task(_run())



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

        result = await run_memory_review(
            model or '', origin='', folder_id='', session_id='', force=force
        )
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
