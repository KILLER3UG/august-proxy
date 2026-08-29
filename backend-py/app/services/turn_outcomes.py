"""M5 — turn outcomes as telemetry, not memory (plan 2026-08-27 §3.6).

The deleted turn-lessons failed because free-text failure rules are not
actionable memory. This module records one structured row per turn into
``turn_outcomes`` (append-only, 30-day retention) and exposes the stats
consumers: routing evidence and the harness self-improve "error rate by
model" stat. Rows are never injected into prompts and never shown in the
Memory UI — diagnostics only (Observability hub).

The single path from failure to memory is ``maybe_promote_failure_lesson``:
when one model/provider/error signature fails repeatedly, ONE typed lesson
fact may be written — gated by a cheap-model review (discard-default) and a
BM25 dedupe filter against existing facts (Q2 ruling).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

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


def record_turn_outcome(
    *,
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
) -> None:
    """Append one telemetry row. Best-effort: never raises into the turn.

    Phase L (Part 17): ``ttft_ms`` + the prompt-cache token split make
    latency regressions measurable per turn — "chat feels slow" becomes
    "first token 42 s, cache hit 0 / miss 29k" instead of a vibe.
    """
    try:
        conn = _conn()
        conn.execute(
            'INSERT INTO turn_outcomes '
            '(model, provider, task_type, ok, error_class, duration_ms, session_id, '
            ' ttft_ms, cache_hit_tokens, cache_miss_tokens) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
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
            ),
        )
        conn.commit()
    except Exception:
        logger.debug('record_turn_outcome failed', exc_info=True)


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


def _signature(provider: str, model: str, errorClass: str) -> str:
    raw = f'{provider or "?"}/{model or "?"}:{errorClass or "other"}'
    return re.sub(r'[^a-z0-9]+', '-', raw.lower()).strip('-')


def _recent_failures(provider: str, model: str, errorClass: str) -> list[str]:
    """Error texts for this signature inside the promotion window."""
    try:
        conn = _conn()
        rows = conn.execute(
            """
            SELECT error_class FROM turn_outcomes
            WHERE ok = 0 AND provider = ? AND model = ? AND error_class = ?
              AND ts >= datetime('now', ?)
            """,
            (provider or '', model or '', errorClass or '', f'-{_PROMOTE_WINDOW_DAYS} days'),
        ).fetchall()
        return [str(r['error_class']) for r in rows]
    except Exception:
        return []


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


async def maybe_promote_failure_lesson(
    *,
    model: str,
    provider: str,
    error_class: str,
    sample_error: str,
    review_model_hint: str = '',
) -> str:
    """Promote ONE lesson fact when a signature fails repeatedly (Q2 ruling).

    Returns a status string for logging/lifecycle: ``promoted``,
    ``below-threshold``, ``cooldown``, ``review-rejected``, ``duplicate``,
    ``no-text`` or ``error``. This is the only path from failure to memory.
    """
    from app.services.memory_store import (
        derive_fact_title,
        get_internal_state,
        record_lifecycle,
        save_fact,
        set_internal_state,
    )

    if not error_class or error_class == 'cancelled':
        return 'below-threshold'
    sig = _signature(provider, model, error_class)
    try:
        failures = _recent_failures(provider, model, error_class)
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
        sample = ' '.join((sample_error or '').split())[:300]
        if not sample:
            return 'no-text'
        lesson = (
            f'{provider or "unknown"}/{model or "unknown"} failed {len(failures)} times in '
            f'{_PROMOTE_WINDOW_DAYS} days with error class "{error_class}". '
            f'Sample: {sample}'
        )
        if len(lesson) > _LESSON_CHAR_CAP:
            lesson = lesson[:_LESSON_CHAR_CAP].rstrip() + '…'
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
