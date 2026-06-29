"""v1.1 — End-to-end smoke test: a real chat session, no crashes."""
import pytest
import uuid
from app.services.memory import context_builder, auto_memory
from app.services.workbench import workbench
from app.services import memory_store


@pytest.fixture(autouse=True)
def _init_db():
    """Run init() so schema is current (idempotent)."""
    memory_store.init()
    yield


def test_build_system_prompt_does_not_crash_with_realistic_payload():
    """The most common failure mode: build_system_prompt with a real-shaped session."""
    session = {
        "id": "e2e-test",
        "user_state": {"profile": "developer", "skills": [{"name": "test", "description": "x"}]},
        "workspace": {"path": "/tmp", "vcs": "git on main"},
        "directives": {"goal": "test the chat", "plan": None, "plan_approved": False},
        "learned_heuristics": [{"rule": "use unicode math"}],
        "core_memory": {"facts": ["user prefers tabs"]},
        "auto_memories": [{"key": "x", "content": "y", "importance": 0.5}],
    }
    memory = {
        "core_memory": {"facts": ["user prefers tabs"]},
        "learned_heuristics": [{"rule": "use unicode math"}],
        "auto_memories": [{"key": "x", "content": "y", "importance": 0.5}],
    }
    tools = [
        {"name": "read_file", "description": "read a file", "parameters": []},
        {"name": "write_file", "description": "write a file", "parameters": []},
    ]

    # Should not raise any exception
    result = context_builder.build_system_prompt(
        session=session,
        memory=memory,
        tools=tools,
    )
    assert isinstance(result, str)
    assert len(result) > 100  # non-trivial content


def test_build_system_prompt_with_cached_t12_does_not_crash():
    """Cache path: cached_t12 provided, should be included verbatim."""
    cache_payload = "PRECOMPUTED_T1_T2_BLOCK"
    result = context_builder.build_system_prompt(
        session={"id": "e2e-test"},
        memory={},
        cached_t12=cache_payload,
    )
    assert cache_payload in result


def test_save_auto_memory_then_brain_query_round_trip():
    """End-to-end: save → read back via brain_query."""
    import json
    # Use a content string with no FTS5-unfriendly chars (no underscores, hyphens, etc.)
    unique_marker = f"e2euniq{uuid.uuid4().hex[:8]}"
    key = f"v11_e2e_round_trip"
    try:
        # Write
        auto_memory.save_auto_memory(key=key, content=f"round trip {unique_marker}", importance=0.9)
        # Read back via brain_query — search for content, not key (key has
        # underscores which the FTS5 simple tokenizer splits on)
        result = memory_store.brain_query(store="auto_memories", query=unique_marker, limit=5)
        parsed = json.loads(result)
        # Should return a list containing our memory
        assert isinstance(parsed, list)
        assert any(unique_marker in str(r.get("content", "")) for r in parsed)
    finally:
        # cleanup
        conn = memory_store._conn()
        conn.execute("DELETE FROM auto_memories WHERE key = ?", (key,))
        conn.commit()


def test_brain_query_all_stores_no_exception():
    """All 12 stores respond without raising."""
    import json
    stores = [
        "memory", "auto_memories", "heuristics", "facts", "sessions",
        "messages", "timeline", "graph", "blackboard", "daemons",
        "exams", "exam_attempts",
    ]
    for store in stores:
        result = memory_store.brain_query(store=store, query="", limit=5)
        assert isinstance(result, str)
        parsed = json.loads(result)
        assert isinstance(parsed, (list, dict)), f"{store}: {type(parsed)}"


def test_failure_feedback_round_trip():
    """Tool error populates session._failure_feedback; subsequent build_system_prompt
    includes it via context_builder (we just check the attribute round-trip)."""
    import asyncio
    from app.services.workbench.workbench import _execute_tool

    class FakeSession:
        def __init__(self):
            self._failure_feedback = None
            self._failure_feedback_age = None
            self.id = "e2e-feedback"
            self.status = "idle"
            self.session_id = "e2e-feedback"

    async def run_error():
        # Patch the dispatch to raise
        from app.services import tool_registry
        original_dispatch = tool_registry.dispatch

        async def boom(tool_name, args):
            raise ValueError("e2e test error")

        tool_registry.dispatch = boom
        try:
            session = FakeSession()
            result = await _execute_tool(
                tool_name="run_command",
                args={"command": "test"},
                session=session,
            )
            return result, session._failure_feedback
        finally:
            tool_registry.dispatch = original_dispatch

    result, feedback = asyncio.run(run_error())
    assert "failed" in result.lower()
    assert feedback is not None
    assert feedback["tool"] == "run_command"
    assert feedback["error_type"] == "ValueError"
    assert "e2e test error" in feedback["error_message"]
