"""Recurring-task daemon (B7) — user-defined reminders that fire at the
right moment.

Trigger grammar (plain text, matched case-insensitively):
  * "every N minutes|hours|days"  — interval-based; fires when the interval
    has elapsed since the last fire.
  * "when I open <X>" / "on open" — fires once per 24h when a workbench
    session starts (workspace-aware: ``<X>`` matches the workspace name).
  * anything else — treated as "on open" with a workspace match.

Firing never raises: it records ``last_fired_at`` and returns the messages
so the caller can surface them (SSE → notification bell / toast).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)

_INTERVAL_RE = re.compile(r'every\s+(\d+)\s*(minute|minutes|min|hour|hours|hr|day|days)', re.IGNORECASE)
_OPEN_RE = re.compile(r'(when\s+i\s+open|when\s+opening|on\s+open|whenever\s+i\s+open)', re.IGNORECASE)
_DAY_SECONDS = 24 * 60 * 60


def _conn():
    from app.services.memory_store import _conn as getConn

    return getConn()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def list_tasks(active_only: bool = True) -> list[dict]:
    try:
        if active_only:
            rows = _conn().execute(
                'SELECT id, trigger, message, model, active, created_at, last_fired_at '
                'FROM recurring_tasks WHERE active = 1 ORDER BY id DESC'
            ).fetchall()
        else:
            rows = _conn().execute(
                'SELECT id, trigger, message, model, active, created_at, last_fired_at '
                'FROM recurring_tasks ORDER BY id DESC'
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug('recurring tasks list failed: %s', exc)
        return []


def add_task(trigger: str, message: str, model: str = '') -> int | None:
    trigger = (trigger or '').strip()
    message = (message or '').strip()
    if not trigger or not message:
        return None
    try:
        conn = _conn()
        conn.execute(
            'INSERT INTO recurring_tasks (trigger, message, model) VALUES (?, ?, ?)',
            (trigger[:300], message[:2000], (model or '').strip()[:120]),
        )
        conn.commit()
        return conn.execute('SELECT last_insert_rowid()').fetchone()[0]
    except Exception as exc:
        logger.error('recurring task add failed: %s', exc)
        return None


def delete_task(task_id: int) -> bool:
    try:
        conn = _conn()
        cur = conn.execute('DELETE FROM recurring_tasks WHERE id = ?', (task_id,))
        conn.commit()
        return cur.rowcount > 0
    except Exception as exc:
        logger.debug('recurring task delete failed: %s', exc)
        return False


def _interval_seconds(trigger: str) -> int | None:
    m = _INTERVAL_RE.search(trigger)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit.startswith('day'):
        return max(60, n * 86400)
    if unit.startswith('hour') or unit.startswith('hr'):
        return max(60, n * 3600)
    return max(60, n * 60)


def _matches_workspace(trigger: str, workspace_name: str) -> bool:
    if not workspace_name:
        return True
    # "when I open <X>" — match X against the workspace folder name.
    m = re.search(r'(?:open|opening)\s+(?:up\s+)?["\']?([^"\']+)["\']?', trigger, re.IGNORECASE)
    if m:
        target = m.group(1).strip().strip('.')
        if not target:
            return True
        return target.lower() in workspace_name.lower() or workspace_name.lower() in target.lower()
    return True


_AGENT_DIRECTIVE_RE = re.compile(r'\[agent:([\w.-]+)(?:\s+model:([\w.\-/@]+))?\]', re.IGNORECASE)


def parse_agent_directive(message: str) -> tuple[str, str, str]:
    """Extract an optional ``[agent:ID model:MODEL]`` directive from a task message.

    Returns ``(clean_message, agent_id, model)`` — the directive is stripped
    from the message, and blank strings mean "not set". Lets a recurring task
    dispatch a sub-agent with a chosen agent + model on schedule.
    """
    m = _AGENT_DIRECTIVE_RE.search(message or '')
    if not m:
        return (message or '', '', '')
    clean = _AGENT_DIRECTIVE_RE.sub('', message).strip()
    return (clean, m.group(1) or '', m.group(2) or '')


def check_and_fire(session_id: str, workspace_path: str = '') -> list[tuple[str, str]]:
    """Evaluate all active tasks against a session start / turn.

    Returns ``(message, model)`` pairs of tasks that fire now — ``model`` is
    the task's pinned sub-agent model ('' when unset; the ``[agent:ID
    model:MODEL]`` text directive still wins when present). Records each
    task's ``last_fired_at``. Never raises.
    """
    fired: list[tuple[str, str]] = []
    try:
        from pathlib import Path

        workspace_name = Path(workspace_path).name if workspace_path else ''
        now = datetime.now(timezone.utc)
        for task in list_tasks(active_only=True):
            trigger = as_str(task.get('trigger'), '')
            message = as_str(task.get('message'), '')
            last = task.get('last_fired_at')
            interval = _interval_seconds(trigger)
            if interval is not None:
                # Interval task: fire when elapsed since last fire.
                if last:
                    try:
                        last_dt = datetime.fromisoformat(str(last))
                        if last_dt.tzinfo is None:
                            last_dt = last_dt.replace(tzinfo=timezone.utc)
                        if (now - last_dt).total_seconds() < interval:
                            continue
                    except (ValueError, TypeError):
                        pass
            else:
                # "On open" task: fire at most once per 24h.
                if last:
                    try:
                        last_dt = datetime.fromisoformat(str(last))
                        if last_dt.tzinfo is None:
                            last_dt = last_dt.replace(tzinfo=timezone.utc)
                        if (now - last_dt).total_seconds() < _DAY_SECONDS:
                            continue
                    except (ValueError, TypeError):
                        pass
                if not _matches_workspace(trigger, workspace_name):
                    continue
            try:
                conn = _conn()
                conn.execute(
                    'UPDATE recurring_tasks SET last_fired_at = ? WHERE id = ?',
                    (_now_iso(), task['id']),
                )
                conn.commit()
            except Exception:
                pass
            fired.append((message, as_str(task.get('model'), '')))
    except Exception as exc:
        logger.debug('recurring task check failed: %s', exc)
    return fired
