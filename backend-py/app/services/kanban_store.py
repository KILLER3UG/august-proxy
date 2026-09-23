"""Durable agent board — atomic JSON under data/kanban.json.

The board existed only in the desktop's localStorage while its own header
promised a "durable kanban across agents and jobs": a card created in one
window was invisible to another, a reload of a different shell lost it, and no
agent could read or claim the work items its own board was tracking. The cards
already carried ``agentId``/``sessionId``/``taskId``, so the intent was
multi-agent; only the storage was browser-local.

Deliberately NOT the blackboard (``blackboard_service``): that is a TTL-expiring
coordination scratchpad, and a work item that ages out on a poll interval is
not a board.

Writes are serialized with an ``asyncio.Lock`` held only for the
load → mutate → write-atomic cycle, mirroring ``automations_store``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Callable, Final, TypeVar

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.lib.paths import dataPath

logger = logging.getLogger(__name__)

_FILE = 'kanban.json'
_MAX_CARDS: Final = 500
COLUMNS: Final[frozenset[str]] = frozenset({'backlog', 'doing', 'review', 'done'})
DEFAULT_COLUMN = 'backlog'

CARD_FIELDS = ('title', 'body', 'column', 'agentId', 'sessionId', 'taskId')

T = TypeVar('T')
Op = Callable[[dict[str, dict[str, object]]], T]

_cards: dict[str, dict[str, object]] | None = None
_cards_path_key: str | None = None
_lock = asyncio.Lock()


def reset_store() -> None:
    """Test helper — drop the process cache so the next load re-reads disk."""
    global _cards, _cards_path_key
    _cards = None
    _cards_path_key = None


def _path():
    return dataPath(_FILE)


def _now_ms() -> int:
    return int(time.time() * 1000)


def normalize_column(raw: object) -> str:
    col = as_str(raw, DEFAULT_COLUMN).strip().lower()
    return col if col in COLUMNS else DEFAULT_COLUMN


def _normalize_card(d: dict[str, object], *, created: int | None = None) -> dict[str, object]:
    """Coerce one stored/deserialized record into the card shape."""
    now = _now_ms()
    title = as_str(d.get('title')).strip()
    created_at = as_int(d.get('createdAt'), 0) or (created or now)
    out: dict[str, object] = {
        'id': as_str(d.get('id')) or f'kb_{uuid.uuid4().hex[:10]}',
        'title': title,
        'body': as_str(d.get('body')),
        'column': normalize_column(d.get('column')),
        'agentId': as_str(d.get('agentId')),
        'sessionId': as_str(d.get('sessionId')),
        'taskId': as_str(d.get('taskId')),
        'createdAt': created_at,
        'updatedAt': as_int(d.get('updatedAt'), 0) or now,
    }
    return out


def _load() -> dict[str, dict[str, object]]:
    global _cards, _cards_path_key
    path = _path()
    key = str(path)
    if _cards is not None and _cards_path_key == key:
        return _cards
    _cards = {}
    _cards_path_key = key
    if path.exists():
        try:
            raw = json.loads(path.read_text('utf-8'))
            items = as_list(raw.get('cards') if isinstance(raw, dict) else raw)
            for item in items:
                d = as_dict(item)
                card = _normalize_card(d)
                _cards[str(card['id'])] = card
        except Exception:
            # Preserve the file rather than silently losing the board: the
            # store starts empty and the next write replaces the index, same
            # recovery shape as automations_store.
            _cards = {}
            try:
                backup = path.with_name(f'{path.name}.corrupt-{int(time.time())}')
                path.rename(backup)
                logger.warning(
                    'kanban: %s was corrupt — backed up to %s and starting with an empty board',
                    path.name,
                    backup.name,
                )
            except OSError:
                logger.exception('kanban: failed to back up corrupt store %s', path)
    return _cards


def _save() -> None:
    path = _path()
    cards = list(_load().values())
    write_json_atomic(path, {'cards': cards})


async def _mutate(mutator: Op[T]) -> T:
    """Hold the lock only for load → mutate → write."""
    async with _lock:
        store = _load()
        result = mutator(store)
        _save()
        return result


async def _read(reader: Op[T]) -> T:
    """Take a consistent snapshot without writing the file back."""
    async with _lock:
        return reader(_load())


async def list_cards_async(column: str | None = None) -> list[dict[str, object]]:
    def reader(store: dict[str, dict[str, object]]) -> list[dict[str, object]]:
        cards = sorted(store.values(), key=lambda c: as_int(c.get('createdAt'), 0))
        if column:
            want = normalize_column(column)
            cards = [c for c in cards if c.get('column') == want]
        return [dict(c) for c in cards]

    return await _read(reader)


async def add_card_async(
    title: str,
    column: str = DEFAULT_COLUMN,
    body: str = '',
    agentId: str = '',
    sessionId: str = '',
    taskId: str = '',
) -> dict[str, object]:
    clean = (title or '').strip()
    if not clean:
        raise ValueError('A board card needs a title.')

    def mut(store: dict[str, dict[str, object]]) -> dict[str, object]:
        if len(store) >= _MAX_CARDS:
            raise ValueError(f'The board holds at most {_MAX_CARDS} cards; clear some first.')
        card = _normalize_card(
            {
                'title': clean,
                'body': body,
                'column': column,
                'agentId': agentId,
                'sessionId': sessionId,
                'taskId': taskId,
            }
        )
        store[str(card['id'])] = card
        return dict(card)

    return await _mutate(mut)


async def patch_card_async(card_id: str, changes: dict[str, object]) -> dict[str, object] | None:
    def mut(store: dict[str, dict[str, object]]) -> dict[str, object] | None:
        card = store.get(card_id)
        if not card:
            return None
        if 'title' in changes:
            title = as_str(changes.get('title')).strip()
            if not title:
                raise ValueError('A board card needs a title.')
            card['title'] = title
        for field in ('body', 'agentId', 'sessionId', 'taskId'):
            if field in changes:
                card[field] = as_str(changes.get(field))
        if 'column' in changes:
            wanted = as_str(changes.get('column')).strip().lower()
            if wanted not in COLUMNS:
                raise ValueError(f'unknown column {wanted!r}; expected one of {sorted(COLUMNS)}')
            card['column'] = wanted
        card['updatedAt'] = _now_ms()
        return dict(card)

    return await _mutate(mut)


async def remove_card_async(card_id: str) -> bool:
    def mut(store: dict[str, dict[str, object]]) -> bool:
        if card_id not in store:
            return False
        del store[card_id]
        return True

    return await _mutate(mut)


async def clear_done_async() -> int:
    def mut(store: dict[str, dict[str, object]]) -> int:
        done = [k for k, v in store.items() if v.get('column') == 'done']
        for k in done:
            del store[k]
        return len(done)

    return await _mutate(mut)


async def import_cards_async(cards: list[object]) -> int:
    """Merge a browser-local board into the durable one (migration path).

    Import is idempotent on ``id`` — a client that retries (or a board opened
    on two machines) must not duplicate or resurrect deleted cards silently.
    Existing server cards win, so the authoritative copy is never overwritten
    by a stale browser tab.
    """

    def mut(store: dict[str, dict[str, object]]) -> int:
        added = 0
        for raw in cards:
            d = as_dict(raw)
            if not as_str(d.get('title')).strip():
                continue
            card = _normalize_card(d)
            cid = str(card['id'])
            if cid in store or len(store) >= _MAX_CARDS:
                continue
            store[cid] = card
            added += 1
        return added

    return await _mutate(mut)
