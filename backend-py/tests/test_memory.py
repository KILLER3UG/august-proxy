"""Memory system unit tests."""

import pytest
from app.services.memory_store import (
    init,
    close,
    save_memory,
    get_memory,
    delete_memory,
    list_memory,
    search_memory,
    save_fact,
    get_fact,
    search_facts,
    list_facts,
    delete_fact,
    save_proposal,
    get_proposal,
    list_proposals,
    decide_proposal,
    record_lifecycle,
    list_lifecycle,
    index_session_topic,
    get_session_topic,
    list_topics,
    save_session,
    get_session,
    list_sessions,
    delete_session_record,
    save_message,
    get_messages,
    record_usage,
    get_usage,
    get_stats,
    vacuum,
)
from app.services.memory.brain_orchestrator import getBrainConfig, classifyTask, riskForTask, extractTextFromMessages
from app.adapters.anthropic import normalizeSystemBlocks, systemBlocksToText
from app.services.memory.context_builder import buildSlimCoreContext
from app.services.memory.context_compressor import (
    compressMessages,
    localSummarize,
    buildSummaryMessage,
    _isSummaryMessage,
    _extractSummaryText,
    DEFAULT_SUMMARY_MARKER,
)
from app.services.memory.context_scrubber import ContextScrubber, stripMemoryBlocks
from app.services.memory.topic_index import classifyTopic


@pytest.fixture(autouse=True)
def setupDb():
    init()
    yield
    from app.services.memory_store import _conn

    conn = _conn()
    conn.executescript(
        '\n        PRAGMA foreign_keys = OFF;\n        DELETE FROM messages;\n        DELETE FROM sessions;\n        DELETE FROM usage_events;\n        DELETE FROM lifecycle;\n        DELETE FROM proposals;\n        DELETE FROM session_topics;\n        DELETE FROM facts;\n        DELETE FROM memory_store;\n        PRAGMA foreign_keys = ON;\n    '
    )
    conn.commit()
    close()


class TestMemoryKV:
    def testSaveAndGet(self):
        save_memory('test_key', {'hello': 'world'})
        val = get_memory('test_key')
        assert val == {'hello': 'world'}

    def testGetNonexistent(self):
        val = get_memory('nonexistent')
        assert val is None

    def testDelete(self):
        save_memory('del_key', 'value')
        assert delete_memory('del_key') is True
        assert get_memory('del_key') is None
        assert delete_memory('del_key') is False

    def testList(self):
        save_memory('a_1', 'v1')
        save_memory('a_2', 'v2')
        save_memory('b_1', 'v3')
        entries = list_memory('a_%')
        assert len(entries) == 2

    def testSearch(self):
        save_memory('hello_world', {'msg': 'Hello there'})
        results = search_memory('hello')
        assert len(results) >= 1


class TestFacts:
    def testSaveAndGet(self):
        save_fact('user_name', 'Alice', category='identity')
        fact = get_fact('user_name')
        assert fact is not None
        assert fact['factKey'] == 'user_name'
        assert fact['category'] == 'identity'

    def testSearchFacts(self):
        save_fact('color', 'blue', category='prefs')
        results = search_facts('blue')
        assert len(results) >= 1

    def testListByCategory(self):
        save_fact('f1', 'v1', category='cat_a')
        save_fact('f2', 'v2', category='cat_a')
        save_fact('f3', 'v3', category='cat_b')
        catA = list_facts('cat_a')
        assert len(catA) == 2
        allFacts = list_facts()
        assert len(allFacts) >= 3


class TestProposals:
    def testCreateAndGet(self):
        pid = save_proposal('session_1', 'plan', {'steps': ['Do X']})
        prop = get_proposal(pid)
        assert prop is not None
        assert prop['status'] == 'pending'

    def testDecide(self):
        pid = save_proposal('session_1', 'plan', {})
        assert decide_proposal(pid, 'approved', 'user') is True
        prop = get_proposal(pid)
        assert prop['status'] == 'approved'

    def testList(self):
        save_proposal('s1', 'plan', {})
        save_proposal('s1', 'mutation', {})
        save_proposal('s2', 'plan', {})
        s1Props = list_proposals('s1')
        assert len(s1Props) == 2


class TestLifecycle:
    def testRecordAndList(self):
        lid = record_lifecycle('session_1', 'session_started', {'task': 'test'})
        assert lid > 0
        events = list_lifecycle('session_1')
        assert len(events) == 1
        assert events[0]['eventType'] == 'session_started'


class TestTopicIndex:
    def testIndexAndGet(self):
        assert index_session_topic('s1', 'debug') is True
        topic = get_session_topic('s1')
        assert topic is not None
        assert topic['topic'] == 'debug'

    def testListTopics(self):
        index_session_topic('s1', 'debug')
        index_session_topic('s2', 'code_edit')
        topics = list_topics()
        assert len(topics) >= 2


class TestSessionPersistence:
    def testSaveAndGetSession(self):
        session = {'id': 'test-session-1', 'title': 'Test', 'startedAt': 'now', 'messageCount': 0}
        save_session(session)
        found = get_session('test-session-1')
        assert found is not None
        assert found['title'] == 'Test'

    def testListSessions(self):
        save_session({'id': 's1', 'title': 'S1', 'startedAt': 'now', 'messageCount': 0})
        save_session({'id': 's2', 'title': 'S2', 'startedAt': 'now', 'messageCount': 0})
        sessions = list_sessions()
        assert len(sessions) >= 2

    def testDeleteSession(self):
        save_session({'id': 'del-me', 'title': 'Delete', 'startedAt': 'now', 'messageCount': 0})
        assert delete_session_record('del-me') is True

    def testMessages(self):
        save_session({'id': 'msg-test', 'title': 'T', 'startedAt': 'now', 'messageCount': 0})
        save_message('msg-test', 'user', 'Hello')
        save_message('msg-test', 'assistant', 'Hi!')
        msgs = get_messages('msg-test')
        assert len(msgs) == 2
        assert msgs[0]['role'] == 'user'


class TestUsage:
    def testRecordAndGet(self):
        record_usage('session_u1', 'gpt-4', 100, 50)
        record_usage('session_u1', 'gpt-4', 200, 30)
        usage = get_usage('session_u1')
        assert usage['totalInputTokens'] >= 300
        assert usage['totalOutputTokens'] >= 80
        assert usage['totalEvents'] >= 2


class TestBrainOrchestrator:
    def testGetConfig(self):
        config = getBrainConfig()
        assert config['enabled'] is True
        assert 'max_agent_depth' in config

    def testClassifyTask(self):
        assert classifyTask('fix this bug') == 'debug'
        assert classifyTask('implement feature') == 'code_edit'
        assert classifyTask('search the web') == 'research'
        assert classifyTask('remember something') == 'memory_question'
        assert classifyTask('plan architecture') == 'planning'
        assert classifyTask('run command') == 'system_control'
        assert classifyTask('hello world') == 'chat'

    def testRiskForTask(self):
        assert riskForTask('code_edit') == 'approval_required'
        assert riskForTask('system_control') == 'approval_required'
        assert riskForTask('chat') == 'read_only'
        assert riskForTask('research') == 'read_only'


class TestContextBuilder:
    def testNormalizeBlocks(self):
        blocks = normalizeSystemBlocks('Hello')
        assert len(blocks) == 1
        assert blocks[0]['type'] == 'text'
        blocks2 = normalizeSystemBlocks(['A', 'B'])
        assert len(blocks2) == 2

    def testSystemBlocksToText(self):
        text = systemBlocksToText([{'type': 'text', 'text': 'Hello'}, {'type': 'text', 'text': 'World'}])
        assert 'Hello' in text
        assert 'World' in text

    def testSlimCoreContext(self):
        ctx = buildSlimCoreContext({'coreMemory': {'name': 'Test User'}, 'global_context': 'Working on X'})
        assert 'Test User' in ctx
        assert 'Working on X' in ctx


class TestContextCompressor:
    def testLocalSummarize(self):
        msgs = [{'role': 'user', 'content': 'Hello'}, {'role': 'assistant', 'content': 'Hi there!'}]
        summary = localSummarize(msgs)
        assert len(summary) > 0
        assert '[user]' in summary or 'Hello' in summary

    def testCompress(self):
        msgs = [
            {'role': 'user', 'content': 'A'},
            {'role': 'assistant', 'content': 'B'},
            {'role': 'user', 'content': 'C'},
            {'role': 'assistant', 'content': 'D'},
        ]
        compressed = compressMessages(msgs, threshold=1, head_count=1, tail_count=1)
        assert len(compressed) <= len(msgs)

    def testSummaryHelpersDetectAndExtract(self):
        """s4 plumbing: prior summaries are detected and their text recovered."""
        msg = buildSummaryMessage([{'role': 'user', 'content': 'x'}], 'the summary body text')
        assert _isSummaryMessage(msg) is True
        assert _extractSummaryText(msg) == 'the summary body text'
        plain = {'role': 'system', 'content': 'You are helpful.'}
        assert _isSummaryMessage(plain) is False
        assert _extractSummaryText(plain) == ''
        assert _isSummaryMessage({'role': 'user', 'content': DEFAULT_SUMMARY_MARKER}) is False

    def testRepeatedCompactionDoesNotAccumulateSummaryBlocks(self):
        """s4 regression: a conversation that already contains a prior
        compressed-summary system block must, on re-compaction, keep exactly
        ONE summary (not the prior one + a new one = N blocks after N
        compactions) and fold the prior summary's text into the survivor so
        no information is lost."""
        priorSummary = buildSummaryMessage([{'role': 'user', 'content': 'old'}], 'PRIOR SUMMARY BODY')
        msgs = (
            [{'role': 'system', 'content': 'You are helpful.'}, priorSummary]
            + [{'role': 'user', 'content': f'turn {i}'} for i in range(20)]
            + [{'role': 'assistant', 'content': f'reply {i}'} for i in range(20)]
        )
        out = compressMessages(msgs, threshold=1, head_count=2, tail_count=2)
        summaries = [m for m in out if _isSummaryMessage(m)]
        assert len(summaries) == 1, f're-compaction must not accumulate summary blocks (s4); got {len(summaries)}'
        assert 'PRIOR SUMMARY BODY' in summaries[0]['content']
        assert 'Earlier summary' in summaries[0]['content']
        assert any((m.get('role') == 'system' and 'You are helpful.' in m.get('content', '') for m in out))


class TestContextScrubber:
    def testBatchStrip(self):
        result = stripMemoryBlocks('Hello <memory_context>secret</memory_context> world')
        assert 'secret' not in result
        assert 'Hello' in result
        assert 'world' in result

    def testStreaming(self):
        s = ContextScrubber()
        parts = [s.feed('Hello '), s.feed('<memory_context>secret'), s.feed('stuff</memory_context>'), s.feed(' world')]
        combined = ''.join(parts)
        assert 'secret' not in combined
        assert 'stuff' not in combined

    def testNoTags(self):
        s = ContextScrubber()
        result = s.feed('Hello world')
        assert result == 'Hello world'

    def testEmpty(self):
        s = ContextScrubber()
        assert s.feed('') == ''


class TestTopicIndex:
    def testClassify(self):
        assert classifyTopic('fix bug') == 'debug'
        assert classifyTopic('search the web') == 'research'
        assert classifyTopic('') == 'chat'
        assert classifyTopic('hello world') == 'chat'
