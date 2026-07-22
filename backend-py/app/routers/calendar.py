"""
Calendar API — internal events (August tasks, reminders, scheduled chats).
External calendar events are fetched via MCP tools on the frontend side.

Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
"""

from __future__ import annotations

from fastapi import APIRouter
from app.json_narrowing import as_bool, as_str

router = APIRouter(prefix='/api/calendar')


def _date_from_iso(value: object) -> str:
    s = as_str(value)
    if not s:
        return ''
    # YYYY-MM-DD from ISO timestamp or date
    return s[:10] if len(s) >= 10 else s


@router.get('/internal')
async def listInternalEvents() -> dict[str, object]:
    """Return August internal events from automations + scheduled cron jobs."""
    events: list[dict[str, object]] = []

    try:
        from app.services import automations_store

        for job in automations_store.list_jobs():
            if not as_bool(job.get('enabled'), True):
                continue
            if as_bool(job.get('paused'), False):
                continue
            next_run = job.get('nextRunAt') or job.get('next_run_at')
            date = _date_from_iso(next_run)
            if not date:
                continue
            title = (
                as_str(job.get('name'))
                or as_str(job.get('title'))
                or as_str(job.get('prompt'))[:80]
                or 'Scheduled chat'
            )
            events.append(
                {
                    'id': f"auto_{as_str(job.get('id'))}",
                    'title': title,
                    'date': date,
                    'kind': 'scheduled_chat',
                    'source': 'internal',
                }
            )
    except Exception:
        pass

    try:
        from app.services import scheduler

        scheduler._loadJobs()
        for job in scheduler.listJobs():
            if not as_bool(job.get('enabled'), True):
                continue
            next_run = job.get('nextRun') or job.get('nextRunAt')
            date = _date_from_iso(next_run) or _date_from_iso(job.get('createdAt'))
            if not date:
                continue
            events.append(
                {
                    'id': f"cron_{as_str(job.get('id'))}",
                    'title': as_str(job.get('name')) or 'Scheduled job',
                    'date': date,
                    'kind': 'reminder',
                    'source': 'internal',
                }
            )
    except Exception:
        pass

    events.sort(key=lambda e: as_str(e.get('date')))
    return {
        'events': events,
        'status': 'ok' if events else 'empty',
        'hint': (
            'No internal events yet. Enable Automations or Cron jobs, '
            'or connect a calendar MCP for external events.'
            if not events
            else ''
        ),
    }
