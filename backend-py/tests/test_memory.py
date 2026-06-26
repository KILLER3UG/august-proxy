"""Memory system unit tests."""
import pytest
from app.services.memory_store import (
    init, close, save_memory, get_memory, delete_memory, list_memory, search_memory,
    save_fact, get_fact, search_facts, list_facts, delete_fact,
    save_proposal, get_proposal, list_proposals, decide_proposal,
    record_lifecycle, list_lifecycle,
    index_session_topic, get_session_topic, list_topics,
    save_session, get_session, list_sessions, delete_session_record,
    save_message, get_messages, record_usage, get_usage, get_stats, vacuum,
)
from app.services.memory.brain_orchestrator import (
    get_brain_config, classify_task, risk_for_task, extract_text_from_messages,
)
from app.services.memory.context_builder import (
    normalize_system_blocks, system_blocks_to_text, build_slim_core_context,
)
from app.services.memory.context_compressor import compress_messages, local_summarize
from app.services.memory.context_scrubber import ContextScrubber, strip_memory_blocks
from app.services.memory.topic_index import classify_topic


@pytest.fixture(autouse=True)
def setup_db():
    init()
    yield
    # Clean up all test data in reverse dependency order
    from app.services.memory_store import _conn
    conn = _conn()
    conn.executescript("""
        PRAGMA foreign_keys = OFF;
        DELETE FROM messages;
        DELETE FROM sessions;
        DELETE FROM usage_events;
        DELETE FROM lifecycle;
        DELETE FROM proposals;
        DELETE FROM session_topics;
        DELETE FROM facts;
        DELETE FROM memory_store;
        PRAGMA foreign_keys = ON;
    """)
    conn.commit()
    close()


class TestMemoryKV:
    def test_save_and_get(self):
        save_memory("test_key", {"hello": "world"})
        val = get_memory("test_key")
        assert val == {"hello": "world"}

    def test_get_nonexistent(self):
        val = get_memory("nonexistent")
        assert val is None

    def test_delete(self):
        save_memory("del_key", "value")
        assert delete_memory("del_key") is True
        assert get_memory("del_key") is None
        assert delete_memory("del_key") is False

    def test_list(self):
        save_memory("a_1", "v1")
        save_memory("a_2", "v2")
        save_memory("b_1", "v3")
        entries = list_memory("a_%")
        assert len(entries) == 2

    def test_search(self):
        save_memory("hello_world", {"msg": "Hello there"})
        results = search_memory("hello")
        assert len(results) >= 1


class TestFacts:
    def test_save_and_get(self):
        save_fact("user_name", "Alice", category="identity")
        fact = get_fact("user_name")
        assert fact is not None
        assert fact["fact_key"] == "user_name"
        assert fact["category"] == "identity"

    def test_search_facts(self):
        save_fact("color", "blue", category="prefs")
        results = search_facts("blue")
        assert len(results) >= 1

    def test_list_by_category(self):
        save_fact("f1", "v1", category="cat_a")
        save_fact("f2", "v2", category="cat_a")
        save_fact("f3", "v3", category="cat_b")
        cat_a = list_facts("cat_a")
        assert len(cat_a) == 2
        all_facts = list_facts()
        assert len(all_facts) >= 3


class TestProposals:
    def test_create_and_get(self):
        pid = save_proposal("session_1", "plan", {"steps": ["Do X"]})
        prop = get_proposal(pid)
        assert prop is not None
        assert prop["status"] == "pending"

    def test_decide(self):
        pid = save_proposal("session_1", "plan", {})
        assert decide_proposal(pid, "approved", "user") is True
        prop = get_proposal(pid)
        assert prop["status"] == "approved"

    def test_list(self):
        save_proposal("s1", "plan", {})
        save_proposal("s1", "mutation", {})
        save_proposal("s2", "plan", {})
        s1_props = list_proposals("s1")
        assert len(s1_props) == 2


class TestLifecycle:
    def test_record_and_list(self):
        lid = record_lifecycle("session_1", "session_started", {"task": "test"})
        assert lid > 0
        events = list_lifecycle("session_1")
        assert len(events) == 1
        assert events[0]["event_type"] == "session_started"


class TestTopicIndex:
    def test_index_and_get(self):
        assert index_session_topic("s1", "debug") is True
        topic = get_session_topic("s1")
        assert topic is not None
        assert topic["topic"] == "debug"

    def test_list_topics(self):
        index_session_topic("s1", "debug")
        index_session_topic("s2", "code_edit")
        topics = list_topics()
        assert len(topics) >= 2


class TestSessionPersistence:
    def test_save_and_get_session(self):
        session = {"id": "test-session-1", "title": "Test", "startedAt": "now", "messageCount": 0}
        save_session(session)
        found = get_session("test-session-1")
        assert found is not None
        assert found["title"] == "Test"

    def test_list_sessions(self):
        save_session({"id": "s1", "title": "S1", "startedAt": "now", "messageCount": 0})
        save_session({"id": "s2", "title": "S2", "startedAt": "now", "messageCount": 0})
        sessions = list_sessions()
        assert len(sessions) >= 2

    def test_delete_session(self):
        save_session({"id": "del-me", "title": "Delete", "startedAt": "now", "messageCount": 0})
        assert delete_session_record("del-me") is True

    def test_messages(self):
        save_session({"id": "msg-test", "title": "T", "startedAt": "now", "messageCount": 0})
        save_message("msg-test", "user", "Hello")
        save_message("msg-test", "assistant", "Hi!")
        msgs = get_messages("msg-test")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"


class TestUsage:
    def test_record_and_get(self):
        record_usage("session_u1", "gpt-4", 100, 50)
        record_usage("session_u1", "gpt-4", 200, 30)
        usage = get_usage("session_u1")
        assert usage["total_input"] >= 300
        assert usage["total_output"] >= 80
        assert usage["request_count"] >= 2


class TestBrainOrchestrator:
    def test_get_config(self):
        config = get_brain_config()
        assert config["enabled"] is True
        assert "max_agent_depth" in config

    def test_classify_task(self):
        assert classify_task("fix this bug") == "debug"
        assert classify_task("implement feature") == "code_edit"
        assert classify_task("search the web") == "research"
        assert classify_task("remember something") == "memory_question"
        assert classify_task("plan architecture") == "planning"
        assert classify_task("run command") == "system_control"
        assert classify_task("hello world") == "chat"

    def test_risk_for_task(self):
        assert risk_for_task("code_edit") == "approval_required"
        assert risk_for_task("system_control") == "approval_required"
        assert risk_for_task("chat") == "read_only"
        assert risk_for_task("research") == "read_only"


class TestContextBuilder:
    def test_normalize_blocks(self):
        blocks = normalize_system_blocks("Hello")
        assert len(blocks) == 1
        assert blocks[0]["type"] == "text"

        blocks2 = normalize_system_blocks(["A", "B"])
        assert len(blocks2) == 2

    def test_system_blocks_to_text(self):
        text = system_blocks_to_text([{"type": "text", "text": "Hello"}, {"type": "text", "text": "World"}])
        assert "Hello" in text
        assert "World" in text

    def test_slim_core_context(self):
        ctx = build_slim_core_context({"user_profile": "Test User", "global_context": "Working on X"})
        assert "Test User" in ctx
        assert "Working on X" in ctx


class TestContextCompressor:
    def test_local_summarize(self):
        msgs = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        summary = local_summarize(msgs)
        assert len(summary) > 0
        assert "[user]" in summary or "Hello" in summary

    def test_compress(self):
        msgs = [
            {"role": "user", "content": "A"},
            {"role": "assistant", "content": "B"},
            {"role": "user", "content": "C"},
            {"role": "assistant", "content": "D"},
        ]
        # Use a tiny threshold to force compression
        compressed = compress_messages(msgs, threshold=1, head_count=1, tail_count=1)
        assert len(compressed) <= len(msgs)


class TestContextScrubber:
    def test_batch_strip(self):
        result = strip_memory_blocks("Hello <memory_context>secret</memory_context> world")
        assert "secret" not in result
        assert "Hello" in result
        assert "world" in result

    def test_streaming(self):
        s = ContextScrubber()
        parts = [
            s.feed("Hello "),
            s.feed("<memory_context>secret"),
            s.feed("stuff</memory_context>"),
            s.feed(" world"),
        ]
        combined = "".join(parts)
        assert "secret" not in combined
        assert "stuff" not in combined

    def test_no_tags(self):
        s = ContextScrubber()
        result = s.feed("Hello world")
        assert result == "Hello world"

    def test_empty(self):
        s = ContextScrubber()
        assert s.feed("") == ""


class TestTopicIndex:
    def test_classify(self):
        assert classify_topic("fix bug") == "debug"
        assert classify_topic("search the web") == "research"
        assert classify_topic("") == "chat"
        assert classify_topic("hello world") == "chat"
