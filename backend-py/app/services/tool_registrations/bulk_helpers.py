"""Shared helpers for homogeneous bulk tool execution."""

from __future__ import annotations

import json
from typing import Any

BULK_MAX_ITEMS = 40


def coerce_str_list(
    value: object = None,
    *,
    single: str = '',
    max_items: int = BULK_MAX_ITEMS,
) -> list[str]:
    """Accept an array, JSON array string, CSV, or a single fallback string."""
    ids: list[str] = []
    if isinstance(value, list):
        ids = [str(x).strip() for x in value if str(x).strip()]
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.startswith('['):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    ids = [str(x).strip() for x in parsed if str(x).strip()]
            except Exception:
                ids = []
        if not ids:
            ids = [p.strip() for p in raw.replace('\n', ',').split(',') if p.strip()]
    if not ids and (single or '').strip():
        ids = [single.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for item in ids:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
        if len(out) >= max_items:
            break
    return out


def coerce_object_list(value: object = None, *, max_items: int = BULK_MAX_ITEMS) -> list[dict[str, Any]]:
    """Accept a list of dicts (or a JSON array string of objects)."""
    items: list[dict[str, Any]] = []
    if isinstance(value, list):
        raw_list = value
    elif isinstance(value, str) and value.strip().startswith('['):
        try:
            parsed = json.loads(value.strip())
            raw_list = parsed if isinstance(parsed, list) else []
        except Exception:
            raw_list = []
    else:
        raw_list = []
    for entry in raw_list:
        if isinstance(entry, dict):
            items.append(dict(entry))
        if len(items) >= max_items:
            break
    return items


def format_bulk_report(
    *,
    label: str,
    total: int,
    ok_ids: list[str],
    missing: list[str] | None = None,
    errors: list[str] | None = None,
    extra: str = '',
) -> str:
    """Compact per-item summary for bulk tool results."""
    parts = [f'{label}: {len(ok_ids)}/{total} succeeded.']
    if extra:
        parts.append(extra)
    if ok_ids:
        shown = ', '.join(ok_ids[:30])
        parts.append(f'OK: {shown}' + ('…' if len(ok_ids) > 30 else ''))
    if missing:
        parts.append('Not found: ' + ', '.join(missing[:20]))
    if errors:
        parts.append('Errors: ' + '; '.join(errors[:12]))
    if total > BULK_MAX_ITEMS:
        parts.append(f'(capped at {BULK_MAX_ITEMS} items per call)')
    return ' '.join(parts)
