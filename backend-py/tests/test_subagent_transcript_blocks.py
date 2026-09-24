"""Durable sub-agent transcript blocks in `messages.blocks_json`.

The desktop mirrors each delegated worker onto a `subagent` block of its parent
assistant message (frontend `sections/chat/stream/subagent-blocks.ts`) so the
worker's own timeline survives a reload. The block is a NESTED payload — a
worker's block list inside a top-level block — which the enrichment
sanitizer had no rule for: the key was not on the allow-list, so the server
silently dropped it and a restored chat rendered a status stub with no output.

Pinned here:
  * the key survives sanitization with its nested blocks intact;
  * the nested blocks go through the SAME allow-list as top-level ones, so a
    worker transcript cannot smuggle keys the renderer would hand to the UI;
  * a snapshot with no job id is dropped rather than stored (the renderer keys
    and de-duplicates on it);
  * long nested text is clipped, not refused;
  * a `subagent` key on a non-subagent block is still sanitized, and a legacy
    row without one is unaffected.
"""

from __future__ import annotations

import json

from app.services import memory_store as store
from app.services.memory_store import transcript_blocks as tb


def _seed(client_id: str = 'm1', session: str = 'sess_subagent') -> None:
    store.save_session({'id': session, 'title': 'Subagent'})
    store.upsert_client_message(session, client_id, 'assistant', 'the answer')


def _stored_blocks(session: str = 'sess_subagent', client_id: str = 'm1') -> list[dict]:
    raw = store._conn().execute(
        'SELECT blocks_json FROM messages WHERE client_message_id = ?', (client_id,)
    ).fetchone()[0]
    return json.loads(raw)['blocks']


def _worker_block(**overrides: object) -> dict:
    snapshot = {
        'jobId': 'job-1',
        'parentToolId': 'toolu_spawn',
        'agentId': 'research',
        'task': 'Audit the memory plan',
        'status': 'completed',
        'startedAt': 1000,
        'finishedAt': 2000,
        'blocks': [
            {'id': 'w_think_0', 'type': 'thinking', 'content': 'reading the list'},
            {
                'id': 'w_tool_0',
                'type': 'toolCall',
                'tool': {'id': 'w_tool_0', 'name': 'read_file', 'status': 'done'},
            },
            {'id': 'w_out_0', 'type': 'finalOutput', 'content': 'Three gaps found.'},
        ],
    }
    snapshot.update(overrides)
    return {'id': 'b_sub_job-1', 'type': 'subagent', 'subagent': snapshot}


def test_subagent_block_survives_sanitization_with_its_timeline(brain_ready):
    _seed()
    result = store.enrich_client_message('sess_subagent', 'm1', [_worker_block()])
    assert result['ok']

    blocks = _stored_blocks()
    assert len(blocks) == 1
    assert blocks[0]['type'] == 'subagent'
    snapshot = blocks[0]['subagent']
    assert snapshot['jobId'] == 'job-1'
    assert snapshot['status'] == 'completed'
    # The worker's own transcript is what makes the restored row useful.
    assert [b['type'] for b in snapshot['blocks']] == [
        'thinking',
        'toolCall',
        'finalOutput',
    ]
    assert snapshot['blocks'][-1]['content'] == 'Three gaps found.'


def test_nested_worker_blocks_use_the_same_allow_list(brain_ready):
    _seed()
    block = _worker_block()
    block['subagent']['blocks'].append(
        {'id': 'w_evil', 'type': 'finalOutput', 'content': 'x', 'secret': 'dropped'}
    )
    store.enrich_client_message('sess_subagent', 'm1', [block])

    nested = _stored_blocks()[0]['subagent']['blocks']
    evil = next(b for b in nested if b['id'] == 'w_evil')
    assert 'secret' not in evil


def test_unknown_snapshot_keys_are_dropped(brain_ready):
    _seed()
    block = _worker_block()
    block['subagent']['apiKey'] = 'sk-should-not-persist'
    store.enrich_client_message('sess_subagent', 'm1', [block])

    assert 'apiKey' not in _stored_blocks()[0]['subagent']


def test_a_snapshot_without_a_job_id_is_dropped(brain_ready):
    # The renderer keys and de-duplicates on the job id; a row without one
    # cannot be placed, so it is not worth storing.
    cleaned = tb.sanitize_enrichment([{'id': 'b_sub_x', 'type': 'subagent', 'subagent': {'agentId': 'r'}}])
    assert cleaned.get('blocks', [{}])[0].get('subagent') is None


def test_a_non_dict_snapshot_is_dropped(brain_ready):
    cleaned = tb.sanitize_enrichment([{'id': 'b_sub_x', 'type': 'subagent', 'subagent': 'nope'}])
    assert 'subagent' not in cleaned['blocks'][0]


def test_long_nested_worker_text_is_clipped_not_refused(brain_ready):
    _seed()
    huge = 'z' * (tb.MAX_ENRICHMENT_BLOCK_CONTENT * 2)
    block = _worker_block(blocks=[{'id': 'w_out_0', 'type': 'finalOutput', 'content': huge}])
    result = store.enrich_client_message('sess_subagent', 'm1', [block])
    assert result['ok']
    nested = _stored_blocks()[0]['subagent']['blocks'][0]
    assert len(nested['content']) <= tb.MAX_ENRICHMENT_BLOCK_CONTENT + 1


def test_a_legacy_block_row_is_unaffected(brain_ready):
    _seed()
    store.enrich_client_message(
        'sess_subagent', 'm1', [{'id': 'b1', 'type': 'finalOutput', 'content': 'hi'}]
    )
    blocks = _stored_blocks()
    assert 'subagent' not in blocks[0]
    assert blocks[0]['content'] == 'hi'


def test_a_worker_row_fits_the_byte_budget_by_trimming_its_own_blocks(brain_ready):
    """A chatty worker must not push the whole message past the cap.

    The byte budget drops TRAILING top-level blocks, so a single oversized
    subagent block would previously take the entire timeline down with it.
    Nested blocks are clipped on the way in for exactly this reason.
    """
    _seed()
    big = 'q' * (tb.MAX_ENRICHMENT_BLOCK_CONTENT - 20)
    block = _worker_block(
        blocks=[{'id': f'w_out_{i}', 'type': 'finalOutput', 'content': big} for i in range(60)]
    )
    result = store.enrich_client_message('sess_subagent', 'm1', [block])
    assert result['ok']
    stored = _stored_blocks()
    assert len(stored) == 1
    assert tb.enrichment_size({'blocks': stored}) <= tb.MAX_ENRICHMENT_BYTES
