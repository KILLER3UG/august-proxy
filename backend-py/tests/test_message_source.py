"""Message provenance (migration 049 — audit C3/D7, 2026-09-26).

Pinned here:
  * the ``messages.source`` column exists and the SoT writer persists it for
    tagged rows (NULL for untagged rows — never '');
  * a tail-patched user message persists as the user's text ALONE: the
    per-turn <memory>/skills/<session_state> tail is stripped at the recorded
    ``_tailFrom`` boundary and the marker keys never reach the row;
  * mining trusts the source column and keeps the legacy prefix filter only
    for pre-049 (NULL-source) rows;
  * both upstream dumps strip the August-internal per-message keys.
"""

from __future__ import annotations

import json

import pytest
from app.services import episode_miner as em
from app.services.memory_store import init as store_init
from app.services.memory_store.sessions import save_workbench_session_sot
from app.services.message_sources import (
    MACHINE_SOURCES,
    SOURCE_HARNESS_NUDGE,
    SOURCE_QUEUED_USER,
)


@pytest.fixture
def brain(isolatedData):
    store_init()
    return isolatedData


def _seed(sessionId: str, rows: list[tuple[str, str, str | None]]) -> None:
    from app.services.memory_conn import conn

    c = conn()
    c.execute('INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)', (sessionId, 't'))
    for role, text, source in rows:
        if source is None:
            c.execute(
                'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                (sessionId, role, json.dumps(text)),
            )
        else:
            c.execute(
                'INSERT INTO messages (session_id, role, content, source) VALUES (?, ?, ?, ?)',
                (sessionId, role, json.dumps(text), source),
            )
    c.commit()


def test_source_column_exists(brain):
    from app.services.memory_conn import conn

    cols = {r['name'] for r in conn().execute('PRAGMA table_info(messages)').fetchall()}
    assert 'source' in cols


def test_tail_patched_message_persists_trimmed(brain):
    userText = 'please fix the import order in main.py'
    tail = '\n\n<memory>stale recall block</memory>\n\n<session_state>{"phase":"x"}</session_state>'
    session = {
        'id': 'sess_src_1',
        'title': 't',
        'provider': 'p',
        'model': 'm',
        'messages': [
            {'role': 'user', 'content': userText + tail, '_tailPatched': True, '_tailFrom': len(userText)},
            {'role': 'assistant', 'content': 'done'},
        ],
    }
    save_workbench_session_sot(session)
    from app.services.memory_conn import conn

    rows = conn().execute(
        'SELECT role, content, source FROM messages WHERE session_id = ? ORDER BY id',
        ('sess_src_1',),
    ).fetchall()
    assert rows[0]['content'] == userText
    assert '<memory>' not in rows[0]['content']
    assert rows[0]['source'] is None
    assert rows[1]['source'] is None


def test_source_persists_for_tagged_rows(brain):
    session = {
        'id': 'sess_src_2',
        'title': 't',
        'provider': 'p',
        'model': 'm',
        'messages': [
            {'role': 'user', 'content': 'do the thing', 'source': SOURCE_QUEUED_USER},
            {
                'role': 'user',
                'content': '[Proxy Self-Heal] reflect',
                'source': SOURCE_HARNESS_NUDGE,
            },
        ],
    }
    save_workbench_session_sot(session)
    from app.services.memory_conn import conn

    rows = conn().execute(
        'SELECT source FROM messages WHERE session_id = ? ORDER BY id', ('sess_src_2',)
    ).fetchall()
    assert [r['source'] for r in rows] == [SOURCE_QUEUED_USER, SOURCE_HARNESS_NUDGE]


def test_miner_trusts_source_and_keeps_legacy_fallback(brain):
    # source-tagged machine rows are never mined, whatever they say.
    _seed(
        'sess_src_3',
        [
            ('assistant', 'error: exit code 1 from build', None),
            ('user', 'actually wait — you broke the tests, fix it', SOURCE_HARNESS_NUDGE),
            ('user', 'no, use the other parser instead', None),
        ],
    )
    episodes = em.extract_episodes('sess_src_3')
    corrections = [
        e for e in episodes if e['kind'] == 'correction_accepted'
    ]
    # The NULL-source genuine correction is mined; the tagged one is not.
    assert len(corrections) == 1

    # Legacy fallback: pre-049 rows carry no source but DO carry prefixes.
    _seed(
        'sess_src_4',
        [
            ('assistant', 'error: exit code 1 from build', None),
            ('user', '[Proxy Self-Heal] The last 3 tool results all failed', None),
        ],
    )
    assert em.extract_episodes('sess_src_4') == []


def test_is_machine_row_prefers_column(brain):
    assert em._isMachineRow(SOURCE_HARNESS_NUDGE, 'harmless text')
    assert not em._isMachineRow('', 'harmless text')
    assert em._isMachineRow('', '[Proxy Self-Heal] something')
    # The full machine vocabulary, including the receipt kind no writer
    # emits standalone yet.
    assert MACHINE_SOURCES == {SOURCE_HARNESS_NUDGE, SOURCE_QUEUED_USER, 'subagent_results'}


def test_upstream_dumps_strip_august_message_keys():
    from app.models.anthropic import dump_anthropic_upstream_body
    from app.models.openai import dump_openai_upstream_body

    msg = {
        'role': 'user',
        'content': 'hi',
        '_tailPatched': True,
        '_tailFrom': 2,
        'source': SOURCE_HARNESS_NUDGE,
    }
    for dump in (dump_anthropic_upstream_body, dump_openai_upstream_body):
        body = dump({'model': 'm', 'max_tokens': 8, 'messages': [msg]})
        assert body['messages'] == [{'role': 'user', 'content': 'hi'}]
