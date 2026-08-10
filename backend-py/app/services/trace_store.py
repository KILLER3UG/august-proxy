"""Per-turn execution traces (trace store).

One row per workbench turn: prompt hash + preview, tools offered and
called, rounds, self-heal events (malformed JSON, refusals, stall nudges),
graded outcome, tokens and duration. Routing evidence answers "which model
wins what"; traces answer "what happened inside that turn" — replay,
regression diffs after harness changes, and drift alerts.

All writes are fire-and-forget (never raise); reads are simple helpers for
the harness API + drift checks.
"""

from __future__ import annotations

import json
import logging

from app.json_narrowing import as_int, as_str

logger = logging.getLogger(__name__)

_TRACE_CAP = 20000


def _conn():
    from app.services.memory_store import _conn as getConn

    return getConn()


def record_turn_trace(
    *,
    session_id: str,
    turn_seq: int = 0,
    prompt_hash: str = '',
    prompt_preview: str = '',
    task_type: str = 'general',
    model: str = '',
    provider: str = '',
    outcome: str = 'ok',
    rounds: int = 0,
    tools_offered: int = 0,
    tool_calls: list[str] | None = None,
    self_heal_events: dict[str, object] | None = None,
    evidence_state: str = '',
    input_tokens: int = 0,
    output_tokens: int = 0,
    duration_ms: int = 0,
    error: str = '',
) -> None:
    """Record one turn trace (fire-and-forget, never raises)."""
    try:
        _conn().execute(
            'INSERT INTO session_traces '
            '(session_id, turn_seq, prompt_hash, prompt_preview, task_type, model, provider, '
            ' outcome, rounds, tools_offered, tool_calls, self_heal_events, evidence_state, '
            ' input_tokens, output_tokens, duration_ms, error) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                as_str(session_id, '')[:120],
                as_int(turn_seq, 0),
                as_str(prompt_hash, '')[:64],
                as_str(prompt_preview, '')[:300],
                as_str(task_type, 'general')[:40],
                as_str(model, '')[:120],
                as_str(provider, '')[:120],
                as_str(outcome, 'ok')[:20],
                as_int(rounds, 0),
                as_int(tools_offered, 0),
                json.dumps(list(tool_calls or []))[:2000],
                json.dumps(self_heal_events or {})[:1000],
                as_str(evidence_state, '')[:20],
                as_int(input_tokens, 0),
                as_int(output_tokens, 0),
                as_int(duration_ms, 0),
                as_str(error, '')[:2000],
            ),
        )
        _conn().commit()
        _trim()
    except Exception as exc:
        logger.debug('trace record failed (non-fatal): %s', exc)


def _trim() -> None:
    """Cap total trace rows (oldest first) so the store stays bounded."""
    try:
        row = _conn().execute('SELECT COUNT(*) AS n FROM session_traces').fetchone()
        total = row['n'] if hasattr(row, 'keys') else (row[0] if row else 0)
        if total and int(total) > _TRACE_CAP:
            _conn().execute(
                'DELETE FROM session_traces WHERE id IN ('
                'SELECT id FROM session_traces ORDER BY id ASC LIMIT ?)',
                (int(total) - _TRACE_CAP,),
            )
            _conn().commit()
    except Exception:
        pass


def list_session_traces(session_id: str, limit: int = 50) -> list[dict[str, object]]:
    """Recent traces for one session (newest first)."""
    try:
        rows = _conn().execute(
            'SELECT * FROM session_traces WHERE session_id = ? ORDER BY id DESC LIMIT ?',
            (as_str(session_id, '')[:120], max(1, min(int(limit), 500))),
        ).fetchall()
        return [_row(r) for r in rows]
    except Exception as exc:
        logger.debug('trace list failed (non-fatal): %s', exc)
        return []


def recent_traces(limit: int = 100) -> list[dict[str, object]]:
    """Newest traces across sessions."""
    try:
        rows = _conn().execute(
            'SELECT * FROM session_traces ORDER BY id DESC LIMIT ?',
            (max(1, min(int(limit), 500)),),
        ).fetchall()
        return [_row(r) for r in rows]
    except Exception as exc:
        logger.debug('trace list failed (non-fatal): %s', exc)
        return []


def _row(r: object) -> dict[str, object]:
    keys = (
        'id', 'session_id', 'turn_seq', 'prompt_hash', 'prompt_preview', 'task_type',
        'model', 'provider', 'outcome', 'rounds', 'tools_offered', 'tool_calls',
        'self_heal_events', 'evidence_state', 'input_tokens', 'output_tokens',
        'duration_ms', 'error', 'created_at',
    )
    try:
        if hasattr(r, 'keys') and hasattr(r, '__getitem__'):
            out = {k: r[k] for k in keys if k in r.keys()}  # type: ignore[operator]
        else:
            # sqlite3.Row fallback: positional tuple of the same width.
            out = dict(zip(keys, tuple(r)))  # type: ignore[arg-type]
    except (KeyError, IndexError, TypeError):
        return {}
    for k in ('tool_calls', 'self_heal_events'):
        raw = out.get(k)
        if isinstance(raw, str):
            try:
                out[k] = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                out[k] = None
    return out
