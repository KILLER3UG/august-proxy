"""Usage analytics and statistics endpoints backed by real SQLite usage_events."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Query

from app.services import memory_store
from app.services.memory_store.rest import _conn

router = APIRouter(prefix="/api/usage", tags=["usage"])


def _parse_range_cutoff(range_str: str) -> tuple[datetime, str]:
    now = datetime.now(timezone.utc)
    days = 7 if range_str == "7d" else 30
    cutoff = now - timedelta(days=days)
    return cutoff, cutoff.strftime("%Y-%m-%d %H:%M:%S")


@router.get("")
def list_usage_events(limit: int = Query(200, ge=1, le=1000)) -> list[dict[str, Any]]:
    """List recent raw usage events (newest first)."""
    return memory_store.list_usage(limit=limit)


@router.get("/session")
def get_session_usage(id: str = Query(..., description="Session ID")) -> dict[str, Any]:
    """Get aggregated usage for a specific session."""
    return memory_store.get_usage(id)


@router.get("/stats")
def get_usage_stats(range: str = Query("30d")) -> dict[str, Any]:
    """Get real summary statistics for the specified time range."""
    _, cutoff_str = _parse_range_cutoff(range)
    conn = _conn()

    # Total tokens, sessions, messages in the range
    row = conn.execute(
        """
        SELECT 
            COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
            COUNT(DISTINCT session_id) AS session_count,
            COUNT(*) AS message_count,
            COUNT(DISTINCT strftime('%Y-%m-%d', created_at)) AS active_days
        FROM usage_events
        WHERE created_at >= ?
        """,
        (cutoff_str,),
    ).fetchone()

    total_tokens = int(row["total_tokens"]) if row else 0
    session_count = int(row["session_count"]) if row else 0
    message_count = int(row["message_count"]) if row else 0
    active_days = int(row["active_days"]) if row else 0

    # Peak tokens in a single day
    peak_row = conn.execute(
        """
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS day_tokens
        FROM usage_events
        WHERE created_at >= ?
        GROUP BY strftime('%Y-%m-%d', created_at)
        ORDER BY day_tokens DESC
        LIMIT 1
        """,
        (cutoff_str,),
    ).fetchone()
    peak_tokens = int(peak_row["day_tokens"]) if peak_row else 0

    # Current streak & longest streak
    day_rows = conn.execute(
        """
        SELECT DISTINCT strftime('%Y-%m-%d', created_at) AS day
        FROM usage_events
        ORDER BY day DESC
        """
    ).fetchall()
    active_dates = {r["day"] for r in day_rows}

    today = datetime.now(timezone.utc).date()
    current_streak = 0
    check_day = today
    while check_day.strftime("%Y-%m-%d") in active_dates:
        current_streak += 1
        check_day -= timedelta(days=1)
    if current_streak == 0:
        # Check if yesterday was active
        check_day = today - timedelta(days=1)
        while check_day.strftime("%Y-%m-%d") in active_dates:
            current_streak += 1
            check_day -= timedelta(days=1)

    longest_streak = max(active_days, current_streak)

    # Favorite model in this range
    fav_row = conn.execute(
        """
        SELECT model, COALESCE(SUM(input_tokens + output_tokens), 0) AS model_tokens
        FROM usage_events
        WHERE created_at >= ? AND model IS NOT NULL AND model != ''
        GROUP BY model
        ORDER BY model_tokens DESC
        LIMIT 1
        """,
        (cutoff_str,),
    ).fetchone()

    fav_model = fav_row["model"] if fav_row else None
    fav_tokens = int(fav_row["model_tokens"]) if fav_row else 0
    fav_share = (fav_tokens / total_tokens * 100.0) if total_tokens > 0 else 0.0

    return {
        "range": range,
        "totalTokens": total_tokens,
        "peakTokens": peak_tokens,
        "sessions": session_count,
        "messages": message_count,
        "activeDays": active_days,
        "currentStreak": current_streak,
        "longestStreak": longest_streak,
        "favoriteModel": fav_model,
        "favoriteModelShare": fav_share,
        "at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/heatmap")
def get_usage_heatmap(range: str = Query("30d")) -> dict[str, Any]:
    """Get daily token activity for the past 365 days."""
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=365)).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()

    rows = conn.execute(
        """
        SELECT 
            strftime('%Y-%m-%d', created_at) AS day,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
        FROM usage_events
        WHERE created_at >= ?
        GROUP BY day
        ORDER BY day ASC
        """,
        (cutoff,),
    ).fetchall()

    results = [{"date": r["day"], "count": int(r["total_tokens"])} for r in rows]
    return {"results": results}


@router.get("/by-model")
def get_usage_by_model(range: str = Query("30d")) -> dict[str, Any]:
    """Get per-model token breakdown and percentage share."""
    _, cutoff_str = _parse_range_cutoff(range)
    conn = _conn()

    total_row = conn.execute(
        """
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS grand_total
        FROM usage_events
        WHERE created_at >= ?
        """,
        (cutoff_str,),
    ).fetchone()
    grand_total = int(total_row["grand_total"]) if total_row else 0

    rows = conn.execute(
        """
        SELECT 
            COALESCE(model, 'unknown') AS model_name,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS model_tokens
        FROM usage_events
        WHERE created_at >= ?
        GROUP BY model_name
        ORDER BY model_tokens DESC
        """,
        (cutoff_str,),
    ).fetchall()

    results = []
    for r in rows:
        tokens = int(r["model_tokens"])
        pct = (tokens / grand_total * 100.0) if grand_total > 0 else 0.0
        results.append({
            "model": r["model_name"],
            "tokens": tokens,
            "percent": pct,
        })

    return {"results": results}


@router.get("/by-day")
def get_usage_by_day(range: str = Query("30d")) -> dict[str, Any]:  # noqa: A002 — public query name
    """Get daily token trend grouped by day and model."""
    num_days = 7 if range == "7d" else 30
    now = datetime.now(timezone.utc).date()
    start_date = now - timedelta(days=num_days - 1)
    cutoff_str = start_date.strftime("%Y-%m-%d 00:00:00")
    conn = _conn()

    rows = conn.execute(
        """
        SELECT
            strftime('%Y-%m-%d', created_at) AS day,
            COALESCE(model, 'unknown') AS model_name,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS model_tokens
        FROM usage_events
        WHERE created_at >= ?
        GROUP BY day, model_name
        ORDER BY day ASC
        """,
        (cutoff_str,),
    ).fetchall()

    # The parameter name shadows the builtin range() — walk the calendar
    # instead of calling it.
    days_map: dict[str, dict[str, int]] = {}
    d = start_date
    while d <= now:
        days_map[d.strftime("%Y-%m-%d")] = {}
        d += timedelta(days=1)

    for r in rows:
        d = r["day"]
        if d in days_map:
            days_map[d][r["model_name"]] = int(r["model_tokens"])

    results = []
    for d_str in sorted(days_map.keys()):
        m_dict = days_map[d_str]
        total_d = sum(m_dict.values())
        models_list = [{"model": k, "tokens": v} for k, v in sorted(m_dict.items(), key=lambda x: x[1], reverse=True)]
        results.append({
            "date": d_str,
            "tokens": total_d,
            "models": models_list,
        })

    return {"results": results}
