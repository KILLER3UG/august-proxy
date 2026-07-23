"""Schedule parsing and next-run helpers for automations.json jobs.

Supports:
  * 5-field cron (``m h dom mon dow``)
  * interval forms: ``every 30m``, ``every 2h``, ``every 1d``
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_EVERY_RE = re.compile(
    r'^\s*every\s+(\d+)\s*([mhd]|min|mins|minute|minutes|hr|hrs|hour|hours|d|day|days)\s*$',
    re.I,
)


def _offset_label(offset: timedelta) -> str:
    total_min = int(offset.total_seconds() // 60)
    sign = '+' if total_min >= 0 else '-'
    h, m = divmod(abs(total_min), 60)
    return f'UTC{sign}{h:02d}:{m:02d}'


def system_local_timezone() -> str:
    """Return a persisted timezone label for the host (never silently invent UTC).

    Prefers a real IANA key when ``tzdata`` / zoneinfo can load it. On Windows
    without tzdata, falls back to an explicit UTC±HH:MM offset label.
    """
    try:
        local = datetime.now().astimezone().tzinfo
        key = getattr(local, 'key', None)
        if isinstance(key, str) and key:
            try:
                ZoneInfo(key)
                return key
            except (ZoneInfoNotFoundError, ModuleNotFoundError, Exception):
                pass
    except Exception:
        pass
    try:
        from tzlocal import get_localzone_name  # type: ignore[import-not-found]

        z = get_localzone_name()
        if z:
            try:
                ZoneInfo(str(z))
                return str(z)
            except (ZoneInfoNotFoundError, ModuleNotFoundError, Exception):
                pass
    except Exception:
        pass
    offset = datetime.now().astimezone().utcoffset() or timedelta(0)
    return _offset_label(offset)


def resolve_tz(name: str | None) -> tzinfo:
    """Resolve a stored label to a tzinfo usable without requiring tzdata."""
    raw = (name or '').strip()
    if raw:
        try:
            return ZoneInfo(raw)
        except (ZoneInfoNotFoundError, ModuleNotFoundError, Exception):
            pass
        # UTC±HH:MM labels
        if raw.upper().startswith('UTC') and len(raw) >= 6:
            try:
                sign = 1 if raw[3] == '+' else -1
                hh, mm = raw[4:].split(':', 1)
                return timezone(sign * timedelta(hours=int(hh), minutes=int(mm)))
            except Exception:
                pass
        # Etc/GMT±N (POSIX sign inverted) — avoid if tzdata missing
    # Host local fixed offset always works
    local = datetime.now().astimezone().tzinfo
    return local or timezone.utc


def parse_schedule(schedule: str) -> dict[str, object]:
    """Normalize a schedule string into a structured descriptor.

    Returns ``{kind: 'cron'|'interval'|'empty', ...}``.
    """
    s = (schedule or '').strip()
    if not s:
        return {'kind': 'empty'}
    m = _EVERY_RE.match(s)
    if m:
        n = max(1, int(m.group(1)))
        unit = m.group(2).lower()
        if unit.startswith('m'):
            seconds = n * 60
        elif unit.startswith('h'):
            seconds = n * 3600
        else:
            seconds = n * 86400
        return {'kind': 'interval', 'everySeconds': seconds, 'raw': s}
    parts = s.split()
    if len(parts) == 5:
        return {'kind': 'cron', 'expr': s, 'raw': s}
    raise ValueError(f'unsupported schedule: {schedule!r}')


def _parse_cron_fields(expression: str) -> tuple[list[int], list[int], list[int], list[int], list[int]]:
    fields = expression.strip().split()
    if len(fields) != 5:
        raise ValueError(f'Invalid cron expression: {expression}')

    def parse_field(field: str, min_val: int, max_val: int) -> list[int]:
        if field == '*':
            return list(range(min_val, max_val + 1))
        values: list[int] = []
        for part in field.split(','):
            if '/' in part:
                base, step_s = part.split('/', 1)
                start = min_val if base == '*' else int(base)
                values.extend(range(start, max_val + 1, int(step_s)))
            elif '-' in part:
                low, high = part.split('-', 1)
                values.extend(range(int(low), int(high) + 1))
            else:
                values.append(int(part))
        return sorted({v for v in values if min_val <= v <= max_val})

    return (
        parse_field(fields[0], 0, 59),
        parse_field(fields[1], 0, 23),
        parse_field(fields[2], 1, 31),
        parse_field(fields[3], 1, 12),
        parse_field(fields[4], 0, 6),
    )


def matches_cron(expr: str, dt: datetime) -> bool:
    minutes, hours, days, months, weekdays = _parse_cron_fields(expr)
    return (
        dt.minute in minutes
        and dt.hour in hours
        and dt.day in days
        and dt.month in months
        and dt.weekday() in weekdays
    )


def compute_next_run_at(
    schedule: str,
    timezone_name: str | None,
    *,
    after: datetime | None = None,
) -> str | None:
    """Return ISO UTC timestamp of the next run, or None if unscheduled."""
    try:
        parsed = parse_schedule(schedule)
    except ValueError:
        return None
    if parsed['kind'] == 'empty':
        return None
    tz = resolve_tz(timezone_name)
    base = after.astimezone(tz) if after else datetime.now(tz)
    if parsed['kind'] == 'interval':
        every_seconds = parsed['everySeconds']
        if not isinstance(every_seconds, (int, float)):
            return None
        nxt = base + timedelta(seconds=int(every_seconds))
        return nxt.astimezone(timezone.utc).isoformat()
    expr = str(parsed['expr'])
    cursor = (base + timedelta(minutes=1)).replace(second=0, microsecond=0)
    for _ in range(60 * 24 * 8):
        if matches_cron(expr, cursor):
            return cursor.astimezone(timezone.utc).isoformat()
        cursor += timedelta(minutes=1)
    return None


def is_due(
    schedule: str,
    timezone_name: str | None,
    next_run_at: str | None,
    *,
    now: datetime | None = None,
) -> bool:
    """True when the job should fire on this tick."""
    now_utc = now or datetime.now(timezone.utc)
    if next_run_at:
        try:
            due = datetime.fromisoformat(str(next_run_at).replace('Z', '+00:00'))
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            return due <= now_utc
        except ValueError:
            pass
    try:
        parsed = parse_schedule(schedule)
    except ValueError:
        return False
    if parsed['kind'] == 'empty':
        return False
    if parsed['kind'] == 'interval':
        return True
    tz = resolve_tz(timezone_name)
    local = now_utc.astimezone(tz)
    return matches_cron(str(parsed['expr']), local)
