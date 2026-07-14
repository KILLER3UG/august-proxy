"""Usage tracking API routes.

Route contract (matches the frontend's ``/api/usage/*`` calls):
  • POST   /api/usage
  • GET    /api/usage/session?id=<sessionId>
  • GET    /api/usage
  • GET    /api/usage/stats|heatmap|by-model|by-day?range=7d|30d
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query
from app.models.camel_base import CamelModel
from app.services import memory_store
from app.json_narrowing import as_int, as_str

router = APIRouter(prefix='/api/usage')


class UsageRecord(CamelModel):
    """Usage event body. Internals are snake_case; JSON stays camelCase."""

    session_id: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    context_tokens: int = 0


def _range_days(range_: str) -> int:
    return 7 if range_ in ('7d', '7') else 30


def _parse_created(value: object) -> datetime | None:
    s = as_str(value)
    if not s:
        return None
    try:
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        return datetime.fromisoformat(s)
    except ValueError:
        # SQLite often stores 'YYYY-MM-DD HH:MM:SS'
        try:
            return datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _events_in_range(range_: str, limit: int = 5000) -> list[dict[str, object]]:
    days = _range_days(range_)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    events = memory_store.list_usage(limit=limit)
    out: list[dict[str, object]] = []
    for e in events:
        ts = _parse_created(e.get('createdAt') or e.get('created_at'))
        if ts is None:
            out.append(e)
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts >= cutoff:
            out.append(e)
    return out


@router.post('')
async def record_usage(body: UsageRecord):
    """Record a usage event."""
    usageId = memory_store.record_usage(
        body.session_id,
        body.model,
        body.input_tokens,
        body.output_tokens,
        body.context_tokens,
    )
    return {'id': usageId}


@router.get('/session')
async def getSessionUsage(id: str = Query(..., description='Session id')):
    """Get aggregated usage for a session."""
    if not id:
        raise HTTPException(status_code=400, detail='Missing session id')
    return memory_store.get_usage(id)


@router.get('/stats')
async def usage_stats(range: str = Query('30d')):
    events = _events_in_range(range)
    total_tokens = 0
    sessions: set[str] = set()
    days: set[str] = set()
    model_tokens: dict[str, int] = defaultdict(int)
    for e in events:
        inp = as_int(e.get('inputTokens') if e.get('inputTokens') is not None else e.get('input_tokens'), 0)
        out = as_int(e.get('outputTokens') if e.get('outputTokens') is not None else e.get('output_tokens'), 0)
        tok = inp + out
        total_tokens += tok
        sid = as_str(e.get('sessionId') or e.get('session_id'))
        if sid:
            sessions.add(sid)
        ts = _parse_created(e.get('createdAt') or e.get('created_at'))
        if ts:
            days.add(ts.date().isoformat())
        model = as_str(e.get('model') or 'unknown') or 'unknown'
        model_tokens[model] += tok
    fav = None
    fav_share = 0.0
    if model_tokens:
        fav = max(model_tokens.items(), key=lambda kv: kv[1])
        fav_share = (fav[1] / total_tokens) if total_tokens else 0.0
        fav = fav[0]
    return {
        'range': '7d' if _range_days(range) == 7 else '30d',
        'totalTokens': total_tokens,
        'sessions': len(sessions),
        'messages': len(events),
        'activeDays': len(days),
        'currentStreak': 0,
        'favoriteModel': fav,
        'favoriteModelShare': fav_share,
        'at': datetime.now(timezone.utc).isoformat(),
    }


@router.get('/heatmap')
async def usage_heatmap(range: str = Query('30d')):
    events = _events_in_range(range)
    by_day: dict[str, int] = defaultdict(int)
    for e in events:
        ts = _parse_created(e.get('createdAt') or e.get('created_at'))
        if not ts:
            continue
        by_day[ts.date().isoformat()] += 1
    results = [{'date': d, 'count': c} for d, c in sorted(by_day.items())]
    return {'results': results}


@router.get('/by-model')
async def usage_by_model(range: str = Query('30d')):
    events = _events_in_range(range)
    model_tokens: dict[str, int] = defaultdict(int)
    total = 0
    for e in events:
        inp = as_int(e.get('inputTokens') if e.get('inputTokens') is not None else e.get('input_tokens'), 0)
        out = as_int(e.get('outputTokens') if e.get('outputTokens') is not None else e.get('output_tokens'), 0)
        tok = inp + out
        total += tok
        model = as_str(e.get('model') or 'unknown') or 'unknown'
        model_tokens[model] += tok
    results = []
    for model, tokens in sorted(model_tokens.items(), key=lambda kv: kv[1], reverse=True):
        results.append(
            {
                'model': model,
                'tokens': tokens,
                'percent': (tokens / total) if total else 0.0,
            }
        )
    return {'results': results}


@router.get('/by-day')
async def usage_by_day(range: str = Query('30d')):
    events = _events_in_range(range)
    by_day: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for e in events:
        ts = _parse_created(e.get('createdAt') or e.get('created_at'))
        if not ts:
            continue
        day = ts.date().isoformat()
        model = as_str(e.get('model') or 'unknown') or 'unknown'
        inp = as_int(e.get('inputTokens') if e.get('inputTokens') is not None else e.get('input_tokens'), 0)
        out = as_int(e.get('outputTokens') if e.get('outputTokens') is not None else e.get('output_tokens'), 0)
        by_day[day][model] += inp + out
    results = []
    for day in sorted(by_day.keys()):
        models = [{'model': m, 'tokens': t} for m, t in sorted(by_day[day].items(), key=lambda kv: kv[1], reverse=True)]
        results.append(
            {
                'date': day,
                'tokens': sum(by_day[day].values()),
                'models': models,
            }
        )
    return {'results': results}


@router.get('')
async def listUsage(limit: int = Query(default=200, ge=1, le=1000)):
    """List recent usage events from the brain DB (newest first)."""
    events = memory_store.list_usage(limit=limit)
    return {'usage': events, 'count': len(events)}
