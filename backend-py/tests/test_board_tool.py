"""The `board` tool — agents reading and moving the same durable board the UI shows.

Without this tool the board's ``agentId``/``sessionId`` fields were decoration:
a model could see neither the queue nor an item it had just finished, so
multi-agent handoff stayed a claim in the header text. These tests drive the
handler directly (the shape the model sees) and pin that a write through the
tool is readable through the store the API serves.
"""

from __future__ import annotations

import pytest
from app.services import kanban_store as store
from app.services import tool_registry
from app.services.tool_registrations import board_tools


async def _first_card_id(column: str | None = None) -> str:
    cards = await store.list_cards_async(column)
    assert cards, 'expected at least one card on the board'
    return str(cards[0]['id'])


@pytest.mark.asyncio
async def test_add_is_visible_in_list_and_in_the_store(isolatedData):
    out = await board_tools._board(action='add', title='Ship the board tool', column='backlog')
    assert out.startswith('Added')
    assert 'Ship the board tool' in out

    listed = await board_tools._board(action='list')
    assert 'Ship the board tool' in listed
    assert 'backlog 1' in listed
    assert [c['title'] for c in await store.list_cards_async()] == ['Ship the board tool']


@pytest.mark.asyncio
async def test_claim_and_done_move_the_card(isolatedData):
    await board_tools._board(action='add', title='Claim me')
    cid = await _first_card_id()

    claimed = await board_tools._board(action='claim', cardId=cid, agentId='agent-3')
    assert '[doing]' in claimed
    assert '@agent-3' in claimed

    done = await board_tools._board(action='done', cardId=cid)
    assert '[done]' in done
    assert 'Claim me' in await board_tools._board(action='list', column='done')


@pytest.mark.asyncio
async def test_bad_input_answers_instead_of_raising(isolatedData):
    assert 'unknown action' in await board_tools._board(action='frob')
    assert 'add needs a title' in await board_tools._board(action='add', title='   ')
    assert 'move needs column' in await board_tools._board(action='move', cardId='kb_x')
    assert 'unknown column' in await board_tools._board(action='list', column='shredded')
    assert 'needs cardId' in await board_tools._board(action='claim')
    assert 'no card with id' in await board_tools._board(action='drop', cardId='kb_nope')

    # A rejected action must not have changed anything.
    assert await board_tools._board(action='list') == 'Board is empty.'


@pytest.mark.asyncio
async def test_card_is_stamped_with_the_session_that_made_it(isolatedData, monkeypatch):
    from app.services.workbench import context as wb_context

    token = wb_context.currentSessionId.set('wb_42')
    try:
        await board_tools._board(action='add', title='From a turn')
    finally:
        wb_context.currentSessionId.reset(token)

    cards = await store.list_cards_async()
    assert cards[0]['sessionId'] == 'wb_42'


@pytest.mark.asyncio
async def test_move_reports_a_card_that_vanished(isolatedData):
    await board_tools._board(action='add', title='Race me')
    cid = await _first_card_id()
    await store.remove_card_async(cid)
    assert 'no card with id' in await board_tools._board(action='done', cardId=cid)


def test_the_tool_is_registered_with_an_action_enum(isolatedData):
    board_tools.register()
    tool = tool_registry.get('board')
    assert tool is not None
    schema = tool['parameters']
    assert isinstance(schema, dict)
    props = schema['properties']
    assert isinstance(props, dict)
    action = props['action']
    assert isinstance(action, dict)
    assert action['enum'] == list(board_tools.ACTIONS)
    assert schema['required'] == ['action']
