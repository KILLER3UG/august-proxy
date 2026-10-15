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
        rec = {
            'reason': reason,
            'count': len(messages),
            # Self-describing position, see `archivedMessages`: without it a single
            # unreadable line shifts every later id down by one.
            'startSeq': _nextSeq(path),
            'messages': messages,
        }
        with path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + '\n')
    except OSError:
        logger.debug('transcript archive failed', exc_info=True)


def _nextSeq(path: Path) -> int:
    """Where this snapshot's first message sits in the transcript-wide sequence."""
    total = 0
    if not path.is_file():
        return 0
    for line in _readLines(path):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msgs = rec.get('messages') if isinstance(rec, dict) else None
        if isinstance(msgs, list):
            total += sum(1 for m in msgs if isinstance(m, dict))
    return total


def _readLines(path: Path) -> list[str]:
    """The transcript's lines, with a torn append confined to ONE line.

    A half-written record at the tail is OFTEN not valid UTF-8, and `read_text`
    raises `UnicodeDecodeError` — which is neither `OSError` nor `JSONDecodeError`,
    so it escaped both readers here and out of `run_review_pass`, whose docstring
    promises it never raises, and one damaged transcript blocked every session's
    review at each cadence. Decoding with a replacement character keeps that
    corruption on the line that has the problem: the torn line then fails to parse
    and is skipped like any other, and `startSeq` means the records after it keep
    their positions.
    """
    try:
        return path.read_bytes().decode('utf-8', errors='replace').splitlines()
    except OSError:
        return []


def load_archive(session_id: str) -> list[dict[str, Any]]:
    path = _path(session_id)
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    for line in _readLines(path):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
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

    Compaction DELETES the middle it folded away from `messages` (a row the saved
    snapshot no longer contains is removed), so the archive is the only place that
    content still exists at all. Each snapshot carries its own `startSeq`, stamped
    when it was written, so a reader never has to re-derive the numbering — which
    is what keeps two reads identical and keeps positions valid if this file is ever
    truncated or rotated by something outside this module.

    State the limit plainly: `load_archive` skips a line it cannot parse, and a
    partial append welds the next record onto the torn bytes so BOTH vanish. That is
    a loss that no position scheme can undo (the bytes are gone), and it is stable —
    it happens at write time, so every later read drops the same records and the
    numbering agrees with the writer's. The residual hazard is a stored cursor
    outrunning the file, which `_reviewTarget` now logs instead of silently skipping.

    Ids are negative because `messages.id` is a positive INTEGER primary key: a
    negative cannot be mistaken for a live row on a path that reads both.
    """
    out: list[tuple[int, dict[str, Any]]] = []
    running = 0
    for rec in load_archive(session_id):
        msgs = rec.get('messages')
        if not isinstance(msgs, list):
            continue
        start = rec.get('startSeq')
        base = start if isinstance(start, int) and not isinstance(start, bool) else running
        for m in msgs:
            if not isinstance(m, dict):
                continue
            out.append((-(base + 1), m))
            base += 1
        running = base
    return out


def archivedMessage(session_id: str, episodeId: int) -> dict[str, Any] | None:
    """One archived message by its synthetic id, or None if this is not one.

    Resolves the recorded position directly rather than by counting, so a snapshot
    the reader could not parse does not move the answer for every id after it.
    """
    if episodeId >= 0:
        return None
    want = -int(episodeId) - 1
    running = 0
    for rec in load_archive(session_id):
        msgs = rec.get('messages')
        if not isinstance(msgs, list):
            continue
        start = rec.get('startSeq')
        base = start if isinstance(start, int) and not isinstance(start, bool) else running
        items = [m for m in msgs if isinstance(m, dict)]
        if base <= want < base + len(items):
            return items[want - base]
        running = base + len(items)
    return None


def archivedCount(session_id: str) -> int:
    """The cursor bound: one past the highest archived position.

    Not `len()`, deliberately — with a dropped snapshot the two differ, and a caller
    comparing a stored cursor against `len()` would read "nothing unread" forever.
    """
    best = 0
    running = 0
    for rec in load_archive(session_id):
        msgs = rec.get('messages')
        if not isinstance(msgs, list):
            continue
        start = rec.get('startSeq')
        base = start if isinstance(start, int) and not isinstance(start, bool) else running
        n = sum(1 for m in msgs if isinstance(m, dict))
        best = max(best, base + n)
        running = base + n
    return best


def hasArchive(session_id: str) -> bool:
    """Cheap check before parsing: reading an archive means parsing every
    snapshot, so a scan over candidate sessions asks this first."""
    try:
        p = _path(session_id)
        return p.is_file() and p.stat().st_size > 0
    except OSError:
        return False
