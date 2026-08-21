"""Trivial-conversation noise gate + reviewer merge action.

Covers the legacy ``conv_summary_*`` cleanup: test chatter ("User asked: hi",
"reply pong") must never reach episodes or graph labels, and the review plan
must accept ``merge`` actions that fold near-duplicates into one row.
"""

from __future__ import annotations

import pytest
from app.services.memory.auto_memory import (
    _is_trivial_conversation,
    consolidate_conv_summaries,
    present_memory_fields,
)


@pytest.fixture(autouse=True)
def _no_md_export(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the debounced markdown-exporter from firing real writes mid-test."""
    monkeypatch.setenv('AUGUST_MEMORY_MD_EXPORT', '0')


@pytest.mark.parametrize(
    'content',
    [
        'User asked: hi (session wb_1)',
        'User asked: hello',
        'User asked: reply with exactly: pong',
        'User asked: test; User asked: test (session wb_2)',
        'User asked: thanks!',
    ],
)
def test_trivial_conversations_detected(content: str) -> None:
    assert _is_trivial_conversation(content) is True


@pytest.mark.parametrize(
    'content',
    [
        'User asked: fix the CI pipeline (session wb_3)',
        'User asked: what does the verifier gate do?',
        'Discussed QLoRA shard annealing for 40 minutes',
        '',
    ],
)
def test_substantive_conversations_kept(content: str) -> None:
    assert _is_trivial_conversation(content) is False


def test_present_fields_neutral_title_for_chatter() -> None:
    fields = present_memory_fields('conv_summary_wb_9', 'User asked: pong (session wb_9)', 'conversation')
    assert fields['title'] == 'Conversation'


def test_present_fields_keeps_semantic_chat_title() -> None:
    fields = present_memory_fields(
        'conv_summary_wb_10', 'User asked: migrate auth to JWT (session wb_10)', 'conversation'
    )
    assert str(fields['title']).startswith('Chat:')


def test_purge_and_episode_merge_skip_trivial(tmp_path, monkeypatch) -> None:
    auto_memory = pytest.importorskip('app.services.memory.auto_memory')
    conn = auto_memory._conn()
    now = '2026-08-21T00:00:00Z'
    rows = [
        ('conv_summary_wb_1', 'User asked: hi (session wb_1)'),
        ('conv_summary_wb_2', 'User asked: real question about deploys (session wb_2)'),
    ]
    for key, content in rows:
        conn.execute(
            'INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (key, content, 'conversation', 0.5, 'auto', 0, now, now),
        )
    conn.commit()
    purged = auto_memory.purge_trivial_conv_summaries()
    assert purged == 1
    remaining = [r['key'] for r in conn.execute("SELECT key FROM auto_memories WHERE key LIKE 'conv_summary_%'")]
    assert remaining == ['conv_summary_wb_2']


def test_merge_action_applies(monkeypatch) -> None:
    from app.services.memory import memory_review

    monkeypatch.setattr(memory_review, '_call_selected_model', lambda *a, **k: None)
    # Direct applier check without a model call:
    from app.services.memory.auto_memory import create_auto_memory, delete_auto_memory, get_auto_memory

    keep_id = create_auto_memory('merge_keep', 'User prefers dark theme', category='preference')
    dup_id = create_auto_memory('merge_dup', 'User likes dark theme', category='preference')
    try:
        assert keep_id and dup_id
        result = memory_review.apply_review_actions(
            [{'kind': 'merge', 'keepId': keep_id, 'removeIds': [dup_id], 'mergedText': 'User prefers the dark theme across all apps'}]
        )
        assert result['merged'] == 1
        kept = get_auto_memory(keep_id)
        assert kept is not None and 'dark theme' in str(kept.get('content'))
        assert get_auto_memory(dup_id) is None
    finally:
        if keep_id:
            delete_auto_memory(keep_id)
        if dup_id:
            delete_auto_memory(dup_id)
