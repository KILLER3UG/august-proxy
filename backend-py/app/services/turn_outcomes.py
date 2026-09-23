"""M5 — turn outcomes as telemetry, not memory (plan 2026-08-27 §3.6).

The deleted turn-lessons failed because free-text failure rules are not
actionable memory. This module records one structured row per turn into
``turn_outcomes`` (append-only, 30-day retention) and exposes the stats
consumers: routing evidence and the harness self-improve "error rate by
model" stat. Rows are never injected into prompts and never shown in the
Memory UI — diagnostics only (Observability hub).

The single path from failure to memory is ``maybe_promote_failure_lesson``:
when one failure signature repeats, ONE typed lesson fact may be written —
gated by a cheap-model review (discard-default) and a BM25 dedupe filter
against existing facts (Q2 ruling). Three failure classes feed it, each in its
own signature space: the upstream ``error_class``, the edit-verification gate
(``edit_verify_fails``) and the tool guardrails (``guardrail_classes``) — the
latter two only became countable when 046 gave a turn its model/provider
attribution for them.

046 also made the turn verdict durable: ``end_reason`` / ``rounds`` are the
persisted twin of the ``turn_end {reason, rounds}`` SSE event, and
``malformed_tool_args`` / ``surface_downgraded`` are the persisted twin of the
loop's turn-scoped self-correction counters. NULL on any of them means NOT
RECORDED (older row, or the value was never measured) — never 0.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services.deferred_writes import defer_commit
from app.services.memory_conn import conn as _conn

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 30
# Repeated-failure threshold within the window before promotion is allowed.
_PROMOTE_MIN_FAILURES = 3
_PROMOTE_WINDOW_DAYS = 7
# One promotion per signature per cooldown — no lesson spam.
_PROMOTE_COOLDOWN_DAYS = 7
_LESSON_CHAR_CAP = 300
# Candidate lessons too similar to an existing fact are discarded (Q2-b).
_DEDUPE_SIMILARITY = 0.55

# ── failure classes (promotion signature spaces) ─────────────────────────
# Which ledger column carries the evidence for one candidate lesson. The
# classes NEVER share a signature space: an ``edit_file`` guardrail block and
# an ``edit_file``-flavoured error class promote two independent facts.
KIND_ERROR = 'error'
KIND_EDIT_VERIFY = 'edit_verify'
KIND_GUARDRAIL = 'guardrail'
FAILURE_KINDS = (KIND_ERROR, KIND_EDIT_VERIFY, KIND_GUARDRAIL)

# The vocabulary of ``turn_end.reason`` (workbench.py:5235). Kept here as a
# note to readers, NOT as a write-time allow-list: a reason the loop learns
# after this file stopped changing must still reach the row instead of being
# silently dropped to NULL.
TURN_END_REASONS = (
    'finished',
    'length',
    'cap',
    'stall-stop',
    'error',
    'interrupted',
    'awaiting-input',
)


@dataclass(frozen=True)
class FailureClass:
    """One candidate lesson signature: which class failed, and what it looked like.

    ``kind`` is one of :data:`FAILURE_KINDS`; ``label`` refines it inside that
    space (the error class for ``error``, the blocked tool for ``guardrail``,
    '' for ``edit_verify``); ``sample`` is the evidence text quoted in the
    lesson, capped by the caller.
    """

    kind: str = KIND_ERROR
    label: str = ''
    sample: str = ''

_ERROR_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ('cancelled', re.compile(r'cancel', re.IGNORECASE)),
    ('rate_limit', re.compile(r'\[?429\]?|rate.?limit|too many requests', re.IGNORECASE)),
    (
        'auth',
        re.compile(r'\[?(?:401|403)\]?|api.?key|unauthori[sz]ed|forbidden|invalid.+key', re.IGNORECASE),
    ),
    (
        'context_overflow',
        re.compile(r'context.?length|maximum context|too long|exceed.+context|token.+limit', re.IGNORECASE),
    ),
    ('timeout', re.compile(r'timed? ?out|deadline', re.IGNORECASE)),
    ('not_found', re.compile(r'\[?404\]?|not found', re.IGNORECASE)),
    (
        'bad_request',
        re.compile(r'\[?400\]?|invalid (?:input|request|parameter)|bad request', re.IGNORECASE),
    ),
    (
        'upstream_5xx',
        re.compile(
            r'\[?5\d\d\]?|internal server error|bad gateway|service unavailable|overloaded',
            re.IGNORECASE,
        ),
    ),
    ('network', re.compile(r'connection|network|dns|refused|reset', re.IGNORECASE)),
]


def classify_error(errorText: str) -> str:
    """Map a raw turn error string onto a stable error class ('' when ok)."""
    text = (errorText or '').strip()
    if not text:
        return ''
    for label, pattern in _ERROR_PATTERNS:
        if pattern.search(text):
            return label
    return 'other'


def _nullable_int(value: object) -> int | None:
    """Store a counter, or NULL when it was never measured.

    Deliberately NOT ``int(value or 0)``: that folds "unmeasured" into
    "measured zero", and the panel's whole honesty claim is that a turn whose
    counters were never recorded is not reported as a clean turn.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    try:
        return int(value)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return None


def _nullable_text(value: object) -> str | None:
    """Same rule for the text fields: None (not recorded) stays None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or ''


_NEW_COLUMNS = (
    'end_reason',
    'rounds',
    'malformed_tool_args',
    'surface_downgraded',
    'edit_verify_fails',
    'guardrail_classes',
)


def record_turn_outcome(
    model: str,
    provider: str,
    task_type: str,
    ok: bool,
    error_class: str = '',
    duration_ms: int = 0,
    session_id: str = '',
    ttft_ms: int = 0,
    cache_hit_tokens: int = 0,
    cache_miss_tokens: int = 0,
    tool_args_ready_to_stream_end_ms: int = 0,
    end_reason: str | None = None,
    rounds: int | None = None,
    malformed_tool_args: int | None = None,
    surface_downgraded: bool | int | None = None,
    edit_verify_fails: int | None = None,
    guardrail_classes: str | None = None,
) -> None:
    """Append one telemetry row. Best-effort: never raises into the turn.

    Phase L (Part 17): ``ttft_ms`` + the prompt-cache token split make
    latency regressions measurable per turn — "chat feels slow" becomes
    "first token 42 s, cache hit 0 / miss 29k" instead of a vibe.
    P3.1 (Part 18): ``tool_args_ready_to_stream_end_ms`` measures the
    trailing stream tail AFTER the last tool call's arguments arrived —
    the time early tool dispatch could save. 0 = no tool call this turn.
    046 (this change): the verdict + self-correction counters at the tail.
    Every one of them is ``None`` = NOT RECORDED and lands as SQL NULL, so an
    older row and a turn that measured nothing stay distinguishable from a
    turn that measured a zero.
    """
    try:
        conn = _conn()
        base_cols = [
            'model',
            'provider',
            'task_type',
            'ok',
            'error_class',
            'duration_ms',
            'session_id',
            'ttft_ms',
            'cache_hit_tokens',
            'cache_miss_tokens',
            'tool_args_ready_to_stream_end_ms',
        ]
        base_vals: list[object] = [
            model or '',
            provider or '',
            task_type or '',
            1 if ok else 0,
            error_class or '',
            int(duration_ms or 0),
            session_id or '',
            int(ttft_ms or 0),
            int(cache_hit_tokens or 0),
            int(cache_miss_tokens or 0),
            int(tool_args_ready_to_stream_end_ms or 0),
        ]
        new_vals: list[object] = [
            _nullable_text(end_reason),
            _nullable_int(rounds),
            _nullable_int(malformed_tool_args),
            _nullable_int(surface_downgraded),
            _nullable_int(edit_verify_fails),
            _nullable_text(guardrail_classes),
        ]
        try:
            conn.execute(
                'INSERT INTO turn_outcomes '
                f'({", ".join(base_cols + list(_NEW_COLUMNS))}) '
                f'VALUES ({", ".join(["?"] * (len(base_cols) + len(_NEW_COLUMNS)))})',
                (*base_vals, *new_vals),
            )
        except Exception as exc:  # noqa: BLE001
            # 046 not applied (fresh install whose migration budget is spent,
            # or a partially upgraded legacy DB): the verdict columns are lost,
            # the turn row is NOT. Losing all M5 telemetry because an additive
            # column is missing would be the worse failure by far. SQLite
            # reports an unknown INSERT target as "has no column named X" and
            # an unknown reference as "no such column" — both mean the same
            # schema hole here.
            msg = str(exc).lower()
            if 'no such column' not in msg and 'has no column' not in msg:
                raise
            logger.debug('record_turn_outcome: 046 columns absent, writing base row')
            conn.execute(
                'INSERT INTO turn_outcomes '
                f'({", ".join(base_cols)}) '
                f'VALUES ({", ".join(["?"] * len(base_cols))})',
                tuple(base_vals),
            )
        # P4.2: telemetry rows are never read back within the turn —
        # the commit is debounced (≤2s) instead of syncing per turn.
        defer_commit(conn)
    except Exception:
        logger.debug('record_turn_outcome failed', exc_info=True)


def guardrail_class_digest(session_id: str, sinceUtc: str) -> tuple[str | None, dict[str, str]]:
    """Roll up THIS turn's guardrail blocks out of ``tool_guardrail_log``.

    The log stays the single authority for the per-block detail — this is a
    read, not a second writer, and it exists because the log has no
    model/provider column, so nothing could tie a repeated block back to the
    model that keeps causing it. Returns ``(digest, samplesByTool)``:

    * digest ``None``  → nothing measurable (no session id, unreadable log) and
      the caller must write NULL, not 0;
    * digest ``''``    → the turn was measured and blocked nothing;
    * digest ``',edit_file:2,'`` → per-tool counts, comma-padded so a LIKE
      match on ``',edit_file:'`` cannot hit ``'not_edit_file:'``.

    Tool names are sanitised on the way in (`,`` and ``:`` are structural) so
    the digest always round-trips through :func:`parse_guardrail_digest`.
    """
    if not session_id or not sinceUtc:
        return None, {}
    try:
        rows = _conn().execute(
            "SELECT tool_name, reason FROM tool_guardrail_log "
            "WHERE session_id = ? AND COALESCE(created_at, '') >= ?",
            (session_id, sinceUtc),
        ).fetchall()
    except Exception:
        logger.debug('guardrail_class_digest failed', exc_info=True)
        return None, {}
    counts: dict[str, int] = {}
    samples: dict[str, str] = {}
    for r in rows:
        tool = re.sub(r'[,:]', '_', str(r['tool_name'] or 'unknown')).strip() or 'unknown'
        counts[tool] = counts.get(tool, 0) + 1
        if tool not in samples:
            samples[tool] = ' '.join(str(r['reason'] or '').split())[:200]
    if not counts:
        # Measured, empty. Only honest when the query above actually ran.
        return '', {}
    return ',' + ','.join(f'{tool}:{n}' for tool, n in sorted(counts.items())) + ',', samples


def parse_guardrail_digest(digest: object) -> dict[str, int]:
    """Inverse of :func:`guardrail_class_digest` ('' / None → {})."""
    text = str(digest or '')
    out: dict[str, int] = {}
    for part in text.split(','):
        part = part.strip()
        if not part or ':' not in part:
            continue
        tool, _, raw = part.rpartition(':')
        try:
            out[tool] = int(raw)
        except ValueError:
            continue
    return out


def turn_verdict_stats(days: int = 7) -> dict[str, object]:
    """Why turns end, and how often they misbehave on the way there.

    The read side of 046 for the Learning panel: one windowed aggregate over
    the rows the sweep keeps. Every counter reports ``total`` (NULL when the
    window holds no measured row), ``measured`` / ``unrecorded`` (row counts
    that split the NULL-vs-zero question out honestly) and ``turns`` (turns
    with at least one of that signal). Diagnostics only: nothing here gates an
    answer, and a reason distribution is not a score.
    """
    windowDays = max(1, min(int(days or 7), _RETENTION_DAYS))
    empty: dict[str, object] = {
        'days': windowDays,
        'turns': 0,
        'reasons': [],
        'reasonUnrecorded': 0,
        'counters': {},
    }
    try:
        conn = _conn()
        args = (f'-{windowDays} days',)
        reasonRows = conn.execute(
            'SELECT end_reason AS reason, COUNT(*) AS n FROM turn_outcomes '
            "WHERE ts >= datetime('now', ?) GROUP BY end_reason ORDER BY n DESC",
            args,
        ).fetchall()
        stats = conn.execute(
            """
            SELECT COUNT(*) AS turns,
                   SUM(CASE WHEN rounds IS NULL THEN 1 ELSE 0 END) AS rounds_missing,
                   SUM(rounds) AS rounds_total, MAX(rounds) AS rounds_max,
                   SUM(CASE WHEN malformed_tool_args IS NULL THEN 1 ELSE 0 END) AS mf_missing,
                   SUM(malformed_tool_args) AS mf_total,
                   SUM(CASE WHEN malformed_tool_args > 0 THEN 1 ELSE 0 END) AS mf_turns,
                   SUM(CASE WHEN surface_downgraded IS NULL THEN 1 ELSE 0 END) AS sd_missing,
                   SUM(surface_downgraded) AS sd_total,
                   SUM(CASE WHEN surface_downgraded > 0 THEN 1 ELSE 0 END) AS sd_turns,
                   SUM(CASE WHEN edit_verify_fails IS NULL THEN 1 ELSE 0 END) AS ev_missing,
                   SUM(edit_verify_fails) AS ev_total,
                   SUM(CASE WHEN edit_verify_fails > 0 THEN 1 ELSE 0 END) AS ev_turns,
                   SUM(CASE WHEN guardrail_classes IS NULL THEN 1 ELSE 0 END) AS gr_missing,
                   SUM(CASE WHEN guardrail_classes != '' THEN 1 ELSE 0 END) AS gr_turns
            FROM turn_outcomes
            WHERE ts >= datetime('now', ?)
            """,
            args,
        ).fetchone()
        digests = conn.execute(
            "SELECT guardrail_classes, COUNT(*) AS n FROM turn_outcomes "
            "WHERE guardrail_classes IS NOT NULL AND guardrail_classes != '' "
            "  AND ts >= datetime('now', ?) GROUP BY guardrail_classes",
            args,
        ).fetchall()
    except Exception:
        logger.debug('turn_verdict_stats failed', exc_info=True)
        return empty

    row: dict[str, Any] = dict(stats) if stats is not None else {}
    turns = int(row.get('turns') or 0)
    reasons: list[dict[str, object]] = []
    unrecordedReason = 0
    for r in reasonRows:
        n = int(r['n'] or 0)
        if r['reason'] is None:
            # Rows written before 046 (and turns whose verdict was never
            # handed down): counted and labelled, never folded into a reason.
            unrecordedReason += n
            continue
        reasons.append({'reason': str(r['reason']), 'turns': n})

    def _counter(totalKey: str, missingKey: str, turnsKey: str) -> dict[str, object]:
        missing = int(row.get(missingKey) or 0)
        rawTotal = row.get(totalKey)
        return {
            # None = the window holds no measured row (NOT 0).
            'total': None if rawTotal is None else int(rawTotal),
            'measured': turns - missing,
            'turns': int(row.get(turnsKey) or 0),
            'unrecorded': missing,
        }

    byTool: dict[str, int] = {}
    guardrailTotal = 0
    for r in digests:
        perTurn = int(r['n'] or 0)
        for tool, n in parse_guardrail_digest(r['guardrail_classes']).items():
            byTool[tool] = byTool.get(tool, 0) + n * perTurn
            guardrailTotal += n * perTurn

    grMeasured = turns - int(row.get('gr_missing') or 0)
    roundsMeasured = turns - int(row.get('rounds_missing') or 0)
    roundsTotalRaw = row.get('rounds_total')
    counters: dict[str, object] = {
        'rounds': {
            'avg': round(float(roundsTotalRaw or 0) / roundsMeasured, 2)
            if roundsTotalRaw is not None
            else None,
            'max': None if row.get('rounds_max') is None else int(row['rounds_max']),
            'measured': roundsMeasured,
            'unrecorded': int(row.get('rounds_missing') or 0),
        },
        'malformedToolArgs': _counter('mf_total', 'mf_missing', 'mf_turns'),
        'surfaceDowngrades': _counter('sd_total', 'sd_missing', 'sd_turns'),
        'editVerifyFails': _counter('ev_total', 'ev_missing', 'ev_turns'),
        'guardrailBlocks': {
            # 0 = measured and nothing was blocked; None = never measured.
            'total': guardrailTotal if grMeasured else None,
            'measured': grMeasured,
            'turns': int(row.get('gr_turns') or 0),
            'unrecorded': int(row.get('gr_missing') or 0),
            'byTool': [
                {'tool': t, 'blocks': n}
                for t, n in sorted(byTool.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
        },
    }
    return {
        'days': windowDays,
        'turns': turns,
        'reasons': reasons,
        'reasonUnrecorded': unrecordedReason,
        'counters': counters,
    }


def sweep_old_outcomes(days: int = _RETENTION_DAYS) -> int:
    """Delete rows older than the retention window (called by M4 job)."""
    try:
        conn = _conn()
        cur = conn.execute(
            "DELETE FROM turn_outcomes WHERE ts < datetime('now', ?)",
            (f'-{int(days)} days',),
        )
        conn.commit()
        return cur.rowcount or 0
    except Exception:
        logger.debug('sweep_old_outcomes failed', exc_info=True)
        return 0


def error_rate_by_model(days: int = 7) -> list[dict[str, object]]:
    """Per-model/provider turn stats for Observability + self-improve."""
    try:
        conn = _conn()
        rows = conn.execute(
            """
            SELECT model, provider,
                   COUNT(*) AS turns,
                   SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors
            FROM turn_outcomes
            WHERE ts >= datetime('now', ?)
            GROUP BY model, provider
            ORDER BY errors DESC, turns DESC
            """,
            (f'-{int(days)} days',),
        ).fetchall()
        out: list[dict[str, object]] = []
        for r in rows:
            turns = int(r['turns'] or 0)
            errors = int(r['errors'] or 0)
            out.append(
                {
                    'model': r['model'] or '',
                    'provider': r['provider'] or '',
                    'turns': turns,
                    'errors': errors,
                    'errorRate': round(errors / turns, 3) if turns else 0.0,
                }
            )
        return out
    except Exception:
        logger.debug('error_rate_by_model failed', exc_info=True)
        return []


def _signature(provider: str, model: str, errorClass: str, kind: str = KIND_ERROR) -> str:
    """One stable slug per (provider, model, kind, label) — the fact key.

    The ``error`` space keeps its pre-046 shape byte-for-byte
    (``p1-m1-auth``): lessons and cooldown state written by older builds are
    keyed that way, and a rename would either orphan them or let the same
    failure be re-learned under a second key. Every other class is suffixed
    with its kind, so a repeated guardrail block on ``edit_file`` can never
    merge with an upstream error class of the same name.
    """
    raw = f'{provider or "?"}/{model or "?"}:{errorClass or "other"}'
    if kind and kind != KIND_ERROR:
        raw = f'{provider or "?"}/{model or "?"}:{kind}:{errorClass or "any"}'
    return re.sub(r'[^a-z0-9]+', '-', raw.lower()).strip('-')


def _failure_signature(failure: FailureClass, provider: str, model: str) -> str:
    return _signature(provider, model, failure.label, failure.kind)


def _recent_failures(failure: FailureClass, provider: str, model: str) -> list[str]:
    """Turns inside the promotion window that carry this failure signature.

    Each class is counted from its own column of the SAME ``turn_outcomes``
    ledger (no second store): the error class from the ``ok``/``error_class``
    pair the feature has always used, the edit-verification gate from
    ``edit_verify_fails``, the guardrails from the ``guardrail_classes``
    digest. A DB without 046 simply yields nothing for the two new classes —
    the query error is swallowed the same way every other read here is.
    """
    try:
        conn = _conn()
        window = f'-{_PROMOTE_WINDOW_DAYS} days'
        if failure.kind == KIND_EDIT_VERIFY:
            rows = conn.execute(
                """
                SELECT edit_verify_fails AS n FROM turn_outcomes
                WHERE provider = ? AND model = ?
                  AND COALESCE(edit_verify_fails, 0) > 0
                  AND ts >= datetime('now', ?)
                """,
                (provider or '', model or '', window),
            ).fetchall()
            return [f'edit-verification gate failed {int(r["n"] or 0)}x' for r in rows]
        if failure.kind == KIND_GUARDRAIL:
            rows = conn.execute(
                """
                SELECT guardrail_classes AS digest FROM turn_outcomes
                WHERE provider = ? AND model = ?
                  AND guardrail_classes IS NOT NULL AND guardrail_classes != ''
                  AND ts >= datetime('now', ?)
                """,
                (provider or '', model or '', window),
            ).fetchall()
            needle = failure.label or ''
            hits: list[str] = []
            for r in rows:
                counts = parse_guardrail_digest(r['digest'])
                if needle and needle not in counts:
                    continue
                hits.append(f"guardrail blocked {counts.get(needle, 0)}x ({needle or 'any tool'})")
            return hits
        rows = conn.execute(
            """
            SELECT error_class FROM turn_outcomes
            WHERE ok = 0 AND provider = ? AND model = ? AND error_class = ?
              AND ts >= datetime('now', ?)
            """,
            (provider or '', model or '', failure.label or '', window),
        ).fetchall()
        return [str(r['error_class']) for r in rows]
    except Exception:
        logger.debug('_recent_failures failed', exc_info=True)
        return []


def _lesson_text(provider: str, model: str, failure: FailureClass, count: int, sample: str) -> str:
    """The fact body for one class. Same shape, same cap, one per signature."""
    who = f'{provider or "unknown"}/{model or "unknown"}'
    head = {
        KIND_EDIT_VERIFY: (
            f'{who} failed its edit-verification gate {count} times in '
            f'{_PROMOTE_WINDOW_DAYS} days — edits the project test/lint gate '
            'kept rejecting.'
        ),
        KIND_GUARDRAIL: (
            f'{who} had {count} turns blocked by the tool guardrails'
            + (f' on `{failure.label}`' if failure.label else '')
            + f' in {_PROMOTE_WINDOW_DAYS} days.'
        ),
    }.get(
        failure.kind,
        (
            f'{who} failed {count} times in {_PROMOTE_WINDOW_DAYS} days '
            f'with error class "{failure.label or "other"}".'
        ),
    )
    lesson = f'{head.strip()} Sample: {sample}'
    if len(lesson) > _LESSON_CHAR_CAP:
        lesson = lesson[:_LESSON_CHAR_CAP].rstrip() + '…'
    return lesson


async def _review_lesson(lessonText: str, sampleError: str, modelHint: str) -> bool:
    """Q2-a gate: one cheap-model review, discard-default.

    Any failure to reach a model (no provider, no key, empty answer) means
    the lesson is discarded — nothing reaches the store unreviewed.
    """
    try:
        from app.services.workbench.providers import make_review_llm_client

        reviewLlm = make_review_llm_client(None, modelHint)
        if reviewLlm is None:
            return False
        prompt = [
            {
                'role': 'system',
                'content': (
                    'You gate candidate lessons before they enter long-term memory. '
                    'A lesson is stored only if it is: actionable (changes future behavior), '
                    'non-obvious, durable (still true beyond today), and not already common knowledge. '
                    'Reply with exactly YES or NO. When unsure, answer NO.'
                ),
            },
            {
                'role': 'user',
                'content': (
                    f'Candidate lesson derived from repeated turn failures:\n{lessonText}\n\n'
                    f'Recent error sample: {sampleError[:300]}\n\n'
                    'Is this a lesson worth storing permanently?'
                ),
            },
        ]
        answer = (await reviewLlm(prompt)).strip().upper()
        return answer.startswith('YES')
    except Exception:
        logger.debug('lesson review call failed (discard-default)', exc_info=True)
        return False


def _coerce_class(entry: FailureClass | Sequence[str]) -> FailureClass:
    """Accept a FailureClass or a plain ``(kind, label[, sample])`` tuple."""
    if isinstance(entry, FailureClass):
        return entry
    parts = [str(p or '') for p in (entry or ())]
    return FailureClass(
        kind=(parts[0] if parts else '') or KIND_ERROR,
        label=parts[1] if len(parts) > 1 else '',
        sample=parts[2] if len(parts) > 2 else '',
    )


# Classes whose signature needs a label to exist: an unnamed error class or an
# unnamed blocked tool is not a signature, it is missing data.
_LABELLED_KINDS = (KIND_ERROR, KIND_GUARDRAIL)


def _candidate_classes(
    error_class: str, sample_error: str, extra: Sequence[FailureClass | Sequence[str]]
) -> list[FailureClass]:
    """Every failure class this turn can teach from, in its own signature space.

    A cancelled turn still teaches nothing (the user stopped it — not the
    model's failure), and duplicates collapse so one class is never judged
    twice in a call.
    """
    out: list[FailureClass] = []
    seen: set[tuple[str, str]] = set()
    candidates = [FailureClass(KIND_ERROR, error_class, sample_error), *( _coerce_class(e) for e in extra or () )]
    for failure in candidates:
        if failure.kind not in FAILURE_KINDS:
            continue
        if failure.kind in _LABELLED_KINDS and not failure.label:
            continue
        if failure.kind == KIND_ERROR and failure.label == 'cancelled':
            continue
        key = (failure.kind, failure.label)
        if key in seen:
            continue
        seen.add(key)
        out.append(failure)
    return out


async def maybe_promote_failure_lesson(
    model: str,
    provider: str,
    error_class: str,
    sample_error: str,
    review_model_hint: str = '',
    failure_classes: Sequence[FailureClass | Sequence[str]] = (),
) -> str:
    """Promote ONE lesson fact per signature that fails repeatedly (Q2 ruling).

    ``failure_classes`` widens the input beyond the upstream error class:
    edit-verification gate misses and guardrail blocks carry their own
    signature, so a model that keeps breaking the same gate learns the same
    way a model that keeps returning 429s does — same threshold, same review,
    same ``lesson`` fact kind, no new store. Each class is judged on its own
    and a noisy one cannot starve the quiet ones: a class that is below
    threshold still leaves the others to run, and every failure inside the
    loop is swallowed so one bad class cannot cancel the rest.

    Returns a status string for logging/lifecycle: ``promoted``,
    ``below-threshold``, ``cooldown``, ``review-rejected``, ``duplicate``,
    ``no-text`` or ``error``. With several classes the per-class statuses are
    joined (``guardrail:promoted;edit_verify:below-threshold``); a single
    class answers with the bare status, exactly as before. This is the only
    path from failure to memory.
    """
    candidates = _candidate_classes(error_class, sample_error, failure_classes)
    if not candidates:
        return 'below-threshold'
    statuses: list[str] = []
    for failure in candidates:
        statuses.append(await _promote_one(model, provider, failure, review_model_hint))
    if len(statuses) == 1:
        return statuses[0]
    return ';'.join(f'{f.kind}:{s}' for f, s in zip(candidates, statuses, strict=True))


async def _promote_one(
    model: str, provider: str, failure: FailureClass, review_model_hint: str
) -> str:
    """The promotion gate for ONE failure signature (see the caller)."""
    from app.services.memory_store import (
        derive_fact_title,
        get_internal_state,
        record_lifecycle,
        save_fact,
        set_internal_state,
    )

    sig = _failure_signature(failure, provider, model)
    try:
        failures = _recent_failures(failure, provider, model)
        if len(failures) < _PROMOTE_MIN_FAILURES:
            return 'below-threshold'
        cooldownKey = f'turn_outcomes:last_promotion:{sig}'
        lastRaw = str(get_internal_state(cooldownKey) or '')
        if lastRaw:
            try:
                lastAt = datetime.fromisoformat(lastRaw)
                if lastAt.tzinfo is None:
                    lastAt = lastAt.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) - lastAt < timedelta(days=_PROMOTE_COOLDOWN_DAYS):
                    return 'cooldown'
            except ValueError:
                pass
        sample = ' '.join((failure.sample or '').split())[:300]
        if not sample:
            return 'no-text'
        lesson = _lesson_text(provider, model, failure, len(failures), sample)
        # Q2-b: strict necessity filter — dedupe against existing facts.
        from app.services.memory_store.fact_retrieval import find_similar_facts

        similar = find_similar_facts(lesson, k=1)
        if similar and float(similar[0][0]) > _DEDUPE_SIMILARITY:
            set_internal_state(cooldownKey, datetime.now(timezone.utc).isoformat())
            record_lifecycle(
                '', 'lesson_promotion_skipped', {'signature': sig, 'reason': 'duplicate'}
            )
            return 'duplicate'
        if not await _review_lesson(lesson, sample, review_model_hint):
            set_internal_state(cooldownKey, datetime.now(timezone.utc).isoformat())
            record_lifecycle(
                '', 'lesson_promotion_skipped', {'signature': sig, 'reason': 'review-rejected'}
            )
            return 'review-rejected'
        factKey = f'harness-lesson:{sig}'
        save_fact(
            factKey,
            lesson,
            category='harness',
            source='harness',
            confidence=0.6,
            title=derive_fact_title(lesson),
            kind='lesson',
        )
        set_internal_state(cooldownKey, datetime.now(timezone.utc).isoformat())
        record_lifecycle('', 'lesson_promoted', {'signature': sig, 'factKey': factKey})
        logger.info('M5 promoted failure lesson %s', factKey)
        return 'promoted'
    except Exception:
        logger.debug('maybe_promote_failure_lesson failed', exc_info=True)
        return 'error'
