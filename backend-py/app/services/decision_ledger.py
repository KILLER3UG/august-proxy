"""The decision ledger — one row per decision, with its counterfactual.

Why this exists (measured 2026-10-17, ``docs/HARNESS_AND_MEMORY_DEEP_DIVE_2026-10-17.md`` §5-6):

The harness kept five per-turn records and no key between them, and the only
measurement it had — ``harness_outcome`` — compared a 14-day window before an
applied proposal against a 14-day window after it, over ALL episodes, with no
control arm. A quiet fortnight therefore read as "improved". Nothing anywhere
recorded a decision *and* what would have falsified it, so no before/after
number could ever be trusted.

This module records the decision itself: the thesis, the alternatives that were
considered and rejected, the confidence, the observable that settles it, and
the cost. The daily ``journal`` job then resolves the open rows against
evidence that already exists, scores a Brier component per model and per
decision kind, and refuses to guess when the evidence is ambiguous.

Two writers, deliberately:

* **mechanical** (``record_turn``) — one row per turn, no model call, written
  from ``turn_close`` where the verdict, the round count and the priced cost are
  already in hand. This is what makes the ledger COMPLETE: it cannot go silent
  the way a model-invoked logger does.
* **model** (``record_decision``) — the counterfactual half, through the
  ``record_decision`` tool. Optional by construction; if it is never called the
  ledger still has rows.

Not a memory store. Rows here are evidence about a decision, never beliefs to
inject into a prompt. Lessons reach the model through ``apply_verdict``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.json_narrowing import as_float, as_int, as_str
from app.services.deferred_writes import defer_commit
from app.services.memory_conn import commit as brain_commit
from app.services.memory_conn import conn as _conn

logger = logging.getLogger(__name__)

# Kinds a row may carry. ``turn`` is the mechanical one; the rest are what the
# model may declare. Kept as a frozenset, not a CHECK constraint, for the same
# reason ``facts.kind`` is: a new kind must not require a migration.
KINDS: frozenset[str] = frozenset(
    {'turn', 'plan', 'tool_choice', 'answer', 'routing', 'memory', 'skill', 'refusal'}
)

# Observables the resolver can actually check. Anything else resolves as
# ``unscorable`` with a reason — see ``_resolve_one``. This list is the honest
# part of the design: a free-text "I expect this to work" is not evidence.
OBSERVABLES: frozenset[str] = frozenset({'turn:finished', 'turn:ok', 'turn:no-error'})

# How long a row stays open before the resolver gives up on it.
_DEFAULT_HORIZON_DAYS = 1
_EXPIRE_DAYS = 14

# Resolution is bounded per pass so one daily run cannot walk the whole table.
_RESOLVE_LIMIT = 500

# A decision counts as a HIT at or above this outcome. -1..1 is allowed so a
# resolver can express "actively wrong" later without a schema change.
_HIT_THRESHOLD = 0.5


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse_ts(value: object) -> datetime | None:
    text = as_str(value, '').strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def record_turn(
    *,
    session_id: str,
    turn_id: int | None,
    end_reason: str,
    ok: bool | None,
    rounds: int | None,
    cost_usd: float | None,
    tokens_in: int | None,
    tokens_out: int | None,
    model: str = '',
    provider: str = '',
) -> int | None:
    """One mechanical row per turn. Best-effort: never raises into the turn.

    ``chosen`` is the stop reason, because that is the decision the loop
    actually made and can be checked. ``alternatives`` stays NULL here — the
    mechanical writer has no counterfactual to offer, and inventing one would
    be the same mistake the retired episode detector made.
    """
    try:
        conn = _conn()
        now = _utcnow()
        # A mechanical row's outcome is already known — the turn it describes
        # has closed — so it is due immediately and the next journal pass
        # settles it. Only a model-declared decision needs a horizon, because
        # its observable is about what happens NEXT.
        cursor = conn.execute(
            'INSERT INTO decision_ledger '
            '(ts, session_id, turn_id, kind, source, chosen, horizon_turns, due_at, '
            ' cost_usd, tokens_in, tokens_out, model, provider) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                _iso(now),
                session_id,
                turn_id,
                'turn',
                'mechanical',
                end_reason or 'unknown',
                0,
                _iso(now),
                cost_usd,
                tokens_in,
                tokens_out,
                model or '',
                provider or '',
            ),
        )
        defer_commit(conn)
        rowid = cursor.lastrowid
        return int(rowid) if rowid else None
    except Exception:  # noqa: BLE001
        logger.debug('decision_ledger.record_turn failed (non-fatal)', exc_info=True)
        return None


def record_decision(
    *,
    session_id: str,
    turn_id: int | None,
    kind: str,
    chosen: str,
    alternatives: list[dict[str, object]] | None = None,
    thesis: str = '',
    observable: str = '',
    confidence: float | None = None,
    horizon_turns: int | None = None,
    model: str = '',
    provider: str = '',
) -> dict[str, object]:
    """The model-declared half: a decision plus the candidates it rejected.

    Returns ``{'ok': bool, ...}`` rather than raising, because the caller is a
    tool handler whose failure text goes straight back to the model.
    """
    chosen = as_str(chosen, '').strip()
    if not chosen:
        return {'ok': False, 'error': 'chosen action is required'}
    kind = as_str(kind, 'answer').strip() or 'answer'
    if kind not in KINDS:
        return {'ok': False, 'error': f'unknown kind {kind!r}; expected one of {sorted(KINDS)}'}
    observable = as_str(observable, '').strip()
    if observable and observable not in OBSERVABLES:
        # Not an error: the row is still worth recording, and the resolver will
        # label it unscorable rather than pretend it verified anything.
        logger.debug('decision_ledger: unsupported observable %r', observable)
    # A confidence outside [0, 1] is not a confidence. NULL means "the model
    # did not state one", which keeps it out of the Brier average instead of
    # scoring it as a guess.
    conf: float | None = None
    _rawConf = as_float(confidence, -1.0)
    if 0 <= _rawConf <= 1:
        conf = _rawConf
    horizon = as_int(horizon_turns, _DEFAULT_HORIZON_DAYS)
    horizon = max(1, min(horizon, _EXPIRE_DAYS))
    try:
        conn = _conn()
        now = _utcnow()
        cursor = conn.execute(
            'INSERT INTO decision_ledger '
            '(ts, session_id, turn_id, kind, source, chosen, alternatives, thesis, '
            ' observable, confidence, horizon_turns, due_at, model, provider) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                _iso(now),
                session_id,
                turn_id,
                kind,
                'model',
                chosen,
                json.dumps(alternatives, ensure_ascii=False) if alternatives else None,
                thesis or '',
                observable,
                conf,
                horizon,
                _iso(now + timedelta(days=horizon)),
                model or '',
                provider or '',
            ),
        )
        defer_commit(conn)
        return {'ok': True, 'id': int(cursor.lastrowid or 0), 'kind': kind}
    except Exception as exc:  # noqa: BLE001
        logger.debug('decision_ledger.record_decision failed', exc_info=True)
        return {'ok': False, 'error': str(exc)[:200]}


def attach_turn(*, session_id: str, turn_id: int | None) -> int:
    """Backfill ``turn_id`` on this session's decisions made DURING the turn.

    A model-declared decision is written while the turn is still running, so
    the verdict row it should be judged against does not exist yet. The turn
    close calls this the moment it has an id, which is what lets
    ``observable='turn:finished'`` resolve at all. Returns rows touched.
    """
    tid = as_int(turn_id, 0)
    if not session_id or tid <= 0:
        return 0
    try:
        conn = _conn()
        cursor = conn.execute(
            'UPDATE decision_ledger SET turn_id = ? '
            'WHERE session_id = ? AND turn_id IS NULL AND source = ?',
            (tid, session_id, 'model'),
        )
        defer_commit(conn)
        return int(cursor.rowcount or 0)
    except Exception:  # noqa: BLE001
        logger.debug('decision_ledger.attach_turn failed (non-fatal)', exc_info=True)
        return 0


def _turn_row(turn_id: object) -> dict[str, object] | None:
    """The turn_outcomes row a decision points at, if any."""
    tid = as_int(turn_id, 0)
    if tid <= 0:
        return None
    try:
        row = _conn().execute(
            'SELECT id, ok, end_reason, error_class, rounds FROM turn_outcomes WHERE id = ?',
            (tid,),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return None
    return dict(row) if row else None


def _resolve_one(row: dict[str, Any]) -> tuple[str, float | None, str, dict[str, object]]:
    """Decide one open row: ``(status, outcome, reason, evidence)``.

    Ambiguity resolves to ``unscorable``. That is the whole point of the
    column: the last unmeasured detector in this repo invented 41 of 41
    findings, and a resolver that always produces a number is how that happens.
    """
    kind = as_str(row.get('kind'), '')
    turn = _turn_row(row.get('turn_id'))
    evidence: dict[str, object] = {'turnId': as_int(row.get('turn_id'), 0) or None}

    if kind == 'turn':
        if turn is None:
            return 'unscorable', None, 'no-turn-row', evidence
        ok = turn.get('ok')
        reason = as_str(turn.get('end_reason'), '')
        evidence.update({'ok': ok, 'endReason': reason})
        if ok is None:
            return 'unscorable', None, 'outcome-unrecorded', evidence
        return 'resolved', 1.0 if ok else 0.0, '', evidence

    observable = as_str(row.get('observable'), '').strip()
    if not observable:
        return 'unscorable', None, 'no-observable', evidence
    if observable not in OBSERVABLES:
        return 'unscorable', None, 'unsupported-observable', evidence
    if turn is None:
        return 'unscorable', None, 'no-turn-row', evidence
    ok = turn.get('ok')
    end_reason = as_str(turn.get('end_reason'), '')
    evidence.update({'ok': ok, 'endReason': end_reason})
    if observable == 'turn:finished':
        if not end_reason:
            return 'unscorable', None, 'outcome-unrecorded', evidence
        return 'resolved', 1.0 if end_reason == 'finished' else 0.0, '', evidence
    if observable == 'turn:ok':
        if ok is None:
            return 'unscorable', None, 'outcome-unrecorded', evidence
        return 'resolved', 1.0 if ok else 0.0, '', evidence
    # turn:no-error
    error_class = as_str(turn.get('error_class'), '')
    if not end_reason and not error_class:
        return 'unscorable', None, 'outcome-unrecorded', evidence
    return 'resolved', 1.0 if not error_class else 0.0, '', evidence


def resolve_open(*, limit: int = _RESOLVE_LIMIT) -> dict[str, object]:
    """Resolve (or expire) every open row whose ``due_at`` has passed.

    One pass, bounded, committed once. Safe to run twice: a row leaves ``open``
    the first time it is touched.
    """
    resolved_n = 0
    unscorable_n = 0
    expired_n = 0
    try:
        conn = _conn()
        now = _utcnow()
        rows = conn.execute(
            'SELECT * FROM decision_ledger WHERE status = ? '
            'AND (due_at IS NULL OR due_at <= ?) ORDER BY id ASC LIMIT ?',
            ('open', _iso(now), max(1, int(limit))),
        ).fetchall()
        for raw in rows:
            row = dict(raw)
            ts = _parse_ts(row.get('ts'))
            if ts is not None and (now - ts) > timedelta(days=_EXPIRE_DAYS):
                conn.execute(
                    'UPDATE decision_ledger SET status = ?, resolved_at = ?, evidence = ? WHERE id = ?',
                    ('expired', _iso(now), json.dumps({'reason': 'horizon-elapsed'}), row['id']),
                )
                expired_n += 1
                continue
            status, outcome, reason, evidence = _resolve_one(row)
            if status == 'unscorable':
                evidence['reason'] = reason
                unscorable_n += 1
            else:
                resolved_n += 1
            conn.execute(
                'UPDATE decision_ledger SET status = ?, outcome = ?, resolved_at = ?, evidence = ? '
                'WHERE id = ?',
                (status, outcome, _iso(now), json.dumps(evidence, ensure_ascii=False), row['id']),
            )
        brain_commit(conn)
    except Exception:  # noqa: BLE001
        logger.debug('decision_ledger.resolve_open failed', exc_info=True)
        return {
            'resolved': resolved_n,
            'unscorable': unscorable_n,
            'expired': expired_n,
            'error': 'resolve failed',
        }
    return {'resolved': resolved_n, 'unscorable': unscorable_n, 'expired': expired_n}


def _brier(confidence: object, outcome: object) -> float | None:
    conf = as_float(confidence, -1.0)
    score = as_float(outcome, -2.0)
    if conf < 0 or score < -1:
        return None
    hit = 1.0 if score >= _HIT_THRESHOLD else 0.0
    return round((conf - hit) ** 2, 6)


def stats(*, days: int = 30) -> dict[str, object]:
    """Per-model and per-kind resolution stats, with a Brier component.

    ``unscorableRate`` is reported next to ``brier`` on purpose: a model with a
    beautiful Brier over three resolved rows out of forty is not calibrated,
    it is lucky, and the two numbers only mean something together.
    """
    window = max(1, min(int(days), 365))
    since = _iso(_utcnow() - timedelta(days=window))
    try:
        rows = [
            dict(r)
            for r in _conn().execute(
                'SELECT model, kind, status, outcome, confidence FROM decision_ledger WHERE ts >= ?',
                (since,),
            ).fetchall()
        ]
    except Exception:  # noqa: BLE001
        return {'days': window, 'rows': 0, 'byModel': [], 'byKind': []}

    def _bucket(key: str) -> list[dict[str, object]]:
        groups: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            groups.setdefault(as_str(row.get(key), '') or '(unknown)', []).append(row)
        out: list[dict[str, object]] = []
        for name, items in sorted(groups.items()):
            resolved = [r for r in items if as_str(r.get('status')) == 'resolved']
            unscorable = [r for r in items if as_str(r.get('status')) == 'unscorable']
            briers = [
                b
                for b in (_brier(r.get('confidence'), r.get('outcome')) for r in resolved)
                if b is not None
            ]
            hits = [r for r in resolved if as_float(r.get('outcome'), -2.0) >= _HIT_THRESHOLD]
            total = len(items)
            out.append(
                {
                    'name': name,
                    'decisions': total,
                    'resolved': len(resolved),
                    'unscorable': len(unscorable),
                    'hitRate': round(len(hits) / len(resolved), 4) if resolved else None,
                    'brier': round(sum(briers) / len(briers), 6) if briers else None,
                    'unscorableRate': round(len(unscorable) / total, 4) if total else None,
                }
            )
        return out

    return {'days': window, 'rows': len(rows), 'byModel': _bucket('model'), 'byKind': _bucket('kind')}


def digest(*, day: str = '') -> dict[str, object]:
    """One day's ledger activity, for the Learning panel and the job ledger."""
    try:
        conn = _conn()
        where: str
        args: tuple[str, ...]
        if day:
            where, args = 'substr(ts, 1, 10) = ?', (day,)
        else:
            where, args = "substr(ts, 1, 10) = date('now')", ()
        row = conn.execute(
            f'SELECT COUNT(*) AS logged, '
            f'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS resolved, '
            f'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS unscorable, '
            f'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS expired, '
            f'ROUND(SUM(cost_usd), 6) AS costUsd '
            f'FROM decision_ledger WHERE {where}',
            ('resolved', 'unscorable', 'expired', *args),
        ).fetchone()
        data = dict(row) if row else {}
        resolved = as_int(data.get('resolved'), 0)
        cost = as_float(data.get('costUsd'), 0.0)
        return {
            'day': day or 'today',
            'logged': as_int(data.get('logged'), 0),
            'resolved': resolved,
            'unscorable': as_int(data.get('unscorable'), 0),
            'expired': as_int(data.get('expired'), 0),
            'costUsd': round(cost, 6),
            # The number that makes the other one meaningful: dollars per
            # decision that actually resolved. None until something resolves.
            'costPerResolved': round(cost / resolved, 6) if resolved else None,
        }
    except Exception:  # noqa: BLE001
        return {'day': day or 'today', 'logged': 0, 'error': 'unavailable'}


def list_decisions(*, status: str = '', limit: int = 50) -> list[dict[str, object]]:
    """Newest-first rows for the API/UI. Read-only."""
    lim = max(1, min(int(limit), 500))
    try:
        conn = _conn()
        if status:
            rows = conn.execute(
                'SELECT * FROM decision_ledger WHERE status = ? ORDER BY id DESC LIMIT ?',
                (status, lim),
            ).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM decision_ledger ORDER BY id DESC LIMIT ?', (lim,)
            ).fetchall()
    except Exception:  # noqa: BLE001
        return []
    return [dict(r) for r in rows]
