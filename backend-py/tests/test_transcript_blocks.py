"""Durable structured transcript blocks (migration 047).

A chat bubble is a block timeline, not a string. Before 047 the messages
table stored one string per row, so restoring a chat from the backend after a
localStorage loss lost tool calls/results, reasoning, attachments and todos.
These tests pin the round trip: write structured blocks -> read them back on
the API, keep `content` (and therefore FTS) unchanged, and leave legacy
text-only rows exactly as they were.
"""

from __future__ import annotations

import json

import pytest
from app.main import app
from app.services import memory_store as store
from app.services.memory_store import transcript_blocks as tb
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


ASSISTANT_TURN = {
    'role': 'assistant',
    'content': [
        {'type': 'thinking', 'thinking': 'let me look at the repo'},
        {'type': 'text', 'text': 'Reading the file now.'},
        {'type': 'tool_use', 'id': 'toolu_1', 'name': 'read_file', 'input': {'path': 'a.py'}},
    ],
}
TOOL_TURN = {'role': 'tool', 'tool_use_id': 'toolu_1', 'name': 'read_file', 'content': 'print(1)'}


def test_derive_blocks_from_anthropic_transcript():
    blocks = tb.derive_blocks(ASSISTANT_TURN)
    assert [b['type'] for b in blocks] == ['thinking', 'finalOutput', 'toolCall']
    assert blocks[0]['content'] == 'let me look at the repo'
    assert blocks[1]['content'] == 'Reading the file now.'
    tool = blocks[2]['tool']
    assert tool['id'] == 'toolu_1'
    assert tool['name'] == 'read_file'
    assert json.loads(tool['args']) == {'path': 'a.py'}


def test_derive_blocks_from_openai_tool_calls():
    blocks = tb.derive_blocks(
        {
            'role': 'assistant',
            'content': 'done',
            'tool_calls': [
                {'id': 'call_1', 'function': {'name': 'run_command', 'arguments': '{"cmd":"ls"}'}}
            ],
        }
    )
    assert [b['type'] for b in blocks] == ['finalOutput', 'toolCall']
    assert blocks[1]['tool']['name'] == 'run_command'
    assert blocks[1]['tool']['args'] == '{"cmd":"ls"}'


def test_derive_blocks_for_tool_result_message():
    blocks = tb.derive_blocks(TOOL_TURN)
    assert len(blocks) == 1
    assert blocks[0]['tool']['name'] == 'read_file'
    assert blocks[0]['tool']['result'] == 'print(1)'
    assert blocks[0]['tool']['status'] == 'done'


def test_encode_decode_round_trip_preserves_structured_fields():
    message = {
        'role': 'assistant',
        'content': 'here you go',
        'thinking': 'reasoning text',
        'attachments': [{'name': 'notes.md', 'type': 'text'}],
        'todos': [{'id': 't1', 'content': 'ship it', 'status': 'pending'}],
        'usage': {'inputTokens': 10, 'outputTokens': 4},
    }
    raw = tb.encode_blocks(message)
    assert raw is not None
    decoded = tb.decode_blocks(raw)
    assert decoded['thinking'] == 'reasoning text'
    assert decoded['attachments'][0]['name'] == 'notes.md'
    assert decoded['todos'][0]['content'] == 'ship it'
    assert decoded['usage']['outputTokens'] == 4
    # Blocks were derived (none supplied) so a restore still has a timeline.
    assert decoded['blocks'][0]['type'] == 'finalOutput'


def test_encode_blocks_returns_none_for_plain_text_message():
    # A legacy plain user message must stay a NULL blocks_json row, not an
    # empty object that would claim a structured transcript was recorded.
    assert tb.encode_blocks({'role': 'user', 'content': 'hi'}) is None


def test_decode_blocks_survives_corrupt_json():
    assert tb.decode_blocks('{not json') == {}
    assert tb.decode_blocks(None) == {}
    assert tb.decode_blocks('[1,2,3]') == {}


def test_decode_blocks_normalizes_snake_case_keys():
    decoded = tb.decode_blocks(json.dumps({'tool_use_id': 'toolu_9', 'tool_calls': []}))
    assert decoded['toolUseId'] == 'toolu_9'
    assert decoded['toolCalls'] == []


def test_legacy_row_without_blocks_json_reads_as_before(brain_ready):
    store.save_session({'id': 'sess_legacy', 'title': 'Legacy'})
    store.save_message('sess_legacy', 'user', 'hello there')
    rows = store.get_messages('sess_legacy')
    assert len(rows) == 1
    assert rows[0]['content'] == 'hello there'
    assert 'blocks' not in rows[0]
    assert 'blocksJson' not in rows[0]


def test_workbench_save_persists_blocks_and_keeps_content_for_fts(brain_ready):
    store.save_workbench_session_sot(
        {
            'id': 'sess_blocks',
            'title': 'Structured',
            'messages': [
                {'role': 'user', 'content': 'read a.py'},
                dict(ASSISTANT_TURN),
                dict(TOOL_TURN),
            ],
        }
    )
    rows = store.get_messages('sess_blocks')
    assert [r['role'] for r in rows] == ['user', 'assistant', 'tool']

    assistant = rows[1]
    assert [b['type'] for b in assistant['blocks']] == ['thinking', 'finalOutput', 'toolCall']

    tool_row = rows[2]
    assert tool_row['tool']['name'] == 'read_file'
    assert tool_row['tool']['result'] == 'print(1)'

    # `content` is unchanged, so messages_fts still indexes the same text and
    # session search keeps working exactly as before.
    conn = store._conn()
    fts = conn.execute(
        "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '\"read_file\"'"
    ).fetchone()
    assert fts[0] >= 1


@pytest.mark.asyncio
async def test_api_returns_structured_blocks(client):
    created = await client.post('/api/sessions')
    sid = created.json()['id']

    posted = await client.post(
        f'/api/sessions/{sid}/messages',
        json={
            'role': 'assistant',
            'content': 'done',
            'blocks': [{'id': 'b1', 'type': 'finalOutput', 'content': 'done'}],
            'structured': {'thinking': 'because', 'todos': [{'id': 't1', 'content': 'go', 'status': 'pending'}]},
        },
    )
    assert posted.status_code == 200

    body = (await client.get(f'/api/sessions/{sid}/messages')).json()
    msg = body['messages'][0]
    assert msg['blocks'][0]['content'] == 'done'
    assert msg['thinking'] == 'because'
    assert msg['todos'][0]['content'] == 'go'
    assert 'blocksJson' not in msg


@pytest.mark.asyncio
async def test_api_post_still_accepts_legacy_role_content_only(client):
    created = await client.post('/api/sessions')
    sid = created.json()['id']
    resp = await client.post(
        f'/api/sessions/{sid}/messages', json={'role': 'user', 'content': 'legacy shape'}
    )
    assert resp.status_code == 200
    msg = (await client.get(f'/api/sessions/{sid}/messages')).json()['messages'][0]
    assert msg['content'] == 'legacy shape'
    assert 'blocks' not in msg


def test_migration_047_adds_blocks_json_column():
    from app.lib.migrations import run_migrations
    from app.services.memory_conn import conn

    run_migrations(conn())
    cols = {r['name'] for r in conn().execute('PRAGMA table_info(messages)').fetchall()}
    assert 'blocks_json' in cols
