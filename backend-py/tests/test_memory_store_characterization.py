"""Characterization tests for memory_store — capture current behavior as-is.

These tests use the isolatedData fixture so they never touch the real brain DB.
They intentionally assert the *current* camelCase schema and return shapes
(post snake→camel migration), not an idealized API.

Do not "improve" assertions to preferred shapes without an approved behavior change.
"""

from __future__ import annotations

import pytest

from app.services import memory_store as ms


@pytest.fixture
def brain(isolatedData):
    """Isolated brain DB ready for use (init already called by isolatedData)."""
    return isolatedData


class TestMemoryKvCharacterization:
    def test_save_get_roundtrip_dict(self, brain):
        ms.save_memory('char_key', {'hello': 'world', 'n': 1})
        assert ms.get_memory('char_key') == {'hello': 'world', 'n': 1}

    def test_get_missing_returns_none(self, brain):
        assert ms.get_memory('does_not_exist') is None

    def test_delete_returns_bool_and_removes(self, brain):
        ms.save_memory('del_me', 'value')
        assert ms.delete_memory('del_me') is True
        assert ms.get_memory('del_me') is None
        assert ms.delete_memory('del_me') is False

    def test_list_memory_pattern_and_camel_keys(self, brain):
        ms.save_memory('a_1', 'v1')
        ms.save_memory('a_2', 'v2')
        ms.save_memory('b_1', 'v3')
        entries = ms.list_memory('a_%')
        assert len(entries) == 2
        # Current shape uses camelCase updatedAt (not updated_at).
        assert all('updatedAt' in e for e in entries)
        assert {e['key'] for e in entries} == {'a_1', 'a_2'}

    def test_search_memory_finds_by_key_or_value(self, brain):
        ms.save_memory('hello_world', {'msg': 'Hello there'})
        results = ms.search_memory('hello')
        assert len(results) >= 1
        assert any(r.get('key') == 'hello_world' for r in results)

    def test_search_empty_query_returns_empty(self, brain):
        ms.save_memory('x', 'y')
        assert ms.search_memory('') == []
        assert ms.search_memory('   ') == []


class TestFactsCharacterization:
    def test_save_get_uses_camel_case_columns(self, brain):
        ms.save_fact('user_name', 'Alice', category='identity', source='test', confidence=0.9)
        fact = ms.get_fact('user_name')
        assert fact is not None
        # Current sqlite Row → dict preserves physical column names (camelCase).
        assert fact['factKey'] == 'user_name'
        assert fact['category'] == 'identity'
        assert fact['source'] == 'test'
        assert fact['confidence'] == 0.9
        # factValue is stored as JSON text of the scalar string.
        assert 'Alice' in str(fact['factValue'])

    def test_list_facts_by_category(self, brain):
        ms.save_fact('f1', 'v1', category='cat_a')
        ms.save_fact('f2', 'v2', category='cat_a')
        ms.save_fact('f3', 'v3', category='cat_b')
        assert len(ms.list_facts('cat_a')) == 2
        assert len(ms.list_facts()) >= 3

    def test_delete_fact(self, brain):
        ms.save_fact('to_delete', 'x')
        assert ms.delete_fact('to_delete') is True
        assert ms.get_fact('to_delete') is None
        assert ms.delete_fact('to_delete') is False

    def test_search_facts(self, brain):
        ms.save_fact('color', 'blue', category='prefs')
        results = ms.search_facts('blue')
        assert len(results) >= 1
        assert any(r.get('factKey') == 'color' for r in results)


class TestProposalsCharacterization:
    def test_create_get_decide(self, brain):
        pid = ms.save_proposal('session_1', 'plan', {'steps': ['Do X']})
        prop = ms.get_proposal(pid)
        assert prop is not None
        assert prop['status'] == 'pending'
        assert prop['sessionId'] == 'session_1'
        assert prop['proposalType'] == 'plan'

        assert ms.decide_proposal(pid, 'approved', 'user') is True
        decided = ms.get_proposal(pid)
        assert decided is not None
        assert decided['status'] == 'approved'
        assert decided['decidedBy'] == 'user'

    def test_list_proposals_by_session(self, brain):
        ms.save_proposal('s1', 'plan', {})
        ms.save_proposal('s1', 'mutation', {})
        ms.save_proposal('s2', 'plan', {})
        assert len(ms.list_proposals('s1')) == 2


class TestLifecycleAndAuditCharacterization:
    def test_record_and_list_lifecycle(self, brain):
        lid = ms.record_lifecycle('session_1', 'session_started', {'task': 'test'})
        assert lid > 0
        events = ms.list_lifecycle('session_1')
        assert len(events) == 1
        assert events[0]['eventType'] == 'session_started'
        assert events[0]['sessionId'] == 'session_1'

    def test_config_audit_roundtrip(self, brain):
        aid = ms.record_config_audit('alias', 'create', actor='test', before=None, after={'a': 1})
        assert aid > 0
        rows = ms.list_config_audit(category='alias', limit=10)
        assert any(r.get('action') == 'create' for r in rows)


class TestSessionAndMessagesCharacterization:
    def test_session_crud(self, brain):
        session = {
            'id': 'test-session-1',
            'title': 'Test',
            'startedAt': 'now',
            'messageCount': 0,
            'provider': 'anthropic',
            'model': 'claude',
        }
        ms.save_session(session)
        got = ms.get_session('test-session-1')
        assert got is not None
        assert got['id'] == 'test-session-1'
        assert got['title'] == 'Test'

        sessions = ms.list_sessions()
        assert any(s.get('id') == 'test-session-1' for s in sessions)

        assert ms.delete_session_record('test-session-1') is True
        assert ms.get_session('test-session-1') is None

    def test_messages_roundtrip(self, brain):
        ms.save_session({'id': 'msg-s1', 'title': 'M', 'startedAt': 't', 'messageCount': 0})
        mid = ms.save_message('msg-s1', 'user', {'text': 'hi'})
        assert mid > 0
        messages = ms.get_messages('msg-s1')
        assert len(messages) == 1
        assert messages[0]['role'] == 'user'
        # content is JSON-serialized then reloaded
        content = messages[0]['content']
        assert content == {'text': 'hi'} or 'hi' in str(content)

        deleted = ms.delete_session_messages('msg-s1')
        assert deleted == 1
        assert ms.get_messages('msg-s1') == []


class TestUsageAndTopicsCharacterization:
    def test_usage_aggregates(self, brain):
        ms.record_usage('u-s1', 'model-a', inputTokens=10, outputTokens=5, contextTokens=100)
        ms.record_usage('u-s1', 'model-a', inputTokens=3, outputTokens=2, contextTokens=50)
        usage = ms.get_usage('u-s1')
        # Current shape (as returned by get_usage today).
        assert usage['sessionId'] == 'u-s1'
        assert usage['totalInputTokens'] == 13
        assert usage['totalOutputTokens'] == 7
        assert usage['totalEvents'] == 2
        assert usage['latestContextTokens'] == 50
        assert isinstance(usage['events'], list) and len(usage['events']) == 2

    def test_topic_index(self, brain):
        assert ms.index_session_topic('s1', 'debug') is True
        topic = ms.get_session_topic('s1')
        assert topic is not None
        assert topic['topic'] == 'debug'
        assert topic['sessionId'] == 's1'
        topics = ms.list_topics()
        assert any(t.get('sessionId') == 's1' for t in topics)


class TestStatsAndTimelineCharacterization:
    def test_get_stats_keys(self, brain):
        ms.save_memory('k', 'v')
        stats = ms.get_stats()
        assert isinstance(stats, dict)
        # At least one of the expected counters is present and non-negative.
        assert any(isinstance(v, int) and v >= 0 for v in stats.values())

    def test_timeline_write(self, brain):
        tid = ms.write_timeline_event('s1', 'did something', category='general')
        assert tid > 0
