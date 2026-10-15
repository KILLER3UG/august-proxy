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


def archivedMessages(session_id: str) -> list[tuple[int, dict[str, Any]]]:
    """Every archived message, in transcript order, with a stable synthetic id.

    Compaction DELETES the middle it folded away from the `messages` table (a row
    the saved snapshot no longer contains is removed), so the archive is the only
    place that content still exists at all. Snapshots are appended and never
    rewritten — this module has no delete and no rotation — so a message's running
    position is identical on every read, which is what makes the position usable
    both as a review cursor and as the `episode` id a judge returns.

    Ids are negative because `messages.id` is a positive INTEGER primary key: a
    negative cannot be mistaken for a live row on a path that reads both, so the
    review pass never needs to know which kind it was handed.
    """
    out: list[tuple[int, dict[str, Any]]] = []
    for rec in load_archive(session_id):
        msgs = rec.get('messages')
        if not isinstance(msgs, list):
            continue
        for m in msgs:
            if isinstance(m, dict):
                out.append((-(len(out) + 1), m))
    return out


def archivedMessage(session_id: str, episodeId: int) -> dict[str, Any] | None:
    """One archived message by its synthetic id, or None if this is not one.

    Reads straight through the file instead of building the list: this is called
    once per proposal, to attach the evidence a human should see before approving.
    """
    if episodeId >= 0:
        return None
    want = -int(episodeId) - 1
    pos = 0
    for rec in load_archive(session_id):
        msgs = rec.get('messages')
        if not isinstance(msgs, list):
            continue
        for m in msgs:
            if not isinstance(m, dict):
                continue
            if pos == want:
                return m
            pos += 1
    return None


def archivedCount(session_id: str) -> int:
    """How many messages the archive holds — the upper bound of a cursor."""
    return len(archivedMessages(session_id))


def hasArchive(session_id: str) -> bool:
    """Cheap check before parsing: reading an archive means parsing every
    snapshot, so a scan over candidate sessions asks this first."""
    try:
        p = _path(session_id)
        return p.is_file() and p.stat().st_size > 0
    except OSError:
        return False
