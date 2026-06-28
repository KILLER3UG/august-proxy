"""Workbench service unit tests."""
import pytest
from app.services.workbench.workbench import (
    create_workbench_session, get_workbench_session, list_workbench_sessions,
    summarize_session, delete_workbench_session,
    normalize_guard_mode, is_plan_mode_blocked,
    build_system_prompt, submit_plan, approve_workbench_plan,
    reject_workbench_plan, create_pending_mutation, consume_pending_mutation,
    set_workbench_goal, get_workbench_goal_status, get_workbench_activity,
    resolve_effective_effort, effort_to_thinking_budget,
    effort_to_openai_reasoning_effort,
)
from app.services.workbench.managed_tool_policy import (
    is_managed_tool_parallel_safe, parse_openai_tool_args,
)
from app.services.workbench.tool_executor import execute_tool_batch
from app.services.workbench.selfheal import detect_error, build_hints, enhance_tool_result, apply_self_heal_to_messages
from app.services.workbench.validator import validate_tool_arguments, build_validation_error_tool_message


class TestSessionManagement:
    def test_create_session(self):
        session = create_workbench_session(provider="anthropic", guard_mode="full")
        assert session.id.startswith("wb_")
        assert session.provider == "anthropic"
        assert session.guard_mode == "full"

    def test_get_session(self):
        session = create_workbench_session()
        found = get_workbench_session(session.id)
        assert found is not None
        assert found.id == session.id

    def test_list_sessions(self):
        create_workbench_session()
        sessions = list_workbench_sessions()
        assert len(sessions) >= 1

    def test_delete_session(self):
        session = create_workbench_session()
        assert delete_workbench_session(session.id) is True
        assert get_workbench_session(session.id) is None

    def test_summarize_session(self):
        session = create_workbench_session(provider="test")
        summary = summarize_session(session)
        assert summary["id"] == session.id
        assert summary["provider"] == "test"


class TestPlanAndApproval:
    def test_submit_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "Test plan", "steps": ["Step 1"]})
        assert session.plan is not None
        assert session.plan_approved is False

    def test_approve_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "Test"})
        assert approve_workbench_plan(session.id) is True
        assert session.plan_approved is True

    def test_reject_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "Test"})
        assert reject_workbench_plan(session.id) is True
        assert session.plan is None

    def test_pending_mutations(self):
        session = create_workbench_session()
        mutation = create_pending_mutation(session, "write_file", {"path": "/tmp/test"})
        assert mutation is not None
        assert "token" in mutation
        assert session.status == "awaiting_approval"

        assert consume_pending_mutation(mutation["token"]) is True
        assert session.status == "idle"


class TestGuardMode:
    def test_normalize(self):
        assert normalize_guard_mode("plan") == "plan"
        assert normalize_guard_mode("FULL") == "full"
        assert normalize_guard_mode("ask") == "ask"
        assert normalize_guard_mode("invalid") == "full"

    def test_plan_mode_blocked(self):
        assert is_plan_mode_blocked("write_file") is True
        assert is_plan_mode_blocked("run_command") is True
        assert is_plan_mode_blocked("read_file") is False
        assert is_plan_mode_blocked("WebSearch") is False


class TestGoalSystem:
    def test_set_and_get_goal(self):
        session = create_workbench_session()
        set_workbench_goal(session, "Complete the task")
        status = get_workbench_goal_status(session.id)
        assert status is not None
        assert status["goal"] == "Complete the task"
        assert status["active"] is True


class TestEffort:
    def test_resolve_effort(self):
        session = create_workbench_session()
        assert resolve_effective_effort("high", session) == "high"
        assert resolve_effective_effort("", session) == "medium"

    def test_thinking_budget(self):
        assert effort_to_thinking_budget("low") <= 8192
        assert effort_to_thinking_budget("high", max_tokens=32000) == 16000
        assert effort_to_thinking_budget("max", model_max=64000, max_tokens=32000) >= 32000

    def test_openai_reasoning(self):
        assert effort_to_openai_reasoning_effort("high") == "high"
        assert effort_to_openai_reasoning_effort("low") == "low"


class TestSystemPrompt:
    def test_build_prompt(self):
        session = create_workbench_session(guard_mode="full")
        prompt = build_system_prompt(session)
        assert "August Proxy" in prompt
        assert len(prompt) > 50

    def test_prompt_with_goal(self):
        session = create_workbench_session()
        set_workbench_goal(session, "Build feature")
        prompt = build_system_prompt(session)
        assert "Build feature" in prompt

    def test_prompt_with_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "My plan"})
        approve_workbench_plan(session.id)
        prompt = build_system_prompt(session)
        assert "My plan" in prompt
        assert "approved" in prompt

    def test_plan_mode_not_injected_into_prompt(self):
        # Regression for the guardrail refactor (a638767): plan-mode
        # enforcement moved from the system prompt to the tool-execution
        # layer (_check_tool_guard, workbench.py). build_system_prompt must
        # NOT inject a "## Plan Mode" section — the submit_plan guidance is
        # now delivered via the blocked-tool result message. Behavioral
        # coverage lives in TestPlanModeGuard below.
        session = create_workbench_session(guard_mode="plan")
        prompt = build_system_prompt(session)
        assert "## Plan Mode" not in prompt
        assert "You are in plan mode" not in prompt
        assert prompt  # prompt still builds for a plan-mode session


class TestPlanModeGuard:
    """Regression: plan mode must not abort the chat after a tool round.

    The old behaviour broke the tool loop after *every* round in plan mode
    (workbench.py `if guard_mode == 'plan': break`), so the model never got
    a re-call to produce its plan/final answer — the 'tools abort the chat'
    symptom. The fix: plan mode allows research re-calls, only pausing when
    the model actually submits a plan; and an approved plan unblocks
    mutations so it can be executed.
    """

    def test_submit_plan_never_blocked_in_plan_mode(self):
        # submit_plan is the model's way to propose a plan; it must never be
        # blocked by is_plan_mode_blocked (the loop special-cases it first).
        assert is_plan_mode_blocked("submit_plan") is False
        assert is_plan_mode_blocked("submitPlan") is False

    def test_readonly_tools_allowed_in_plan_mode(self):
        session = create_workbench_session(guard_mode="plan")
        from app.services.workbench.workbench import _check_tool_guard
        assert _check_tool_guard(session, "read_file", {"path": "/x"}) is None
        assert _check_tool_guard(session, "list_directory", {"path": "/x"}) is None

    def test_mutations_blocked_until_plan_approved(self):
        from app.services.workbench.workbench import _check_tool_guard
        session = create_workbench_session(guard_mode="plan")
        # Before approval, mutations are blocked.
        assert _check_tool_guard(session, "write_file", {"path": "/x", "content": "y"}) is not None
        assert _check_tool_guard(session, "run_command", {"command": "ls"}) is not None
        # After a plan is submitted and approved, mutations are allowed so
        # the approved plan can actually execute.
        submit_plan(session, {"plan": "1. write the file"})
        assert approve_workbench_plan(session.id) is True
        assert _check_tool_guard(session, "write_file", {"path": "/x", "content": "y"}) is None
        assert _check_tool_guard(session, "run_command", {"command": "ls"}) is None

    def test_all_non_destructive_tools_allowed_in_plan_mode(self):
        """In plan mode only DESTRUCTIVE tools are blocked; everything else
        (including unknown / custom / MCP tool names) is allowed so the model
        can investigate freely."""
        # Known read-only tools.
        for name in ("read_file", "list_directory", "search_files",
                     "context_read", "web_fetch", "web_search",
                     "memory_search", "fact_search", "list_skills", "load_skill"):
            assert is_plan_mode_blocked(name) is False, name
        # Unknown / custom / MCP-style tool names that aren't destructive
        # must be allowed (not silently dropped or blocked).
        for name in ("mcp__github__search", "spawn_subagent",
                     "analyze_code", "fetch_logs", "get_status"):
            assert is_plan_mode_blocked(name) is False, name

    def test_destructive_tools_blocked_in_plan_mode(self):
        for name in ("write_file", "edit_file", "delete_file", "run_command",
                     "bash", "apply_patch", "install", "StrReplaceEditTool"):
            assert is_plan_mode_blocked(name) is True, name

    def test_blocked_message_guides_model_to_submit_plan(self):
        """When the model tries a destructive tool in plan mode, the guard
        message must tell it to submit_plan and ask the user — this is the
        tool result the model receives on the next re-call."""
        from app.services.workbench.workbench import _check_tool_guard
        session = create_workbench_session(guard_mode="plan")
        reason = _check_tool_guard(session, "write_file", {"path": "/x", "content": "y"})
        assert reason is not None
        assert "submit_plan" in reason
        assert "approve" in reason.lower() or "permission" in reason.lower()


class TestManagedToolPolicy:
    def test_parallel_safe(self):
        assert is_managed_tool_parallel_safe("WebSearch") is True
        assert is_managed_tool_parallel_safe("WebFetch") is True
        assert is_managed_tool_parallel_safe("write_file") is False
        assert is_managed_tool_parallel_safe("read_file") is True
        assert is_managed_tool_parallel_safe("bash") is False

    def test_parse_args(self):
        result = parse_openai_tool_args({"function": {"arguments": '{"key": "val"}'}})
        assert result == {"key": "val"}

        result2 = parse_openai_tool_args({"function": {"arguments": "invalid"}})
        assert result2 == {}


@pytest.mark.asyncio
class TestToolExecutor:
    async def test_sequential(self):
        async def exec_one(tu):
            return {"tool_call_id": tu["id"], "content": "done"}
        results = await execute_tool_batch([{"id": "1"}, {"id": "2"}], exec_one)
        assert len(results) == 2

    async def test_parallel(self):
        async def exec_one(tu):
            return {"tool_call_id": tu["id"], "content": "done"}
        results = await execute_tool_batch(
            [{"id": "a"}, {"id": "b"}], exec_one,
            {"parallel": True, "can_run_in_parallel": lambda x: True},
        )
        assert len(results) == 2


class TestSelfHeal:
    def test_detect_error(self):
        assert detect_error("Error: file not found") is True
        assert detect_error("command not found: ls") is True
        assert detect_error("permission denied") is True
        assert detect_error("All good") is False

    def test_build_hints(self):
        hints = build_hints("command not found: ls")
        assert "Hint" in hints

        hints2 = build_hints("Error: permission denied")
        assert "Hint" in hints2

    def test_enhance_result(self):
        enhanced = enhance_tool_result("Error: something broke")
        assert "Hint" in enhanced

    def test_apply_to_messages(self):
        msgs = [{"role": "tool", "content": "Error: failed"}]
        healed = apply_self_heal_to_messages(msgs)
        assert "Hint" in healed[0]["content"]


class TestValidator:
    def test_valid_call(self):
        result = validate_tool_arguments(
            {"function": {"name": "WebSearch", "arguments": '{"query": "test"}'}},
            [{"function": {"name": "WebSearch", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
        )
        assert result["valid"] is True

    def test_missing_field(self):
        result = validate_tool_arguments(
            {"function": {"name": "WebSearch", "arguments": "{}"}},
            [{"function": {"name": "WebSearch", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
        )
        assert result["valid"] is False
        assert "Missing" in result.get("error", "")

    def test_anthropic_format(self):
        result = validate_tool_arguments(
            {"name": "WebSearch", "input": {"query": "test"}},
            [{"name": "WebSearch", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}],
        )
        assert result["valid"] is True

    def test_compatibility_shim(self):
        result = validate_tool_arguments(
            {"function": {"name": "WebFetch", "arguments": '{"prompt": "https://x.com"}'}},
            [{"function": {"name": "WebFetch", "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}}],
        )
        assert result["valid"] is True

    def test_error_message(self):
        msg = build_validation_error_tool_message("call_1", "WebSearch", "Missing field")
        assert "Validation Error" in msg["content"]
        assert msg["tool_call_id"] == "call_1"


@pytest.mark.asyncio
class TestAnthropicWorkbenchStreaming:
    """Regression for the C1 streaming bug.

    A non-thinking-capable model (claude-3-5-sonnet-20241022, haiku*) must
    still stream and return a dict. Before the fix, the streaming block was
    nested inside the `if thinking_budget > 0 and _supports_thinking(...)`
    guard, so a non-thinking model fell through to an implicit `return None`
    and the chat loop crashed with AttributeError at the caller's
    `response.get(...)`. This test mocks the upstream stream so the path is
    exercised end-to-end.
    """

    async def test_non_thinking_model_streams_and_returns_dict(self, monkeypatch):
        from app.services.workbench.workbench import _call_anthropic_workbench

        captured_body: dict = {}

        class _FakeClient:
            def resolve_api_key(self):
                return "test-key"

            async def messages_stream(self, body):
                captured_body.update(body)
                yield {"_event_type": "content_block_start",
                       "content_block": {"type": "text", "text": ""}}
                yield {"_event_type": "content_block_delta",
                       "delta": {"type": "text_delta", "text": "Hello "}}
                yield {"_event_type": "content_block_delta",
                       "delta": {"type": "text_delta", "text": "world"}}
                yield {"_event_type": "content_block_stop"}
                yield {"_event_type": "message_delta",
                       "usage": {"input_tokens": 10, "output_tokens": 5}}

        import app.providers.clients as clients
        monkeypatch.setattr(clients, "get_client", lambda provider: _FakeClient())

        emitted: list[dict] = []
        # No supportsThinking profile → _supports_thinking is False, while
        # effort_to_thinking_budget("medium") > 0: the exact C1 path where
        # the guard is False but streaming must still run.
        provider = {"name": "test", "model_profiles": {"*": {}},
                    "api_mode": "anthropic_messages"}
        result = await _call_anthropic_workbench(
            [{"role": "user", "content": "hi"}],
            "You are helpful.",
            "claude-3-5-sonnet-20241022",
            [],
            "medium",
            provider=provider,
            emit=emitted.append,
        )

        # The pre-fix bug returned None here, crashing the caller's .get().
        assert result is not None
        assert "error" not in result
        assert result["text"] == "Hello world"
        assert any(b.get("type") == "text" for b in result["content"])
        assert result["usage"]["input_tokens"] == 10
        assert result["usage"]["output_tokens"] == 5
        # The thinking request field is correctly conditional: a
        # non-thinking model must not send `thinking` upstream.
        assert "thinking" not in captured_body
        # Progressive emission happened during streaming.
        assert any(e.get("type") == "final_output" for e in emitted)
        # No thinking content for a non-thinking model.
        assert result["thinking"] == ""
        assert not any(b.get("type") == "thinking" for b in result["content"])

    async def test_workbench_records_context_tokens_as_final_subcall_input(self, monkeypatch):
        """The gauge ground truth: record_usage must be called with
        context_tokens = the input_tokens of the FINAL provider sub-call in
        the turn (the true current context fill), not the cumulative sum."""
        from app.services.workbench import workbench as wb
        from app.services.workbench.workbench import (
            send_workbench_message_stream, create_workbench_session,
        )

        session = create_workbench_session(provider="anthropic", guard_mode="full")

        class _FakeClient:
            def resolve_api_key(self):
                return "test-key"

            async def messages_stream(self, body):
                yield {"_event_type": "content_block_start",
                       "content_block": {"type": "text", "text": ""}}
                yield {"_event_type": "content_block_delta",
                       "delta": {"type": "text_delta", "text": "done"}}
                yield {"_event_type": "content_block_stop"}
                yield {"_event_type": "message_delta",
                       "usage": {"input_tokens": 4823, "output_tokens": 40}}

        import app.providers.clients as clients
        monkeypatch.setattr(clients, "get_client", lambda provider: _FakeClient())

        recorded: list[dict] = []

        def fake_record_usage(session_id, model, input_tokens=0, output_tokens=0, context_tokens=0):
            recorded.append({
                "session_id": session_id,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "context_tokens": context_tokens,
            })
            return 1

        # The workbench imports record_usage lazily inside the function, so
        # patch it on the memory_store module the import resolves to.
        import app.services.memory_store as memory_store
        monkeypatch.setattr(memory_store, "record_usage", fake_record_usage)

        # No tools → single sub-call → context_tokens == input_tokens.
        # Provide a provider config so resolution succeeds.
        provider_config = {
            "name": "anthropic",
            "model_profiles": {"*": {}},
            "api_mode": "anthropic_messages",
        }
        monkeypatch.setattr(wb, "_resolve_workbench_provider", lambda *a, **k: provider_config)
        monkeypatch.setattr(wb, "_resolve_model", lambda *a, **k: "claude-3-5-sonnet-20241022")

        await send_workbench_message_stream(
            session_id=session.id,
            message="hi",
            provider="anthropic",
            emit=lambda e: None,
        )

        assert len(recorded) == 1
        rec = recorded[0]
        # context_tokens is the final sub-call's input_tokens (the true
        # current context fill), NOT the cumulative sum.
        assert rec["context_tokens"] == 4823
