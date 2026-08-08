"""Routing evidence loop (surpass #1/#7) — what actually wins, per task type.

Every workbench turn records ``{task_type, model, provider, ok, tokens,
duration}``; arena/debate winner picks record explicit comparisons. The
suggestions endpoint answers "for this kind of task, which model wins most
and costs least?" — feeding the harness's routing decisions over time.
"""

from __future__ import annotations

import logging
import time

from app.json_narrowing import as_float, as_int, as_str

logger = logging.getLogger(__name__)

# Auto-route decision log (surpass #1 closed loop): who was routed where,
# and by what margin — capped, newest last. The Reliability dashboard
# renders these so auto-routing is auditable, not a black box.
ROUTING_DECISIONS_KEY = 'routing:auto-route:decisions'

_TASK_TYPE_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    ('tests', ('test', 'pytest', 'jest', 'vitest', 'unit test', 'e2e', 'ci')),
    ('bugfix', ('bug', 'error', 'fix', 'crash', 'exception', 'traceback', 'broken', 'failing')),
    ('refactor', ('refactor', 'rename', 'extract', 'restructure', 'clean up', 'simplify')),
    ('docs', ('document', 'readme', 'docstring', 'comment', 'explain', 'tutorial')),
    ('performance', ('performance', 'slow', 'optimize', 'latency', 'profile', 'memory leak')),
    ('question', ('what is', 'how do', 'why does', 'explain', '?')),
]


def classify_task_type(prompt: str) -> str:
    """Keyword classifier for the task type (cheap, deterministic)."""
    text = (prompt or '').lower()
    if not text.strip():
        return 'general'
    for task_type, markers in _TASK_TYPE_PATTERNS:
        if any(marker in text for marker in markers):
            return task_type
    return 'general'


def _conn():
    from app.services.memory_store import _conn as getConn

    return getConn()


def record_turn(
    *,
    session_id: str,
    task_type: str,
    model: str,
    provider: str,
    ok: bool,
    input_tokens: int = 0,
    output_tokens: int = 0,
    duration_ms: int = 0,
    source: str = 'turn',
    prompt: str = '',
) -> None:
    """Record one turn's outcome (fire-and-forget, never raises)."""
    try:
        _conn().execute(
            'INSERT INTO routing_evidence '
            '(session_id, task_type, model, provider, ok, input_tokens, output_tokens, duration_ms, source, prompt) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                as_str(session_id, '')[:120],
                as_str(task_type, 'general')[:40],
                as_str(model, '')[:120],
                as_str(provider, '')[:120],
                1 if ok else 0,
                as_int(input_tokens, 0),
                as_int(output_tokens, 0),
                as_int(duration_ms, 0),
                as_str(source, 'turn')[:20],
                as_str(prompt, '')[:4000],
            ),
        )
        _conn().commit()
    except Exception as exc:
        logger.debug('routing evidence record failed (non-fatal): %s', exc)


def record_arena(
    *,
    session_id: str,
    task_type: str,
    winner_model: str,
    winner_provider: str,
    loser_models: list[tuple[str, str]],
    prompt: str = '',
) -> None:
    """Record an arena/debate verdict: winner ok=1, losers ok=0.

    ``prompt`` is stored verbatim so the archive can offer replay.
    """
    record_turn(
        session_id=session_id,
        task_type=task_type,
        model=winner_model,
        provider=winner_provider,
        ok=True,
        source='arena',
        prompt=prompt,
    )
    for model, provider in loser_models:
        record_turn(
            session_id=session_id,
            task_type=task_type,
            model=model,
            provider=provider,
            ok=False,
            source='arena',
            prompt=prompt,
        )


def get_suggestions(task_type: str, min_samples: int = 1, limit: int = 5) -> list[dict]:
    """Best models for a task type: win-rate first, then average tokens.

    Returns ``[{model, provider, wins, total, winRate, avgTokens,
    avgDurationMs}]`` sorted by win-rate desc, avg tokens asc.
    """
    try:
        rows = _conn().execute(
            'SELECT model, provider, SUM(ok) AS wins, COUNT(*) AS total, '
            'AVG(input_tokens + output_tokens) AS avg_tokens, '
            'AVG(duration_ms) AS avg_duration '
            'FROM routing_evidence WHERE task_type = ? '
            'GROUP BY model, provider HAVING total >= ?',
            (task_type, min_samples),
        ).fetchall()
    except Exception:
        return []
    out = []
    for r in rows:
        total = as_int(r['total'], 0)
        if total <= 0:
            continue
        wins = as_int(r['wins'], 0)
        out.append(
            {
                'model': as_str(r['model'], ''),
                'provider': as_str(r['provider'], ''),
                'wins': wins,
                'total': total,
                'winRate': round(wins / total, 2),
                'avgTokens': int(round(as_int(r['avg_tokens'], 0))),
                'avgDurationMs': int(round(as_int(r['avg_duration'], 0))),
            }
        )
    out.sort(
        key=lambda s: (
            -as_float(s.get('winRate'), 0.0),
            as_int(s.get('avgTokens'), 0),
        )
    )
    return out[: max(1, min(limit, 10))]


def record_auto_route_decision(
    *,
    task_type: str,
    from_model: str,
    from_provider: str,
    to_model: str,
    to_provider: str,
    win_rate: float,
    gap: float,
) -> None:
    """Log one auto-route decision (fire-and-forget, never raises)."""
    try:
        from app.services.memory_store import get_memory, save_memory

        entries = get_memory(ROUTING_DECISIONS_KEY)
        entries = entries if isinstance(entries, list) else []
        entries.append(
            {
                'at': time.time(),
                'taskType': as_str(task_type, 'general')[:40],
                'fromModel': as_str(from_model, '')[:120],
                'fromProvider': as_str(from_provider, '')[:120],
                'toModel': as_str(to_model, '')[:120],
                'toProvider': as_str(to_provider, '')[:120],
                'winRate': round(max(0.0, min(1.0, as_float(win_rate, 0.0))), 2),
                'gap': round(max(0.0, as_float(gap, 0.0)), 2),
            }
        )
        save_memory(ROUTING_DECISIONS_KEY, entries[-100:])
    except Exception as exc:
        logger.debug('auto-route decision log failed (non-fatal): %s', exc)


def list_auto_route_decisions(limit: int = 20) -> list[dict]:
    """Recent auto-route decisions, newest first."""
    try:
        from app.services.memory_store import get_memory

        entries = get_memory(ROUTING_DECISIONS_KEY)
        if not isinstance(entries, list):
            return []
        out: list[dict] = []
        for e in entries[-max(1, min(limit, 100)):]:
            out.append(e if isinstance(e, dict) else {})
        return out[::-1]
    except Exception:
        return []


def best_by_task(days: int = 30, min_samples: int = 3) -> list[dict]:
    """Best model per task type (win-rate desc, tokens asc) — the
    Reliability dashboard's routing table."""
    try:
        conn = _conn()
        rows = conn.execute(
            "SELECT task_type, model, provider, SUM(ok) AS wins, COUNT(*) AS total, "
            "AVG(input_tokens + output_tokens) AS avg_tokens, AVG(duration_ms) AS avg_duration "
            "FROM routing_evidence WHERE task_type != 'general' "
            "AND created_at > datetime('now', ?) "
            "GROUP BY task_type, model, provider HAVING total >= ? "
            "ORDER BY task_type, wins DESC, avg_tokens ASC",
            (f'-{max(1, min(days, 90))} days', max(1, min_samples)),
        ).fetchall()
    except Exception:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        task_type = as_str(r['task_type'], '')
        if task_type in seen:
            continue
        seen.add(task_type)
        total = as_int(r['total'], 0)
        if total <= 0:
            continue
        out.append(
            {
                'taskType': task_type,
                'model': as_str(r['model'], ''),
                'provider': as_str(r['provider'], ''),
                'winRate': round(as_int(r['wins'], 0) / total, 2),
                'total': total,
                'avgTokens': int(round(as_int(r['avg_tokens'], 0))),
                'avgDurationMs': int(round(as_int(r['avg_duration'], 0))),
            }
        )
    return out


def get_stats(days: int = 30) -> dict:
    """Model track record + daily token totals (D6/D7).

    One table feeds both: per-model win/error/latency/token aggregates and
    the daily token burn (the same turns record input+output tokens).
    """
    try:
        conn = _conn()
        models = conn.execute(
            'SELECT model, provider, SUM(ok) AS wins, COUNT(*) AS total, '
            'SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS losses, '
            'AVG(input_tokens + output_tokens) AS avg_tokens, '
            'AVG(duration_ms) AS avg_duration '
            'FROM routing_evidence WHERE created_at > datetime(\'now\', ?) '
            'GROUP BY model, provider ORDER BY total DESC LIMIT 20',
            (f'-{max(1, min(days, 90))} days',),
        ).fetchall()
        daily = conn.execute(
            "SELECT date(created_at) AS day, SUM(input_tokens + output_tokens) AS tokens "
            "FROM routing_evidence WHERE created_at > datetime('now', ?) "
            "GROUP BY date(created_at) ORDER BY day",
            (f'-{max(1, min(days, 90))} days',),
        ).fetchall()
    except Exception:
        return {'models': [], 'daily': [], 'totalTokens': 0}
    model_rows = []
    for r in models:
        total = as_int(r['total'], 0)
        if total <= 0:
            continue
        model_rows.append(
            {
                'model': as_str(r['model'], ''),
                'provider': as_str(r['provider'], ''),
                'wins': as_int(r['wins'], 0),
                'losses': as_int(r['losses'], 0),
                'total': total,
                'winRate': round(as_int(r['wins'], 0) / total, 2),
                'avgTokens': int(round(as_int(r['avg_tokens'], 0))),
                'avgDurationMs': int(round(as_int(r['avg_duration'], 0))),
            }
        )
    daily_rows = [
        {'day': as_str(r['day'], ''), 'tokens': as_int(r['tokens'], 0)} for r in daily
    ]
    total_tokens = sum(as_int(r['tokens'], 0) for r in daily_rows)
    return {'models': model_rows, 'daily': daily_rows, 'totalTokens': total_tokens}
