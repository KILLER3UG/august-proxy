"""Part 21 M-11 — automation persistent memory + Part 19 Phase B routines.

Three brain-DB stores (migration 031) make automation jobs stateful:

* ``automation_runs`` — one immutable row per run attempt (the ledger; the
  job object's ``lastRun``/``lastOutput`` stay as cheap UI summary).
* ``automation_notes`` — per-job KV notepad ("what I decided last time"),
  capped 4 KiB/key, 16 KiB/job. Machine state, deliberately NOT facts.
* ``automation_incidents`` — deduped failures upserted by
  ``(job_id, error_signature)``; a succeeding run auto-closes the open row.

Part 19 Phase B rides on this: a routine (automation job with
``deliver='bot-chat'``) gets a wake-up context block (last run + notepad) and
its result is delivered into the Bot's canonical Bot Chat, optionally as a
responding turn (``respond`` flag, default on) — "cron output lands where
the bot actually responds".
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from app.json_narrowing import as_bool, as_str
from app.services.deferred_writes import defer_commit
from app.services.memory_conn import conn as _conn

logger = logging.getLogger(__name__)

# Notepad caps (service-enforced — SQLite has no cheap per-row cap).
_NOTE_KEY_CAP = 4 * 1024
_NOTE_JOB_CAP = 16 * 1024
# Wake-up context caps (re-injected every run — must stay bounded).
_CONTEXT_LAST_RUN_CAP = 4 * 1024
_CONTEXT_CONTINUITY_CAP = 2 * 1024
# Closed incident rows kept this many days before the sweep deletes them.
_INCIDENT_RETENTION_DAYS = 90

TERMINAL_STATUSES = frozenset({'succeeded', 'failed', 'timeout', 'cancelled'})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── runs ledger ────────────────────────────────────────────────────────────


def start_run(
    *,
    job_id: str,
    trigger: str = 'cron',
    agent_id: str = '',
    session_id: str = '',
) -> int:
    """Insert a ``running`` ledger row; returns its id (0 on failure)."""
    try:
        c = _conn()
        cur = c.execute(
            'INSERT INTO automation_runs (job_id, started_at, status, trigger, agent_id, session_id) '
            "VALUES (?, ?, 'running', ?, ?, ?)",
            (job_id, _now(), trigger or 'cron', agent_id or '', session_id or ''),
        )
        defer_commit(c)
        return int(cur.lastrowid or 0)
    except Exception:
        logger.debug('start_run failed', exc_info=True)
        return 0


def error_signature(text: str) -> str:
    """Normalize a failure into a dedupe fingerprint (exception class + head)."""
    raw = ' '.join((text or '').split())
    if not raw:
        return 'unknown'
    return raw[:120]


def finish_run(
    run_id: int,
    *,
    status: str,
    result_excerpt: str = '',
    error_sig: str = '',
    duration_ms: int = 0,
) -> None:
    """Stamp a terminal state on a ledger row and update the incident row.

    ``status`` must be terminal (``succeeded`` closes the job's open incident;
    ``failed``/``timeout`` bump it). Best-effort — never raises into a run.
    """
    if run_id <= 0 or status not in TERMINAL_STATUSES:
        return
    excerpt = (result_excerpt or '')[:4 * 1024]
    try:
        c = _conn()
        row = c.execute(
            'SELECT job_id FROM automation_runs WHERE id = ?', (run_id,)
        ).fetchone()
        c.execute(
            'UPDATE automation_runs '
            'SET finished_at = ?, status = ?, duration_ms = ?, result_excerpt = ?, error_signature = ? '
            'WHERE id = ?',
            (_now(), status, int(duration_ms or 0), excerpt, error_sig or '', run_id),
        )
        defer_commit(c)
        if row is not None:
            job_id = str(row['job_id'])
            if status == 'succeeded':
                close_incident(job_id)
            elif error_sig:
                record_incident(job_id, error_sig)
    except Exception:
        logger.debug('finish_run failed', exc_info=True)


# ── notepad ─────────────────────────────────────────────────────────────────


def get_notes(job_id: str) -> dict[str, str]:
    try:
        rows = (
            _conn()
            .execute(
                'SELECT note_key, value FROM automation_notes WHERE job_id = ? ORDER BY updated_at',
                (job_id,),
            )
            .fetchall()
        )
        return {str(r['note_key']): str(r['value']) for r in rows}
    except Exception:
        logger.debug('get_notes failed', exc_info=True)
        return {}


def set_note(job_id: str, key: str, value: str) -> str:
    """Upsert one notepad entry. Returns '' on success, else an error reason."""
    if not key.strip():
        return 'empty key'
    value = value or ''
    if len(value.encode('utf-8', errors='replace')) > _NOTE_KEY_CAP:
        return f'value over {_NOTE_KEY_CAP} bytes'
    if not value:
        return delete_note(job_id, key)
    notes = get_notes(job_id)
    others = sum(
        len(v.encode('utf-8', errors='replace'))
        for k, v in notes.items()
        if k != key
    )
    if others + len(value.encode('utf-8', errors='replace')) > _NOTE_JOB_CAP:
        return f'job notepad over {_NOTE_JOB_CAP} bytes'
    try:
        c = _conn()
        c.execute(
            'INSERT INTO automation_notes (job_id, note_key, value, updated_at) '
            'VALUES (?, ?, ?, ?) '
            'ON CONFLICT(job_id, note_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            (job_id, key.strip(), value, _now()),
        )
        defer_commit(c)
        return ''
    except Exception:
        logger.debug('set_note failed', exc_info=True)
        return 'storage error'


def delete_note(job_id: str, key: str) -> str:
    try:
        c = _conn()
        c.execute('DELETE FROM automation_notes WHERE job_id = ? AND note_key = ?', (job_id, key))
        defer_commit(c)
        return ''
    except Exception:
        logger.debug('delete_note failed', exc_info=True)
        return 'storage error'


# ── incidents ───────────────────────────────────────────────────────────────


def record_incident(job_id: str, error_sig: str) -> bool:
    """Upsert the open incident for this signature (bump occurrences).

    Returns True when a NEW incident row was created (first detection),
    False on a bump or failure — callers use that to fire one-time notices.
    """
    sig = error_sig or 'unknown'
    try:
        c = _conn()
        cur = c.execute(
            'UPDATE automation_incidents SET occurrences = occurrences + 1, last_seen_at = ? '
            "WHERE job_id = ? AND error_signature = ? AND state != 'closed'",
            (_now(), job_id, sig),
        )
        if cur.rowcount:
            defer_commit(c)
            return False
        cur = c.execute(
            "INSERT OR IGNORE INTO automation_incidents "
            "(job_id, error_signature, first_seen_at, last_seen_at, state, occurrences) "
            "VALUES (?, ?, ?, ?, 'detected', 1)",
            (job_id, sig, _now(), _now()),
        )
        defer_commit(c)
        return bool(cur.rowcount)
    except Exception:
        logger.debug('record_incident failed', exc_info=True)
        return False


def close_incident(job_id: str) -> None:
    """A succeeding run auto-closes the job's open incidents."""
    try:
        c = _conn()
        c.execute(
            "UPDATE automation_incidents SET state = 'closed', last_seen_at = ? "
            "WHERE job_id = ? AND state != 'closed'",
            (_now(), job_id),
        )
        defer_commit(c)
    except Exception:
        logger.debug('close_incident failed', exc_info=True)


def record_blocked_step(
    *, job_id: str, tool: str, reason: str, session_id: str = ''
) -> None:
    """S-1 rider: an approval that could never be answered in an unattended run.

    Writes a deduped ``blocked-step`` incident (the M-11 ledger row for the
    denial — visible in the RoutinesPane incident badge like any failure) and,
    on FIRST detection, appends a passive notice to the owning Bot's canonical
    chat so the user sees why a routine stopped short. Never raises into the
    turn; interactive and job-less headless sessions record nothing.
    """
    if not job_id:
        return
    new = record_incident(job_id, f'blocked-step: {tool}')
    if not new:
        return
    try:
        from app.services import automations_store

        job = automations_store.get_job(job_id)
        if not job:
            return
        deliver_to_bot_chat(
            job,
            result_text=(
                f'Step blocked: {tool} — {reason}. No approver is available in an '
                'unattended run, so the routine continued without this step. '
                'Re-run it interactively (or approve the command in chat) if the '
                'step is essential.'
            ),
            trigger='blocked-step',
            respond=False,
        )
    except Exception:
        logger.debug('blocked-step notice failed', exc_info=True)


def open_incidents(job_id: str = '') -> list[dict[str, object]]:
    """Open incidents for one job (all jobs when ``job_id`` is empty)."""
    try:
        if job_id:
            rows = (
                _conn()
                .execute(
                    "SELECT * FROM automation_incidents WHERE job_id = ? AND state != 'closed' "
                    'ORDER BY last_seen_at DESC',
                    (job_id,),
                )
                .fetchall()
            )
        else:
            rows = (
                _conn()
                .execute(
                    "SELECT * FROM automation_incidents WHERE state != 'closed' "
                    'ORDER BY last_seen_at DESC'
                )
                .fetchall()
            )
        return [dict(r) for r in rows]
    except Exception:
        logger.debug('open_incidents failed', exc_info=True)
        return []


# ── wake-up context ─────────────────────────────────────────────────────────


def last_run(job_id: str) -> dict[str, object] | None:
    """The most recent ledger row for a job (any status)."""
    try:
        row = (
            _conn()
            .execute(
                'SELECT * FROM automation_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1',
                (job_id,),
            )
            .fetchone()
        )
        return dict(row) if row is not None else None
    except Exception:
        logger.debug('last_run failed', exc_info=True)
        return None


def runs_for_job(job_id: str, limit: int = 10) -> list[dict[str, object]]:
    try:
        rows = (
            _conn()
            .execute(
                'SELECT * FROM automation_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?',
                (job_id, max(1, int(limit))),
            )
            .fetchall()
        )
        return [dict(r) for r in rows]
    except Exception:
        logger.debug('runs_for_job failed', exc_info=True)
        return []


def wake_context(job: dict[str, object]) -> str:
    """Volatile wake-up block prepended to a workbench automation prompt.

    Bounded: last-run status + result excerpt (4 KiB), the job's notepad
    (4 KiB total), and — only when the job sets ``continuity: true`` — the
    previous run's result tail (2 KiB) as "what you did last time". Empty
    string when there is no history (first run stays exactly the authored
    prompt).
    """
    job_id = as_str(job.get('id'))
    if not job_id:
        return ''
    last = last_run(job_id)
    notes = get_notes(job_id)
    if last is None and not notes:
        return ''

    parts: list[str] = ['<routine_context>', '(This block is refreshed every run — volatile context, not memory.)']
    if last is not None:
        status = as_str(last.get('status'))
        excerpt = as_str(last.get('result_excerpt'))[:_CONTEXT_LAST_RUN_CAP]
        finished = as_str(last.get('finished_at')) or as_str(last.get('started_at'))
        parts.append(f'Last run ({finished}): {status or "unknown"}.')
        if excerpt:
            parts.append(f'Last run result excerpt:\n{excerpt}')
        if as_bool(job.get('continuity')):
            tail = excerpt[-_CONTEXT_CONTINUITY_CAP:]
            if tail:
                parts.append(f'What you did last time (tail):\n{tail}')
    if notes:
        budget = _CONTEXT_LAST_RUN_CAP
        lines: list[str] = []
        for k, v in notes.items():
            entry = f'{k}: {v}'
            if len(entry) > budget:
                entry = entry[:budget]
            lines.append(entry)
            budget -= len(entry)
            if budget <= 0:
                break
        parts.append('Your notepad from previous runs:\n' + '\n'.join(lines))
    parts.append('</routine_context>')
    return '\n'.join(parts)


def sweep(days: int = 30, *, now: datetime | None = None) -> int:
    """Retention sweep — runs ledger at 30 d, closed incidents at 90 d.

    Rides the same maintenance window as the ``turn_outcomes`` sweep; one
    lifecycle row records what was removed.
    """
    now = now or datetime.now(timezone.utc)
    removed = 0
    try:
        c = _conn()
        # Runs retention is `days` (30), not "everything before today" —
        # a plain now.date() cutoff would wipe the whole ledger on every
        # sweep and the wake-context would forget its history.
        cutoff = (now - timedelta(days=days)).date().isoformat()
        cur = c.execute(
            "DELETE FROM automation_runs WHERE started_at < ?",
            (cutoff,),
        )
        removed += cur.rowcount or 0
        cur = c.execute(
            "DELETE FROM automation_incidents "
            "WHERE state = 'closed' AND last_seen_at != '' "
            "AND julianday(last_seen_at) IS NOT NULL "
            "AND julianday(last_seen_at) < julianday('now', ?)",
            (f'-{_INCIDENT_RETENTION_DAYS} days',),
        )
        removed += cur.rowcount or 0
        c.commit()
    except Exception:
        logger.debug('automation_memory sweep failed', exc_info=True)
        return 0
    if removed:
        try:
            from app.services.memory_store import record_lifecycle

            record_lifecycle(
                '',
                'automation_memory_sweep',
                {'removedRows': removed, 'retentionDays': int(days)},
            )
        except Exception:
            logger.debug('sweep lifecycle row failed', exc_info=True)
    return removed


# ── Part 19 Phase B: routine delivery into the canonical Bot Chat ──────────


def deliver_to_bot_chat(
    job: dict[str, object],
    *,
    result_text: str,
    trigger: str = 'cron',
    respond: bool = True,
) -> str:
    """Append a routine's result into the Bot's canonical chat.

    ``respond=False`` (or no deliverable bot) appends the text as a plain
    user-role message — visible history, no turn. ``respond=True`` runs one
    workbench turn so the Bot reacts to its own routine output (the §1c
    delta: "cron output lands in a chat where the bot actually responds").

    Returns a status string for the run record; never raises into the caller.
    """
    from app.services.bot_mode import roster

    agent_id = as_str(job.get('agentId'))
    if not agent_id:
        return 'no-agent'
    try:
        chat = roster.find_canonical_bot_chat(agent_id)
        if chat is None:
            chat = roster.ensure_canonical_bot_chat(agent_id)
        session_id = as_str(getattr(chat, 'id', ''))
        if not session_id:
            return 'no-session'
        job_name = as_str(job.get('name')) or job_id_label(job)
        body = f'[routine:{job_name}] (trigger: {trigger}) result:\n' + (result_text or '')[:8000]
        from app.services.workbench import sessions as sessions_mod

        if not respond:
            # Passive delivery: append as visible user-role history, no turn.
            session = sessions_mod.get_workbench_session(session_id)
            if session is not None:
                session.messages.append({'role': 'user', 'content': body})
                session.messageCount += 1
                session.updatedAt = _now()
                sessions_mod.save_sessions()
            return 'delivered-passive'
        # respond=True: the turn loop appends the message itself
        # (workbench.py:2440) — appending here too would duplicate it in the
        # transcript, so the delivery IS the responding turn's user message.
        import asyncio

        async def _turn() -> None:
            try:
                from app.services.workbench import workbench as wb

                await wb.sendWorkbenchMessageStream(
                    sessionId=session_id,
                    message=body,
                    agentId=agent_id,
                )
            except Exception:
                logger.debug('routine respond turn failed', exc_info=True)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None and loop.is_running():
            loop.create_task(_turn())
        else:
            asyncio.run(_turn())
        return 'delivered-respond'
    except Exception:
        logger.debug('deliver_to_bot_chat failed', exc_info=True)
        return 'delivery-error'


def job_id_label(job: dict[str, object]) -> str:
    return as_str(job.get('id')) or 'job'
