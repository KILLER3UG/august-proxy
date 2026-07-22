"""Tests for auto_memory source split, enrichment, and memory_search merge."""

from __future__ import annotations

import pytest


@pytest.fixture()
def brain_ready(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.services.memory_schema import ensure_schema
    from app.services.memory_store import _conn

    c = _conn()
    ensure_schema(c)
    c.commit()
    return c


def test_save_auto_sets_source_and_user_cap_preference(brain_ready):
    from app.services.memory import auto_memory as am

    am.saveAutoMemory('a1', 'agent fact', category='conversation', source='auto', importance=0.2)
    am.create_auto_memory('u1', 'My dog is Beans', category='user', importance=0.9, source='user')

    recalled = am.list_all_auto_memories(origin='recalled', include_telemetry=False)
    added = am.list_all_auto_memories(origin='added')
    assert any(r['key'] == 'a1' for r in recalled)
    assert all(str(r.get('source') or '') != 'user' for r in recalled)
    assert len(added) == 1
    assert added[0]['key'] == 'u1'
    assert added[0]['source'] == 'user'
    assert added[0].get('origin') == 'added'
    assert 'Beans' in str(added[0].get('summary') or added[0].get('content'))


def test_enrichment_never_uses_json_as_title():
    from app.services.memory.auto_memory import enrich_memory_for_model, present_memory_fields

    fields = present_memory_fields(
        'tool_failure_1',
        {'count': 7, 'suggestion': 'Review tool usage patterns'},
        'learning',
    )
    assert not str(fields['title']).lstrip().startswith('{')
    assert '7' in str(fields['summary']) or 'failure' in str(fields['summary']).lower()

    item = enrich_memory_for_model(
        {
            'key': 'tool_failure_1',
            'content': {'count': 7, 'suggestion': 'Review tool usage patterns'},
            'category': 'learning',
            'source': 'auto',
        }
    )
    assert not str(item['label']).lstrip().startswith('{')


def test_telemetry_filtered_from_recalled_list(brain_ready):
    from app.services.memory import auto_memory as am

    am.saveAutoMemory(
        'tool_failure_99',
        'High tool failure rate: 4 errors — review tool usage patterns',
        category='learning',
        source='auto',
    )
    am.saveAutoMemory('conv_ok', 'User asked: hello', category='conversation', source='auto')

    all_rec = am.list_all_auto_memories(origin='recalled', include_telemetry=True)
    filtered = am.list_all_auto_memories(origin='recalled', include_telemetry=False)
    assert any(r['key'] == 'tool_failure_99' for r in all_rec)
    assert not any(r['key'] == 'tool_failure_99' for r in filtered)
    assert any(r['key'] == 'conv_ok' for r in filtered)


@pytest.mark.asyncio
async def test_memory_search_finds_auto_memories(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.tool_registrations.memory_tools import _memorySearch

    unique = 'zebra_unique_memory_token_xyz'
    am.saveAutoMemory(
        'conv_search_test', f'User asked: {unique}', category='conversation', source='auto'
    )

    out = await _memorySearch(unique)
    assert unique in out or 'zebra' in out.lower()
    assert 'No memory results' not in out


def test_user_added_list_for_prompt(brain_ready):
    from app.services.memory import auto_memory as am

    am.create_auto_memory(
        'added_1', 'Prefer short answers', category='user', source='user', importance=0.9
    )
    am.saveAutoMemory('conv_x', 'noise', category='conversation', source='auto')
    rows = am.list_user_added_memories()
    assert len(rows) == 1
    assert rows[0]['source'] == 'user'


def test_present_conv_summary_title():
    from app.services.memory.auto_memory import present_memory_fields

    f = present_memory_fields(
        'conv_summary_wb_1',
        'User asked: help with CI (session wb_1)',
        'conversation',
    )
    assert f['section'] == 'topics'
    assert 'Chat' in str(f['title']) or 'help' in str(f['title']).lower()


def test_added_memories_in_context_builder(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.memory import context_builder as cb

    am.create_auto_memory(
        'added_prompt', 'Remember I like dark mode', category='user', source='user', importance=0.9
    )
    added = am.list_user_added_memories()
    prompt = cb.buildSystemPrompt(session={}, memory={'addedMemories': added})
    assert '<added_memories>' in prompt
    assert 'dark mode' in prompt
