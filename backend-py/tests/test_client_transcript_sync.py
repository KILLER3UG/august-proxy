"""Client/server rich transcript synchronization (migration 048).

Migration 047 made `messages.blocks_json` durable, but the desktop still owns
the block timeline: it renders tool cards, reasoning, attachments and inline
cards the backend's own transcript cannot derive. Syncing that back needs a
join key that survives the workbench save, which re-writes the whole
`messages` table on every durability barrier.

Pinned here:
  * `client_message_id` exists, is unique per session, and makes the POST
    idempotent (create → adopt an identical backend row → update in place);
  * the PATCH/PUT enrichment endpoint writes ONLY `blocks_json` — never the
    FTS-indexed `content` — with an allow-listed, size-capped payload, and is a
    no-op when the same payload is sent twice;
  * the workbench snapshot rewrite keeps the client id and the synced timeline;
  * a legacy caller (no client id) behaves exactly as before.
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


TOOL_BLOCKS = [
    {
        'id': 'toolu_1',
        'type': 'toolCall',
        'tool': {'id': 'toolu_1', 'name': 'read_file', 'status': 'done', 'result': 'print(1)'},
    }
]


# ── migration / schema ───────────────────────────────────────────────────


def test_migration_048_adds_client_message_id_and_index(brain_ready):
    from app.lib.migrations import run_migrations
    from app.services.memory_conn import conn

    run_migrations(conn())
    cols = {r['name'] for r in conn().execute('PRAGMA table_info(messages)').fetchall()}
    assert 'client_message_id' in cols
    indexes = {
        r['name'] for r in conn().execute('PRAGMA index_list(messages)').fetchall()
    }
    assert 'idx_messages_client_id' in indexes


def test_migration_048_scopes_the_fts_update_trigger(brain_ready):
    """A blocks-only write must not re-index content.

    047's `AFTER UPDATE ON messages` fired for every UPDATE, so enriching one
    message's blocks re-indexed that row's text. 048 narrows the trigger to the
    indexed columns; this asserts the live trigger, not just the SQL file.
    """
    from app.services.memory_conn import conn

    sql = conn().execute(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_au'"
    ).fetchone()
    assert sql is not None and sql[0]
    body = ' '.join(str(sql[0]).split()).upper()
    assert 'AFTER UPDATE OF CONTENT, SESSION_ID, ROLE ON MESSAGES' in body


def test_legacy_message_still_writes_a_null_client_id(brain_ready):
    store.save_session({'id': 'sess_legacy_048', 'title': 'Legacy'})
    store.save_message('sess_legacy_048', 'user', 'hello there')
    row = store.get_messages('sess_legacy_048')[0]
    assert not row.get('clientMessageId')


# ── store: upsert reconciliation ─────────────────────────────────────────


def test_upsert_creates_then_updates_the_same_row(brain_ready):
    store.save_session({'id': 'sess_upsert', 'title': 'Upsert'})
    first = store.upsert_client_message('sess_upsert', 'm1', 'user', 'hi')
    assert first['status'] == 'created'
    second = store.upsert_client_message('sess_upsert', 'm1', 'user', 'hi there')
    assert second['status'] == 'updated'
    assert second['id'] == first['id']
    assert store.count_messages('sess_upsert') == 1


def test_upsert_adopts_an_identical_backend_row_instead_of_duplicating(brain_ready):
    """The workbench loop already wrote this user turn.

    The desktop then syncs it. Inserting a second row would show the same
    bubble twice in every restored chat, so the unclaimed twin is adopted.
    """
    store.save_session({'id': 'sess_adopt', 'title': 'Adopt'})
    store.save_message('sess_adopt', 'user', 'read a.py')
    result = store.upsert_client_message('sess_adopt', 'm42', 'user', 'read a.py')
    assert result['status'] == 'adopted'
    assert store.count_messages('sess_adopt') == 1
    assert store.get_messages('sess_adopt')[0]['clientMessageId'] == 'm42'


def test_upsert_does_not_adopt_a_row_another_client_claimed(brain_ready):
    store.save_session({'id': 'sess_owned', 'title': 'Owned'})
    store.save_message('sess_owned', 'user', 'shared text')
    store.upsert_client_message('sess_owned', 'm1', 'user', 'shared text')
    other = store.upsert_client_message('sess_owned', 'm2', 'user', 'shared text')
    assert other['status'] == 'created'
    assert store.count_messages('sess_owned') == 2


def test_upsert_rejects_an_empty_client_id(brain_ready):
    with pytest.raises(ValueError):
        store.upsert_client_message('sess_bad', '   ', 'user', 'x')


def test_client_message_id_is_bounded(brain_ready):
    store.save_session({'id': 'sess_bound', 'title': 'Bound'})
    long_id = 'm' + 'x' * 5000
    store.upsert_client_message('sess_bound', long_id, 'user', 'hi')
    row = store.get_messages('sess_bound')[0]
    assert len(row['clientMessageId']) == store.MAX_CLIENT_MESSAGE_ID_CHARS


# ── store: enrichment ────────────────────────────────────────────────────


def _seed(client_id: str = 'm1', session: str = 'sess_enrich') -> int:
    store.save_session({'id': session, 'title': 'Enrich'})
    result = store.upsert_client_message(session, client_id, 'user', 'read a.py')
    return int(result['id'])


def test_enrichment_writes_blocks_without_touching_content_or_fts(brain_ready):
    _seed()
    before = store._conn().execute(
        "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '\"read\"'"
    ).fetchone()[0]

    result = store.enrich_client_message(
        'sess_enrich', 'm1', TOOL_BLOCKS, {'thinking': 'checking'}
    )
    assert result['ok'] and result['unchanged'] is False

    row = store.get_messages('sess_enrich')[0]
    assert row['content'] == 'read a.py'  # FTS text untouched
    assert row['blocks'][0]['tool']['name'] == 'read_file'
    assert row['thinking'] == 'checking'
    after = store._conn().execute(
        "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '\"read\"'"
    ).fetchone()[0]
    assert after == before


def test_enrichment_is_idempotent(brain_ready):
    _seed()
    first = store.enrich_client_message('sess_enrich', 'm1', TOOL_BLOCKS)
    assert first['unchanged'] is False
    # Same payload, different key order / re-serialized string.
    reordered = store.enrich_client_message(
        'sess_enrich', 'm1', [dict(reversed(list(TOOL_BLOCKS[0].items())))]
    )
    assert reordered['ok'] and reordered['unchanged'] is True
    assert store.count_messages('sess_enrich') == 1


def test_enrichment_reports_not_found_for_an_unknown_client_id(brain_ready):
    _seed()
    result = store.enrich_client_message('sess_enrich', 'nope', TOOL_BLOCKS)
    assert result == {'ok': False, 'reason': 'not_found'}


def test_enrichment_reports_empty_when_nothing_is_allow_listed(brain_ready):
    _seed()
    result = store.enrich_client_message('sess_enrich', 'm1', [{'no': 'id or type'}], {'evil': 1})
    assert result == {'ok': False, 'reason': 'empty'}


def test_enrichment_drops_unknown_keys_and_caps_block_text(brain_ready):
    _seed()
    huge = 'x' * (tb.MAX_ENRICHMENT_BLOCK_CONTENT * 3)
    store.enrich_client_message(
        'sess_enrich',
        'm1',
        [{'id': 'b1', 'type': 'finalOutput', 'content': huge, 'secret': 'dropped'}],
        {'thinking': 'ok', 'notAField': 'dropped'},
    )
    raw = store._conn().execute(
        'SELECT blocks_json FROM messages WHERE client_message_id = ?', ('m1',)
    ).fetchone()[0]
    stored = json.loads(raw)
    assert 'notAField' not in stored
    assert stored['blocks'][0]['type'] == 'finalOutput'
    assert 'secret' not in stored['blocks'][0]
    assert len(stored['blocks'][0]['content']) <= tb.MAX_ENRICHMENT_BLOCK_CONTENT + 1


def test_enrichment_fits_the_payload_by_dropping_trailing_blocks(brain_ready):
    _seed()
    big = 'y' * (tb.MAX_ENRICHMENT_BLOCK_CONTENT - 10)
    blocks = [
        {'id': f'b{i}', 'type': 'finalOutput', 'content': big} for i in range(30)
    ]
    result = store.enrich_client_message('sess_enrich', 'm1', blocks)
    assert result['ok']
    stored = store.get_messages('sess_enrich')[0]['blocks']
    assert 0 < len(stored) < 30  # trimmed, not refused
    assert stored[-1]['id'] == f'b{len(stored) - 1}'  # oldest kept, tail dropped
    assert tb.enrichment_size({'blocks': stored}) <= tb.MAX_ENRICHMENT_BYTES


def test_enrichment_refuses_a_payload_too_large_to_trim(brain_ready):
    """A wide, block-less payload cannot be reduced by dropping blocks.

    Long strings and long lists are clipped on the way in, so the byte budget
    is normally met by trimming trailing blocks. A wide object (many keys, no
    clip path) with no blocks to drop is refused rather than stored.
    """
    _seed()
    result = store.enrich_client_message(
        'sess_enrich',
        'm1',
        None,
        {'usage': {f'k{i}': i for i in range(20_000)}},
    )
    assert result == {'ok': False, 'reason': 'too_large'}


def test_enrichment_clips_an_oversized_string_instead_of_refusing(brain_ready):
    _seed()
    result = store.enrich_client_message(
        'sess_enrich', 'm1', None, {'thinking': 'w' * (tb.MAX_ENRICHMENT_BYTES * 2)}
    )
    assert result['ok'] is True
    assert len(store.get_messages('sess_enrich')[0]['thinking']) <= (
        tb.MAX_ENRICHMENT_BLOCK_CONTENT + 1
    )


# ── workbench snapshot preservation ──────────────────────────────────────


def test_workbench_save_preserves_client_id_and_synced_blocks(brain_ready):
    store.save_session({'id': 'sess_snapshot', 'title': 'Snapshot'})
    store.upsert_client_message('sess_snapshot', 'm1', 'user', 'read a.py')
    store.enrich_client_message('sess_snapshot', 'm1', TOOL_BLOCKS)

    # The very next durability barrier rewrites the whole table.
    store.save_workbench_session_sot(
        {
            'id': 'sess_snapshot',
            'title': 'Snapshot',
            'messages': [
                # The backend's copy of the same turn: the desktop prompt is the
                # leading text, the @git snapshot is appended by the send path.
                {'role': 'user', 'content': 'read a.py\n\n<git>branch main</git>'},
                {'role': 'assistant', 'content': 'done'},
            ],
        }
    )

    rows = store.get_messages('sess_snapshot')
    user = rows[0]
    assert user['clientMessageId'] == 'm1'
    assert user['blocks'][0]['tool']['name'] == 'read_file'
    # A message the client never claimed keeps a NULL id.
    assert not rows[1].get('clientMessageId')


def test_workbench_save_keeps_a_client_timeline_the_snapshot_cannot_derive(brain_ready):
    store.save_session({'id': 'sess_keep', 'title': 'Keep'})
    store.upsert_client_message('sess_keep', 'm1', 'user', 'read a.py')
    store.enrich_client_message('sess_keep', 'm1', TOOL_BLOCKS)

    store.save_workbench_session_sot(
        {
            'id': 'sess_keep',
            'title': 'Keep',
            'messages': [
                {'role': 'user', 'content': 'read a.py'},
                {'role': 'assistant', 'content': [
                    {'type': 'text', 'text': 'done'},
                ]},
            ],
        }
    )
    user = store.get_messages('sess_keep')[0]
    assert user['clientMessageId'] == 'm1'
    assert user['blocks'][0]['type'] == 'toolCall'


def test_workbench_save_honors_an_explicit_client_id_in_the_snapshot(brain_ready):
    store.save_workbench_session_sot(
        {
            'id': 'sess_explicit',
            'title': 'Explicit',
            'messages': [
                {'role': 'user', 'content': 'hello', 'clientMessageId': 'm9'},
            ],
        }
    )
    assert store.get_messages('sess_explicit')[0]['clientMessageId'] == 'm9'


def test_workbench_save_drops_a_removed_message_and_its_identity(brain_ready):
    """The backend transcript stays authoritative for removals (Undo/clear)."""
    store.save_session({'id': 'sess_undo', 'title': 'Undo'})
    store.upsert_client_message('sess_undo', 'm1', 'user', 'first')
    store.upsert_client_message('sess_undo', 'm2', 'user', 'second')
    store.save_workbench_session_sot(
        {'id': 'sess_undo', 'title': 'Undo', 'messages': [{'role': 'user', 'content': 'second'}]}
    )
    rows = store.get_messages('sess_undo')
    assert [r['content'] for r in rows] == ['second']
    assert [r['clientMessageId'] for r in rows] == ['m2']


def test_workbench_save_never_rolls_back_on_a_duplicate_client_id(brain_ready):
    store.save_workbench_session_sot(
        {
            'id': 'sess_dup',
            'title': 'Dup',
            'messages': [
                {'role': 'user', 'content': 'one', 'clientMessageId': 'm1'},
                {'role': 'user', 'content': 'two', 'clientMessageId': 'm1'},
            ],
        }
    )
    rows = store.get_messages('sess_dup')
    assert [r['content'] for r in rows] == ['one', 'two']
    assert rows[0]['clientMessageId'] == 'm1'
    assert not rows[1].get('clientMessageId')


# ── HTTP contract ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_with_client_message_id_is_idempotent_over_http(client):
    sid = (await client.post('/api/sessions')).json()['id']
    body = {'role': 'user', 'content': 'read a.py', 'clientMessageId': 'm1'}

    first = await client.post(f'/api/sessions/{sid}/messages', json=body)
    second = await client.post(f'/api/sessions/{sid}/messages', json=body)
    assert first.status_code == second.status_code == 200
    assert first.json()['id'] == second.json()['id']
    listed = (await client.get(f'/api/sessions/{sid}/messages')).json()['messages']
    assert len(listed) == 1


@pytest.mark.asyncio
async def test_post_without_client_id_is_unchanged(client):
    sid = (await client.post('/api/sessions')).json()['id']
    resp = await client.post(
        f'/api/sessions/{sid}/messages', json={'role': 'user', 'content': 'plain'}
    )
    assert resp.status_code == 200
    assert 'write' not in resp.json()
    assert (await client.get(f'/api/sessions/{sid}/messages')).json()['messages'][0]['content'] == 'plain'


@pytest.mark.asyncio
@pytest.mark.parametrize('method', ['patch', 'put'])
async def test_enrichment_endpoint_round_trip(client, method):
    sid = (await client.post('/api/sessions')).json()['id']
    await client.post(
        f'/api/sessions/{sid}/messages',
        json={'role': 'assistant', 'content': 'done', 'clientMessageId': 'a1'},
    )

    resp = await getattr(client, method)(
        f'/api/sessions/{sid}/messages/enrichment',
        json={'clientMessageId': 'a1', 'blocks': TOOL_BLOCKS, 'structured': {'usage': {'inputTokens': 3}}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body['unchanged'] is False
    assert body['clientMessageId'] == 'a1'

    # Re-sending the same payload is a no-op, and the content text is intact.
    again = await getattr(client, method)(
        f'/api/sessions/{sid}/messages/enrichment',
        json={'clientMessageId': 'a1', 'blocks': TOOL_BLOCKS, 'structured': {'usage': {'inputTokens': 3}}},
    )
    assert again.json()['unchanged'] is True

    msg = (await client.get(f'/api/sessions/{sid}/messages')).json()['messages'][0]
    assert msg['content'] == 'done'
    assert msg['blocks'][0]['tool']['result'] == 'print(1)'
    assert msg['usage']['inputTokens'] == 3


@pytest.mark.asyncio
async def test_enrichment_404s_for_an_unknown_client_id(client):
    sid = (await client.post('/api/sessions')).json()['id']
    resp = await client.patch(
        f'/api/sessions/{sid}/messages/enrichment',
        json={'clientMessageId': 'ghost', 'blocks': TOOL_BLOCKS},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_enrichment_400s_without_a_client_id(client):
    sid = (await client.post('/api/sessions')).json()['id']
    resp = await client.patch(
        f'/api/sessions/{sid}/messages/enrichment', json={'blocks': TOOL_BLOCKS}
    )
    assert resp.status_code == 422  # required field missing

    blank = await client.patch(
        f'/api/sessions/{sid}/messages/enrichment', json={'clientMessageId': '  ', 'blocks': TOOL_BLOCKS}
    )
    assert blank.status_code == 400


@pytest.mark.asyncio
async def test_enrichment_400s_when_nothing_is_allow_listed(client):
    sid = (await client.post('/api/sessions')).json()['id']
    await client.post(
        f'/api/sessions/{sid}/messages',
        json={'role': 'user', 'content': 'x', 'clientMessageId': 'm1'},
    )
    resp = await client.patch(
        f'/api/sessions/{sid}/messages/enrichment',
        json={'clientMessageId': 'm1', 'structured': {'definitelyNotAField': 1}},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_enrichment_413s_for_an_oversized_field(client):
    sid = (await client.post('/api/sessions')).json()['id']
    await client.post(
        f'/api/sessions/{sid}/messages',
        json={'role': 'user', 'content': 'x', 'clientMessageId': 'm1'},
    )
    resp = await client.patch(
        f'/api/sessions/{sid}/messages/enrichment',
        json={'clientMessageId': 'm1', 'structured': {'usage': {f'k{i}': i for i in range(20_000)}}},
    )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_client_message_id_survives_an_http_workbench_save(client):
    sid = (await client.post('/api/sessions')).json()['id']
    await client.post(
        f'/api/sessions/{sid}/messages',
        json={'role': 'user', 'content': 'read a.py', 'clientMessageId': 'm1'},
    )
    await client.patch(
        f'/api/sessions/{sid}/messages/enrichment',
        json={'clientMessageId': 'm1', 'blocks': TOOL_BLOCKS},
    )

    store.save_workbench_session_sot(
        {
            'id': sid,
            'title': 'Durable',
            'messages': [{'role': 'user', 'content': 'read a.py'}],
        }
    )

    msg = (await client.get(f'/api/sessions/{sid}/messages')).json()['messages'][0]
    assert msg['clientMessageId'] == 'm1'
    assert msg['blocks'][0]['tool']['name'] == 'read_file'
