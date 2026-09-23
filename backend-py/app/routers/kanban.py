"""Agent board API — durable cards in data/kanban.json.

  GET    /api/kanban                 — the whole board, oldest card first
  POST   /api/kanban                 — add a card
  PATCH  /api/kanban/{id}            — move and/or edit one card
  DELETE /api/kanban/{id}            — remove one card
  POST   /api/kanban/clear-done      — drop the done column
  POST   /api/kanban/import          — merge a browser-local board in (migration)

The board is shared state: the desktop UI and the model-facing board tools read
and write this same store, which is why a card's ``agentId``/``taskId`` are
first-class fields rather than client-side decoration.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.camel_base import CamelModel
from app.services import kanban_store as store

router = APIRouter(prefix='/api/kanban')


class AddBody(CamelModel):
    title: str = ''
    column: str = 'backlog'
    body: str = ''
    agent_id: str = ''
    session_id: str = ''
    task_id: str = ''


class PatchBody(CamelModel):
    title: str | None = None
    column: str | None = None
    body: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    task_id: str | None = None


class ImportBody(CamelModel):
    cards: list[object] = []


def _wire(card: dict[str, object]) -> dict[str, object]:
    return {
        'id': card.get('id'),
        'title': card.get('title'),
        'body': card.get('body'),
        'column': card.get('column'),
        'agentId': card.get('agentId'),
        'sessionId': card.get('sessionId'),
        'taskId': card.get('taskId'),
        'createdAt': card.get('createdAt'),
        'updatedAt': card.get('updatedAt'),
    }


@router.get('')
async def list_board(column: str = ''):
    cards = await store.list_cards_async(column or None)
    return {'cards': [_wire(c) for c in cards], 'columns': sorted(store.COLUMNS)}


@router.post('')
async def add_card(body: AddBody):
    try:
        card = await store.add_card_async(
            body.title,
            column=body.column,
            body=body.body,
            agentId=body.agent_id,
            sessionId=body.session_id,
            taskId=body.task_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _wire(card)


@router.patch('/{card_id}')
async def patch_card(card_id: str, body: PatchBody):
    changes = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        card = await store.patch_card_async(card_id, changes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if card is None:
        raise HTTPException(status_code=404, detail='Card not found')
    return _wire(card)


@router.delete('/{card_id}')
async def delete_card(card_id: str):
    if not await store.remove_card_async(card_id):
        raise HTTPException(status_code=404, detail='Card not found')
    return {'ok': True}


@router.post('/clear-done')
async def clear_done():
    return {'ok': True, 'removed': await store.clear_done_async()}


@router.post('/import')
async def import_board(body: ImportBody):
    """Merge cards a client held in localStorage. Server cards win on id
    collisions, so a stale tab cannot resurrect or overwrite a card. Entries
    that are not objects, or have no title, are skipped by the store."""
    added = await store.import_cards_async(body.cards)
    return {'ok': True, 'added': added}
