"""Append-only transcript archive. Compaction rewrites the *projection* only."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_SAFE = re.compile(r'[^A-Za-z0-9_.-]')


def _path(session_id: str) -> Path:
    from app.lib.paths import dataPath

    safe = _SAFE.sub('_', session_id or 'default')[:120] or 'default'
    return dataPath('transcripts', f'{safe}.jsonl')


def archive_messages(session_id: str, messages: list[dict[str, Any]], *, reason: str = 'compact') -> None:
    """Append a snapshot of model-visible messages before projection rewrite."""
    if not session_id or not messages:
        return
    try:
        path = _path(session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        rec = {'reason': reason, 'count': len(messages), 'messages': messages}
        with path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + '\n')
    except OSError:
        logger.debug('transcript archive failed', exc_info=True)


def load_archive(session_id: str) -> list[dict[str, Any]]:
    path = _path(session_id)
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        return []
    return out


def derive_messages(session_id: str, projection: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the latest full snapshot if archived, else the live projection."""
    snaps = load_archive(session_id)
    if not snaps:
        return list(projection)
    last = snaps[-1]
    msgs = last.get('messages')
    if isinstance(msgs, list) and msgs:
        return msgs
    return list(projection)
